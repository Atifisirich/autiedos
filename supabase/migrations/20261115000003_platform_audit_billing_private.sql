-- AutoEd platform foundation (3/6): audit, billing and private tables.

-- ---------------------------------------------------------------- audit (plan rule 6)
-- Insert-only, written by security definer triggers and functions. org_id has no foreign key so the
-- history survives deleting an organisation. support_session_id marks actions done while "viewing as".
create table audit.log (
  id bigint generated always as identity primary key,
  org_id uuid,
  branch_id uuid,
  actor_user_id uuid,
  support_session_id uuid,
  action text not null,               -- 'insert' | 'update' | 'delete' | event name such as 'support_session.start'
  schema_name text,
  table_name text,
  row_id uuid,
  before jsonb,
  after jsonb,
  detail jsonb,
  created_at timestamptz not null default now()
);
create index audit_log_org on audit.log(org_id, created_at desc);
create index audit_log_row on audit.log(schema_name, table_name, row_id);

create table audit.config_history (
  id bigint generated always as identity primary key,
  org_id uuid not null,
  branch_id uuid,
  schema_name text not null,
  table_name text not null,
  row_id uuid,
  action text not null check (action in ('insert','update','delete')),
  before jsonb,
  after jsonb,
  actor_user_id uuid,
  support_session_id uuid,
  created_at timestamptz not null default now()
);
create index config_history_org on audit.config_history(org_id, created_at desc);

-- ---------------------------------------------------------------- billing (decision 32: Razorpay + GST)
-- Amounts are integer paise. Built late; these are the shapes the Razorpay integration fills.
create table billing.plans (                       -- global price list (no org_id: reviewed)
  key text primary key check (key ~ '^[a-z][a-z0-9_]*$'),
  product_key text not null references core.products(key),
  name text not null,
  billing_interval text not null check (billing_interval in ('month','year')),
  price_paise bigint not null check (price_paise >= 0),
  currency text not null default 'INR' check (currency = 'INR'),
  sac_code text,                                   -- services accounting code printed on the invoice
  gst_rate numeric(5,2) not null default 18.00 check (gst_rate >= 0 and gst_rate <= 28),
  razorpay_plan_id text unique,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- One billing profile per client org (who is invoiced, place of supply).
create table billing.accounts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null unique references core.organizations(id) on delete cascade,
  legal_name text not null,
  gstin text check (gstin is null or gstin ~ '^[0-9]{2}[A-Z0-9]{10}[0-9A-Z]Z[0-9A-Z]$'),
  state_code text not null check (state_code ~ '^[0-9]{2}$'),
  billing_email text,
  address text,
  razorpay_customer_id text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table billing.razorpay_subscriptions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  subscription_id uuid not null references core.subscriptions(id) on delete cascade,
  plan_key text not null references billing.plans(key),
  razorpay_subscription_id text not null unique,
  status text not null,                            -- mirrors Razorpay: created, authenticated, active, pending, halted, cancelled, completed
  current_start timestamptz,
  current_end timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- GST tax invoice. Intra-state supply: CGST + SGST; inter-state: IGST (checked below).
create table billing.invoices (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  invoice_number text not null unique,             -- sequential per financial year, e.g. AE/2026-27/000123
  financial_year text not null check (financial_year ~ '^[0-9]{4}-[0-9]{2}$'),
  invoice_date date not null,
  status text not null default 'draft' check (status in ('draft','issued','paid','void')),
  supplier_gstin text,
  supplier_state_code text not null check (supplier_state_code ~ '^[0-9]{2}$'),
  customer_legal_name text not null,
  customer_gstin text,
  place_of_supply text not null check (place_of_supply ~ '^[0-9]{2}$'),
  taxable_paise bigint not null check (taxable_paise >= 0),
  cgst_paise bigint not null default 0 check (cgst_paise >= 0),
  sgst_paise bigint not null default 0 check (sgst_paise >= 0),
  igst_paise bigint not null default 0 check (igst_paise >= 0),
  total_paise bigint not null,
  currency text not null default 'INR' check (currency = 'INR'),
  razorpay_invoice_id text unique,
  pdf_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (total_paise = taxable_paise + cgst_paise + sgst_paise + igst_paise),
  check (case when supplier_state_code = place_of_supply then igst_paise = 0 else cgst_paise = 0 and sgst_paise = 0 end),
  unique (org_id, id)
);

create table billing.invoice_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  invoice_id uuid not null,
  product_key text references core.products(key),
  description text not null,
  sac_code text,
  quantity numeric(12,3) not null default 1 check (quantity > 0),
  unit_paise bigint not null check (unit_paise >= 0),
  taxable_paise bigint not null check (taxable_paise >= 0),
  gst_rate numeric(5,2) not null check (gst_rate >= 0 and gst_rate <= 28),
  foreign key (org_id, invoice_id) references billing.invoices(org_id, id) on delete cascade
);

create table billing.payments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  invoice_id uuid,
  razorpay_order_id text,
  razorpay_payment_id text unique,
  amount_paise bigint not null check (amount_paise > 0),
  currency text not null default 'INR' check (currency = 'INR'),
  method text,
  status text not null check (status in ('created','authorized','captured','failed','refunded')),
  captured_at timestamptz,
  raw jsonb,
  created_at timestamptz not null default now(),
  foreign key (org_id) references core.organizations(id) on delete cascade,
  foreign key (org_id, invoice_id) references billing.invoices(org_id, id)
);

-- Metered usage per org per product (AI credits, WhatsApp messages ...), billed or capped later.
create table billing.usage (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  product_key text references core.products(key),
  metric text not null check (metric in ('ai_credits','whatsapp_messages','sms','email','storage_mb')),
  quantity numeric(14,3) not null,
  period_start date not null,
  period_end date not null check (period_end >= period_start),
  source_ref text,
  created_at timestamptz not null default now()
);
create index usage_org_period on billing.usage(org_id, period_start);

do $$
declare t text;
begin
  foreach t in array array['accounts','razorpay_subscriptions','invoices'] loop
    execute format('create trigger trg_touch before update on billing.%I for each row execute function app.touch_updated_at()', t);
  end loop;
end $$;

-- ---------------------------------------------------------------- private (never exposed)
-- Every job carries org_id and product_key; private.claim_jobs re-checks the subscription before a job
-- runs (plan 4.10, test T11).
create table private.jobs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  product_key text not null references core.products(key),
  kind text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'queued' check (status in ('queued','running','done','failed','skipped')),
  run_at timestamptz not null default now(),
  attempts integer not null default 0,
  max_attempts integer not null default 5,
  locked_at timestamptz,
  locked_by text,
  last_error text,
  skip_reason text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index jobs_due on private.jobs(product_key, run_at) where status = 'queued';

-- Fixed-window counters (login attempts, OTP sends, API calls). org_id is null for pre-login keys.
create table private.rate_limits (
  key text not null,
  window_start timestamptz not null,
  org_id uuid,
  hits integer not null default 0,
  primary key (key, window_start)
);

-- Inbound webhooks (Razorpay, WhatsApp) stored once for idempotent processing.
create table private.webhook_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  event_id text not null,
  org_id uuid,
  payload jsonb not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  unique (provider, event_id)
);
