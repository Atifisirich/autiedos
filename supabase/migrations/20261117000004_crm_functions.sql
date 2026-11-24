-- AutoEd CRM port (4/6): roles, automation actor, sensitive-field masking, wallet, numbers, consents, public lookups,
-- recurring jobs, and the core helper functions the core stream left to the CRM (can_contact,
-- student_primary_phone, upsert_staff). core.admit_student is in 20261117000005.
-- Every security definer function pins search_path = '' and is revoked from PUBLIC in 20261117000006.

-- ---------------------------------------------------------------- small helpers
create or replace function crm.mask() returns text language sql immutable set search_path = '' as $$ select '••••••'::text $$;

-- Reporting line (RB-02): is the signed-in user, directly or further up, the manager of this owner?
-- Used by the team policies on crm.enquiries ("own" scope also covers everyone who reports to you).
create or replace function crm.in_my_team(p_org uuid, p_owner uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  with recursive up as (
    select s.id, s.reports_to, s.user_id from core.staff s
     where s.org_id = p_org and s.user_id = p_owner and s.deleted_at is null
    union
    select m.id, m.reports_to, m.user_id from core.staff m join up on m.id = up.reports_to
     where m.org_id = p_org and m.deleted_at is null)
  select p_owner is not null and exists (select 1 from up where up.user_id = auth.uid() and up.user_id is distinct from p_owner)
$$;

create policy sel_team on crm.enquiries for select using (
  app.user_has_product(org_id, 'crm') and crm.in_my_team(org_id, owner_id)
  and app.can('crm', 'leads', 'view', org_id, branch_id, app.uid()));
create policy upd_team on crm.enquiries for update
  using (app.user_has_product(org_id, 'crm') and crm.in_my_team(org_id, owner_id) and app.can('crm', 'leads', 'edit', org_id, branch_id, app.uid()))
  with check (app.user_has_product(org_id, 'crm') and crm.in_my_team(org_id, owner_id) and app.can('crm', 'leads', 'edit', org_id, branch_id, app.uid()));

-- ---------------------------------------------------------------- the permission matrix -> core.role_permissions
-- crm.roles.permissions holds one level per capability (lib/perm.ts CAPS). The database enforces it through the
-- platform's role tables, so every capability is translated into (module, action, scope) rows. Where several
-- capabilities give the same (module, action) the widest scope wins. App-level nuances (concession limits,
-- "Masked") stay in the CRM server; what protects data lives here.
create or replace function crm.role_rows(p jsonb)
returns table (module_key text, action text, scope text)
language sql immutable set search_path = '' as $$
  with c as (select k as cap, v as lv from jsonb_each_text(coalesce(p, '{}'::jsonb)) x(k, v)),
  r(module_key, action, scope) as (
    -- leads (enquiries, households, guardians, prospects, activities, messages ...)
    select 'leads', a, case lv when 'F' then 'org' when 'T' then 'branch' else 'own' end
      from c, unnest(array['view','create','edit']) a where cap = 'leads' and lv in ('F','T','O')
    union all select 'leads', 'view', 'branch' from c where cap = 'leads' and lv = 'V'
    union all select 'leads', a, 'branch' from c, unnest(array['view','create']) a where cap = 'leads' and lv = 'Create, V'
    union all select 'leads', 'reassign', case lv when 'F' then 'org' else 'branch' end from c where cap = 'reassign' and lv in ('F','T')
    union all select 'leads', 'export', case lv when 'F' then 'org' else 'branch' end from c where cap = 'bulk' and lv in ('F','T','Part')
    union all select 'leads', 'delete', case lv when 'F' then 'org' else 'branch' end from c where cap = 'delete' and lv in ('F','T')
    union all select 'leads', 'merge', 'branch' from c where cap = 'delete' and lv = 'Merge only'
    -- tasks and visits
    union all select 'tasks', a, case lv when 'F' then 'org' else 'branch' end
      from c, unnest(array['view','create','edit','delete']) a where cap = 'tasks' and lv in ('F','T')
    union all select 'tasks', a, 'own' from c, unnest(array['view','create','edit']) a where cap = 'tasks' and lv = 'O'
    union all select 'tasks', a, 'own' from c, unnest(array['view','edit']) a where cap = 'tasks' and lv = 'Own'
    union all select 'tasks', a, 'branch' from c, unnest(array['view','edit']) a where cap = 'tasks' and lv = 'Check-in'
    union all select 'tasks', 'view', 'branch' from c where cap = 'tasks' and lv = 'V'
    -- applications and documents
    union all select 'applications', a, case lv when 'F' then 'org' else 'branch' end
      from c, unnest(array['view','create','edit','delete','verify']) a where cap = 'applications' and lv in ('F','T')
    union all select 'applications', a, 'own' from c, unnest(array['view','create','edit']) a where cap = 'applications' and lv = 'O'
    union all select 'applications', a, 'branch' from c, unnest(array['view','create','edit']) a where cap = 'applications' and lv = 'Assist'
    union all select 'applications', a, 'branch' from c, unnest(array['view','edit','verify']) a where cap = 'applications' and lv = 'Decide'
    union all select 'applications', 'view', 'branch' from c where cap = 'applications' and lv = 'V'
    -- payments and concessions
    union all select 'payments', a, case lv when 'F' then 'org' else 'branch' end
      from c, unnest(array['view','create','edit','delete','verify']) a where cap = 'payments' and lv in ('F','T')
    union all select 'payments', a, 'branch' from c, unnest(array['view','create']) a where cap = 'payments' and lv in ('Collect','Send link')
    union all select 'payments', 'view', 'branch' from c where cap = 'payments' and lv = 'V'
    union all select 'payments', 'concession', case lv when 'F' then 'org' else 'branch' end from c where cap = 'concession' and lv in ('F','T','Within limit')
    union all select 'payments', 'request_concession', 'branch' from c where cap = 'concession' and lv = 'Request'
    -- campaigns, workflows, templates (core.message_templates is written through module `notifications`)
    union all select 'campaigns', a, case lv when 'F' then 'org' else 'branch' end
      from c, unnest(array['view','create','edit','delete']) a where cap = 'campaigns' and lv in ('F','T')
    union all select 'campaigns', 'view', 'branch' from c where cap = 'campaigns' and lv = 'V'
    union all select 'workflows', a, case lv when 'F' then 'org' else 'branch' end
      from c, unnest(array['view','create','edit','delete','publish']) a where cap = 'workflows' and lv in ('F','T')
    union all select 'workflows', a, 'branch' from c, unnest(array['view','create','edit']) a where cap = 'workflows' and lv = 'Draft'
    union all select 'workflows', 'view', 'branch' from c where cap = 'workflows' and lv = 'V'
    union all select 'notifications', a, case lv when 'F' then 'org' else 'branch' end
      from c, unnest(array['create','edit','delete']) a where cap = 'templates' and lv in ('F','T')
    -- reports, sensitive custom fields, audit
    union all select 'reports', 'view', case lv when 'F' then 'org' when 'Fin.' then 'org' when 'O' then 'own' else 'branch' end
      from c where cap = 'reports' and lv <> '-'
    union all select 'sensitive', a, case lv when 'F' then 'org' else 'branch' end
      from c, unnest(array['view','create','edit','delete']) a where cap = 'sensitive' and lv in ('F','T')
    union all select 'sensitive', 'view', 'branch' from c where cap = 'sensitive' and lv = 'V'
    union all select 'audit', 'view', case lv when 'F' then 'org' else 'branch' end from c where cap = 'audit' and lv in ('F','Branch')
    -- admin console
    union all select m, a, 'org' from c,
        (values ('admin','configure'), ('setup','create'), ('setup','edit'), ('setup','delete'), ('setup','configure'),
                ('users','view'), ('users','manage'), ('users','configure'),
                ('integrations','view'), ('integrations','create'), ('integrations','edit'), ('integrations','delete'),
                ('secrets','view'), ('secrets','create'), ('secrets','edit'), ('secrets','delete'),
                ('data','view'), ('data','create'), ('data','edit'), ('data','delete'),
                ('wallet','view'), ('wallet','create'), ('files','create')) v(m, a)
      where cap = 'admin' and lv = 'F'
    union all select m, a, 'branch' from c,
        (values ('admin','configure'), ('users','view'), ('users','manage'),
                ('data','view'), ('data','create'), ('data','edit'), ('data','delete')) v(m, a)
      where cap = 'admin' and lv = 'Branch scope'
    union all select 'admin', 'configure', 'branch' from c where cap = 'admin' and lv = 'Part'
    union all select 'wallet', 'view', 'org' from c where cap = 'payments' and lv in ('F','T')
    -- everyone who works leads can notify colleagues (core.notifications has no owner/branch)
    union all select 'notifications', 'create', 'org' from c where cap = 'leads' and lv <> '-'
  )
  select r.module_key, r.action,
         case max(case r.scope when 'own' then 1 when 'branch' then 2 else 3 end) when 1 then 'own' when 2 then 'branch' else 'org' end
    from r group by r.module_key, r.action
$$;

-- Rebuilds the core.role_permissions rows of one CRM role from its matrix.
create or replace function crm.sync_role_permissions(p_org uuid, p_key text) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_role uuid;
  v_perms jsonb;
begin
  select r.id into v_role from core.roles r where r.org_id = p_org and r.product_key = 'crm' and r.key = p_key;
  select c.permissions into v_perms from crm.roles c where c.org_id = p_org and c.key = p_key;
  if v_role is null or v_perms is null then raise exception 'unknown crm role %', p_key using errcode = '22023'; end if;
  delete from core.role_permissions where role_id = v_role and org_id = p_org;
  insert into core.role_permissions (org_id, role_id, module_key, action, scope)
  select p_org, v_role, x.module_key, x.action, x.scope from crm.role_rows(v_perms) x;
end $$;

-- Invoker trigger: current_user is the request role, so a request role must be allowed to manage CRM users
-- (migrations and the owner connection are not checked). The rebuild itself is the definer function above.
create or replace function crm.trg_sync_role() returns trigger
language plpgsql set search_path = '' as $$
begin
  if current_user in ('authenticated','crm_server','os_server','erp_server','platform_admin_server','job_runner')
     and not app.can('crm', 'users', 'manage', new.org_id) then
    raise exception 'not allowed to change CRM roles' using errcode = '42501';
  end if;
  perform crm.sync_role_permissions(new.org_id, new.key);
  return null;
end $$;
create trigger trg_sync_role after insert or update of permissions on crm.roles
  for each row execute function crm.trg_sync_role();

-- ---------------------------------------------------------------- automation actor and provisioning
-- Each org with the CRM gets one automation user (kind staff, role `system` = everything in the CRM). The CRM
-- server runs webhooks, public forms, the cron sweep and the lead-capture/dedupe path as that user: RLS still
-- applies (org + product + audit), and the server role itself has no BYPASSRLS. It cannot touch OS or ERP: the
-- role is a crm role, and grants stop at the crm and core schemas.
create or replace function crm.provision_org(p_org uuid) returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_sys uuid;
  v_role uuid;
begin
  if not exists (select 1 from core.organizations o where o.id = p_org) then
    raise exception 'unknown organisation' using errcode = '22023';
  end if;
  insert into crm.settings (org_id) values (p_org) on conflict (org_id) do nothing;
  select s.system_user_id into v_sys from crm.settings s where s.org_id = p_org;
  if v_sys is not null then return v_sys; end if;
  v_sys := gen_random_uuid();
  insert into auth.users (id, email) values (v_sys, 'crm-system+' || p_org::text || '@system.autoed.invalid');
  insert into core.org_users (org_id, user_id, kind, display_name, status) values (p_org, v_sys, 'staff', 'AutoEd CRM automation', 'active');
  select r.id into v_role from core.roles r where r.org_id = p_org and r.product_key = 'crm' and r.key = 'system';
  if v_role is null then
    insert into core.roles (org_id, product_key, key, name) values (p_org, 'crm', 'system', 'CRM automation') returning id into v_role;
  end if;
  insert into core.role_permissions (org_id, role_id, module_key, action, scope) values (p_org, v_role, '*', '*', 'org') on conflict do nothing;
  insert into core.user_product_access (org_id, user_id, product_key, role_key) values (p_org, v_sys, 'crm', 'system');
  update crm.settings set system_user_id = v_sys where org_id = p_org;
  return v_sys;
end $$;

create or replace function crm.trg_provision_org() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform crm.provision_org(new.org_id);
  return null;
end $$;
create trigger trg_crm_provision after insert on core.subscriptions
  for each row when (new.product_key = 'crm') execute function crm.trg_provision_org();

-- The automation user of an org, only while the org has an active CRM subscription. Called by the CRM server
-- (no signed-in user) before it sets request.jwt.claims to that user.
create or replace function crm.system_actor(p_org uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select s.system_user_id from crm.settings s where s.org_id = p_org and app.org_has_product(p_org, 'crm')
$$;

-- Unauthenticated entry points (Meta webhook, hosted forms, parent links, API keys) name an org only by an
-- unguessable key. This resolves the key to (org, automation user, record) if, and only if, the org has the CRM.
-- kinds: webhook (crm.settings.webhook_key), form (slug), enquiry (public_token), payment (token),
-- api_key (sha256 hash of the key; ref = core.api_keys.id, source_id from the scope `source:<uuid>`).
create or replace function crm.resolve_public(p_kind text, p_token text)
returns table (org_id uuid, system_user_id uuid, ref_id uuid, name text, source_id uuid)
language sql stable security definer set search_path = '' as $$
  select x.org_id, s.system_user_id, x.ref_id, x.name, x.source_id
    from (
      select st.org_id, st.id as ref_id, null::text as name, null::uuid as source_id from crm.settings st
       where p_kind = 'webhook' and st.webhook_key = p_token
      union all
      select f.org_id, f.id, f.name, f.source_id from crm.forms f where p_kind = 'form' and f.slug = p_token and f.active
      union all
      select e.org_id, e.id, null, null from crm.enquiries e where p_kind = 'enquiry' and e.public_token = p_token
      union all
      select p.org_id, p.id, p.purpose, null from crm.payments p where p_kind = 'payment' and p.token = p_token
      union all
      select k.org_id, k.id, k.name,
             (select app.try_uuid(substring(sc from '^source:(.*)$')) from unnest(k.scopes) sc where sc like 'source:%' limit 1)
        from core.api_keys k
       where p_kind = 'api_key' and k.key_hash = p_token and k.product_key = 'crm' and k.revoked_at is null
         and k.deleted_at is null and (k.expires_at is null or k.expires_at > now())
    ) x
    join crm.settings s on s.org_id = x.org_id
   where app.org_has_product(x.org_id, 'crm') and s.system_user_id is not null
$$;

-- ---------------------------------------------------------------- sensitive custom fields (enforced in SQL)
-- Plain values of fields flagged sensitive in crm.field_settings never stay in crm.enquiries.custom: this trigger
-- moves them to crm.enquiry_sensitive (module `sensitive`) and leaves a placeholder behind. A caller without
-- sensitive.edit cannot change them (their value is put back); a caller without sensitive.view sees only the
-- placeholder, whatever they select. crm.enquiries_full overlays the real values for those who may see them.
-- (Invoker trigger: it writes crm.enquiry_sensitive under the caller's own RLS rights.)
create or replace function crm.trg_enquiry_sensitive() returns trigger
language plpgsql set search_path = '' as $$
declare
  v_keys text[];
  k text;
  v jsonb;
  v_data jsonb := '{}'::jsonb;
  v_del text[] := '{}';
  v_mask jsonb := to_jsonb(crm.mask());
  v_old jsonb := case when tg_op = 'UPDATE' then old.custom else '{}'::jsonb end;
  v_allowed boolean;
begin
  select array_agg(f.key) into v_keys from crm.field_settings f
   where f.org_id = new.org_id and f.entity = 'enquiry' and f.sensitive;
  if v_keys is null then return new; end if;
  v_allowed := app.can('crm', 'sensitive', 'edit', new.org_id, new.branch_id, null);
  foreach k in array v_keys loop
    if not (new.custom ? k) then continue; end if;
    v := new.custom -> k;
    if v = v_mask then
      continue;                                       -- placeholder written back unchanged
    elsif not v_allowed then
      new.custom := case when v_old ? k then jsonb_set(new.custom, array[k], v_old -> k) else new.custom - k end;
    elsif v = 'null'::jsonb or v = '""'::jsonb then
      v_del := v_del || k;
      new.custom := new.custom - k;
    else
      v_data := v_data || jsonb_build_object(k, v);
      new.custom := jsonb_set(new.custom, array[k], v_mask);
    end if;
  end loop;
  if v_data <> '{}'::jsonb or cardinality(v_del) > 0 then
    insert into crm.enquiry_sensitive (org_id, branch_id, enquiry_id, data) values (new.org_id, new.branch_id, new.id, v_data)
    on conflict (org_id, enquiry_id) do update set data = (crm.enquiry_sensitive.data || excluded.data) - v_del, branch_id = excluded.branch_id;
  end if;
  return new;
end $$;
create trigger trg_enquiry_sensitive before insert or update of custom on crm.enquiries
  for each row execute function crm.trg_enquiry_sensitive();

-- The enquiry with its sensitive values overlaid where the caller's RLS rights on crm.enquiry_sensitive allow.
create view crm.enquiries_full with (security_invoker = true) as
select e.*, e.custom || coalesce(s.data, '{}'::jsonb) as custom_full
  from crm.enquiries e
  left join crm.enquiry_sensitive s on s.org_id = e.org_id and s.enquiry_id = e.id;

-- Flags / unflags a custom field as sensitive and moves the existing values accordingly.
create or replace function crm.set_field_sensitivity(p_key text, p_sensitive boolean) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_org uuid := app.current_org_id();
begin
  if v_org is null or not app.user_has_product(v_org, 'crm')
     or not app.can('crm', 'admin', 'configure', v_org) or not app.can('crm', 'sensitive', 'edit', v_org) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  insert into crm.field_settings (org_id, entity, key, sensitive) values (v_org, 'enquiry', p_key, p_sensitive)
  on conflict (org_id, entity, key) do update set sensitive = excluded.sensitive;
  if p_sensitive then
    update crm.enquiries set custom = custom where org_id = v_org and custom ? p_key;     -- trigger moves the values
  else
    update crm.enquiries e set custom = jsonb_set(e.custom, array[p_key], s.data -> p_key)
      from crm.enquiry_sensitive s where s.org_id = v_org and s.enquiry_id = e.id and e.org_id = v_org and s.data ? p_key;
    update crm.enquiry_sensitive set data = data - p_key where org_id = v_org and data ? p_key;
  end if;
end $$;

-- ---------------------------------------------------------------- messaging wallet
-- The balance and the ledger change only through crm.wallet_post; a request role writing either table
-- directly is refused by these guards (inside the security definer function current_user is the owner).
create or replace function crm.guard_wallet() returns trigger
language plpgsql set search_path = '' as $$
begin
  if current_user in ('authenticated','anon','crm_server','os_server','erp_server','platform_admin_server','job_runner') then
    if tg_table_name = 'wallet_ledger' then
      raise exception 'the wallet ledger changes only through crm.wallet_post()' using errcode = '42501';
    elsif tg_op = 'UPDATE' and new.wallet_balance is distinct from old.wallet_balance then
      raise exception 'the wallet balance changes only through crm.wallet_post()' using errcode = '42501';
    elsif tg_op = 'INSERT' and new.wallet_balance <> 0 then
      raise exception 'the wallet balance changes only through crm.wallet_post()' using errcode = '42501';
    end if;
  end if;
  return coalesce(new, old);
end $$;
create trigger trg_guard_wallet before insert or update on crm.settings for each row execute function crm.guard_wallet();
create trigger trg_guard_wallet before insert or update or delete on crm.wallet_ledger for each row execute function crm.guard_wallet();

-- Credit (recharge) needs wallet.create; debit is for message sends (any CRM user working leads) and cannot
-- overdraw. Returns the new balance. Locks the settings row, so concurrent sends never lose an update.
create or replace function crm.wallet_post(p_type text, p_category text, p_amount numeric, p_note text default null, p_branch uuid default null)
returns numeric language plpgsql volatile security definer set search_path = '' as $$
declare
  v_org uuid := app.current_org_id();
  v_bal numeric;
begin
  if v_org is null or not app.user_has_product(v_org, 'crm') then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_type not in ('credit','debit') or p_amount is null or p_amount <= 0 then raise exception 'bad wallet entry' using errcode = '22023'; end if;
  if p_type = 'credit' and not app.can('crm', 'wallet', 'create', v_org, p_branch, null) then raise exception 'not allowed to recharge' using errcode = '42501'; end if;
  if p_type = 'debit' and p_category not in ('whatsapp','sms','email','voice')
     and not app.can('crm', 'wallet', 'create', v_org, p_branch, null) then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_type = 'debit' and not (app.can('crm', 'leads', 'view', v_org, null, auth.uid()) or app.can('crm', 'wallet', 'create', v_org, null, null)) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select s.wallet_balance into v_bal from crm.settings s where s.org_id = v_org for update;
  if not found then raise exception 'org has no CRM settings' using errcode = '22023'; end if;
  if p_type = 'debit' and v_bal < p_amount then raise exception 'insufficient wallet balance' using errcode = '23514'; end if;
  v_bal := case when p_type = 'credit' then v_bal + p_amount else v_bal - p_amount end;
  update crm.settings set wallet_balance = v_bal where org_id = v_org;
  insert into crm.wallet_ledger (org_id, branch_id, type, category, amount, balance_after, note)
  values (v_org, p_branch, p_type, p_category, p_amount, v_bal, p_note);
  return v_bal;
end $$;

-- ---------------------------------------------------------------- numbers (application numbers, receipts)
-- Draws from core.number_series (OQ-16): key crm_application (one series per academic year, "APP-27-0001") or
-- crm_receipt (one per org, "RCPT-00001"). Series rows are created on first use from the CRM settings.
create or replace function crm.next_number(p_key text, p_year uuid default null) returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_org uuid := app.current_org_id();
  v_set jsonb;
  v_yy text;
  v_prefix text;
  v_pad integer;
begin
  if v_org is null or not app.user_has_product(v_org, 'crm')
     or not (app.can('crm', 'leads', 'view', v_org, null, auth.uid())) then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_key not in ('crm_application', 'crm_receipt') then raise exception 'unknown number series %', p_key using errcode = '22023'; end if;
  select s.settings into v_set from crm.settings s where s.org_id = v_org;
  if p_key = 'crm_application' then
    select substr(y.name, 3, 2) into v_yy from core.academic_years y where y.org_id = v_org and y.id = p_year;
    v_prefix := coalesce(v_set ->> 'app_no_prefix', 'APP') || '-' || coalesce(v_yy, '') || '-';
    v_pad := 4;
  else
    p_year := null;
    v_prefix := coalesce(v_set ->> 'receipt_prefix', 'RCPT') || '-';
    v_pad := 5;
  end if;
  insert into core.number_series (org_id, key, academic_year_id, prefix, padding, product_key)
  values (v_org, p_key, p_year, v_prefix, v_pad, 'crm')
  on conflict (org_id, branch_id, key, academic_year_id) do nothing;
  return core.next_number(p_key, null, p_year);
end $$;

-- ---------------------------------------------------------------- audit events (CRM audit_events -> audit.log)
create or replace function crm.audit_event(p_action text, p_entity text, p_entity_id text, p_summary text,
  p_before jsonb default null, p_after jsonb default null, p_user_name text default null, p_ip text default null)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare
  v_org uuid := app.current_org_id();
begin
  if v_org is null or not app.user_has_product(v_org, 'crm') then raise exception 'not allowed' using errcode = '42501'; end if;
  insert into audit.log (org_id, actor_user_id, support_session_id, action, schema_name, table_name, row_id, before, after, detail)
  values (v_org, auth.uid(), app.support_session_id(), 'crm.' || p_action, 'crm', p_entity, app.try_uuid(p_entity_id), p_before, p_after,
          jsonb_build_object('entity_id', p_entity_id, 'summary', p_summary, 'user_name', p_user_name, 'ip', p_ip));
end $$;

-- ---------------------------------------------------------------- consent of pre-admission contacts
-- Consent of CRM guardians lives in core.consents (subject_type crm_guardian), readable only with the CRM
-- (core-master-001) and written only through here, so a counsellor needs no compliance permission.
create or replace function crm.set_consent(p_guardian uuid, p_purpose text, p_granted boolean,
  p_source text default null, p_wording text default null) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_org uuid := app.current_org_id();
  v_n integer;
begin
  if v_org is null or not app.user_has_product(v_org, 'crm')
     or not (app.can('crm', 'leads', 'create', v_org, null, auth.uid()) or app.can('crm', 'leads', 'edit', v_org, null, auth.uid())) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not exists (select 1 from crm.guardians g where g.org_id = v_org and g.id = p_guardian) then
    raise exception 'unknown guardian' using errcode = '22023';
  end if;
  update core.consents c set granted = p_granted,
         withdrawn_at = case when p_granted then null else now() end,
         granted_at = case when p_granted then now() else c.granted_at end,
         source = coalesce(p_source, c.source), wording_version = coalesce(p_wording, c.wording_version), user_id = auth.uid()
   where c.org_id = v_org and c.subject_type = 'crm_guardian' and c.crm_contact_id = p_guardian and c.purpose = p_purpose and c.deleted_at is null;
  get diagnostics v_n = row_count;
  if v_n = 0 then
    insert into core.consents (org_id, subject_type, crm_contact_id, purpose, granted, wording_version, source, granted_at, withdrawn_at, product_key)
    values (v_org, 'crm_guardian', p_guardian, p_purpose, p_granted, p_wording, p_source, now(), case when p_granted then null else now() end, 'crm');
  end if;
end $$;

-- {whatsapp: true, sms: true, email: true, call: true} for one CRM guardian (missing = no record = not granted).
create or replace function crm.guardian_consents(p_guardian uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_org uuid := app.current_org_id();
begin
  if v_org is null or not app.user_has_product(v_org, 'crm') or not app.can('crm', 'leads', 'view', v_org, null, auth.uid()) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return coalesce((select jsonb_object_agg(c.purpose, c.granted and c.withdrawn_at is null) from core.consents c
                    where c.org_id = v_org and c.subject_type = 'crm_guardian' and c.crm_contact_id = p_guardian and c.deleted_at is null), '{}'::jsonb);
end $$;

-- Expo push tokens of a colleague in the same org (core.device_tokens rows are otherwise readable by their owner only).
create or replace function crm.push_tokens(p_user uuid) returns setof text
language plpgsql stable security definer set search_path = '' as $$
declare
  v_org uuid := app.current_org_id();
begin
  if v_org is null or not app.user_has_product(v_org, 'crm') then raise exception 'not allowed' using errcode = '42501'; end if;
  return query select t.token from core.device_tokens t
                where t.org_id = v_org and t.user_id = p_user and t.revoked_at is null and t.deleted_at is null;
end $$;

-- ---------------------------------------------------------------- recurring jobs (private.jobs)
-- Queues one job of `kind` for every org that currently has `product`, unless one is already waiting or running.
-- Called by the job worker (role job_runner) before it claims jobs; the per-product subscription re-check
-- happens again in private.claim_jobs.
create or replace function private.enqueue_tick_jobs(p_product text, p_kind text) returns integer
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_n integer;
begin
  insert into private.jobs (org_id, product_key, kind, run_at)
  select s.org_id, s.product_key, p_kind, now() from core.subscriptions s
   where s.product_key = p_product and app.org_has_product(s.org_id, p_product)
     and not exists (select 1 from private.jobs j where j.org_id = s.org_id and j.product_key = p_product
                      and j.kind = p_kind and j.status in ('queued','running'));
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- ---------------------------------------------------------------- core helpers left to the CRM stream
-- Read path for every sender (B.17): did this contact consent to this channel? No record means no.
create or replace function core.can_contact(p_subject_type text, p_subject_id uuid, p_channel text) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  v_org uuid := app.current_org_id();
begin
  if v_org is null or not app.user_has_any_product(v_org) then return false; end if;
  if p_subject_type = 'crm_guardian' and not app.user_has_product(v_org, 'crm') then return false; end if;
  return coalesce((
    select c.granted and c.withdrawn_at is null from core.consents c
     where c.org_id = v_org and c.deleted_at is null and c.subject_type = p_subject_type and c.purpose = p_channel
       and p_subject_id = case p_subject_type when 'guardian' then c.guardian_id when 'student' then c.student_id
                               when 'staff' then c.staff_id when 'crm_guardian' then c.crm_contact_id end
     order by c.granted_at desc, c.created_at desc limit 1), false);
end $$;

-- Replaces OS students.parent_phone: the phone of the primary guardian of the student's household.
create or replace function core.student_primary_phone(p_student uuid) returns text
language plpgsql stable security definer set search_path = '' as $$
declare
  v_org uuid := app.current_org_id();
begin
  if v_org is null or not app.user_has_any_product(v_org) then return null; end if;
  if app.my_member_kind() not in ('staff','support') and not (p_student = any(app.my_learner_ids())) then return null; end if;
  return (select g.phone from core.students s
            join core.guardians g on g.org_id = s.org_id and g.household_id = s.household_id and g.deleted_at is null and g.phone is not null
           where s.org_id = v_org and s.id = p_student and s.deleted_at is null
           order by g.is_primary desc, g.created_at limit 1);
end $$;

-- Creates or updates a staff member of the caller's org: org link, core.staff row and product access in one call.
-- The auth user must already exist (Supabase Auth invite). one login = one org (decision 37): a user of another
-- org is refused by the unique constraint on core.org_users.
create or replace function core.upsert_staff(p_user uuid, p_first_name text, p_last_name text, p_email text, p_phone text,
  p_branch uuid, p_product text, p_role_key text, p_staff_type text default 'admin', p_status text default 'active',
  p_reports_to uuid default null) returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_org uuid := app.current_org_id();
  v_staff uuid;
begin
  if v_org is null or not app.can(p_product, 'users', 'manage', v_org) then
    raise exception 'not allowed to manage users in %', p_product using errcode = '42501';
  end if;
  insert into core.org_users (org_id, user_id, kind, display_name, status, home_branch_id)
  values (v_org, p_user, 'staff', btrim(p_first_name || coalesce(' ' || p_last_name, '')), case when p_status = 'invited' then 'invited' else 'active' end, p_branch)
  on conflict (user_id) do update set display_name = excluded.display_name, home_branch_id = excluded.home_branch_id, status = excluded.status
   where core.org_users.org_id = v_org;
  if not exists (select 1 from core.org_users u where u.org_id = v_org and u.user_id = p_user) then
    raise exception 'user belongs to another organisation' using errcode = '23505';
  end if;
  insert into core.staff (org_id, branch_id, user_id, first_name, last_name, email, phone, status, staff_type, reports_to)
  values (v_org, p_branch, p_user, p_first_name, p_last_name, p_email, p_phone, p_status, p_staff_type, p_reports_to)
  on conflict (user_id) do update set branch_id = excluded.branch_id, first_name = excluded.first_name, last_name = excluded.last_name,
    email = excluded.email, phone = excluded.phone, status = excluded.status, staff_type = excluded.staff_type, reports_to = excluded.reports_to, deleted_at = null
  returning id into v_staff;
  update core.user_product_access set revoked_at = now()
   where org_id = v_org and user_id = p_user and product_key = p_product and revoked_at is null and role_key <> p_role_key;
  insert into core.user_product_access (org_id, user_id, product_key, role_key, granted_by)
  select v_org, p_user, p_product, p_role_key, auth.uid()
   where not exists (select 1 from core.user_product_access a where a.user_id = p_user and a.product_key = p_product and a.revoked_at is null);
  return v_staff;
end $$;
