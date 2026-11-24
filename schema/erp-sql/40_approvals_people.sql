-- Approval side effects, learner exit listener, restricted-data read/save functions, report cards, organisation setup.

-- ---------------------------------------------------------------- approvals (core.approval_requests is the one engine)
-- The decision itself is made in core (core.approval_requests / core.approval_actions). A decided request of type
-- linked_type = concession | refund | receipt_reversal | expense | purchase_request | purchase_order | gate_pass |
-- marks_unlock | gallery | announcement has an ERP side effect; this function applies it. It only follows a decision that
-- is already recorded (status approved / rejected) and is safe to call again: every update is conditional on the pending state.
-- (ERP source: apply_approval in 005_logic_ops.sql.)
create or replace function erp.apply_approval(p_request uuid) returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_org uuid := app.current_org_id();
  a core.approval_requests;
  v_ok boolean;
  v_otp text;
  c erp.concessions;
begin
  if v_org is null or not app.user_has_product(v_org, 'erp') or app.my_member_kind() is distinct from 'staff' then   -- a read-only support session may not apply decisions
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into a from core.approval_requests r where r.id = p_request and r.org_id = v_org;
  if not found or a.product_key <> 'erp' then raise exception 'approval request not found' using errcode = '22023'; end if;
  if a.status not in ('approved', 'rejected') then raise exception 'the request is still %', a.status using errcode = '22023'; end if;
  v_ok := a.status = 'approved';
  case a.linked_type
    when 'concession' then
      update erp.concessions set status = case when v_ok then 'approved' else 'rejected' end, approved_at = now()
       where id = a.linked_id and org_id = v_org and status = 'pending' returning * into c;
      if v_ok and c.id is not null then perform erp.apply_concession(c.id); end if;
    when 'refund' then
      update erp.refunds set status = case when v_ok then 'approved' else 'rejected' end where id = a.linked_id and org_id = v_org and status = 'pending';
    when 'receipt_reversal' then
      if v_ok and exists (select 1 from erp.receipts where id = a.linked_id and org_id = v_org and status = 'valid') then
        perform erp.reverse_receipt(a.linked_id, coalesce(a.data->>'reason', 'Approved reversal'));
      end if;
    when 'expense' then
      update erp.expenses set status = case when v_ok then 'approved' else 'rejected' end where id = a.linked_id and org_id = v_org and status = 'requested';
    when 'purchase_request' then
      update erp.purchase_requests set status = case when v_ok then 'approved' else 'rejected' end where id = a.linked_id and org_id = v_org and status = 'requested';
    when 'purchase_order' then
      update erp.purchase_orders set status = case when v_ok then 'approved' else 'cancelled' end where id = a.linked_id and org_id = v_org and status = 'draft';
    when 'gate_pass' then
      update erp.gate_passes set status = case when v_ok then 'approved' else 'rejected' end where id = a.linked_id and org_id = v_org and status = 'requested';
      if v_ok and found then
        v_otp := lpad(floor(random() * 1000000)::integer::text, 6, '0');
        insert into private.gate_pass_otps (org_id, pass_id, student_id, otp)
        select g.org_id, g.id, g.student_id, v_otp from erp.gate_passes g where g.id = a.linked_id and g.org_id = v_org
        on conflict (org_id, pass_id) do nothing;
      end if;
    when 'marks_unlock' then
      if v_ok then update erp.assessments set status = 'open' where id = a.linked_id and org_id = v_org and status in ('locked', 'published'); end if;
    when 'gallery' then
      update erp.gallery_albums set status = case when v_ok then 'approved' else 'draft' end where id = a.linked_id and org_id = v_org and status = 'pending';
    when 'announcement' then
      update erp.announcements set status = case when v_ok then 'scheduled' else 'rejected' end where id = a.linked_id and org_id = v_org and status = 'pending';
    else
      return 'nothing to apply';
  end case;
  return a.status;
end $$;

-- ---------------------------------------------------------------- learner leaves the school (ERP listener, MAP B.7)
-- core.change_student_status() only changes the status; fees, transport, hostel and the alumni record follow here.
create or replace function erp.apply_student_exit(p_student uuid, p_to text, p_date date default current_date) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_org uuid := app.current_org_id();
  v_s core.students;
