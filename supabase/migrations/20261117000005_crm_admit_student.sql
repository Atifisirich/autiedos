-- AutoEd CRM port (5/6): core.admit_student(enquiry) - the one door from a CRM lead to a core student
-- (decision 38: core.students exists only after admission; MAP-TABLES B.7 "Admission function").
--
-- Contract
--   input    the CRM enquiry id; its stage must be flagged is_won ("Admission confirmed")
--   caller   a signed-in staff user of the enquiry's org with the CRM product and the right to edit applications
--            for that enquiry (own / team / branch / org scope as app.can decides) - ERP and OS users never need,
--            and without the CRM cannot use, this function
--   effect   in ONE transaction: match or create core.households and core.guardians (guardians are matched by phone,
--            so a sibling joins the family that already exists), create core.students (status 'admitted', no
--            admission number yet), core.student_sensitive (special needs), the core.enrolments row for the
--            enquiry's academic year, a core.student_status_events row, copy the guardians' consents to
--            core.consents (subject guardian), set the back-links crm.prospects.core_student_id,
--            crm.households.core_household_id, crm.guardians.core_guardian_id, write an audit.log event, and queue
--            an `erp` job `post_admission` when the org has the ERP (an event, never a direct write to erp.*)
--   result   jsonb {student_id, household_id, guardian_ids, created, household_matched}
--   repeat   idempotent: a second call for the same prospect returns the same student with created = false and
--            changes nothing; concurrent calls are serialised by an advisory lock on the enquiry

