-- Gate pass handover, PTM booking, online tests, canteen/store counter, driver and attendant app.
-- Ports of verify_gate_pass, book_ptm_slot, get_test_questions, submit_test, pos_sale and driver_* (005_logic_ops.sql).
-- Family and driver users have no table access for these flows: they call these functions, which check who they are.

-- ---------------------------------------------------------------- gate pass (SAF-02)
-- The guardian sees the OTP of an approved pass for their own child; gate staff verify what the collector says.
create or replace function erp.my_gate_pass_otp(p_pass uuid) returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_org uuid := app.current_org_id();
  g erp.gate_passes;
begin
  select * into g from erp.gate_passes x where x.id = p_pass and x.org_id = v_org;
  if v_org is null or not found or not app.user_has_product(v_org, 'erp') or g.status <> 'approved'
     or not (g.student_id = any(app.my_learner_ids())) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return (select o.otp from private.gate_pass_otps o where o.org_id = v_org and o.pass_id = p_pass);
end $$;

create or replace function erp.verify_gate_pass(p_pass uuid, p_otp text) returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_org uuid := app.current_org_id();
  g erp.gate_passes;
  v_name text;
begin
  select * into g from erp.gate_passes x where x.id = p_pass and x.org_id = v_org;
  if v_org is null or not found or not app.user_has_product(v_org, 'erp') or not app.can('erp', 'gate', 'edit', v_org, g.branch_id, null) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if g.status <> 'approved' then raise exception 'This pass is % and cannot be used.', g.status using errcode = '22023'; end if;
  if not app.rate_limit_hit('gatepass:' || p_pass::text, 5, 900, v_org) then
    raise exception 'Too many tries for this pass. Ask the front office.' using errcode = '54000';
  end if;
  if not exists (select 1 from private.gate_pass_otps o where o.org_id = v_org and o.pass_id = p_pass and o.otp = btrim(p_otp)) then
    perform erp.notify_roles(v_org, array['principal', 'front_office'], g.branch_id, 'gate.wrong_otp', 'Wrong OTP at the gate',
      'A collector gave a wrong OTP. The student was not handed over.', '/gate');
    return 'mismatch';
  end if;
  update erp.gate_passes set status = 'handed_over', handed_over_at = now(), verified_by_user_id = app.uid(),
         verified_by_name = (select u.display_name from core.org_users u where u.user_id = app.uid())
   where id = p_pass;
  select s.full_name into v_name from core.students s where s.id = g.student_id;
  perform erp.notify_guardians(g.student_id, 'gate.handed_over', 'Handed over',
    v_name || ' was handed over to ' || coalesce(g.collector_name, 'the collector') || ' at ' || to_char(now() at time zone 'Asia/Kolkata', 'HH12:MI AM'), '/parent');
  return 'ok';
end $$;

