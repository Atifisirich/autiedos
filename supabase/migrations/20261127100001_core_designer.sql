-- AI school designer (DECISIONS 56-59, docs/designer.md, docs/adr/designer.md).
--
-- core.design_changesets       one plan per request: the prompt, the validated changeset (plan), its plain-language
--                              preview, status draft -> validated -> published -> reverted (or rejected), who wrote it
--                              (org admin or AutoEd relationship manager inside a support session), who published it,
--                              and the org's running version number of published changesets.
-- core.design_changeset_items  one row per applied operation: block, instance key, settings, the instance's state
--                              before and after, and the inverse operation used by one-click undo.
--
-- Who: only the org's management (a role holding setup.configure at branch scope or wider, in any product: the same
-- people as the setup wizard) and AutoEd staff inside an open support session for the org (read; write only when the
-- session was opened read-write). Everything is audited by the platform row trigger (actor + support session id).
-- The configuration itself is changed through the existing product tables with the user's claims, so their RLS,
-- audit and config history apply as for the settings screens; this migration adds no bypass.

-- ---------------------------------------------------------------- who may use the designer
create or replace function app.designer_allowed(p_org uuid, p_write boolean default true) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_org is not null and p_org = app.current_org_id() and (
    exists (select 1 from core.support_sessions s
             where s.id = app.support_session_id() and s.org_id = p_org and (not p_write or not s.read_only))
    or exists (
      select 1 from core.org_users u
        join core.user_product_access a on a.user_id = u.user_id and a.org_id = u.org_id and a.revoked_at is null
        join core.roles r on r.org_id = a.org_id and r.product_key = a.product_key and r.key = a.role_key
        join core.role_permissions rp on rp.role_id = r.id
       where u.user_id = auth.uid() and u.org_id = p_org and u.kind = 'staff' and u.status = 'active'
         and app.org_has_product(p_org, a.product_key)
         and rp.module_key in ('setup', '*') and rp.action in ('configure', '*') and rp.scope in ('branch', 'org')))
$$;
revoke execute on function app.designer_allowed(uuid, boolean) from public;
grant execute on function app.designer_allowed(uuid, boolean) to authenticated, service_role, crm_server, os_server, erp_server, platform_admin_server;

-- ---------------------------------------------------------------- changesets
create table core.design_changesets (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  branch_id uuid,                                       -- the branch the plan was made in (branch-level blocks)
  product_scope text[] not null default '{}',           -- products the ops touch
  source text not null default 'prompt' check (source in ('prompt', 'template')),
  template_key text,
  prompt text not null,                                 -- what the person typed (PII: may contain names; erasable)
  plan jsonb not null default '{}'::jsonb,              -- the validated changeset (ops refer to config by stable keys)
  preview jsonb not null default '{}'::jsonb,           -- plain-language preview + who is affected
  issues jsonb not null default '[]'::jsonb,            -- validation issues still open (status draft)
  status text not null default 'draft' check (status in ('draft', 'validated', 'published', 'reverted', 'rejected')),
  author_user_id uuid not null default app.uid(),
  author_kind text not null check (author_kind in ('org_admin', 'relationship_manager')),
  support_session_id uuid references core.support_sessions(id) on delete set null,
  approved_by_user_id uuid,                             -- who published it
  ai_generation_id uuid,                                -- core.ai_generations row of the planner call (credits)
  credits numeric(10,2) not null default 0,
  version integer,                                      -- set on publish: 1, 2, 3 ... per org
  published_at timestamptz,
  reverted_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid default app.uid(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (org_id, id),
  unique (org_id, version),
  foreign key (org_id, branch_id) references core.branches(org_id, id),
  check (product_scope <@ array['os', 'crm', 'erp', 'core']::text[]),
  check (author_kind <> 'relationship_manager' or support_session_id is not null),
  check ((status in ('published', 'reverted')) = (version is not null and published_at is not null)),
  check (status <> 'reverted' or reverted_at is not null)
);
create index design_changesets_org on core.design_changesets(org_id, created_at desc);
create index design_changesets_branch on core.design_changesets(org_id, branch_id);
create trigger trg_touch before update on core.design_changesets for each row execute function app.touch_updated_at();

create table core.design_changeset_items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  changeset_id uuid not null,
  seq integer not null check (seq > 0),
  product_key text not null check (product_key in ('os', 'crm', 'erp', 'core')),
  block_key text not null check (block_key ~ '^(os|crm|erp|core)\.[a-z][a-z0-9_]*$'),
  op text not null check (op in ('create', 'update', 'delete')),
  instance_key text not null,
  settings jsonb,                                       -- what was applied (null for delete)
  before jsonb,                                         -- the instance before (null = did not exist)
  after jsonb,                                          -- the instance after publishing (null = deleted)
  inverse jsonb not null,                               -- the undo operation
  applied_at timestamptz not null default now(),
  reverted_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid default app.uid(),
  updated_at timestamptz not null default now(),
  unique (org_id, id),
  unique (changeset_id, seq),
  foreign key (org_id, changeset_id) references core.design_changesets(org_id, id) on delete cascade
);
create index design_changeset_items_changeset on core.design_changeset_items(org_id, changeset_id);
create index design_changeset_items_instance on core.design_changeset_items(org_id, block_key, instance_key);
create trigger trg_touch before update on core.design_changeset_items for each row execute function app.touch_updated_at();