begin
  select * into v_s from core.students s where s.id = p_student and s.org_id = v_org;
  if v_org is null or not found or not app.user_has_product(v_org, 'erp') or not app.can('erp', 'students', 'edit', v_org, v_s.branch_id, null) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_to not in ('withdrawn', 'alumni', 'transferred') or v_s.status <> p_to then
    raise exception 'the learner is not % (change the status with core.change_student_status first)', p_to using errcode = '22023';
  end if;
  update erp.fee_demands set status = 'cancelled', note = trim(coalesce(note, '') || ' Cancelled: student ' || p_to)
   where org_id = v_org and student_id = p_student and due_date > p_date and paid = 0 and status = 'due';
  update erp.student_transport set active = false, end_date = p_date where org_id = v_org and student_id = p_student and active;
  update erp.hostel_allocations set active = false, end_date = p_date where org_id = v_org and student_id = p_student and active;
  update core.enrolments set status = case when p_to = 'transferred' then 'transferred' else 'left' end, end_date = p_date
   where org_id = v_org and student_id = p_student and status = 'active';
  if p_to = 'alumni' then
    insert into erp.alumni_profiles (org_id, student_id, batch_year) values (v_org, p_student, extract(year from p_date)::integer)
    on conflict (org_id, student_id) do nothing;
  end if;
end $$;

-- ---------------------------------------------------------------- restricted data: read and save through functions (logged)
-- erp.student_sensitive and erp.staff_payroll have no direct table access. Health data: staff with student_sensitive.view
-- or the learner's own guardian / the learner. Payroll identity and bank data: staff with payroll.view or the person themself.
create or replace function erp.read_student_sensitive(p_student uuid) returns erp.student_sensitive
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_org uuid := app.current_org_id();
  v_s core.students;
  r erp.student_sensitive;
begin
  select * into v_s from core.students s where s.id = p_student and s.org_id = v_org;
  if v_org is null or not found or not app.user_has_product(v_org, 'erp')
     or not (p_student = any(app.my_learner_ids()) or app.can('erp', 'student_sensitive', 'view', v_org, v_s.branch_id, null)) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into r from erp.student_sensitive x where x.org_id = v_org and x.student_id = p_student;
  perform erp.log_view('student_sensitive', p_student, 'Health and statutory fields viewed');
  return r;
end $$;

create or replace function erp.save_student_sensitive(p_student uuid, p_data jsonb) returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_org uuid := app.current_org_id();
  v_s core.students;
  v_id uuid;
begin
  select * into v_s from core.students s where s.id = p_student and s.org_id = v_org;
  if v_org is null or not found or not app.user_has_product(v_org, 'erp') or not app.can('erp', 'student_sensitive', 'edit', v_org, v_s.branch_id, null) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  insert into erp.student_sensitive (org_id, student_id, medical_notes, doctor_name, doctor_phone, emergency_contact, vaccination, aadhaar_last4, cwsn, cwsn_details)
  values (v_org, p_student, p_data->>'medical_notes', p_data->>'doctor_name', p_data->>'doctor_phone', p_data->>'emergency_contact',
          p_data->>'vaccination', p_data->>'aadhaar_last4', coalesce((p_data->>'cwsn')::boolean, false), p_data->>'cwsn_details')
  on conflict (org_id, student_id) do update set
    medical_notes = excluded.medical_notes, doctor_name = excluded.doctor_name, doctor_phone = excluded.doctor_phone,
    emergency_contact = excluded.emergency_contact, vaccination = excluded.vaccination, aadhaar_last4 = excluded.aadhaar_last4,
    cwsn = excluded.cwsn, cwsn_details = excluded.cwsn_details
  returning id into v_id;
  return v_id;
end $$;

create or replace function erp.read_staff_payroll(p_staff uuid) returns erp.staff_payroll
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_org uuid := app.current_org_id();
  v_st core.staff;
  r erp.staff_payroll;
begin
  select * into v_st from core.staff s where s.id = p_staff and s.org_id = v_org;
  if v_org is null or not found or not app.user_has_product(v_org, 'erp')
     or not (p_staff = app.my_core_staff_id() or app.can('erp', 'payroll', 'view', v_org, v_st.branch_id, null)) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into r from erp.staff_payroll x where x.org_id = v_org and x.staff_id = p_staff;
  perform erp.log_view('staff_payroll', p_staff, 'Bank, tax and statutory identity viewed');
  return r;
end $$;

create or replace function erp.save_staff_payroll(p_staff uuid, p_data jsonb) returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_org uuid := app.current_org_id();
  v_st core.staff;
  v_id uuid;
