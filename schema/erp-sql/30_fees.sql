-- Fee collection (FEE-04, TEC-02): atomic, idempotent, traceable to the ledger. Port of the ERP's collect_fee,
-- reverse_receipt, bounce_cheque and apply_concession (004_logic_core.sql) onto core.* and the platform helpers.
-- Receipts, payments, allocations and vouchers have no insert policy: they are written only by these functions.

-- ---------------------------------------------------------------- numbering (one receipt series in core.number_series, OQ-16)
-- Next receipt number of a branch: 'RCPT-<branch code>-00001'. Creates the branch series on first use. Locks the row.
create or replace function erp.next_receipt_no(p_org uuid, p_branch uuid) returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_code text;
  v_s core.number_series;
begin
  select b.code into v_code from core.branches b where b.org_id = p_org and b.id = p_branch;
  insert into core.number_series (org_id, branch_id, key, prefix, padding, product_key)
  values (p_org, p_branch, 'receipt', 'RCPT-' || coalesce(v_code, 'X') || '-', 5, 'erp')
  on conflict do nothing;
  select * into v_s from core.number_series s
   where s.org_id = p_org and s.key = 'receipt' and s.branch_id is not distinct from p_branch and s.academic_year_id is null
   for update;
  update core.number_series set next_value = next_value + 1 where id = v_s.id;
  return v_s.prefix || lpad(v_s.next_value::text, v_s.padding, '0') || v_s.suffix;
end $$;