-- ---------------------------------------------------------------- PTM booking (EVT-02)
create or replace function erp.book_ptm_slot(p_slot uuid, p_student uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_org uuid := app.current_org_id();
begin
  if v_org is null or not app.user_has_product(v_org, 'erp') or not (p_student = any(app.my_learner_ids())) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  update erp.ptm_slots set status = 'booked', student_id = p_student, booked_by = app.uid()
   where id = p_slot and org_id = v_org and status = 'open';
  if not found then raise exception 'That slot has just been taken. Please pick another.' using errcode = '55000'; end if;
end $$;

-- ---------------------------------------------------------------- online tests (EXM-05, EXM-06): answers never reach the student's browser
-- Questions are core.question_bank rows: content = {text, type, options, answer}.
create or replace function erp.get_test_questions(p_test uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_org uuid := app.current_org_id();
  t erp.online_tests;
begin
  select * into t from erp.online_tests x where x.id = p_test and x.org_id = v_org;
  if v_org is null or not found or not app.user_has_product(v_org, 'erp') then raise exception 'Test not found.' using errcode = '22023'; end if;
  if not (app.can('erp', 'exams', 'view', v_org, t.branch_id, null)
          or (t.status = 'live' and t.section_id = any(app.my_learner_section_ids()))) then
    raise exception 'This test is not open to you.' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', q.id, 'question', q.content->>'text', 'type', coalesce(q.content->>'type', 'mcq'),
                                        'options', q.content->'options', 'marks', coalesce(q.marks, 1))
                     order by case when t.randomise then random() else 0 end)
      from core.question_bank q
     where q.org_id = t.org_id and q.deleted_at is null and q.id in (select (x #>> '{}')::uuid from jsonb_array_elements(t.question_ids) x)), '[]'::jsonb);
end $$;

create or replace function erp.submit_test(p_test uuid, p_student uuid, p_answers jsonb, p_tab_switches integer default 0) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_org uuid := app.current_org_id();
  t erp.online_tests;
  q record;
  v_score numeric := 0;
  v_max numeric := 0;
  got numeric;
  v_an jsonb := '{}'::jsonb;
  given text;
  v_bloom text;
  v_marks numeric;
begin
  select * into t from erp.online_tests x where x.id = p_test and x.org_id = v_org;
  if v_org is null or not found or t.status <> 'live' or not app.user_has_product(v_org, 'erp') then
    raise exception 'This test is not open.' using errcode = '22023';
  end if;
  if not (p_student = any(app.my_learner_ids())) then raise exception 'Not allowed.' using errcode = '42501'; end if;
  if exists (select 1 from erp.test_attempts a where a.org_id = v_org and a.test_id = p_test and a.student_id = p_student and a.submitted_at is not null) then
    raise exception 'You have already submitted this test.' using errcode = '22023';
  end if;
  for q in select * from core.question_bank where org_id = t.org_id and id in (select (x #>> '{}')::uuid from jsonb_array_elements(t.question_ids) x) loop
    given := lower(btrim(coalesce(p_answers->>(q.id::text), '')));
    v_marks := coalesce(q.marks, 1);
    v_bloom := coalesce(q.bloom, 'understand');
    got := case when coalesce(q.content->>'type', 'mcq') in ('mcq', 'true_false', 'short') and given <> ''
                 and given = lower(btrim(coalesce(q.content->>'answer', ''))) then v_marks else 0 end;
    v_score := v_score + got;
    v_max := v_max + v_marks;
    v_an := jsonb_set(v_an, array[v_bloom], jsonb_build_object(
      'score', coalesce((v_an->v_bloom->>'score')::numeric, 0) + got, 'max', coalesce((v_an->v_bloom->>'max')::numeric, 0) + v_marks));
  end loop;
  insert into erp.test_attempts (org_id, test_id, student_id, answers, score, max_score, submitted_at, tab_switches, analysis)
  values (v_org, p_test, p_student, p_answers, v_score, v_max, now(), coalesce(p_tab_switches, 0), v_an)
  on conflict (org_id, test_id, student_id) do update set answers = excluded.answers, score = excluded.score, max_score = excluded.max_score,
    submitted_at = now(), tab_switches = excluded.tab_switches, analysis = excluded.analysis;
  -- marks of an assessment are written only while it is still open for entry (locked and published marks never change)
  if t.assessment_id is not null and erp.assessment_status(v_org, t.assessment_id) in ('open', 'submitted') then
    insert into erp.assessment_results (org_id, assessment_id, student_id, marks) values (v_org, t.assessment_id, p_student, v_score)
    on conflict (org_id, assessment_id, student_id) do update set marks = excluded.marks;
  end if;
  return jsonb_build_object('score', v_score, 'max', v_max);
end $$;

-- ---------------------------------------------------------------- store and canteen counter, wallet (CAN-01, CAN-02)
-- p = { counter, student_id, payment_mode, lines: [{item_id, qty, price, variant?}] }
create or replace function erp.pos_sale(p jsonb) returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_org uuid := app.current_org_id();
  w erp.student_wallets;
  v_total numeric;
  v_today numeric;
  l jsonb;
  v_id uuid;
  v_student uuid := nullif(p->>'student_id', '')::uuid;
  v_mode text := coalesce(p->>'payment_mode', 'wallet');
  blocked text;
begin
  if v_org is null or not app.user_has_product(v_org, 'erp') or not app.can('erp', 'inventory', 'create', v_org, null, null) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select coalesce(sum((x->>'qty')::numeric * (x->>'price')::numeric), 0) into v_total from jsonb_array_elements(p->'lines') x;
  if v_total <= 0 then raise exception 'Add at least one item.' using errcode = '22023'; end if;
  if v_mode = 'wallet' then
    select * into w from erp.student_wallets x where x.student_id = v_student and x.org_id = v_org for update;
    if w.id is null or not w.active then raise exception 'This student has no active wallet.' using errcode = '22023'; end if;
    for l in select * from jsonb_array_elements(p->'lines') loop
      select i.name into blocked from erp.items i
       where i.id = (l->>'item_id')::uuid and i.org_id = v_org and (',' || lower(coalesce(w.blocked_items, '')) || ',') like '%,' || lower(i.name) || ',%';
      if blocked is not null then raise exception '% is blocked by the parent for this student.', blocked using errcode = '22023'; end if;
    end loop;
    if w.balance < v_total then raise exception 'Wallet balance is Rs % but the bill is Rs %.', w.balance, v_total using errcode = '22023'; end if;
    select coalesce(sum(t.amount), 0) into v_today from erp.student_wallet_txns t where t.wallet_id = w.id and t.type = 'purchase' and t.at::date = current_date;
    if w.daily_limit is not null and v_today + v_total > w.daily_limit then
      raise exception 'This goes over the daily spend limit of Rs % set by the parent.', w.daily_limit using errcode = '22023';
    end if;
    update erp.student_wallets set balance = balance - v_total where id = w.id;
    insert into erp.student_wallet_txns (org_id, wallet_id, student_id, type, amount, note)
    values (v_org, w.id, v_student, 'purchase', v_total, coalesce(p->>'counter', 'canteen') || ' purchase');
  end if;
  insert into erp.sales (org_id, branch_id, counter, student_id, lines, total, payment_mode, sold_by_user_id, sold_by_name)
  values (v_org, erp.my_branch_id(), coalesce(p->>'counter', 'canteen'), v_student, p->'lines', v_total, v_mode, app.uid(),
          (select u.display_name from core.org_users u where u.user_id = app.uid())) returning id into v_id;
  insert into erp.stock_movements (org_id, branch_id, item_id, qty, type, ref, variant)
  select v_org, erp.my_branch_id(), (x->>'item_id')::uuid, -(x->>'qty')::numeric, 'sale', v_id::text, x->>'variant'
    from jsonb_array_elements(p->'lines') x where x->>'item_id' is not null;
  return v_id;
end $$;

-- Top-up (or adjustment) of a learner's wallet at the counter; the gateway top-up is posted by the server with the same function.
create or replace function erp.wallet_topup(p_student uuid, p_amount numeric, p_ref text default null, p_type text default 'topup') returns numeric
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_org uuid := app.current_org_id();
  w erp.student_wallets;
begin
  if v_org is null or not app.user_has_product(v_org, 'erp') or not app.can('erp', 'canteen', 'create', v_org, null, null) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_amount is null or p_amount <= 0 or p_type not in ('topup', 'refund', 'adjust') then raise exception 'invalid top-up' using errcode = '22023'; end if;
  if not exists (select 1 from core.students s where s.id = p_student and s.org_id = v_org) then raise exception 'learner not found' using errcode = '22023'; end if;
  insert into erp.student_wallets (org_id, student_id) values (v_org, p_student) on conflict (org_id, student_id) do nothing;
  select * into w from erp.student_wallets x where x.org_id = v_org and x.student_id = p_student for update;
  update erp.student_wallets set balance = balance + p_amount where id = w.id returning * into w;
  insert into erp.student_wallet_txns (org_id, wallet_id, student_id, type, amount, ref) values (v_org, w.id, p_student, p_type, p_amount, p_ref);
  return w.balance;
end $$;

-- ---------------------------------------------------------------- driver and attendant app (TR-04): no table access, only these actions
create or replace function erp.route_ok(p_route uuid) returns boolean
language plpgsql stable security definer set search_path = '' as $$
begin
  return exists (select 1 from erp.routes r
                  where r.id = p_route and r.org_id = app.current_org_id() and app.user_has_product(r.org_id, 'erp')
                    and (app.can('erp', 'transport', 'edit', r.org_id, r.branch_id, null)
                         or r.driver_id = app.my_core_staff_id() or r.attendant_id = app.my_core_staff_id()));
end $$;

create or replace function erp.driver_routes() returns table (id uuid, name text, vehicle text, running_trip uuid)
language plpgsql stable security definer set search_path = '' as $$
begin
  return query
    select r.id, r.name, v.reg_no,
           (select t.id from erp.trips t where t.route_id = r.id and t.status = 'running' order by t.started_at desc limit 1)
      from erp.routes r left join erp.vehicles v on v.id = r.vehicle_id and v.org_id = r.org_id
     where r.org_id = app.current_org_id() and r.active and erp.route_ok(r.id) order by r.name;
end $$;

create or replace function erp.driver_trip_start(p_route uuid, p_direction text default 'pickup') returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_id uuid;
  r erp.routes;
begin
  if not erp.route_ok(p_route) then raise exception 'This route is not assigned to you.' using errcode = '42501'; end if;
  if p_direction not in ('pickup', 'drop', 'special') then raise exception 'unknown direction' using errcode = '22023'; end if;
  select * into r from erp.routes where id = p_route;
  select id into v_id from erp.trips where org_id = r.org_id and route_id = p_route and status = 'running' limit 1;
  if v_id is not null then return v_id; end if;
  insert into erp.trips (org_id, branch_id, route_id, direction) values (r.org_id, r.branch_id, p_route, p_direction) returning id into v_id;
  insert into core.notifications (org_id, user_id, product_key, event_key, title, body, link)
  select distinct r.org_id, g.user_id, 'erp', 'transport.trip_started', 'Bus started', r.name || ' has started its ' || p_direction || ' trip.', '/parent/bus'
    from erp.student_transport st
    join core.students s on s.org_id = st.org_id and s.id = st.student_id
    join core.guardians g on g.org_id = s.org_id and g.household_id = s.household_id
   where st.org_id = r.org_id and st.route_id = p_route and st.active and g.user_id is not null;
  return v_id;
end $$;

create or replace function erp.driver_trip_students(p_trip uuid) returns table (student_id uuid, name text, stop text, sort integer, last_event text)
language plpgsql stable security definer set search_path = '' as $$
begin
  return query
    select s.id, s.full_name, sp.name, coalesce(sp.sort, 0),
           (select e.type from erp.trip_events e where e.org_id = t.org_id and e.trip_id = t.id and e.student_id = s.id order by e.at desc limit 1)
      from erp.trips t
      join erp.student_transport st on st.org_id = t.org_id and st.route_id = t.route_id and st.active
      join core.students s on s.org_id = st.org_id and s.id = st.student_id and s.status = 'active'
      left join erp.stops sp on sp.org_id = st.org_id and sp.id = st.stop_id
     where t.id = p_trip and t.org_id = app.current_org_id() and erp.route_ok(t.route_id)
     order by 4, 2;
end $$;

create or replace function erp.driver_mark(p_trip uuid, p_student uuid, p_type text, p_lat numeric default null, p_lng numeric default null, p_note text default null)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare
  t erp.trips;
  v_name text;
begin
  select * into t from erp.trips where id = p_trip and org_id = app.current_org_id();
  if t.id is null or not erp.route_ok(t.route_id) then raise exception 'This trip is not assigned to you.' using errcode = '42501'; end if;
  if p_type not in ('boarded', 'dropped', 'absent', 'sos', 'delay') then raise exception 'Unknown event.' using errcode = '22023'; end if;
  if p_student is not null and not exists (select 1 from erp.student_transport st where st.org_id = t.org_id and st.route_id = t.route_id and st.student_id = p_student and st.active) then
    raise exception 'That student is not on this route.' using errcode = '22023';
  end if;
  insert into erp.trip_events (org_id, trip_id, student_id, type, lat, lng, note) values (t.org_id, p_trip, p_student, p_type, p_lat, p_lng, p_note);
  if p_type in ('boarded', 'dropped') and p_student is not null then
    select s.full_name into v_name from core.students s where s.id = p_student;
    perform erp.notify_guardians(p_student, 'transport.' || p_type, v_name || ' ' || p_type, 'At ' || to_char(now() at time zone 'Asia/Kolkata', 'HH12:MI AM'), '/parent/bus');
  elsif p_type = 'sos' then
    perform erp.notify_roles(t.org_id, array['transport', 'principal', 'group_admin'], t.branch_id, 'transport.sos', 'SOS from a bus', coalesce(p_note, 'The driver pressed SOS.'), '/transport/live');
  elsif p_type = 'delay' then
    update erp.trips set delay_minutes = coalesce(nullif(p_note, '')::integer, 15) where id = p_trip;
    insert into core.notifications (org_id, user_id, product_key, event_key, title, body, link)
    select distinct t.org_id, g.user_id, 'erp', 'transport.delay', 'Bus running late',
           'Your bus is running about ' || coalesce(nullif(p_note, ''), '15') || ' minutes late.', '/parent/bus'
      from erp.student_transport st
      join core.students s on s.org_id = st.org_id and s.id = st.student_id
      join core.guardians g on g.org_id = s.org_id and g.household_id = s.household_id
     where st.org_id = t.org_id and st.route_id = t.route_id and st.active and g.user_id is not null;
    perform erp.notify_roles(t.org_id, array['transport'], t.branch_id, 'transport.delay', 'Bus delay reported', null, '/transport/live');
  end if;
end $$;

create or replace function erp.driver_position(p_trip uuid, p_lat numeric, p_lng numeric, p_speed numeric default null) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  t erp.trips;
begin
  select * into t from erp.trips where id = p_trip and org_id = app.current_org_id() and status = 'running';
  if t.id is null or not erp.route_ok(t.route_id) then return; end if;
  update erp.trips set last_lat = p_lat, last_lng = p_lng, last_speed = p_speed, last_at = now() where id = p_trip;
  insert into erp.trip_positions (org_id, trip_id, lat, lng, speed) values (t.org_id, p_trip, p_lat, p_lng, p_speed);
  if coalesce(p_speed, 0) > 60 and not exists (select 1 from erp.trip_events e where e.org_id = t.org_id and e.trip_id = p_trip and e.type = 'overspeed' and e.at > now() - interval '5 minutes') then
    insert into erp.trip_events (org_id, trip_id, type, lat, lng, note) values (t.org_id, p_trip, 'overspeed', p_lat, p_lng, round(p_speed) || ' km/h');
    perform erp.notify_roles(t.org_id, array['transport'], t.branch_id, 'transport.overspeed', 'Over-speed alert', round(p_speed) || ' km/h', '/transport/live');
  end if;
end $$;

create or replace function erp.driver_trip_end(p_trip uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  t erp.trips;
begin
  select * into t from erp.trips where id = p_trip and org_id = app.current_org_id();
  if t.id is null or not erp.route_ok(t.route_id) then raise exception 'This trip is not assigned to you.' using errcode = '42501'; end if;
  update erp.trips set status = 'completed', ended_at = now() where id = p_trip;
end $$;
