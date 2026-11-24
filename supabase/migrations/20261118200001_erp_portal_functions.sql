-- ERP portal (parent, student, driver): three functions the family screens need and the tables cannot give them.
--
-- The portal reads and writes through the Supabase Data API as the signed-in user (decision 51), so everything here is
-- security definer + search_path pinned + a caller check inside, like the other erp.* functions it sits next to.
--
--   erp.portal_directory(student)      who the family may name: class teacher, subject teachers, PTM staff, bus, driver, attendant.
--                                      core.staff is closed to families, so names come through here (names only, no phone or e-mail).
--   erp.portal_results(student)        published marks with the assessment name, subject, term and maximum. A family can read its own
--                                      assessment_results rows but not the assessment definition behind them; this joins the two
--                                      for published assessments only (what the table policy already allows, plus the labels).
--   erp.request_gate_pass(...)         an early-pickup request and its approval request in one step. The approval is what makes
--                                      erp.apply_approval issue the OTP; a family cannot create the approval row with the right
--                                      approver itself.

-- ---------------------------------------------------------------- directory
create or replace function erp.portal_directory(p_student uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_org uuid := app.current_org_id();
  s core.students;
  sec core.sections;
begin
  if v_org is null or not app.user_has_product(v_org, 'erp') or not (p_student = any(app.my_learner_ids())) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into s from core.students x where x.id = p_student and x.org_id = v_org;
  if not found then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into sec from core.sections x where x.id = s.section_id and x.org_id = v_org;
  return jsonb_build_object(
    'section', sec.name,
    'programme', (select p.name from core.programmes p where p.id = s.programme_id and p.org_id = v_org),
    'class_teacher', (select jsonb_build_object('id', st.id, 'name', st.full_name)
                        from core.staff st where st.id = sec.class_teacher_id and st.org_id = v_org and st.deleted_at is null),
    'subject_teachers', coalesce((
      select jsonb_agg(jsonb_build_object('id', x.staff_id, 'name', x.name, 'subject', x.subject) order by x.subject)
        from (select distinct st.id as staff_id, st.full_name as name, sj.name as subject
                from core.timetable_entries te
                join core.timetable_versions tv on tv.org_id = te.org_id and tv.id = te.version_id and tv.status = 'published'
                join core.staff st on st.org_id = te.org_id and st.id = te.staff_id and st.deleted_at is null
                join core.subjects sj on sj.org_id = te.org_id and sj.id = te.subject_id
               where te.org_id = v_org and te.section_id = s.section_id) x), '[]'::jsonb),
    'ptm_staff', coalesce((
      select jsonb_agg(jsonb_build_object('id', st.id, 'name', st.full_name) order by st.full_name)
        from core.staff st
       where st.org_id = v_org and st.deleted_at is null
         and st.id in (select p.staff_id from erp.ptm_slots p
                        where p.org_id = v_org and p.deleted_at is null and (p.status = 'open' or p.student_id = p_student))), '[]'::jsonb),
    'transport', (select jsonb_build_object(
                    'route_id', r.id, 'route', r.name, 'stop', sp.name, 'pickup_time', sp.pickup_time, 'drop_time', sp.drop_time,
                    'vehicle', v.reg_no,
                    'driver', (select d.full_name from core.staff d where d.id = r.driver_id and d.org_id = v_org),
                    'attendant', (select a.full_name from core.staff a where a.id = r.attendant_id and a.org_id = v_org))
                    from erp.student_transport t
                    join erp.routes r on r.org_id = t.org_id and r.id = t.route_id
                    left join erp.stops sp on sp.org_id = t.org_id and sp.id = t.stop_id
                    left join erp.vehicles v on v.org_id = r.org_id and v.id = r.vehicle_id
                   where t.org_id = v_org and t.student_id = p_student and t.active and t.deleted_at is null
                   order by t.created_at desc limit 1));
end $$;

-- ---------------------------------------------------------------- published results with labels
create or replace function erp.portal_results(p_student uuid)
returns table (assessment_id uuid, name text, term text, component text, subject text, max_marks numeric, marks numeric,
               code text, grade text, remark text, held_on date)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_org uuid := app.current_org_id();
begin
  if v_org is null or not app.user_has_product(v_org, 'erp') or not (p_student = any(app.my_learner_ids())) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return query
    select a.id, a.name, a.term, a.component, sj.name, a.max_marks, r.marks, r.code, r.grade, r.remark, a.date
      from erp.assessment_results r
      join erp.assessments a on a.org_id = r.org_id and a.id = r.assessment_id and a.deleted_at is null
      left join core.subjects sj on sj.org_id = a.org_id and sj.id = a.subject_id
     where r.org_id = v_org and r.student_id = p_student and r.deleted_at is null and a.status = 'published'
     order by a.date desc nulls last, a.name;
end $$;

-- ---------------------------------------------------------------- early pickup request + approval
create or replace function erp.request_gate_pass(
  p_student uuid, p_reason text, p_collector_name text default null, p_collector_phone text default null,
  p_pickup_person uuid default null, p_pickup_time timestamptz default null) returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_org uuid := app.current_org_id();
  s core.students;
  sec core.sections;
  v_type uuid;
  v_pass uuid;
  v_teacher_user uuid;
  v_name text;
begin
  if v_org is null or not app.user_has_product(v_org, 'erp') or not (p_student = any(app.my_learner_ids())) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if coalesce(btrim(p_reason), '') = '' then raise exception 'Please give a reason.' using errcode = '22023'; end if;
  select * into s from core.students x where x.id = p_student and x.org_id = v_org and x.status = 'active';
  if not found then raise exception 'This learner is not active.' using errcode = '22023'; end if;
  if p_pickup_person is not null and not exists (
       select 1 from erp.pickup_persons pp where pp.id = p_pickup_person and pp.org_id = v_org and pp.student_id = p_student and pp.active) then
    raise exception 'That pickup person is not registered for this learner.' using errcode = '22023';
  end if;
  select * into sec from core.sections x where x.id = s.section_id and x.org_id = v_org;

  insert into erp.gate_passes (org_id, branch_id, student_id, type, reason, collector_name, collector_phone, pickup_person_id, pickup_time, status, requested_by)
  values (v_org, s.branch_id, p_student, 'early_pickup', btrim(p_reason), nullif(btrim(p_collector_name), ''), nullif(btrim(p_collector_phone), ''),
          p_pickup_person, p_pickup_time, 'requested', app.uid())
  returning id into v_pass;

  insert into core.approval_types (org_id, key, name, product_key, is_system)
  values (v_org, 'gate_pass', 'Early pickup', 'erp', true) on conflict (org_id, key) do nothing;
  select t.id into v_type from core.approval_types t where t.org_id = v_org and t.key = 'gate_pass';
  select u.display_name into v_name from core.org_users u where u.org_id = v_org and u.user_id = app.uid();

  insert into core.approval_requests (org_id, branch_id, approval_type_id, product_key, applicant_user_id, requested_by_name, title, summary,
                                      student_id, status, pending_approver_ids, linked_type, linked_id)
  values (v_org, s.branch_id, v_type, 'erp', app.uid(), v_name, 'Early pickup: ' || s.full_name,
          btrim(p_reason) || ' | collector: ' || coalesce(nullif(btrim(p_collector_name), ''), 'registered person'),
          p_student, 'pending', case when sec.class_teacher_id is null then '{}'::uuid[] else array[sec.class_teacher_id] end, 'gate_pass', v_pass);

  select st.user_id into v_teacher_user from core.staff st where st.id = sec.class_teacher_id and st.org_id = v_org;
  perform erp.notify_user(v_org, v_teacher_user, 'gate.requested', 'Early pickup request', s.full_name || ': ' || btrim(p_reason), '/approvals');
  perform erp.notify_roles(v_org, array['principal', 'front_office'], s.branch_id, 'gate.requested', 'Early pickup request', s.full_name || ': ' || btrim(p_reason), '/gate');
  return v_pass;
end $$;

-- ---------------------------------------------------------------- grants (as the other family functions: signed-in users, each checks the caller)
revoke execute on function erp.portal_directory(uuid), erp.portal_results(uuid),
  erp.request_gate_pass(uuid, text, text, text, uuid, timestamptz) from public;
grant execute on function erp.portal_directory(uuid), erp.portal_results(uuid),
  erp.request_gate_pass(uuid, text, text, text, uuid, timestamptz) to authenticated, erp_server, service_role;
