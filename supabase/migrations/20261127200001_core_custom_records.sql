-- Custom records engine (decisions 56-59; docs/custom-records.md, docs/adr/custom-records.md).
--
-- 500 schools making 500 custom things ("Hostel visitor log", "Sports Day equipment checklist", "Library late-return
-- register") never need a migration or a new table: an object is a typed definition (core.custom_objects) and its rows
-- live in one shared table (core.custom_records, data jsonb), with their history in core.custom_record_events.
--
--   * Definitions are validated here (fields, types, permissions, states, portal, schedule): the AI designer and the
--     settings screen are held to the same rules, and a bad definition never reaches the table.
--   * Records are validated here too (types, required, choices, unique, link targets in the same org), whoever writes.
--   * RLS: org isolation + product entitlement (the owning product, or any product for 'core') + per-object role
--     permissions evaluated in SQL (app.custom_record_can). Families see a record only when the object turns portal
--     visibility on, and then only rows whose learner link field is one of their own learners. Off by default.
--   * State changes go through core.custom_record_transition (optionally via core approvals); a request role can
--     never write `state` directly.
--   * Reminders: app.custom_records_enqueue_reminders / private.claim_record_jobs / app.custom_records_deliver_reminder,
--     executable by job_runner only, for orgs that still have the owning product.
--   * Compliance: person and learner link fields are copied to staff_ids / learner_ids by the validation trigger,
--     so core.pii_registry can find a person's records (export and erasure through the compliance tooling).

-- ---------------------------------------------------------------- modules
-- 'records' in every product: records.configure (or setup.configure) = management of objects; records.view/create/
-- edit/delete/export through a product role = access to every object of that product (admins with '*' get it).
insert into core.product_modules (product_key, module_key, name)
select p.key, 'records', 'Custom records' from core.products p where p.key in ('crm','os','erp')
on conflict do nothing;

-- ---------------------------------------------------------------- tables
create table core.custom_objects (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  product_key text not null default 'core' check (product_key in ('core','crm','os','erp')),
  key text not null check (key ~ '^[a-z][a-z0-9_]{1,39}$'),
  label_singular text not null check (length(btrim(label_singular)) between 1 and 80),
  label_plural text not null check (length(btrim(label_plural)) between 1 and 80),
  labels_i18n jsonb not null default '{}',          -- {"hi": {"singular": "...", "plural": "..."}, "te": {...}}
  description text,
  icon text not null default 'list' check (icon ~ '^[a-z][a-z0-9_-]{0,30}$'),
  fields jsonb not null default '[]',               -- [{key, label, type, required, unique, default, options, help, min, max, max_length}]
  title_field text,                                  -- field shown as the record's title
  list_columns text[] not null default '{}',
  form_layout jsonb,                                 -- [{title, fields: [key, ...]}] or null (fields in order)
  permissions jsonb not null default '[]',           -- [{who: all_staff|role, product?, role?, view, create, edit, delete, export}]
  states jsonb,                                      -- {list: [{key, label, final?}], initial, transitions: [{from, to, label, approval, approver_roles}]}
  portal jsonb not null default '{"enabled": false}',-- {enabled, learner_field}
  schedule jsonb,                                    -- {reminder: {date_field, days_before}}
  archived boolean not null default false,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  created_by uuid default app.uid(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (org_id, id),
  unique (org_id, key)
);
create index custom_objects_product on core.custom_objects(org_id, product_key, archived);
create trigger trg_touch before update on core.custom_objects for each row execute function app.touch_updated_at();

create table core.custom_records (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  branch_id uuid,
  object_id uuid not null,
  data jsonb not null default '{}',
  state text,
  pending_state text,
  pending_approval_id uuid,                          -- core.approval_requests.id while a state change waits (no FK: set by functions)
  owner_id uuid default app.uid(),                   -- auth user who owns the row ("own" permissions)
  staff_ids uuid[] not null default '{}',            -- person link fields (core.staff ids), kept by the validation trigger
  learner_ids uuid[] not null default '{}',          -- learner link fields (core.students ids), kept by the validation trigger
  created_at timestamptz not null default now(),
  created_by uuid default app.uid(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (org_id, id),
  foreign key (org_id, branch_id) references core.branches(org_id, id),
  foreign key (org_id, object_id) references core.custom_objects(org_id, id) on delete cascade
);
create index custom_records_object on core.custom_records(org_id, object_id, created_at desc);
create index custom_records_branch on core.custom_records(org_id, branch_id);
create index custom_records_owner on core.custom_records(org_id, owner_id);
create index custom_records_state on core.custom_records(org_id, object_id, state);
create index custom_records_data on core.custom_records using gin (data jsonb_path_ops);
create index custom_records_learners on core.custom_records using gin (learner_ids);
create index custom_records_staff on core.custom_records using gin (staff_ids);
create trigger trg_touch before update on core.custom_records for each row execute function app.touch_updated_at();

create table core.custom_record_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  object_id uuid not null,
  record_id uuid,                                    -- null for object-level events (export)
  kind text not null check (kind in ('created','updated','state','approval_requested','approved','rejected','deleted','restored','exported')),
  from_state text,
  to_state text,
  changes jsonb,                                     -- {field: {from, to}}; scrubbed when the record is erased
  note text,
  actor_user_id uuid default app.uid(),
  created_at timestamptz not null default now(),
  created_by uuid default app.uid(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (org_id, id),
  foreign key (org_id, object_id) references core.custom_objects(org_id, id) on delete cascade,
  foreign key (org_id, record_id) references core.custom_records(org_id, id) on delete cascade
);
create index custom_record_events_object on core.custom_record_events(org_id, object_id, created_at desc);
create index custom_record_events_record on core.custom_record_events(org_id, record_id, created_at);
create trigger trg_touch before update on core.custom_record_events for each row execute function app.touch_updated_at();

grant select, insert, update, delete on core.custom_objects, core.custom_records to authenticated, crm_server, os_server, erp_server;
grant select on core.custom_record_events to authenticated, crm_server, os_server, erp_server;
grant select on core.custom_objects, core.custom_records, core.custom_record_events to platform_admin_server;

-- ---------------------------------------------------------------- helpers
-- A request comes from one of the request roles (set local role, or a real login). Works inside security definer
-- functions, where current_user is the owner but the role setting / session user still name the caller.
create or replace function app.custom_records_is_request() returns boolean
language sql stable set search_path = '' as $$
  select coalesce(nullif(current_setting('role', true), 'none'), session_user::text)
         in ('authenticated','anon','crm_server','os_server','erp_server','platform_admin_server','job_runner')
$$;

-- The owning product is on for the signed-in user ('core' = any product of the org).
create or replace function app.custom_records_user_has(p_org uuid, p_product text) returns boolean
language sql stable security definer set search_path = '' as $$
  select case when p_product = 'core' then app.user_has_any_product(p_org) else app.user_has_product(p_org, p_product) end
$$;

-- Management of objects: records.configure or setup.configure in the owning product (any product for 'core').
create or replace function app.custom_records_can_manage(p_org uuid, p_product text) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_org is not null and p_org = app.current_org_id()
     and app.my_member_kind() in ('staff','support')
     and app.custom_records_user_has(p_org, p_product)
     and exists (select 1 from core.products p where p.active and (p_product = 'core' or p.key = p_product)
                  and (app.can(p.key, 'records', 'configure', p_org) or app.can(p.key, 'setup', 'configure', p_org)))
$$;

-- Access level of the signed-in staff member to an object for one action: 'all', 'own' or null.
-- Management and holders of records.<action> get 'all'; otherwise the object's permission rules decide
-- (who = all_staff, or a product role key). create -> 'own' (the creator owns the row); export -> 'all'.
create or replace function app.custom_record_level_of(o core.custom_objects, p_action text) returns text
language plpgsql stable security definer set search_path = '' as $$
declare
  v_kind text := app.my_member_kind();
  v_rank integer := 0;
  r jsonb;
  v text;
begin
  if p_action is null or p_action not in ('view','create','edit','delete','export') then return null; end if;
  if v_kind is null or v_kind not in ('staff','support') then return null; end if;
  if o.id is null or o.org_id is distinct from app.current_org_id() or o.deleted_at is not null then return null; end if;
  if not app.custom_records_user_has(o.org_id, o.product_key) then return null; end if;
  if exists (select 1 from core.products p where p.active and (o.product_key = 'core' or p.key = o.product_key)
              and (app.can(p.key, 'records', p_action, o.org_id) or app.can(p.key, 'records', 'configure', o.org_id)
                   or app.can(p.key, 'setup', 'configure', o.org_id))) then
    if o.archived and p_action <> 'view' and p_action <> 'export' then return null; end if;
    return 'all';
  end if;
  if o.archived or v_kind <> 'staff' then return null; end if;
  for r in select x from jsonb_array_elements(o.permissions) x loop
    if (r->>'who' = 'all_staff')
       or (r->>'who' = 'role' and (o.product_key = 'core' or r->>'product' = o.product_key)
           and app.user_has_product(o.org_id, r->>'product')
           and exists (select 1 from core.user_product_access a
                        where a.user_id = app.uid() and a.org_id = o.org_id and a.product_key = r->>'product'
                          and a.role_key = r->>'role' and a.revoked_at is null)) then
      v := case p_action
             when 'create' then case when r->'create' = 'true'::jsonb then 'own' end
             when 'export' then case when r->'export' = 'true'::jsonb then 'all' end
             else r->>p_action end;
      v_rank := greatest(v_rank, case v when 'all' then 2 when 'own' then 1 else 0 end);
    end if;
  end loop;
  return case v_rank when 2 then 'all' when 1 then 'own' end;
end $$;

create or replace function app.custom_record_level(p_object uuid, p_action text) returns text
language sql stable security definer set search_path = '' as $$
  select app.custom_record_level_of(o, p_action) from core.custom_objects o where o.id = p_object and o.org_id = app.current_org_id()
$$;

-- Row check used by the policies. Families: view only, portal on, the learner link field is one of their learners.
create or replace function app.custom_record_can(p_object uuid, p_action text, p_branch uuid, p_owner uuid, p_data jsonb) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  o core.custom_objects;
  v_kind text := app.my_member_kind();
  v_level text;
  v_learner uuid;
begin
  if v_kind in ('guardian','parent','student') then
    if p_action <> 'view' then return false; end if;
    select * into o from core.custom_objects x
     where x.id = p_object and x.org_id = app.current_org_id() and x.deleted_at is null and not x.archived;
    if not found or o.portal->'enabled' is distinct from 'true'::jsonb or not app.custom_records_user_has(o.org_id, o.product_key) then
      return false;
    end if;
    v_learner := app.try_uuid(p_data->>(o.portal->>'learner_field'));
    return v_learner is not null and v_learner = any(app.my_learner_ids());
  end if;
  if p_branch is not null and not (p_branch = any(app.user_branch_ids())) then return false; end if;
  v_level := app.custom_record_level(p_object, p_action);
  return v_level = 'all' or (v_level = 'own' and p_owner is not null and p_owner = app.uid());
end $$;

-- Is the object definition visible: management, any view/create access, or (families) portal visibility.
-- Takes the row (not its id): the select policy also checks rows just inserted (insert ... returning).
create or replace function app.custom_object_visible(o core.custom_objects) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  v_kind text := app.my_member_kind();
begin
  if o.org_id is distinct from app.current_org_id() or not app.custom_records_user_has(o.org_id, o.product_key) then return false; end if;
  if v_kind in ('guardian','parent','student') then
    return o.deleted_at is null and not o.archived and o.portal->'enabled' = 'true'::jsonb;
  end if;
  if app.custom_records_can_manage(o.org_id, o.product_key) then return true; end if;
  return o.deleted_at is null and (app.custom_record_level_of(o, 'view') is not null or app.custom_record_level_of(o, 'create') is not null);
end $$;

-- Event rows follow their record (or, for object events, management of the object).
create or replace function app.custom_record_event_visible(p_object uuid, p_record uuid) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  r core.custom_records;
  v_product text;
begin
  if p_record is null then
    select product_key into v_product from core.custom_objects where id = p_object and org_id = app.current_org_id();
    return v_product is not null and app.custom_records_can_manage(app.current_org_id(), v_product);
  end if;
  select * into r from core.custom_records x where x.id = p_record and x.org_id = app.current_org_id();
  if not found then return false; end if;
  if app.my_member_kind() not in ('staff','support') then return false; end if;  -- families see the record, not its history
  return app.custom_record_can(r.object_id, 'view', r.branch_id, r.owner_id, r.data);
end $$;

-- ---------------------------------------------------------------- definition validation
create or replace function app.custom_object_problems(o core.custom_objects) returns text[]
language plpgsql stable set search_path = '' as $$
declare
  types constant text[] := array['text','long_text','number','money','date','datetime','yes_no','choice','multi_choice',
                                 'person','learner','section','branch','file','phone','email','url'];
  p text[] := '{}';
  f jsonb;
  r jsonb;
  t jsonb;
  keys text[] := '{}';
  states text[] := '{}';
  k text;
  v_type text;
begin
  if jsonb_typeof(o.fields) <> 'array' then return array['fields must be a list']; end if;
  if jsonb_array_length(o.fields) = 0 then p := p || 'add at least one field'; end if;
  if jsonb_array_length(o.fields) > 100 then p := p || 'at most 100 fields'; end if;
  for f in select x from jsonb_array_elements(o.fields) x loop
    if jsonb_typeof(f) <> 'object' then p := p || 'each field must be an object'; continue; end if;
    k := f->>'key';
    v_type := f->>'type';
    if k is null or k !~ '^[a-z][a-z0-9_]{0,39}$' then p := p || format('field key %s: use lower-case letters, digits and _', coalesce(k, '(empty)')); continue; end if;
    if k = any(keys) then p := p || format('field %s appears twice', k); end if;
    keys := keys || k;
    if coalesce(btrim(f->>'label'), '') = '' or length(f->>'label') > 120 then p := p || format('field %s: label is required (120 characters at most)', k); end if;
    if v_type is null or not (v_type = any(types)) then p := p || format('field %s: unknown type %s', k, coalesce(v_type, '(empty)')); continue; end if;
    if f ? 'required' and jsonb_typeof(f->'required') <> 'boolean' then p := p || format('field %s: required must be true or false', k); end if;
    if f ? 'unique' and jsonb_typeof(f->'unique') <> 'boolean' then p := p || format('field %s: unique must be true or false', k); end if;
    if f->'unique' = 'true'::jsonb and v_type in ('long_text','yes_no','multi_choice','file') then p := p || format('field %s: a %s field cannot be unique', k, v_type); end if;
    if v_type in ('choice','multi_choice') then
      if jsonb_typeof(f->'options') is distinct from 'array' or jsonb_array_length(f->'options') = 0 then
        p := p || format('field %s: give the choices', k);
      elsif exists (select 1 from jsonb_array_elements(f->'options') x where jsonb_typeof(x) <> 'string' or btrim(x #>> '{}') = '') then
        p := p || format('field %s: every choice must be text', k);
      elsif (select count(*) <> count(distinct x #>> '{}') from jsonb_array_elements(f->'options') x) then
        p := p || format('field %s: a choice appears twice', k);
      end if;
    elsif f ? 'options' and f->'options' <> 'null'::jsonb then
      p := p || format('field %s: only choice fields have choices', k);
    end if;
    if f ? 'min' and f->'min' <> 'null'::jsonb and jsonb_typeof(f->'min') <> 'number' then p := p || format('field %s: min must be a number', k); end if;
    if f ? 'max' and f->'max' <> 'null'::jsonb and jsonb_typeof(f->'max') <> 'number' then p := p || format('field %s: max must be a number', k); end if;
    if f ? 'max_length' and f->'max_length' <> 'null'::jsonb and (jsonb_typeof(f->'max_length') <> 'number' or (f->>'max_length')::numeric not between 1 and 10000) then
      p := p || format('field %s: max_length must be 1..10000', k);
    end if;
    if f ? 'default' and f->'default' <> 'null'::jsonb then
      if v_type in ('person','learner','section','branch','file') and not (v_type = 'person' and f->>'default' = 'me') then
        p := p || format('field %s: a link field has no default (except "me" for a person)', k);
      elsif v_type = 'yes_no' and jsonb_typeof(f->'default') <> 'boolean' then p := p || format('field %s: default must be yes or no', k);
      elsif v_type in ('number','money') and jsonb_typeof(f->'default') <> 'number' then p := p || format('field %s: default must be a number', k);
      elsif v_type = 'choice' and not (f->'options' @> jsonb_build_array(f->'default')) then p := p || format('field %s: default must be one of the choices', k);
      elsif v_type = 'date' and f->>'default' <> 'today' and app.custom_records_date(f->>'default') is null then p := p || format('field %s: default must be a date or "today"', k);
      elsif v_type = 'datetime' and f->>'default' <> 'now' then p := p || format('field %s: default must be "now"', k);
      end if;
    end if;
  end loop;

  if o.title_field is not null and not (o.title_field = any(keys)) then p := p || format('title field %s is not a field', o.title_field); end if;
  foreach k in array coalesce(o.list_columns, '{}') loop
    if not (k = any(keys) or k in ('state','created_at','updated_at','owner')) then p := p || format('list column %s is not a field', k); end if;
  end loop;
  if o.form_layout is not null and o.form_layout <> 'null'::jsonb then
    if jsonb_typeof(o.form_layout) <> 'array' then p := p || 'form layout must be a list of sections';
    else
      for r in select x from jsonb_array_elements(o.form_layout) x loop
        if jsonb_typeof(r->'fields') is distinct from 'array' then p := p || 'each form section needs a list of fields'; continue; end if;
        for k in select x #>> '{}' from jsonb_array_elements(r->'fields') x loop
          if not (k = any(keys)) then p := p || format('form layout: %s is not a field', k); end if;
        end loop;
      end loop;
    end if;
  end if;

  if jsonb_typeof(o.permissions) <> 'array' then p := p || 'permissions must be a list';
  else
    for r in select x from jsonb_array_elements(o.permissions) x loop
      if r->>'who' not in ('all_staff','role') then p := p || 'permission: who must be all_staff or role'; continue; end if;
      if r->>'who' = 'role' and (coalesce(r->>'product', '') not in ('crm','os','erp') or coalesce(r->>'role', '') !~ '^[a-z][a-z0-9_]*$') then
        p := p || 'permission: a role rule needs a product (crm, os, erp) and a role key';
      end if;
      if r->>'who' = 'role' and o.product_key <> 'core' and r->>'product' <> o.product_key then
        p := p || format('permission: role %s:%s is not a role of the owning product %s', r->>'product', r->>'role', o.product_key);
      end if;
      foreach k in array array['view','edit','delete'] loop
        if r ? k and r->>k not in ('all','own','none') then p := p || format('permission %s must be all, own or none', k); end if;
      end loop;
      foreach k in array array['create','export'] loop
        if r ? k and jsonb_typeof(r->k) <> 'boolean' then p := p || format('permission %s must be true or false', k); end if;
      end loop;
    end loop;
  end if;

  if o.states is not null and o.states <> 'null'::jsonb then
    if jsonb_typeof(o.states->'list') is distinct from 'array' or jsonb_array_length(o.states->'list') < 2 then
      p := p || 'a workflow needs at least two states';
    else
      for r in select x from jsonb_array_elements(o.states->'list') x loop
        k := r->>'key';
        if k is null or k !~ '^[a-z][a-z0-9_]{0,39}$' then p := p || format('state key %s: use lower-case letters, digits and _', coalesce(k, '(empty)')); continue; end if;
        if k = any(states) then p := p || format('state %s appears twice', k); end if;
        if coalesce(btrim(r->>'label'), '') = '' then p := p || format('state %s needs a label', k); end if;
        states := states || k;
      end loop;
      if not (coalesce(o.states->>'initial', '') = any(states)) then p := p || 'the first state must be one of the states'; end if;
      if o.states ? 'transitions' and jsonb_typeof(o.states->'transitions') <> 'array' then p := p || 'transitions must be a list';
      else
        for t in select x from jsonb_array_elements(coalesce(o.states->'transitions', '[]')) x loop
          if not (coalesce(t->>'from', '') = any(states)) or not (coalesce(t->>'to', '') = any(states)) or t->>'from' = t->>'to' then
            p := p || format('transition %s -> %s: both must be different states', coalesce(t->>'from', '?'), coalesce(t->>'to', '?'));
          end if;
          if t ? 'approval' and jsonb_typeof(t->'approval') <> 'boolean' then p := p || 'transition approval must be true or false'; end if;
          if t ? 'approver_roles' and (jsonb_typeof(t->'approver_roles') <> 'array'
              or exists (select 1 from jsonb_array_elements_text(t->'approver_roles') a where a !~ '^(crm|os|erp):[a-z][a-z0-9_]*$')) then
            p := p || 'approver roles look like os:os_principal';
          end if;
        end loop;
      end if;
    end if;
  end if;

  if jsonb_typeof(o.portal) <> 'object' then p := p || 'portal settings must be an object';
  elsif o.portal->'enabled' = 'true'::jsonb then
    if not exists (select 1 from jsonb_array_elements(o.fields) x where x->>'key' = o.portal->>'learner_field' and x->>'type' = 'learner') then
      p := p || 'families can see records only through a learner field: choose one';
    end if;
  end if;

  if o.schedule is not null and o.schedule <> 'null'::jsonb and o.schedule ? 'reminder' and o.schedule->'reminder' <> 'null'::jsonb then
    if not exists (select 1 from jsonb_array_elements(o.fields) x where x->>'key' = o.schedule->'reminder'->>'date_field' and x->>'type' in ('date','datetime')) then
      p := p || 'a reminder needs a date field';
    end if;
    if jsonb_typeof(o.schedule->'reminder'->'days_before') is distinct from 'number' or (o.schedule->'reminder'->>'days_before')::numeric not between 0 and 365 then
      p := p || 'reminder days before must be 0..365';
    end if;
  end if;
  return p;
end $$;

create or replace function app.custom_records_date(p text) returns date
language plpgsql immutable set search_path = '' as $$
begin
  if p is null or p !~ '^\d{4}-\d{2}-\d{2}$' then return null; end if;
  return p::date;
exception when others then return null;
end $$;

create or replace function app.custom_records_timestamp(p text) returns timestamptz
language plpgsql stable set search_path = '' as $$
begin
  if p is null or p !~ '^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}' then return null; end if;
  return p::timestamptz;
exception when others then return null;
end $$;

create or replace function core.custom_objects_validate() returns trigger
language plpgsql set search_path = '' as $$
declare
  v_problems text[];
begin
  if tg_op = 'UPDATE' then
    if new.key <> old.key or new.product_key <> old.product_key or new.org_id <> old.org_id then
      raise exception 'custom_objects: key and owning product cannot change' using errcode = '22023';
    end if;
    if (new.fields, new.permissions, new.states, new.portal, new.schedule, new.list_columns, new.form_layout, new.title_field)
       is distinct from (old.fields, old.permissions, old.states, old.portal, old.schedule, old.list_columns, old.form_layout, old.title_field) then
      new.version := old.version + 1;
    else
      new.version := old.version;
    end if;
  else
    new.version := 1;
  end if;
  v_problems := app.custom_object_problems(new);
  if cardinality(v_problems) > 0 then
    raise exception 'custom_objects: %', array_to_string(v_problems, '; ') using errcode = '23514';
  end if;
  return new;
end $$;
create trigger trg_validate before insert or update on core.custom_objects for each row execute function core.custom_objects_validate();

-- ---------------------------------------------------------------- record validation
-- Checks data against the object's fields (types, required, choices, unique, link targets in the same org), applies
-- defaults on insert, keeps staff_ids / learner_ids, sets the first state, and enforces who may change state / delete.
-- Security definer: link targets and duplicates are checked against all rows of the org, not only the visible ones.
create or replace function core.custom_records_validate() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  o core.custom_objects;
  f jsonb;
  k text;
  t text;
  v jsonb;
  v_data jsonb;
  v_req boolean := app.custom_records_is_request();
  v_ctx text;
  v_fn boolean;
  v_staff uuid[] := '{}';
  v_learners uuid[] := '{}';
  v_id uuid;
  v_num numeric;
  e text[] := '{}';
  x text;
begin
  get diagnostics v_ctx = pg_context;
  -- the compliance engine anonymises or deletes rows from inside its own functions (not callable by request roles)
  if not v_req and v_ctx ~ 'function app\.(_compliance_erase|_compliance_delete_scope|compliance_retention_purge)\(' then
    return new;
  end if;
  -- state changes made by this engine's own functions (checked on the call stack: a request cannot fake it)
  v_fn := v_ctx ~ 'function core\.custom_record_(transition|approval_applied)\(';
  select * into o from core.custom_objects x where x.id = new.object_id and x.org_id = new.org_id;
  if not found then raise exception 'custom_records: unknown object' using errcode = '23503'; end if;

  if tg_op = 'UPDATE' then
    if new.object_id <> old.object_id or new.org_id <> old.org_id then
      raise exception 'custom_records: a record cannot move to another object' using errcode = '22023';
    end if;
    if v_req and not v_fn then
      if (new.state, new.pending_state, new.pending_approval_id) is distinct from (old.state, old.pending_state, old.pending_approval_id) then
        raise exception 'custom_records: change the state with core.custom_record_transition' using errcode = '42501';
      end if;
      if new.deleted_at is distinct from old.deleted_at
         and not app.custom_record_can(old.object_id, 'delete', old.branch_id, old.owner_id, old.data) then
        raise exception 'custom_records: you may not delete this record' using errcode = '42501';
      end if;
      if (new.data, new.branch_id, new.owner_id) is distinct from (old.data, old.branch_id, old.owner_id)
         and not app.custom_record_can(old.object_id, 'edit', old.branch_id, old.owner_id, old.data) then
        raise exception 'custom_records: you may not edit this record' using errcode = '42501';
      end if;
      if new.owner_id is distinct from old.owner_id and not app.custom_records_can_manage(o.org_id, o.product_key) then
        raise exception 'custom_records: only management can change the owner' using errcode = '42501';
      end if;
    end if;
    if new.data = old.data then
      return new;  -- state / deletion only: the data was valid already
    end if;
  else
    if o.archived and v_req then raise exception 'custom_records: % is archived', o.label_plural using errcode = '22023'; end if;
    if v_req then
      new.pending_state := null;
      new.pending_approval_id := null;
      new.created_by := app.uid();
    end if;
    new.state := case when o.states is null or o.states = 'null'::jsonb then null
                      when v_req or new.state is null then o.states->>'initial'
                      else new.state end;
  end if;

  v_data := coalesce(new.data, '{}');
  if jsonb_typeof(v_data) <> 'object' then raise exception 'custom_records: data must be an object' using errcode = '23514'; end if;
  if octet_length(v_data::text) > 65536 then raise exception 'custom_records: record is too large' using errcode = '23514'; end if;

  -- fields removed from the definition: their old values are dropped; anything else unknown is an error
  for k in select jsonb_object_keys(v_data) loop
    if not exists (select 1 from jsonb_array_elements(o.fields) z where z->>'key' = k) then
      if tg_op = 'UPDATE' and old.data ? k and old.data->k = v_data->k then
        v_data := v_data - k;
      else
        e := e || format('%s is not a field of %s', k, o.label_plural);
      end if;
    end if;
  end loop;

  for f in select z from jsonb_array_elements(o.fields) z loop
    k := f->>'key';
    t := f->>'type';
    if tg_op = 'INSERT' and not (v_data ? k) and f ? 'default' and f->'default' <> 'null'::jsonb then
      v_data := jsonb_set(v_data, array[k], case
        when t = 'date' and f->>'default' = 'today' then to_jsonb(current_date::text)
        when t = 'datetime' and f->>'default' = 'now' then to_jsonb(now())
        when t = 'person' and f->>'default' = 'me' then coalesce(to_jsonb(app.my_core_staff_id()), 'null'::jsonb)
        else f->'default' end);
    end if;
    v := v_data->k;
    if v is null or v = 'null'::jsonb or (jsonb_typeof(v) = 'string' and btrim(v #>> '{}') = '') or v = '[]'::jsonb then
      if v is not null then v_data := v_data - k; end if;
      if f->'required' = 'true'::jsonb then e := e || format('%s is required', f->>'label'); end if;
      continue;
    end if;
    x := null;
    case t
      when 'text', 'long_text' then
        if jsonb_typeof(v) <> 'string' then x := 'must be text';
        elsif length(v #>> '{}') > coalesce((f->>'max_length')::integer, case when t = 'text' then 500 else 10000 end) then x := 'is too long';
        end if;
      when 'number', 'money' then
        if jsonb_typeof(v) <> 'number' then x := 'must be a number';
        else
          v_num := (v #>> '{}')::numeric;
          if t = 'money' and v_num <> round(v_num, 2) then x := 'has more than two decimals';
          elsif f ? 'min' and f->'min' <> 'null'::jsonb and v_num < (f->>'min')::numeric then x := format('must be at least %s', f->>'min');
          elsif f ? 'max' and f->'max' <> 'null'::jsonb and v_num > (f->>'max')::numeric then x := format('must be at most %s', f->>'max');
          end if;
        end if;
      when 'date' then
        if jsonb_typeof(v) <> 'string' or app.custom_records_date(v #>> '{}') is null then x := 'must be a date (YYYY-MM-DD)'; end if;
      when 'datetime' then
        if jsonb_typeof(v) <> 'string' or app.custom_records_timestamp(v #>> '{}') is null then x := 'must be a date and time'; end if;
      when 'yes_no' then
        if jsonb_typeof(v) <> 'boolean' then x := 'must be yes or no'; end if;
      when 'choice' then
        if jsonb_typeof(v) <> 'string' or not (f->'options' @> jsonb_build_array(v)) then x := 'must be one of the choices'; end if;
      when 'multi_choice' then
        if jsonb_typeof(v) <> 'array' or exists (select 1 from jsonb_array_elements(v) z where not (f->'options' @> jsonb_build_array(z))) then
          x := 'must be some of the choices';
        end if;
      when 'phone' then
        if jsonb_typeof(v) <> 'string' or (v #>> '{}') !~ '^\+?[0-9][0-9 \-]{5,19}$' then x := 'must be a phone number'; end if;
      when 'email' then
        if jsonb_typeof(v) <> 'string' or (v #>> '{}') !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or length(v #>> '{}') > 254 then x := 'must be an e-mail address'; end if;
      when 'url' then
        if jsonb_typeof(v) <> 'string' or (v #>> '{}') !~* '^https?://[^\s]+$' or length(v #>> '{}') > 2000 then x := 'must be a web address (https://...)'; end if;
      else  -- links: a uuid of a live row of the same org
        v_id := case when jsonb_typeof(v) = 'string' then app.try_uuid(v #>> '{}') end;
        if v_id is null then x := 'must be chosen from the list';
        elsif t = 'person' and not exists (select 1 from core.staff s where s.org_id = new.org_id and s.id = v_id and s.deleted_at is null) then x := 'is not a staff member of this school';
        elsif t = 'learner' and not exists (select 1 from core.students s where s.org_id = new.org_id and s.id = v_id and s.deleted_at is null) then x := 'is not a learner of this school';
        elsif t = 'section' and not exists (select 1 from core.sections s where s.org_id = new.org_id and s.id = v_id and s.deleted_at is null) then x := 'is not a class/section of this school';
        elsif t = 'branch' and not exists (select 1 from core.branches s where s.org_id = new.org_id and s.id = v_id) then x := 'is not a branch of this school';
        elsif t = 'file' and not exists (select 1 from core.files s where s.org_id = new.org_id and s.id = v_id and s.deleted_at is null) then x := 'is not a file of this school';
        end if;
        if x is null and t = 'person' then v_staff := v_staff || v_id; end if;
        if x is null and t = 'learner' then v_learners := v_learners || v_id; end if;
    end case;
    if x is not null then
      e := e || format('%s %s', f->>'label', x);
      continue;
    end if;
    if f->'unique' = 'true'::jsonb then
      perform pg_advisory_xact_lock(hashtextextended(new.object_id::text || ':' || k, 0));
      if exists (select 1 from core.custom_records r where r.org_id = new.org_id and r.object_id = new.object_id and r.id <> new.id
                  and r.deleted_at is null and r.data->k = v) then
        e := e || format('%s must be unique: another record already has this value', f->>'label');
      end if;
    end if;
  end loop;
  if cardinality(e) > 0 then
    raise exception 'custom_records: %', array_to_string(e, '; ') using errcode = '23514';
  end if;
  new.data := v_data;
  new.staff_ids := v_staff;
  new.learner_ids := v_learners;
  return new;
end $$;
create trigger trg_validate before insert or update on core.custom_records for each row execute function core.custom_records_validate();

-- History: one event per insert / data change / state change / (soft) delete. When the compliance engine changes a
-- record, the values kept in its history are scrubbed instead.
create or replace function core.custom_records_history() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_ctx text;
  v_changes jsonb;
begin
  if not app.custom_records_is_request() then
    get diagnostics v_ctx = pg_context;
    if v_ctx ~ 'function app\.(_compliance_erase|_compliance_delete_scope|compliance_retention_purge)\(' then
      update core.custom_record_events e set changes = null, note = null where e.org_id = new.org_id and e.record_id = new.id;
      return null;
    end if;
  end if;
  if tg_op = 'INSERT' then
    insert into core.custom_record_events (org_id, object_id, record_id, kind, to_state, changes)
    values (new.org_id, new.object_id, new.id, 'created', new.state,
            (select jsonb_object_agg(d.key, jsonb_build_object('to', d.value)) from jsonb_each(new.data) d));
    return null;
  end if;
  if new.deleted_at is distinct from old.deleted_at then
    insert into core.custom_record_events (org_id, object_id, record_id, kind)
    values (new.org_id, new.object_id, new.id, case when new.deleted_at is null then 'restored' else 'deleted' end);
  end if;
  if new.data is distinct from old.data then
    select jsonb_object_agg(k, jsonb_build_object('from', old.data->k, 'to', new.data->k)) into v_changes
      from (select jsonb_object_keys(old.data) k union select jsonb_object_keys(new.data)) ks
     where old.data->k is distinct from new.data->k;
    insert into core.custom_record_events (org_id, object_id, record_id, kind, changes)
    values (new.org_id, new.object_id, new.id, 'updated', v_changes);
  end if;
  if new.state is distinct from old.state then
    insert into core.custom_record_events (org_id, object_id, record_id, kind, from_state, to_state, note)
    values (new.org_id, new.object_id, new.id, 'state', old.state, new.state, nullif(current_setting('app.custom_record_note', true), ''));
  end if;
  return null;
end $$;
create trigger trg_history after insert or update on core.custom_records for each row execute function core.custom_records_history();

-- ---------------------------------------------------------------- RLS
select app.apply_core_rls('custom_objects', 'staff', '*', 'records', null, null);
select app.apply_core_rls('custom_records', 'staff', '*', 'records', null, null);
select app.apply_core_rls('custom_record_events', 'staff', '*', 'records', null, null);

-- apply_core_rls attached the audit trigger and the comment the harness looks for; the policies are replaced with the
-- per-object rules (still bounded by org and product inside the helper functions).
select app.drop_policies('core', 'custom_objects');
create policy sel on core.custom_objects for select using (org_id = app.current_org_id() and app.custom_object_visible(custom_objects));
create policy ins on core.custom_objects for insert with check (org_id = app.current_org_id() and app.custom_records_can_manage(org_id, product_key));
create policy upd on core.custom_objects for update using (org_id = app.current_org_id() and app.custom_records_can_manage(org_id, product_key))
  with check (org_id = app.current_org_id() and app.custom_records_can_manage(org_id, product_key));
create policy del on core.custom_objects for delete using (org_id = app.current_org_id() and app.custom_records_can_manage(org_id, product_key));

select app.drop_policies('core', 'custom_records');
create policy sel on core.custom_records for select using (
  org_id = app.current_org_id() and app.custom_record_can(object_id, 'view', branch_id, owner_id, data)
  and (deleted_at is null or app.my_member_kind() in ('staff','support')));
create policy ins on core.custom_records for insert with check (
  org_id = app.current_org_id() and app.custom_record_can(object_id, 'create', branch_id, owner_id, data));
create policy upd on core.custom_records for update
  using (org_id = app.current_org_id() and (app.custom_record_can(object_id, 'edit', branch_id, owner_id, data)
                                            or app.custom_record_can(object_id, 'delete', branch_id, owner_id, data)))
  with check (org_id = app.current_org_id() and app.custom_record_can(object_id, 'view', branch_id, owner_id, data));
-- hard delete: management only (everyone else soft-deletes with the delete permission, checked by the trigger)
create policy del on core.custom_records for delete using (
  org_id = app.current_org_id() and app.custom_record_level(object_id, 'delete') = 'all'
  and exists (select 1 from core.custom_objects o where o.org_id = custom_records.org_id and o.id = custom_records.object_id
               and app.custom_records_can_manage(o.org_id, o.product_key)));

-- history is written by triggers and functions only
select app.drop_policies('core', 'custom_record_events');
create policy sel on core.custom_record_events for select using (org_id = app.current_org_id() and app.custom_record_event_visible(object_id, record_id));

comment on table core.custom_objects is 'core master data. read: per-object permission (app.custom_object_visible); write: records.configure / setup.configure of the owning product';
comment on table core.custom_records is 'core master data. read/write: per-object role permissions (app.custom_record_can) + portal rows for own learners when enabled';
comment on table core.custom_record_events is 'core master data. read: with the record (app.custom_record_event_visible); write: triggers and functions only';

-- ---------------------------------------------------------------- state changes and approvals
-- Move a record to another state along a defined transition. Needs edit access to the record (and, when the
-- transition names roles, one of those roles or management). A transition with approval opens a core approval request
-- (linked_type 'custom_record'); the record moves when it is approved (trigger below), whichever engine decides it.
create or replace function core.custom_record_transition(p_record uuid, p_to text, p_note text default null) returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  r core.custom_records;
  o core.custom_objects;
  t jsonb;
  v_org uuid := app.current_org_id();
  v_product text;
  v_type uuid;
  v_req uuid;
  v_staff uuid := app.my_core_staff_id();
  v_name text;
  v_title text;
  v_roles text[];
begin
  select * into r from core.custom_records x where x.id = p_record and x.org_id = v_org and x.deleted_at is null for update;
  if not found then raise exception 'record not found' using errcode = '22023'; end if;
  if not app.custom_record_can(r.object_id, 'edit', r.branch_id, r.owner_id, r.data) then
    raise exception 'you may not change this record' using errcode = '42501';
  end if;
  select * into o from core.custom_objects x where x.id = r.object_id and x.org_id = v_org;
  if o.states is null or o.states = 'null'::jsonb then raise exception '% has no workflow', o.label_plural using errcode = '22023'; end if;
  if r.pending_approval_id is not null then raise exception 'a change of state is waiting for approval' using errcode = '22023'; end if;
  select x into t from jsonb_array_elements(coalesce(o.states->'transitions', '[]')) x where x->>'from' = r.state and x->>'to' = p_to limit 1;
  if t is null then raise exception 'cannot move from % to %', r.state, p_to using errcode = '22023'; end if;
  if jsonb_typeof(t->'roles') = 'array' and jsonb_array_length(t->'roles') > 0 and not app.custom_records_can_manage(v_org, o.product_key)
     and not exists (select 1 from jsonb_array_elements_text(t->'roles') a join core.user_product_access u
                       on u.user_id = app.uid() and u.org_id = v_org and u.revoked_at is null and a = u.product_key || ':' || u.role_key) then
    raise exception 'your role may not make this change' using errcode = '42501';
  end if;
  perform set_config('app.custom_record_note', coalesce(left(p_note, 1000), ''), true);

  if t->'approval' = 'true'::jsonb then
    v_product := case when o.product_key <> 'core' then o.product_key
                      else (select p.key from core.products p where p.active and app.org_has_product(v_org, p.key) order by p.key limit 1) end;
    insert into core.approval_types (org_id, key, name, product_key, is_system)
    values (v_org, 'custom_record', 'Custom record change', v_product, true)
    on conflict (org_id, key) do nothing;
    select id into v_type from core.approval_types where org_id = v_org and key = 'custom_record';
    select u.display_name into v_name from core.org_users u where u.user_id = app.uid() and u.org_id = v_org;
    v_title := o.label_singular || ': ' || coalesce(left(r.data->>o.title_field, 80), left(r.id::text, 8)) || ' -> '
               || coalesce((select x->>'label' from jsonb_array_elements(o.states->'list') x where x->>'key' = p_to), p_to);
    v_roles := coalesce((select array_agg(a) from jsonb_array_elements_text(t->'approver_roles') a), '{}');
    insert into core.approval_requests (org_id, branch_id, approval_type_id, product_key, applicant_user_id, applicant_staff_id, requested_by_name,
                                        title, summary, data, status, current_seq, pending_approver_ids, step_due_at, linked_type, linked_id)
    values (v_org, r.branch_id, v_type, v_product, app.uid(), v_staff, v_name, v_title, left(p_note, 1000),
            jsonb_build_object('object_id', o.id, 'object_key', o.key, 'from', r.state, 'to', p_to, 'approver_roles', to_jsonb(v_roles)),
            'pending', 1,
            coalesce((select array_agg(distinct s.id) from core.staff s
                        join core.user_product_access a on a.org_id = s.org_id and a.user_id = s.user_id and a.revoked_at is null
                       where s.org_id = v_org and s.deleted_at is null and (a.product_key || ':' || a.role_key) = any(v_roles)), '{}'),
            now() + interval '48 hours', 'custom_record', r.id)
    returning id into v_req;
    insert into core.approval_actions (org_id, request_id, step_seq, actor_user_id, actor_staff_id, actor_name, action, comment)
    values (v_org, v_req, 0, app.uid(), v_staff, v_name, 'submit', left(p_note, 1000));
    update core.custom_records x set pending_state = p_to, pending_approval_id = v_req where x.id = r.id;
    insert into core.custom_record_events (org_id, object_id, record_id, kind, from_state, to_state, note)
    values (v_org, o.id, r.id, 'approval_requested', r.state, p_to, left(p_note, 1000));
    return 'pending';
  end if;
  update core.custom_records x set state = p_to where x.id = r.id;
  return 'done';
end $$;

-- May the signed-in user decide this custom-record approval: management of the object, or a holder of one of the
-- transition's approver roles; never the applicant (unless management).
create or replace function app.custom_record_can_decide(a core.approval_requests) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  v_product text;
begin
  if a.linked_type is distinct from 'custom_record' or a.status <> 'pending' or a.org_id is distinct from app.current_org_id()
     or app.my_member_kind() is distinct from 'staff' then
    return false;
  end if;
  select o.product_key into v_product from core.custom_objects o where o.org_id = a.org_id and o.id = app.try_uuid(a.data->>'object_id');
  if v_product is null then return false; end if;
  if app.custom_records_can_manage(a.org_id, v_product) then return true; end if;
  if a.applicant_user_id is not distinct from app.uid() then return false; end if;
  if a.branch_id is not null and not (a.branch_id = any(app.user_branch_ids())) then return false; end if;
  return exists (select 1 from jsonb_array_elements_text(coalesce(a.data->'approver_roles', '[]')) x
                   join core.user_product_access u on u.user_id = app.uid() and u.org_id = a.org_id and u.revoked_at is null
                    and x = u.product_key || ':' || u.role_key
                  where app.user_has_product(a.org_id, u.product_key));
end $$;

create or replace function core.custom_record_decide(p_request uuid, p_ok boolean, p_comment text default null) returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  a core.approval_requests;
  v_org uuid := app.current_org_id();
  v_name text;
begin
  select * into a from core.approval_requests r where r.id = p_request and r.org_id = v_org and r.linked_type = 'custom_record' for update;
  if not found then raise exception 'approval not found' using errcode = '22023'; end if;
  if not app.custom_record_can_decide(a) then raise exception 'you cannot decide this request' using errcode = '42501'; end if;
  select u.display_name into v_name from core.org_users u where u.user_id = app.uid() and u.org_id = v_org;
  insert into core.approval_actions (org_id, request_id, step_seq, actor_user_id, actor_staff_id, actor_name, action, comment)
  values (v_org, a.id, a.current_seq, app.uid(), app.my_core_staff_id(), v_name, case when p_ok then 'approve' else 'reject' end, left(p_comment, 1000));
  perform set_config('app.custom_record_note', coalesce(left(p_comment, 1000), ''), true);
  update core.approval_requests r set status = case when p_ok then 'approved' else 'rejected' end, decided_at = now(), pending_approver_ids = '{}'
   where r.id = a.id;
  return case when p_ok then 'approved' else 'rejected' end;
end $$;

-- Pending custom-record approvals the signed-in user may decide.
create or replace function core.custom_record_approvals() returns setof core.approval_requests
language sql stable security definer set search_path = '' as $$
  select r.* from core.approval_requests r
   where r.org_id = app.current_org_id() and r.linked_type = 'custom_record' and r.status = 'pending' and r.deleted_at is null
     and app.custom_record_can_decide(r)
   order by r.created_at
$$;

-- Applies a decided approval to its record, whichever engine decided it.
create or replace function core.custom_record_approval_applied() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  r core.custom_records;
begin
  if new.status = old.status or new.status = 'pending' then return null; end if;
  select * into r from core.custom_records x where x.org_id = new.org_id and x.id = new.linked_id and x.pending_approval_id = new.id for update;
  if not found then return null; end if;
  insert into core.custom_record_events (org_id, object_id, record_id, kind, from_state, to_state, note, actor_user_id)
  values (r.org_id, r.object_id, r.id, case when new.status = 'approved' then 'approved' else 'rejected' end, r.state, r.pending_state,
          nullif(current_setting('app.custom_record_note', true), ''), app.uid());
  update core.custom_records x
     set state = case when new.status = 'approved' then r.pending_state else x.state end, pending_state = null, pending_approval_id = null
   where x.id = r.id;
  return null;
end $$;
create trigger trg_custom_record_approval after update of status on core.approval_requests
  for each row when (new.linked_type = 'custom_record') execute function core.custom_record_approval_applied();

-- CSV export: allowed with export access; written to audit.log (counts only) and the object's history.
create or replace function core.custom_records_log_export(p_object uuid, p_rows integer, p_format text default 'csv') returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_org uuid := app.current_org_id();
begin
  if app.custom_record_level(p_object, 'export') is null then raise exception 'you may not export these records' using errcode = '42501'; end if;
  insert into audit.log (org_id, actor_user_id, support_session_id, action, schema_name, table_name, detail)
  values (v_org, app.uid(), app.support_session_id(), 'records.export', 'core', 'custom_records',
          jsonb_build_object('object_id', p_object, 'rows', p_rows, 'format', left(p_format, 10)));
  insert into core.custom_record_events (org_id, object_id, kind, note) values (v_org, p_object, 'exported', format('%s rows (%s)', p_rows, left(p_format, 10)));
end $$;

-- ---------------------------------------------------------------- reminders (private.jobs, job_runner only)
-- One job per record whose reminder date field is due today (date - days_before), for orgs that still have the owning
-- product (any product for 'core'). Idempotent per record and date.
create or replace function app.custom_records_enqueue_reminders() returns integer
language plpgsql volatile security definer set search_path = '' as $$
declare
  n integer;
begin
  with due as (
    select r.org_id, r.id as record_id, o.id as object_id, (r.data->>(o.schedule->'reminder'->>'date_field'))::text as due_on,
           case when o.product_key <> 'core' then o.product_key
                else (select p.key from core.products p where p.active and app.org_has_product(r.org_id, p.key) order by p.key limit 1) end as product
      from core.custom_objects o
      join core.custom_records r on r.org_id = o.org_id and r.object_id = o.id and r.deleted_at is null
     where o.deleted_at is null and not o.archived and o.schedule->'reminder' is not null and o.schedule->'reminder' <> 'null'::jsonb
       and left(r.data->>(o.schedule->'reminder'->>'date_field'), 10) = (current_date + coalesce((o.schedule->'reminder'->>'days_before')::integer, 0))::text
       and not exists (select 1 from jsonb_array_elements(coalesce(o.states->'list', '[]')) s where s->>'key' = r.state and s->'final' = 'true'::jsonb)
  )
  insert into private.jobs (org_id, product_key, kind, payload, run_at)
  select d.org_id, d.product, 'records.reminder', jsonb_build_object('record_id', d.record_id, 'object_id', d.object_id, 'due', left(d.due_on, 10)), now()
    from due d
   where d.product is not null and app.org_has_product(d.org_id, d.product)
     and not exists (select 1 from private.jobs j where j.org_id = d.org_id and j.kind = 'records.reminder'
                      and j.payload->>'record_id' = d.record_id::text and j.payload->>'due' = left(d.due_on, 10));
  get diagnostics n = row_count;
  return n;
end $$;

-- Claims due reminder jobs only (private.claim_jobs would take every kind of a product). Jobs of orgs that lost the
-- product are skipped and logged, as claim_jobs does.
create or replace function private.claim_record_jobs(p_worker text, p_limit integer default 10) returns setof private.jobs
language plpgsql volatile security definer set search_path = '' as $$
declare
  j record;
begin
  for j in update private.jobs set status = 'skipped', skip_reason = 'org has no active ' || product_key || ' subscription', finished_at = now()
            where status = 'queued' and kind = 'records.reminder' and run_at <= now() and not app.org_has_product(org_id, product_key)
           returning id, org_id, product_key, kind loop
    insert into audit.log (org_id, action, schema_name, table_name, row_id, detail)
    values (j.org_id, 'job.skipped', 'private', 'jobs', j.id, jsonb_build_object('product', j.product_key, 'kind', j.kind, 'reason', 'no active subscription'));
  end loop;
  return query
    update private.jobs t set status = 'running', locked_at = now(), locked_by = p_worker, attempts = t.attempts + 1
     where t.id in (select q.id from private.jobs q where q.status = 'queued' and q.kind = 'records.reminder' and q.run_at <= now()
                     order by q.run_at limit greatest(p_limit, 0) for update skip locked)
    returning t.*;
end $$;

-- Delivers one claimed reminder: an in-app notification to the record's owner (if still an active member).
create or replace function app.custom_records_deliver_reminder(p_job uuid) returns integer
language plpgsql volatile security definer set search_path = '' as $$
declare
  j private.jobs;
  r core.custom_records;
  o core.custom_objects;
  n integer;
begin
  select * into j from private.jobs x where x.id = p_job and x.kind = 'records.reminder' and x.status = 'running';
  if not found then raise exception 'job not found' using errcode = '22023'; end if;
  select * into r from core.custom_records x where x.org_id = j.org_id and x.id = app.try_uuid(j.payload->>'record_id') and x.deleted_at is null;
  if not found then return 0; end if;
  select * into o from core.custom_objects x where x.org_id = r.org_id and x.id = r.object_id;
  insert into core.notifications (org_id, user_id, staff_id, product_key, event_key, title, body, link, data, dedupe_key)
  select r.org_id, u.user_id, (select s.id from core.staff s where s.org_id = r.org_id and s.user_id = u.user_id limit 1), j.product_key,
         'records.reminder', left('Reminder: ' || o.label_singular || coalesce(' - ' || (r.data->>o.title_field), ''), 200),
         'Due ' || (j.payload->>'due'), '/records/' || o.key || '/' || r.id,
         jsonb_build_object('record_id', r.id, 'object_id', o.id, 'due', j.payload->>'due'),
         'records.reminder:' || r.id || ':' || (j.payload->>'due')
    from core.org_users u
   where u.org_id = r.org_id and u.user_id = r.owner_id and u.status = 'active'
  on conflict (org_id, user_id, dedupe_key) do nothing;
  get diagnostics n = row_count;
  return n;
end $$;

-- ---------------------------------------------------------------- grants
revoke execute on function app.custom_records_is_request(), app.custom_records_user_has(uuid, text), app.custom_records_can_manage(uuid, text),
  app.custom_record_level_of(core.custom_objects, text), app.custom_record_level(uuid, text), app.custom_record_can(uuid, text, uuid, uuid, jsonb), app.custom_object_visible(core.custom_objects),
  app.custom_record_event_visible(uuid, uuid), app.custom_object_problems(core.custom_objects), app.custom_records_date(text),
  app.custom_records_timestamp(text), core.custom_objects_validate(), core.custom_records_validate(), core.custom_records_history(),
  core.custom_record_transition(uuid, text, text), app.custom_record_can_decide(core.approval_requests), core.custom_record_decide(uuid, boolean, text),
  core.custom_record_approvals(), core.custom_record_approval_applied(), core.custom_records_log_export(uuid, integer, text),
  app.custom_records_enqueue_reminders(), private.claim_record_jobs(text, integer), app.custom_records_deliver_reminder(uuid) from public;
grant execute on function app.custom_records_is_request(), app.custom_records_user_has(uuid, text), app.custom_records_can_manage(uuid, text),
  app.custom_record_level_of(core.custom_objects, text), app.custom_record_level(uuid, text), app.custom_record_can(uuid, text, uuid, uuid, jsonb), app.custom_object_visible(core.custom_objects),
  app.custom_record_event_visible(uuid, uuid), app.custom_object_problems(core.custom_objects), app.custom_records_date(text),
  app.custom_records_timestamp(text), core.custom_record_transition(uuid, text, text), app.custom_record_can_decide(core.approval_requests),
  core.custom_record_decide(uuid, boolean, text), core.custom_record_approvals(), core.custom_records_log_export(uuid, integer, text)
  to authenticated, crm_server, os_server, erp_server, service_role;
grant execute on function app.custom_records_enqueue_reminders(), private.claim_record_jobs(text, integer), app.custom_records_deliver_reminder(uuid)
  to job_runner, service_role;

-- ---------------------------------------------------------------- compliance (docs/adr/compliance-tooling.md)
-- Records hold personal data: person/learner link fields resolve the subject through staff_ids / learner_ids, and the
-- free text in data goes with them. A learner's records are deleted on erasure; a staff member's records are kept as
-- pseudonymous rows (data emptied, state and dates stay); ownership and history actors are removed.
insert into core.pii_registry (schema_name, table_name, person_type, key_column, pii_columns, anonymise_values, erasure_mode, erase_order, note) values
  ('core', 'custom_records', 'student', 'learner_ids', array['data','learner_ids','staff_ids'], '{"data":"{}","learner_ids":"{}","staff_ids":"{}"}', 'delete', 90,
   'Custom records that link the learner (learner fields): the record is about them, deleted with its history.'),
  ('core', 'custom_records', 'staff', 'staff_ids', array['data','staff_ids','learner_ids'], '{"data":"{}","staff_ids":"{}","learner_ids":"{}"}', 'anonymise', 90,
   'Custom records that link the staff member (person fields): data and links removed, the pseudonymous row (state, dates) stays.'),
  ('core', 'custom_records', 'staff', 'owner_id', array['owner_id','created_by'], '{}', 'anonymise', 95,
   'Custom records owned by the staff login: ownership removed, the record stays.'),
  ('core', 'custom_record_events', 'staff', 'actor_user_id', array['actor_user_id','created_by','note'], '{}', 'anonymise', 95,
   'History of custom records: the actor is removed, the trail (what, when) stays.'),
  ('core', 'custom_record_events', 'guardian', 'actor_user_id', array['actor_user_id','created_by','note'], '{}', 'anonymise', 95,
   'History of custom records: the actor is removed.'),
  ('core', 'custom_record_events', 'student', 'actor_user_id', array['actor_user_id','created_by','note'], '{}', 'anonymise', 95,
   'History of custom records: the actor is removed.');

insert into core.retention_policies (scope, data_type, description, schema_name, table_name, date_column, action, period_value, period_unit, enabled, legal_status, legal_note)
values ('table', 'custom_records_inactive', 'Custom records not changed for 7 years (CONFIRM per object type with counsel).', 'core', 'custom_records', 'updated_at', 'delete', 84, 'months', false, 'draft',
        'Draft: custom records vary by school; a per-object period may replace this default.');