create or replace function core.admit_student(p_enquiry uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  e crm.enquiries;
  pr crm.prospects;
  hh crm.households;
  st crm.stages;
  v_org uuid;
  v_student uuid;
  v_core_hh uuid;
  v_matched boolean := false;
  v_programme uuid;
  v_family text;
  v_primary crm.guardians;
  v_g record;
  v_cg uuid;
  v_ids uuid[] := '{}';
  v_has_primary boolean;
begin
  select * into e from crm.enquiries x where x.id = p_enquiry;
  if not found then raise exception 'enquiry not found' using errcode = 'P0002'; end if;
  v_org := e.org_id;
  if auth.uid() is null or v_org is distinct from app.current_org_id() or not app.user_has_product(v_org, 'crm')
     or not app.can('crm', 'applications', 'edit', v_org, e.branch_id,
                    case when crm.in_my_team(v_org, e.owner_id) then auth.uid() else e.owner_id end) then
    raise exception 'not allowed to admit this student' using errcode = '42501';
  end if;
  select * into st from crm.stages s where s.org_id = v_org and s.id = e.stage_id;
  if not st.is_won then
    raise exception 'the enquiry is in stage "%", not in an admission-confirmed stage', st.name using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_enquiry::text, 0));
  select * into pr from crm.prospects x where x.org_id = v_org and x.id = e.prospect_id for update;
  select * into hh from crm.households x where x.org_id = v_org and x.id = e.household_id for update;

  -- already admitted: same answer, no changes
  if pr.core_student_id is not null and exists (select 1 from core.students s where s.org_id = v_org and s.id = pr.core_student_id and s.deleted_at is null) then
    return jsonb_build_object('student_id', pr.core_student_id, 'household_id', hh.core_household_id, 'created', false,
      'household_matched', hh.core_household_id is not null,
      'guardian_ids', coalesce((select jsonb_agg(g.core_guardian_id) from crm.guardians g where g.org_id = v_org and g.household_id = hh.id and g.core_guardian_id is not null), '[]'::jsonb));
  end if;

  -- 1. household: the family already in core (back-link, or any guardian phone), else a new one
  if hh.core_household_id is not null and exists (select 1 from core.households x where x.org_id = v_org and x.id = hh.core_household_id and x.deleted_at is null) then
    v_core_hh := hh.core_household_id;
    v_matched := true;
  else
    select cg.household_id into v_core_hh
      from crm.guardians g
      join core.guardians cg on cg.org_id = g.org_id and cg.deleted_at is null and cg.phone is not null and cg.phone in (g.phone, g.alt_phone)
     where g.org_id = v_org and g.household_id = hh.id
     order by g.is_primary desc, g.created_at limit 1;
    v_matched := v_core_hh is not null;
  end if;
  if v_core_hh is null then
    select * into v_primary from crm.guardians g where g.org_id = v_org and g.household_id = hh.id order by g.is_primary desc, g.created_at limit 1;
    v_family := nullif(btrim(regexp_replace(coalesce(v_primary.name, ''), '^.*\s', '')), '');
    insert into core.households (org_id, family_name, address, pincode, locality, phone, email, home_language)
    values (v_org, coalesce(v_family, pr.last_name), hh.address, hh.pincode, hh.locality, v_primary.phone, v_primary.email, hh.home_language)
    returning id into v_core_hh;
  end if;

  -- 2. guardians, matched by phone (unique per client in core)
  select exists (select 1 from core.guardians x where x.org_id = v_org and x.household_id = v_core_hh and x.is_primary and x.deleted_at is null) into v_has_primary;
  for v_g in select * from crm.guardians g where g.org_id = v_org and g.household_id = hh.id order by g.is_primary desc, g.created_at loop
    select x.id into v_cg from core.guardians x where x.org_id = v_org and x.phone = v_g.phone and x.deleted_at is null;
    if v_cg is null then
      insert into core.guardians (org_id, household_id, name, relation, phone, alt_phone, email, occupation, is_primary, language)
      values (v_org, v_core_hh, v_g.name, v_g.relation, v_g.phone, v_g.alt_phone, v_g.email, v_g.occupation,
              v_g.is_primary and not v_has_primary, case when v_g.language in ('en','hi','te') then v_g.language else 'en' end)
      returning id into v_cg;
      v_has_primary := v_has_primary or v_g.is_primary;
    end if;
    update crm.guardians set core_guardian_id = v_cg where id = v_g.id;
    v_ids := v_ids || v_cg;
    -- consents given to the school before admission go with the family (the CRM rows stay as the lead history)
    insert into core.consents (org_id, subject_type, guardian_id, purpose, granted, wording_version, source, granted_at, withdrawn_at, product_key)
    select c.org_id, 'guardian', v_cg, c.purpose, c.granted, c.wording_version, c.source, c.granted_at, c.withdrawn_at, 'crm'
      from core.consents c
     where c.org_id = v_org and c.subject_type = 'crm_guardian' and c.crm_contact_id = v_g.id and c.deleted_at is null
       and not exists (select 1 from core.consents d where d.org_id = v_org and d.subject_type = 'guardian' and d.guardian_id = v_cg and d.purpose = c.purpose and d.deleted_at is null);
  end loop;

  -- 3. the student (admission number comes later from the number series, status only through change_student_status)
  v_programme := coalesce(e.programme_id, (
    select p.id from core.programmes p
     where p.org_id = v_org and p.deleted_at is null and p.name = e.grade and (p.board is null or e.board is null or p.board = e.board)
       and (p.branch_id is null or p.branch_id = e.branch_id)
     order by (p.branch_id is not null) desc, (p.board = e.board) desc nulls last limit 1));
  insert into core.students (org_id, branch_id, household_id, first_name, last_name, dob, gender, status, programme_id, previous_school, crm_prospect_id)
  values (v_org, e.branch_id, v_core_hh, pr.first_name, pr.last_name, pr.dob, pr.gender, 'admitted', v_programme, pr.current_school, pr.id)
  returning id into v_student;
  if nullif(btrim(coalesce(pr.special_needs, '')), '') is not null then
    insert into core.student_sensitive (org_id, student_id, special_needs) values (v_org, v_student, btrim(pr.special_needs));
  end if;
  insert into core.enrolments (org_id, student_id, academic_year_id, programme_id, status)
  values (v_org, v_student, e.academic_year_id, v_programme, 'active')
  on conflict (org_id, student_id, academic_year_id) do nothing;
  insert into core.student_status_events (org_id, student_id, from_status, to_status, reason, actor_name)
  values (v_org, v_student, null, 'admitted', 'Admission confirmed in the CRM', (select u.display_name from core.org_users u where u.user_id = auth.uid()));

  -- 4. back-links, audit, ERP event
  update crm.prospects set core_student_id = v_student where id = pr.id;
  update crm.households set core_household_id = v_core_hh where id = hh.id;
  insert into audit.log (org_id, branch_id, actor_user_id, support_session_id, action, schema_name, table_name, row_id, detail)
  values (v_org, e.branch_id, auth.uid(), app.support_session_id(), 'crm.admit_student', 'core', 'students', v_student,
          jsonb_build_object('enquiry_id', p_enquiry, 'prospect_id', pr.id, 'household_id', v_core_hh, 'household_matched', v_matched, 'guardian_ids', to_jsonb(v_ids)));
  if app.org_has_product(v_org, 'erp') then
    insert into private.jobs (org_id, product_key, kind, payload)
    values (v_org, 'erp', 'post_admission', jsonb_build_object('student_id', v_student, 'household_id', v_core_hh, 'enquiry_id', p_enquiry));
  end if;

  return jsonb_build_object('student_id', v_student, 'household_id', v_core_hh, 'created', true, 'household_matched', v_matched, 'guardian_ids', to_jsonb(v_ids));
end $$;