begin
  select * into v_st from core.staff s where s.id = p_staff and s.org_id = v_org;
  if v_org is null or not found or not app.user_has_product(v_org, 'erp') or not app.can('erp', 'payroll', 'edit', v_org, v_st.branch_id, null) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  insert into erp.staff_payroll (org_id, staff_id, bank_name, bank_account, ifsc, pan, uan, esi_no, aadhaar_last4, tax_regime, address, emergency_contact)
  values (v_org, p_staff, p_data->>'bank_name', p_data->>'bank_account', p_data->>'ifsc', upper(p_data->>'pan'), p_data->>'uan', p_data->>'esi_no',
          p_data->>'aadhaar_last4', coalesce(p_data->>'tax_regime', 'new'), p_data->>'address', p_data->>'emergency_contact')
  on conflict (org_id, staff_id) do update set
    bank_name = excluded.bank_name, bank_account = excluded.bank_account, ifsc = excluded.ifsc, pan = excluded.pan, uan = excluded.uan,
    esi_no = excluded.esi_no, aadhaar_last4 = excluded.aadhaar_last4, tax_regime = excluded.tax_regime, address = excluded.address,
    emergency_contact = excluded.emergency_contact
  returning id into v_id;
  return v_id;
end $$;

-- ---------------------------------------------------------------- report cards, documents
-- Family (published only) and staff open a report card here so that the view is logged; the count goes up for families.
create or replace function erp.open_report_card(p_id uuid) returns erp.report_cards
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_org uuid := app.current_org_id();
  r erp.report_cards;
  v_staff boolean;
begin
  select * into r from erp.report_cards c where c.id = p_id and c.org_id = v_org;
  if v_org is null or not found or not app.user_has_product(v_org, 'erp') then raise exception 'not allowed' using errcode = '42501'; end if;
  v_staff := app.can('erp', 'marks', 'view', v_org, r.branch_id, null);
  if not v_staff and not (r.status = 'published' and r.student_id = any(app.my_learner_ids())) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not v_staff then
    update erp.report_cards set views = views + 1 where id = r.id returning * into r;
    perform erp.log_view('report_cards', p_id, 'Opened by family');
  end if;
  return r;
end $$;

-- Verification of a certificate or report card by its code. NOT granted to anon (nothing in this schema is): the public QR page
-- calls this from the ERP server. Returns only what a verifier needs.
create or replace function erp.verify_document(p_code text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select jsonb_build_object('kind', 'document', 'type', d.type, 'title', d.title, 'number', d.number, 'status', d.status,
              'issued_on', d.issued_on, 'school', o.name,
              'student', (select s.full_name from core.students s where s.id = d.student_id))
       from erp.issued_documents d join core.organizations o on o.id = d.org_id
      where d.verify_code = p_code and length(p_code) >= 10 and app.org_has_product(d.org_id, 'erp')),
    (select jsonb_build_object('kind', 'report_card', 'type', 'Report card', 'title', r.term, 'status', r.status,
              'issued_on', r.published_at::date, 'school', o.name,
              'student', (select s.full_name from core.students s where s.id = r.student_id))
       from erp.report_cards r join core.organizations o on o.id = r.org_id
      where r.verify_code = p_code and r.status = 'published' and length(p_code) >= 10 and app.org_has_product(r.org_id, 'erp')))
$$;

-- ---------------------------------------------------------------- organisation setup
-- Roles, default chart of accounts and module switches for a school that has just got ERP. Idempotent. Callable by the
-- platform (service role / platform admin) or by an admin of the school itself (setup.configure), for that school only.
create or replace function erp.setup_org(p_org uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  if not (app.is_platform_admin() or coalesce(auth.role(), '') = 'service_role'
          or (p_org = app.current_org_id() and app.user_has_product(p_org, 'erp') and app.can('erp', 'setup', 'configure', p_org, null, null))) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform erp.seed_roles(p_org);
  insert into erp.accounts (org_id, code, name, type, is_system) values
    (p_org, '1000', 'Cash in hand', 'asset', true), (p_org, '1010', 'Bank', 'asset', true), (p_org, '1100', 'Fee receivable', 'asset', true),
    (p_org, '2000', 'Caution deposits and advances', 'liability', true), (p_org, '2100', 'Payroll payable', 'liability', true),
    (p_org, '4000', 'Fee income', 'income', true), (p_org, '4100', 'Other income', 'income', true),
    (p_org, '5000', 'Salaries', 'expense', true), (p_org, '5100', 'Operating expenses', 'expense', true)
  on conflict (org_id, code) do nothing;
end $$;
