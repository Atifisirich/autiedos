-- AutoEd OS on the shared platform (4/6): platform settings, AI generations and the AI credit wallet, OS jobs.
--
-- MAP-TABLES: platform_settings -> core.platform_settings, ai_generations -> core.ai_generations,
-- ai_action_costs / ai_credit_ledger / credit_topup_requests -> billing.*, branch_subscriptions -> core.subscriptions
-- + billing.ai_allowances (OQ-11). Decision 40 / OQ-11: ONE AI wallet per client org shared by its products; ledger
-- rows keep branch_id and staff_id for reporting and per-branch / per-teacher caps.
--
-- The product servers have no grant on `billing` (ADR 001), so the OS reaches the wallet only through the
-- security definer functions app.ai_* below; platform_admin_server writes top-ups and plans directly.
-- Global rows (org_id null: AutoEd defaults) of core.platform_settings and billing.ai_action_costs are read only
-- through app.platform_setting() / app.ai_costs(); an org row overrides the global one.

-- ---------------------------------------------------------------- core.platform_settings
create table core.platform_settings (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references core.organizations(id) on delete cascade,   -- null = AutoEd default
  key text not null check (key ~ '^[a-z][a-z0-9_]*$'),
  value jsonb not null,
  created_at timestamptz not null default now(),
  created_by uuid default app.uid(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (org_id, id),
  unique nulls not distinct (org_id, key)
);
create index platform_settings_org on core.platform_settings(org_id);
create trigger trg_touch before update on core.platform_settings for each row execute function app.touch_updated_at();
grant select, insert, update, delete on core.platform_settings to authenticated, crm_server, os_server, erp_server, platform_admin_server;
select app.apply_core_rls('platform_settings', 'permission', '*', 'setup', null, null);
create policy platform_admin on core.platform_settings for all using (org_id is null and app.is_platform_admin())
  with check (org_id is null and app.is_platform_admin());

create or replace function app.platform_setting(p_key text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select s.value from core.platform_settings s
   where s.key = p_key and s.deleted_at is null and (s.org_id is null or s.org_id = app.current_org_id())
   order by s.org_id nulls last limit 1
$$;

insert into core.platform_settings (org_id, key, value) values
  (null, 'ai_models', '{"strong":"PLACEHOLDER_GEMINI_STRONG_MODEL_ID","fast":"PLACEHOLDER_GEMINI_FAST_MODEL_ID","prices":null}'::jsonb),
  (null, 'credit_warnings', '{"levels":[80,95]}'::jsonb);

-- ---------------------------------------------------------------- core.ai_generations
create table core.ai_generations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  branch_id uuid,
  product_key text not null references core.products(key),
  user_id uuid,
  staff_id uuid,
  action text not null,
  model text not null,
  provider text not null,
  input jsonb not null,
  output jsonb,
  status text not null check (status in ('ok','invalid','failed','blocked')),
  attempts integer not null default 1,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  provider_cost numeric(12,6) not null default 0,
  credits numeric(10,2) not null default 0,
  error text,
  linked_type text,
  linked_id uuid,
  created_at timestamptz not null default now(),
  created_by uuid default app.uid(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (org_id, id),
  foreign key (org_id, branch_id) references core.branches(org_id, id),
  foreign key (org_id, staff_id) references core.staff(org_id, id)
);
create index ai_generations_branch_id on core.ai_generations(org_id, branch_id);
create index ai_generations_staff_id on core.ai_generations(org_id, staff_id, action, created_at);
create trigger trg_touch before update on core.ai_generations for each row execute function app.touch_updated_at();
grant select, insert, update, delete on core.ai_generations to authenticated, crm_server, os_server, erp_server;
grant select on core.ai_generations to platform_admin_server;
select app.apply_core_rls('ai_generations', 'permission', '*', 'ai', 'user_id = app.uid()', null);

-- ---------------------------------------------------------------- billing: AI plans, costs, allowances, ledger
alter table billing.plans
  add column ai_monthly_credits numeric(12,2) not null default 0,
  add column ai_carry_forward boolean not null default false,
  add column whatsapp_included integer not null default 0;
insert into billing.plans (key, product_key, name, billing_interval, price_paise, sac_code, ai_monthly_credits, ai_carry_forward, whatsapp_included) values
  ('os_starter', 'os', 'OS Starter', 'month', 0, '998314', 300, false, 500),
  ('os_growth', 'os', 'OS Growth', 'month', 0, '998314', 1000, false, 2000),
  ('os_scale', 'os', 'OS Scale', 'month', 0, '998314', 3000, true, 6000)
on conflict (key) do nothing;

create table billing.ai_action_costs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references core.organizations(id) on delete cascade,   -- null = AutoEd price list
  action text not null,
  credits numeric(10,2) not null,
  included boolean not null default false,
  daily_fair_use integer,
  model_tier text not null default 'strong' check (model_tier in ('strong','fast')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique nulls not distinct (org_id, action)
);
insert into billing.ai_action_costs (org_id, action, credits, included, daily_fair_use, model_tier) values
  (null, 'daily_plan', 1, false, null, 'strong'),
  (null, 'section_rewrite', 0.2, false, null, 'fast'),
  (null, 'companion', 1, false, null, 'strong'),
  (null, 'unit_plan', 3, false, null, 'strong'),
  (null, 'annual_plan', 5, false, null, 'strong'),
  (null, 'question_paper', 5, false, null, 'strong'),
  (null, 'recovery_plan', 2, false, null, 'strong'),
  (null, 'weekly_insight', 0, true, null, 'strong'),
  (null, 'ask_question', 0, true, 30, 'fast'),
  (null, 'help_bot', 0, true, 50, 'fast');

-- One wallet per org (branch_id null) with optional per-branch rows for caps.
create table billing.ai_allowances (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  branch_id uuid,
  plan_key text references billing.plans(key),
  monthly_credits numeric(12,2) not null default 0,
  carry_forward boolean not null default false,
  teacher_monthly_cap numeric(10,2),
  branch_monthly_cap numeric(12,2),
  starts_on date not null default current_date,
  ends_on date,
  status text not null default 'active' check (status in ('active','paused','ended')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (org_id, branch_id) references core.branches(org_id, id) on delete cascade
);
create unique index ai_allowances_live on billing.ai_allowances(org_id, coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid)) where status = 'active';

create table billing.ai_credit_ledger (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  branch_id uuid,
  staff_id uuid,
  product_key text not null default 'os' references core.products(key),
  kind text not null check (kind in ('allowance','usage','topup','adjustment','expiry')),
  action text,
  period text not null check (period ~ '^[0-9]{4}-[0-9]{2}$'),
  credits numeric(10,2) not null,
  generation_id uuid unique,
  tokens integer not null default 0,
  provider_cost numeric(12,6) not null default 0,
  note text,
  created_at timestamptz not null default now(),
  foreign key (org_id, generation_id) references core.ai_generations(org_id, id)
);
create index ai_credit_ledger_period on billing.ai_credit_ledger(org_id, period);
create unique index ai_credit_ledger_allowance on billing.ai_credit_ledger(org_id, period) where kind = 'allowance';

create table billing.credit_topup_requests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  branch_id uuid,
  requested_by_user_id uuid,
  requested_by_staff_id uuid,
  credits numeric(10,2) not null check (credits > 0),
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index credit_topup_requests_org on billing.credit_topup_requests(org_id, status);

do $$
declare t text;
begin
  foreach t in array array['ai_action_costs','ai_allowances','ai_credit_ledger','credit_topup_requests'] loop
    execute format('alter table billing.%I enable row level security', t);
    execute format('create policy sel on billing.%I for select using (app.is_platform_admin() or (org_id = app.current_org_id() and app.can_any_product(''billing'', ''view'', org_id)))', t);
    execute format('create policy wr on billing.%I for all using (app.is_platform_admin()) with check (app.is_platform_admin())', t);
    perform app.enable_audit('billing', t);
  end loop;
end $$;
grant select on billing.ai_action_costs, billing.ai_allowances, billing.ai_credit_ledger, billing.credit_topup_requests to authenticated, platform_admin_server;
grant insert, update, delete on billing.ai_action_costs, billing.ai_allowances, billing.ai_credit_ledger, billing.credit_topup_requests to platform_admin_server;
grant all on billing.ai_action_costs, billing.ai_allowances, billing.ai_credit_ledger, billing.credit_topup_requests to service_role;

-- ---------------------------------------------------------------- wallet functions (security definer)
-- Costs: the org's override of each action, else the AutoEd price.
create or replace function app.ai_costs() returns table (action text, credits numeric, included boolean, daily_fair_use integer, model_tier text)
language sql stable security definer set search_path = '' as $$
  select distinct on (c.action) c.action, c.credits, c.included, c.daily_fair_use, c.model_tier
    from billing.ai_action_costs c
   where c.org_id is null or (c.org_id = app.current_org_id() and app.user_has_any_product(c.org_id))
   order by c.action, c.org_id nulls last
$$;

-- Ensures the period's allowance row of the caller's org (carry-forward when the allowance allows it).
create or replace function app.ai_ensure_allowance(p_period text) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_org uuid := app.current_org_id();
  a billing.ai_allowances;
  v_carry numeric := 0;
begin
  if v_org is null or not app.user_has_any_product(v_org) then return; end if;
  if exists (select 1 from billing.ai_credit_ledger l where l.org_id = v_org and l.period = p_period and l.kind = 'allowance') then return; end if;
  select * into a from billing.ai_allowances x where x.org_id = v_org and x.branch_id is null and x.status = 'active' limit 1;
  if a.id is null then return; end if;
  if a.carry_forward then
    select greatest(0, coalesce(sum(l.credits), 0)) into v_carry from billing.ai_credit_ledger l where l.org_id = v_org and l.period < p_period;
  end if;
  insert into billing.ai_credit_ledger (org_id, kind, period, credits, note)
  values (v_org, 'allowance', p_period, a.monthly_credits + v_carry,
          case when v_carry > 0 then 'Monthly allowance + ' || v_carry || ' carried forward' else 'Monthly allowance' end)
  on conflict do nothing;
end $$;

-- Wallet state of the caller's org for a period, with the caller-relevant caps.
create or replace function app.ai_credit_state(p_period text, p_staff uuid default null, p_branch uuid default null)
returns table (granted numeric, used numeric, teacher_used numeric, teacher_cap numeric, branch_used numeric, branch_cap numeric)
language sql stable security definer set search_path = '' as $$
  select coalesce(sum(l.credits) filter (where l.credits > 0), 0),
         coalesce(-sum(l.credits) filter (where l.credits < 0), 0),
         coalesce(-sum(l.credits) filter (where l.credits < 0 and l.staff_id = p_staff), 0),
         (select a.teacher_monthly_cap from billing.ai_allowances a where a.org_id = app.current_org_id() and a.status = 'active'
           and (a.branch_id is null or a.branch_id = p_branch) order by a.branch_id nulls last limit 1),
         coalesce(-sum(l.credits) filter (where l.credits < 0 and l.branch_id = p_branch), 0),
         (select a.branch_monthly_cap from billing.ai_allowances a where a.org_id = app.current_org_id() and a.status = 'active' and a.branch_id = p_branch limit 1)
    from billing.ai_credit_ledger l
   where l.org_id = app.current_org_id() and app.user_has_any_product(l.org_id) and l.period = p_period
$$;

-- Charges a successful generation of the caller's org exactly once (amount taken from the generation row).
create or replace function app.ai_charge(p_generation uuid, p_period text) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  g core.ai_generations;
begin
  select * into g from core.ai_generations x where x.id = p_generation and x.org_id = app.current_org_id();
  if g.id is null or not app.user_has_product(g.org_id, g.product_key) then
    raise exception 'unknown generation' using errcode = '42501';
  end if;
  if g.status <> 'ok' or g.credits <= 0 then return; end if;
  insert into billing.ai_credit_ledger (org_id, branch_id, staff_id, product_key, kind, action, period, credits, generation_id, tokens, provider_cost)
  values (g.org_id, g.branch_id, g.staff_id, g.product_key, 'usage', g.action, p_period, -g.credits, g.id, g.input_tokens + g.output_tokens, g.provider_cost)
  on conflict (generation_id) do nothing;
end $$;

-- Usage report for the credits screen (needs ai.view in a product, or the OS system actor).
create or replace function app.ai_usage(p_period text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_org uuid := app.current_org_id();
begin
  if v_org is null or not (app.can_any_product('ai', 'view', v_org) or os.staff_perm_rank(os.my_staff_id(), 'ai', 'view') >= 5 or os.is_system()) then
    raise exception 'ai.view required' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'by_action', (select coalesce(jsonb_agg(x order by x.credits desc), '[]') from (
        select l.action, -sum(l.credits) as credits, count(*)::int as uses from billing.ai_credit_ledger l
         where l.org_id = v_org and l.period = p_period and l.kind = 'usage' group by l.action) x),
    'by_teacher', (select coalesce(jsonb_agg(x order by x.credits desc), '[]') from (
        select s.full_name, -sum(l.credits) as credits from billing.ai_credit_ledger l join core.staff s on s.id = l.staff_id
         where l.org_id = v_org and l.period = p_period and l.kind = 'usage' group by s.full_name limit 50) x),
    'ledger', (select coalesce(jsonb_agg(x order by x.created_at desc), '[]') from (
        select l.created_at, l.kind, l.action, l.credits, l.note, s.full_name, b.name as branch from billing.ai_credit_ledger l
          left join core.staff s on s.id = l.staff_id left join core.branches b on b.id = l.branch_id
         where l.org_id = v_org and l.period = p_period order by l.created_at desc limit 200) x),
    'requests', (select coalesce(jsonb_agg(x order by x.created_at desc), '[]') from (
        select r.id, r.credits, r.status, r.note, r.created_at, r.branch_id from billing.credit_topup_requests r
         where r.org_id = v_org order by r.created_at desc limit 20) x));
end $$;

create or replace function app.ai_request_topup(p_credits numeric, p_note text, p_branch uuid default null) returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_org uuid := app.current_org_id();
  v_id uuid;
begin
  if v_org is null or not app.user_has_any_product(v_org) or app.my_member_kind() <> 'staff' then
    raise exception 'staff of a client org only' using errcode = '42501';
  end if;
  insert into billing.credit_topup_requests (org_id, branch_id, requested_by_user_id, requested_by_staff_id, credits, note)
  values (v_org, p_branch, auth.uid(), app.my_core_staff_id(), p_credits, p_note) returning id into v_id;
  return v_id;
end $$;

-- ---------------------------------------------------------------- OS jobs on private.jobs (plan 4.10)
-- The OS de-duplicates scheduled work ("one escalation per task and level"): a nullable key, unique per product.
alter table private.jobs add column dedupe_key text;
create unique index jobs_dedupe on private.jobs(product_key, dedupe_key) where dedupe_key is not null;

-- Enqueue an OS job for the caller's org (user or system actor). Duplicate keys are ignored (returns null).
create or replace function os.enqueue_job(p_kind text, p_payload jsonb, p_run_at timestamptz default now(),
  p_dedupe_key text default null, p_max_attempts integer default 5) returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_org uuid := app.current_org_id();
  v_id uuid;
begin
  if not app.user_has_product(v_org, 'os') then
    raise exception 'product os is not available' using errcode = '42501';
  end if;
  insert into private.jobs (org_id, product_key, kind, payload, run_at, dedupe_key, max_attempts)
  values (v_org, 'os', p_kind, coalesce(p_payload, '{}'::jsonb), coalesce(p_run_at, now()), p_dedupe_key, coalesce(p_max_attempts, 5))
  on conflict do nothing returning id into v_id;
  return v_id;
end $$;