grant select, insert, update on core.design_changesets, core.design_changeset_items to authenticated, crm_server, os_server, erp_server;
grant select on core.design_changesets, core.design_changeset_items to platform_admin_server;

-- ---------------------------------------------------------------- RLS (platform wrapper + designer rule)
-- Read: org member with setup.view in any product AND app.designer_allowed (management, or an open support session).
-- Write: app.designer_allowed(org, write) only. No delete: published history stays (the org's deletion cascades).
select app.apply_core_rls('design_changesets', 'permission', '*', 'setup', null, 'app.designer_allowed(org_id, false)');
select app.apply_core_rls('design_changeset_items', 'permission', '*', 'setup', null, 'app.designer_allowed(org_id, false)');
do $$
declare t text;
begin
  foreach t in array array['design_changesets', 'design_changeset_items'] loop
    execute format('drop policy ins on core.%I', t);
    execute format('drop policy upd on core.%I', t);
    execute format('drop policy del on core.%I', t);
    execute format('create policy ins on core.%I for insert with check (org_id = app.current_org_id() and app.user_has_any_product(org_id) and app.designer_allowed(org_id, true))', t);
    execute format('create policy upd on core.%I for update using (org_id = app.current_org_id() and app.user_has_any_product(org_id) and app.designer_allowed(org_id, true)) with check (org_id = app.current_org_id() and app.user_has_any_product(org_id) and app.designer_allowed(org_id, true))', t);
  end loop;
end $$;
-- The author of a new changeset is the signed-in person (no planting a plan in someone else's name).
create policy ins_author on core.design_changesets as restrictive for insert with check (author_user_id = app.uid());

-- ---------------------------------------------------------------- AI price (one designer plan = 1 credit, AutoEd default)
insert into billing.ai_action_costs (org_id, action, credits, included, daily_fair_use, model_tier)
values (null, 'designer_plan', 1, false, null, 'strong')
on conflict (org_id, action) do nothing;

-- ---------------------------------------------------------------- compliance registry (catalogue test)
-- The prompt can name people ("Mrs Rao approves..."): it is personal data of the author, erased by anonymising the
-- text. The changeset itself (configuration) is the school's record and is kept.
insert into core.pii_registry (schema_name, table_name, person_type, key_column, contact_columns, is_subject, link_columns,
                               pii_columns, audit_columns, anonymise_values, erasure_mode, retain_reason, erase_order, note)
values
  ('core', 'design_changesets', 'staff', 'author_user_id', '{}', false, '{}', array['prompt'], '{}',
   '{"prompt":"[erased]"}'::jsonb, 'anonymise', null, 100, 'Designer requests typed by the staff member (prompt text may name people).'),
  ('core', 'design_changesets', 'staff', 'approved_by_user_id', '{}', false, '{}', array['approved_by_user_id'], '{}',
   '{}'::jsonb, 'anonymise', null, 100, 'Designer changesets the staff member published.');