-- ---------------------------------------------------------------- ledger
-- Voucher for a receipt: debit cash/bank by payment mode, credit the income account of each fee head. Needs the
-- default accounts 1000 cash, 1010 bank and 4000 fee income (erp.setup_org); without them nothing is posted.
create or replace function erp.post_receipt_voucher(p_receipt uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  r erp.receipts;
  v uuid;
  v_cash uuid;
  v_bank uuid;
  v_inc uuid;
begin
  select * into r from erp.receipts where id = p_receipt;
  select id into v_cash from erp.accounts where org_id = r.org_id and code = '1000';
  select id into v_bank from erp.accounts where org_id = r.org_id and code = '1010';
  select id into v_inc from erp.accounts where org_id = r.org_id and code = '4000';
  if v_cash is null or v_bank is null or v_inc is null then return; end if;
  insert into erp.vouchers (org_id, branch_id, voucher_no, date, type, narration, ref_type, ref_id)
  values (r.org_id, r.branch_id, 'V-' || r.receipt_no, r.date, 'receipt', 'Fee receipt ' || r.receipt_no, 'receipt', r.id)
  returning id into v;
  insert into erp.voucher_lines (org_id, branch_id, voucher_id, account_id, debit)
  select r.org_id, r.branch_id, v, case when rp.mode = 'cash' then v_cash else v_bank end, sum(rp.amount)
    from erp.receipt_payments rp where rp.receipt_id = r.id group by case when rp.mode = 'cash' then v_cash else v_bank end;
  insert into erp.voucher_lines (org_id, branch_id, voucher_id, account_id, credit)
  select r.org_id, r.branch_id, v, coalesce(h.account_id, v_inc), sum(ra.amount)
    from erp.receipt_allocations ra
    join erp.fee_demands d on d.id = ra.demand_id
    join erp.fee_heads h on h.id = d.head_id
   where ra.receipt_id = r.id group by coalesce(h.account_id, v_inc);
end $$;

-- ---------------------------------------------------------------- posting (internal; permission checks are in the wrappers)
-- p = { idempotency_key?, date?, channel?, note?, allocations: [{demand_id, amount}], payments: [{mode, amount, reference?, ...}] }
-- One receipt per learner. Repeating the same idempotency_key returns the earlier receipts.
create or replace function erp.post_receipts(p_org uuid, p jsonb, p_actor uuid, p_actor_name text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_allocs jsonb := coalesce(p->'allocations', '[]'::jsonb);
  v_pays jsonb := coalesce(p->'payments', '[]'::jsonb);
  v_key text := nullif(p->>'idempotency_key', '');
  v_total numeric := 0;
  v_paytotal numeric;
  a jsonb;
  d erp.fee_demands;
  bal numeric;
  v_students uuid[];
  sid uuid;
  v_receipt uuid;
  v_no text;
  v_ids uuid[] := '{}';
  stotal numeric;
  pay jsonb;
  rem numeric[];
  remaining numeric;
  share numeric;
  v_year uuid;
  v_branch uuid;
  v_hh uuid;
  i integer;
begin
  if v_key is not null and exists (select 1 from erp.receipts where org_id = p_org and idempotency_key = v_key) then
    return jsonb_build_object('duplicate', true, 'receipt_ids',
      (select jsonb_agg(id) from erp.receipts where org_id = p_org and idempotency_key = v_key));
  end if;
  if jsonb_typeof(v_allocs) <> 'array' or jsonb_typeof(v_pays) <> 'array' then
    raise exception 'allocations and payments must be lists' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(v_allocs) x group by x->>'demand_id' having count(*) > 1) then
    raise exception 'Each fee can appear only once in a payment.' using errcode = '22023';
  end if;
  for a in select * from jsonb_array_elements(v_allocs) loop
    select * into d from erp.fee_demands where id = (a->>'demand_id')::uuid and org_id = p_org for update;
    if d.id is null then raise exception 'Fee demand not found.' using errcode = '22023'; end if;
    if d.status in ('cancelled', 'waived') then
      raise exception '% is % and cannot be collected.', coalesce(d.label, 'This fee'), d.status using errcode = '22023';
    end if;
    bal := d.amount - d.concession + d.fine - d.paid;
    if (a->>'amount')::numeric <= 0 or (a->>'amount')::numeric > bal then
      raise exception 'The amount for % is more than its balance of %.', coalesce(d.label, 'a fee'), bal using errcode = '22023';
    end if;
    v_total := v_total + (a->>'amount')::numeric;
  end loop;
  select coalesce(sum((x->>'amount')::numeric), 0) into v_paytotal from jsonb_array_elements(v_pays) x;
  if v_total <= 0 then raise exception 'Nothing to collect.' using errcode = '22023'; end if;
  if v_paytotal <> v_total then
    raise exception 'Payment modes add up to % but the fees selected add up to %.', v_paytotal, v_total using errcode = '22023';
  end if;
  select array_agg(distinct d2.student_id) into v_students
    from jsonb_array_elements(v_allocs) x join erp.fee_demands d2 on d2.id = (x->>'demand_id')::uuid and d2.org_id = p_org;
  select array_agg((x->>'amount')::numeric order by ord) into rem from jsonb_array_elements(v_pays) with ordinality as t(x, ord);

  foreach sid in array v_students loop
    select sum((x->>'amount')::numeric), (array_agg(d2.academic_year_id))[1] into stotal, v_year
      from jsonb_array_elements(v_allocs) x join erp.fee_demands d2 on d2.id = (x->>'demand_id')::uuid and d2.org_id = p_org
     where d2.student_id = sid;
    select s.branch_id, s.household_id into v_branch, v_hh from core.students s where s.id = sid and s.org_id = p_org;
    v_no := erp.next_receipt_no(p_org, v_branch);
    insert into erp.receipts (org_id, branch_id, academic_year_id, receipt_no, student_id, household_id, date, total,
                              collected_by_name, collected_by_user_id, idempotency_key, channel, note)
    values (p_org, v_branch, v_year, v_no, sid, v_hh, coalesce(nullif(p->>'date', '')::date, current_date), stotal,
            p_actor_name, p_actor, v_key, coalesce(p->>'channel', 'counter'), p->>'note')
    returning id into v_receipt;
    v_ids := v_ids || v_receipt;
    for a in select x from jsonb_array_elements(v_allocs) x join erp.fee_demands d2 on d2.id = (x->>'demand_id')::uuid and d2.org_id = p_org where d2.student_id = sid loop
      insert into erp.receipt_allocations (org_id, receipt_id, demand_id, student_id, amount)
      values (p_org, v_receipt, (a->>'demand_id')::uuid, sid, (a->>'amount')::numeric);
      update erp.fee_demands set paid = paid + (a->>'amount')::numeric,
             status = case when paid + (a->>'amount')::numeric >= amount - concession + fine then 'paid' else 'partial' end
       where id = (a->>'demand_id')::uuid;
    end loop;
    remaining := stotal;
    for i in 1..coalesce(array_length(rem, 1), 0) loop
      exit when remaining <= 0;
      if rem[i] > 0 then
        share := least(rem[i], remaining);
        pay := v_pays -> (i - 1);
        insert into erp.receipt_payments (org_id, receipt_id, mode, amount, reference, cheque_no, cheque_bank, cheque_date, cheque_status, gateway, gateway_payment_id)
        values (p_org, v_receipt, pay->>'mode', share, pay->>'reference', pay->>'cheque_no', pay->>'cheque_bank',
                nullif(pay->>'cheque_date', '')::date, case when pay->>'mode' in ('cheque', 'dd') then 'received' end,
                pay->>'gateway', pay->>'gateway_payment_id');
        rem[i] := rem[i] - share;
        remaining := remaining - share;
      end if;
    end loop;
    perform erp.post_receipt_voucher(v_receipt);
    perform erp.notify_guardians(sid, 'fees.receipt', 'Payment received', 'Receipt ' || v_no || ' for Rs ' || stotal, '/receipt/' || v_receipt);
  end loop;
  return jsonb_build_object('duplicate', false, 'receipt_ids', to_jsonb(v_ids));
end $$;

-- Counter collection by staff with fees.create for every learner's branch.
create or replace function erp.collect_fee(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_org uuid := app.current_org_id();
  v_sid uuid;
  v_branch uuid;
begin
  if v_org is null or not app.user_has_product(v_org, 'erp') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  for v_sid, v_branch in
    select distinct d.student_id, s.branch_id
      from jsonb_array_elements(coalesce(p->'allocations', '[]'::jsonb)) x
      join erp.fee_demands d on d.org_id = v_org and d.id = (x->>'demand_id')::uuid
      join core.students s on s.org_id = d.org_id and s.id = d.student_id
  loop
    if not app.can('erp', 'fees', 'create', v_org, v_branch, null) then
      raise exception 'You do not have permission to collect fees.' using errcode = '42501';
    end if;
  end loop;
  return erp.post_receipts(v_org, p, app.uid(), (select u.display_name from core.org_users u where u.user_id = app.uid()));
end $$;

-- Reversal: marks the receipt reversed, gives the money back to the demands, posts the mirror voucher. Internal: it is
-- reached through an approved receipt_reversal request (erp.apply_approval) or erp.bounce_cheque.
create or replace function erp.reverse_receipt(p_receipt uuid, p_reason text) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  r erp.receipts;
  v uuid;
begin
  select * into r from erp.receipts where id = p_receipt for update;
  if r.id is null or r.status = 'reversed' then return; end if;
  update erp.receipts set status = 'reversed', reversed_reason = p_reason where id = r.id;
  update erp.fee_demands d set paid = d.paid - ra.amount,
         status = case when d.paid - ra.amount <= 0 then 'due' else 'partial' end
    from erp.receipt_allocations ra where ra.receipt_id = r.id and ra.demand_id = d.id;
  if exists (select 1 from erp.vouchers where ref_type = 'receipt' and ref_id = r.id) then
    insert into erp.vouchers (org_id, branch_id, voucher_no, date, type, narration, ref_type, ref_id)
    values (r.org_id, r.branch_id, 'V-REV-' || r.receipt_no, current_date, 'journal',
            'Reversal of ' || r.receipt_no || ': ' || coalesce(p_reason, ''), 'receipt_reversal', r.id)
    returning id into v;
    insert into erp.voucher_lines (org_id, branch_id, voucher_id, account_id, debit, credit)
    select vl.org_id, vl.branch_id, v, vl.account_id, vl.credit, vl.debit
      from erp.voucher_lines vl join erp.vouchers vo on vo.id = vl.voucher_id
     where vo.ref_type = 'receipt' and vo.ref_id = r.id;
  end if;
  perform erp.notify_guardians(r.student_id, 'fees.receipt_reversed', 'Receipt cancelled',
    'Receipt ' || r.receipt_no || ' was reversed: ' || coalesce(p_reason, ''), '/receipt/' || r.id);
end $$;

create or replace function erp.bounce_cheque(p_payment uuid, p_fine numeric default 0) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_org uuid := app.current_org_id();
  rp erp.receipt_payments;
  r erp.receipts;
  fh uuid;
begin
  select * into rp from erp.receipt_payments where id = p_payment and org_id = v_org;
  if rp.id is null or rp.mode not in ('cheque', 'dd') then raise exception 'Cheque payment not found.' using errcode = '22023'; end if;
  select * into r from erp.receipts where id = rp.receipt_id;
  if not app.can('erp', 'fees', 'edit', v_org, r.branch_id, null) then
    raise exception 'You do not have permission to record a bounced cheque.' using errcode = '42501';
  end if;
  if coalesce(p_fine, 0) < 0 then raise exception 'The fine cannot be negative.' using errcode = '22023'; end if;
  update erp.receipt_payments set cheque_status = 'bounced' where id = rp.id;
  perform erp.reverse_receipt(r.id, 'Cheque ' || coalesce(rp.cheque_no, '') || ' bounced');
  if p_fine > 0 then
    select id into fh from erp.fee_heads where org_id = r.org_id and type = 'fine' limit 1;
    if fh is not null then
      insert into erp.fee_demands (org_id, branch_id, academic_year_id, student_id, head_id, label, amount, due_date, note)
      values (r.org_id, r.branch_id, r.academic_year_id, r.student_id, fh, 'Cheque bounce charge', p_fine, current_date, 'Cheque ' || coalesce(rp.cheque_no, ''));
    end if;
  end if;
  perform erp.notify_roles(r.org_id, array['accounts'], r.branch_id, 'fees.cheque_bounced', 'Cheque bounced',
    'Receipt ' || r.receipt_no || ' was reversed. Follow up with the family.', '/fees/cheques');
end $$;

-- Applies an approved concession to the learner's open demands of the matching head type, oldest first.
create or replace function erp.apply_concession(p_id uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  c erp.concessions;
  ht text;
  tot numeric := 0;
  dem record;
  cut numeric;
  rem numeric;
begin
  select * into c from erp.concessions where id = p_id;
  select ct.head_type into ht from erp.concession_types ct where ct.id = c.type_id;
  ht := coalesce(nullif(ht, ''), 'tuition');
  rem := c.value;
  for dem in
    select d.* from erp.fee_demands d join erp.fee_heads h on h.id = d.head_id
     where d.org_id = c.org_id and d.student_id = c.student_id and d.status in ('due', 'partial') and h.type = ht
       and (c.academic_year_id is null or d.academic_year_id = c.academic_year_id)
     order by d.due_date
  loop
    if c.kind = 'percent' then
      cut := round(dem.amount * c.value / 100);
    else
      cut := least(rem, dem.amount - dem.concession - dem.paid);
      rem := rem - greatest(cut, 0);
    end if;
    cut := greatest(least(cut, dem.amount - dem.concession - dem.paid), 0);
    if cut > 0 then
      update erp.fee_demands set concession = concession + cut,
             status = case when amount - (concession + cut) + fine - paid <= 0 then (case when paid > 0 then 'paid' else 'waived' end) else status end
       where id = dem.id;
      tot := tot + cut;
    end if;
  end loop;
  update erp.concessions set amount = tot where id = p_id;
end $$;

-- ---------------------------------------------------------------- online payment (Razorpay, family portal)
-- The family never inserts a payment order: it asks for one here, and the amounts are checked against the balances.
create or replace function erp.create_payment_order(p_student uuid, p_allocations jsonb) returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_org uuid := app.current_org_id();
  v_s core.students;
  a jsonb;
  d erp.fee_demands;
  v_total numeric := 0;
  v_id uuid;
begin
  if v_org is null or not app.user_has_product(v_org, 'erp') then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into v_s from core.students s where s.id = p_student and s.org_id = v_org;
  if not found or not (p_student = any(app.my_learner_ids()) or app.can('erp', 'fees', 'create', v_org, v_s.branch_id, null)) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if jsonb_typeof(p_allocations) <> 'array' or jsonb_array_length(p_allocations) = 0 then
    raise exception 'Choose at least one fee.' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(p_allocations) x group by x->>'demand_id' having count(*) > 1) then
    raise exception 'Each fee can appear only once.' using errcode = '22023';
  end if;
  for a in select * from jsonb_array_elements(p_allocations) loop
    select * into d from erp.fee_demands where id = (a->>'demand_id')::uuid and org_id = v_org and student_id = p_student;
    if d.id is null or d.status in ('cancelled', 'waived', 'paid') then raise exception 'That fee cannot be paid.' using errcode = '22023'; end if;
    if (a->>'amount')::numeric <= 0 or (a->>'amount')::numeric > d.amount - d.concession + d.fine - d.paid then
      raise exception 'The amount is more than the balance.' using errcode = '22023';
    end if;
    v_total := v_total + (a->>'amount')::numeric;
  end loop;
  insert into erp.payment_orders (org_id, student_id, amount, allocations, gateway, status)
  values (v_org, p_student, v_total, p_allocations, 'razorpay', 'created') returning id into v_id;
  return v_id;
end $$;

-- Called by the ERP server when the gateway confirms the payment (webhook), never by a school user.
create or replace function erp.settle_payment_order(p_order uuid, p_gateway_payment_id text, p_paid_amount numeric) returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare
  o erp.payment_orders;
  v_res jsonb;
  v_receipt uuid;
begin
  select * into o from erp.payment_orders where id = p_order for update;
  if o.id is null then raise exception 'payment order not found' using errcode = '22023'; end if;
  if not app.org_has_product(o.org_id, 'erp') then raise exception 'ERP is not active for this school' using errcode = '42501'; end if;
  if o.status = 'paid' then return o.receipt_id; end if;
  if o.status <> 'created' then raise exception 'payment order is %', o.status using errcode = '22023'; end if;
  if p_paid_amount is distinct from o.amount then raise exception 'paid amount does not match the order' using errcode = '22023'; end if;
  v_res := erp.post_receipts(o.org_id, jsonb_build_object(
      'idempotency_key', 'order:' || o.id::text, 'channel', 'online', 'allocations', o.allocations,
      'payments', jsonb_build_array(jsonb_build_object('mode', 'online', 'amount', o.amount, 'gateway', o.gateway, 'gateway_payment_id', p_gateway_payment_id))),
    null, 'Online payment');
  v_receipt := (v_res->'receipt_ids'->>0)::uuid;
  update erp.payment_orders set status = 'paid', receipt_id = v_receipt where id = o.id;
  return v_receipt;
end $$;

create or replace function erp.fail_payment_order(p_order uuid) returns void
language sql volatile security definer set search_path = '' as $$
  update erp.payment_orders set status = 'failed' where id = p_order and status = 'created'
$$;

-- ---------------------------------------------------------------- CRM hand-off (OQ-16; interface only, no CRM code)
-- Admission / registration money collected in the CRM before the learner exists stays in crm.payments. When the learner is
-- admitted (core.admit_student) and ERP is on, the ERP server calls this with the CRM payment: it creates the admission fee
-- demand, one receipt in the same receipt series, and the voucher. Idempotent on (source, source_ref).
create or replace function erp.post_admission_payment(
  p_student uuid, p_amount numeric, p_mode text, p_source text, p_source_ref text,
  p_reference text default null, p_paid_on date default current_date, p_head_type text default 'admission') returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_s core.students;
  v_key text := left(coalesce(p_source, '') || ':' || coalesce(p_source_ref, ''), 200);
  v_head uuid;
  v_demand uuid;
  v_res jsonb;
begin
  if p_source is null or p_source_ref is null or p_amount is null or p_amount <= 0 then
    raise exception 'source, source_ref and a positive amount are required' using errcode = '22023';
  end if;
  if p_mode is null or p_mode not in ('cash', 'card', 'upi', 'cheque', 'dd', 'bank_transfer', 'online') then
    raise exception 'unknown payment mode' using errcode = '22023';
  end if;
  select * into v_s from core.students s where s.id = p_student;
  if not found then raise exception 'learner not found' using errcode = '22023'; end if;
  if v_s.status = 'archived' then raise exception 'learner is archived' using errcode = '22023'; end if;
  if not app.org_has_product(v_s.org_id, 'erp') then raise exception 'ERP is not active for this school' using errcode = '42501'; end if;
  -- repeated hand-off of the same CRM payment returns the earlier receipt
  select r.id into v_demand from erp.receipts r where r.org_id = v_s.org_id and r.idempotency_key = v_key and r.student_id = p_student;
  if v_demand is not null then return v_demand; end if;
  select id into v_head from erp.fee_heads where org_id = v_s.org_id and type = p_head_type and active order by created_at limit 1;
  if v_head is null then
    insert into erp.fee_heads (org_id, name, type) values (v_s.org_id, initcap(p_head_type) || ' fee', p_head_type) returning id into v_head;
  end if;
  insert into erp.fee_demands (org_id, branch_id, student_id, head_id, label, amount, due_date, note)
  values (v_s.org_id, v_s.branch_id, p_student, v_head, initcap(p_head_type) || ' fee', p_amount, p_paid_on, 'Posted from ' || p_source || ' ' || p_source_ref)
  returning id into v_demand;
  v_res := erp.post_receipts(v_s.org_id, jsonb_build_object(
      'idempotency_key', v_key, 'channel', 'import', 'date', p_paid_on, 'note', 'Posted from ' || p_source || ' ' || p_source_ref,
      'allocations', jsonb_build_array(jsonb_build_object('demand_id', v_demand, 'amount', p_amount)),
      'payments', jsonb_build_array(jsonb_build_object('mode', p_mode, 'amount', p_amount, 'reference', p_reference))),
    null, 'CRM hand-off (' || p_source || ')');
  return (v_res->'receipt_ids'->>0)::uuid;
end $$;
