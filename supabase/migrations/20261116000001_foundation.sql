-- AutoEd OS — foundation: extensions, helper schema, platform tables.
create extension if not exists pgcrypto;
create extension if not exists vector;

create schema if not exists app;
grant usage on schema app to authenticated, service_role;

-- updated_at maintenance
create or replace function app.touch_updated_at() returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- Adds the standard columns (section 9.1) to a table if missing, plus updated_at trigger
-- and indexes on org_id / branch_id.
create or replace function app.standardize(p_table text) returns void language plpgsql as $$
declare
  has_org boolean;
  has_branch boolean;
begin
  execute format('alter table public.%I add column if not exists created_at timestamptz not null default now()', p_table);
  execute format('alter table public.%I add column if not exists created_by uuid default auth.uid()', p_table);
  execute format('alter table public.%I add column if not exists updated_at timestamptz not null default now()', p_table);
  execute format('alter table public.%I add column if not exists deleted_at timestamptz', p_table);
  execute format('drop trigger if exists trg_touch_%1$s on public.%1$I', p_table);
  execute format('create trigger trg_touch_%1$s before update on public.%1$I for each row execute function app.touch_updated_at()', p_table);
  select exists(select 1 from information_schema.columns where table_schema='public' and table_name=p_table and column_name='org_id') into has_org;
  select exists(select 1 from information_schema.columns where table_schema='public' and table_name=p_table and column_name='branch_id') into has_branch;
  if has_org then
    execute format('create index if not exists idx_%1$s_org on public.%1$I(org_id)', p_table);
  end if;
  if has_branch then
    execute format('create index if not exists idx_%1$s_branch on public.%1$I(branch_id)', p_table);
  end if;
end $$;

-- ---------------------------------------------------------------- platform (Digivate)
create table public.plans (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  name text not null,
  monthly_credits numeric(12,2) not null default 0,
  carry_forward boolean not null default false,
  whatsapp_included integer not null default 0,
  price_note text,
  active boolean not null default true
);
select app.standardize('plans');

create table public.platform_admins (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique,
  name text not null
);
select app.standardize('platform_admins');

-- Editable cost table for AI actions (section 8.5)
create table public.ai_action_costs (
  id uuid primary key default gen_random_uuid(),
  action text not null unique,
  credits numeric(10,2) not null,
  included boolean not null default false,
  daily_fair_use integer,
  model_tier text not null default 'strong' check (model_tier in ('strong','fast'))
);
select app.standardize('ai_action_costs');

-- Platform settings (model ids, adapters). Key/value.
create table public.platform_settings (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  value jsonb not null
);
select app.standardize('platform_settings');

insert into public.plans (key, name, monthly_credits, carry_forward, whatsapp_included) values
  ('starter', 'Starter', 300, false, 500),
  ('growth', 'Growth', 1000, false, 2000),
  ('scale', 'Scale', 3000, true, 6000);

insert into public.ai_action_costs (action, credits, included, daily_fair_use, model_tier) values
  ('daily_plan', 1, false, null, 'strong'),
  ('section_rewrite', 0.2, false, null, 'fast'),
  ('companion', 1, false, null, 'strong'),
  ('unit_plan', 3, false, null, 'strong'),
  ('annual_plan', 5, false, null, 'strong'),
  ('question_paper', 5, false, null, 'strong'),
  ('recovery_plan', 2, false, null, 'strong'),
  ('weekly_insight', 0, true, null, 'strong'),
  ('ask_question', 0, true, 30, 'fast'),
  ('help_bot', 0, true, 50, 'fast');

insert into public.platform_settings (key, value) values
  ('ai_models', '{"strong":"claude-opus-5-5","fast":"claude-haiku-5-5"}'::jsonb),
  ('credit_warnings', '{"levels":[80,95]}'::jsonb);
