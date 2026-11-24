-- AutoEd CRM port (3/6): campaigns, two-way family inbox, workflows, imports, Meta lead log.
-- Templates -> core.message_templates (product_key 'crm'), notifications -> core.notifications, push tokens ->
-- core.device_tokens, api_keys/webhooks -> core.api_keys/core.webhooks, custom fields -> core.custom_fields,
-- jobs -> private.jobs, audit_events -> audit.log: nothing is created for those here.

create table crm.campaigns (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  name text not null,
  channel text not null check (channel in ('whatsapp','sms','email')),
  template_id uuid,
  audience jsonb not null default '{}',
  status text not null default 'draft' check (status in ('draft','scheduled','sending','sent','cancelled')),
  stats jsonb not null default '{}',
  cost numeric(12,2) not null default 0,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid default app.uid(),               -- the author (CRM created_by)
  updated_at timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, template_id) references core.message_templates(org_id, id) on delete set null (template_id)
);
create index campaigns_template on crm.campaigns(org_id, template_id);
create trigger trg_touch before update on crm.campaigns for each row execute function app.touch_updated_at();
select app.apply_rls('crm', 'campaigns', 'product', 'crm', 'campaigns');

-- The family inbox. Provider delivery is also what core.outbox records (once the channel layer lands).
create table crm.messages (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  household_id uuid not null,
  enquiry_id uuid,
  channel text not null check (channel in ('whatsapp','sms','email','voice','app')),
  direction text not null check (direction in ('in','out')),
  body text not null,
  status text not null default 'sent' check (status in ('queued','sent','delivered','read','failed','received')),
  fail_reason text,
  campaign_id uuid,
  sender_id uuid,                                    -- auth user id of the sender; null = automation
  is_note boolean not null default false,
  read boolean not null default false,
  provider_id text,
  delivered_at timestamptz,
  read_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid default app.uid(),
  updated_at timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, household_id) references crm.households(org_id, id) on delete cascade,
  foreign key (org_id, enquiry_id) references crm.enquiries(org_id, id) on delete set null (enquiry_id),
  foreign key (org_id, campaign_id) references crm.campaigns(org_id, id) on delete set null (campaign_id)
);
create index messages_household on crm.messages(org_id, household_id, created_at);
create index messages_enquiry on crm.messages(org_id, enquiry_id);
create index messages_campaign on crm.messages(org_id, campaign_id);
create index messages_provider on crm.messages(provider_id) where provider_id is not null;
create trigger trg_touch before update on crm.messages for each row execute function app.touch_updated_at();
select crm.apply_rls_scoped('messages', 'leads',
  'exists (select 1 from crm.enquiries e where e.org_id = crm.messages.org_id and e.household_id = crm.messages.household_id)');

create table crm.workflows (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  recipe_key text,
  name text not null,
  description text,
  trigger text not null,
  conditions jsonb not null default '[]',
  steps jsonb not null default '[]',
  status text not null default 'draft' check (status in ('draft','published','paused')),
  version integer not null default 1,
  created_at timestamptz not null default now(),
  created_by uuid default app.uid(),
  updated_at timestamptz not null default now(),
  unique (org_id, id)
);
create trigger trg_touch before update on crm.workflows for each row execute function app.touch_updated_at();
select app.apply_rls('crm', 'workflows', 'product', 'crm', 'workflows');

create table crm.workflow_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  workflow_id uuid not null,
  enquiry_id uuid,
  status text not null default 'running' check (status in ('running','completed','cancelled','error','tested')),
  entry_stage_id uuid,
  log jsonb not null default '[]',
  test boolean not null default false,
  created_at timestamptz not null default now(),
  created_by uuid default app.uid(),
  updated_at timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, workflow_id) references crm.workflows(org_id, id) on delete cascade,
  foreign key (org_id, enquiry_id) references crm.enquiries(org_id, id) on delete cascade
);
create index workflow_runs_workflow on crm.workflow_runs(org_id, workflow_id, enquiry_id, status);
create index workflow_runs_enquiry on crm.workflow_runs(org_id, enquiry_id);
create trigger trg_touch before update on crm.workflow_runs for each row execute function app.touch_updated_at();
select crm.apply_rls_scoped('workflow_runs', 'workflows',
  'crm.workflow_runs.enquiry_id is null or exists (select 1 from crm.enquiries e where e.org_id = crm.workflow_runs.org_id and e.id = crm.workflow_runs.enquiry_id)');

create table crm.import_batches (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  file_name text,
  total integer not null default 0,
  created integer not null default 0,
  duplicates integer not null default 0,
  failed integer not null default 0,
  status text not null default 'done',
  created_at timestamptz not null default now(),
  created_by uuid default app.uid(),
  updated_at timestamptz not null default now(),
  unique (org_id, id)
);
create trigger trg_touch before update on crm.import_batches for each row execute function app.touch_updated_at();
select app.apply_rls('crm', 'import_batches', 'product', 'crm', 'data');

create table crm.import_rows (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  batch_id uuid not null,
  data jsonb not null,
  status text not null,
  error text,
  match_household_id uuid,
  enquiry_id uuid,
  created_at timestamptz not null default now(),
  created_by uuid default app.uid(),
  unique (org_id, id),
  foreign key (org_id, batch_id) references crm.import_batches(org_id, id) on delete cascade,
  foreign key (org_id, match_household_id) references crm.households(org_id, id) on delete set null (match_household_id),
  foreign key (org_id, enquiry_id) references crm.enquiries(org_id, id) on delete set null (enquiry_id)
);
create index import_rows_batch on crm.import_rows(org_id, batch_id);
create index import_rows_household on crm.import_rows(org_id, match_household_id);
create index import_rows_enquiry on crm.import_rows(org_id, enquiry_id);
select app.apply_rls('crm', 'import_rows', 'product', 'crm', 'data');

-- Leads received from Meta lead ads; keeps a retried webhook from creating a second enquiry. leadgen_id is the key.
create table crm.meta_leads (
  leadgen_id text primary key,
  org_id uuid not null references core.organizations(id) on delete cascade,
  enquiry_id uuid,
  status text not null,
  detail text,
  created_at timestamptz not null default now(),
  created_by uuid default app.uid(),
  unique (org_id, leadgen_id),
  foreign key (org_id, enquiry_id) references crm.enquiries(org_id, id) on delete set null (enquiry_id)
);
create index meta_leads_enquiry on crm.meta_leads(org_id, enquiry_id);
select app.apply_rls('crm', 'meta_leads', 'product', 'crm', 'leads');
