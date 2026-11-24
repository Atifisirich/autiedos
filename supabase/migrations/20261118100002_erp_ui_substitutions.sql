-- ERP staff UI: substitutions for schools that do not have the OS product.
-- docs/MAP-TABLES.md B.11: the ERP's substitution screen writes only when the organisation has no OS (os.substitutions is the OS's table and is
-- invisible to ERP users). erp.substitutions is that fallback: one row per uncovered period, covered by another teacher.
-- Same conventions as the generated tables (R3 standard columns, composite organisation foreign keys, apply_rls through the 'timetable' module).

-- 'timetable' is a permission module the ERP roles already hold (erp.seed_roles); register it so apply_rls accepts it for an erp table.
insert into core.product_modules (product_key, module_key, name) values ('erp', 'timetable', 'Timetable') on conflict do nothing;

create table erp.substitutions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default app.current_org_id() references core.organizations(id) on delete cascade,
  branch_id uuid default erp.my_branch_id(),
  date date not null,
  period_seq integer not null,
  section_id uuid not null,
  subject_id uuid,
  absent_staff_id uuid not null,
  substitute_staff_id uuid,
  status text not null default 'suggested' check (status in ('suggested', 'assigned', 'declined', 'cancelled')),
  reason text,
  note text,
  created_at timestamptz not null default now(),
  created_by uuid default app.uid(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (org_id, id),
  unique (org_id, date, period_seq, section_id),
  foreign key (org_id, branch_id) references core.branches(org_id, id),
  foreign key (org_id, section_id) references core.sections(org_id, id) on delete cascade,
  foreign key (org_id, subject_id) references core.subjects(org_id, id),
  foreign key (org_id, absent_staff_id) references core.staff(org_id, id) on delete cascade,
  foreign key (org_id, substitute_staff_id) references core.staff(org_id, id)
);
create index substitutions_branch on erp.substitutions(org_id, branch_id);
create index substitutions_subject on erp.substitutions(org_id, subject_id);
create index substitutions_section on erp.substitutions(org_id, section_id);
create index substitutions_absent on erp.substitutions(org_id, absent_staff_id);
create index substitutions_substitute on erp.substitutions(org_id, substitute_staff_id);
create index substitutions_date on erp.substitutions(org_id, date);
create trigger trg_touch before update on erp.substitutions for each row execute function app.touch_updated_at();
select app.apply_rls(p_schema => 'erp', p_table => 'substitutions', p_kind => 'product', p_product => 'erp', p_module => 'timetable');
-- every ERP staff user sees the cover list (a teacher must see the periods they cover); changes need timetable.create / edit
create policy sel_staff_any on erp.substitutions for select
  using (org_id = app.current_org_id() and app.user_has_product(org_id, 'erp') and (branch_id is null or branch_id = any(app.user_branch_ids())) and app.my_member_kind() in ('staff','support'));
comment on table erp.substitutions is 'erp product data (hand-written, 20261118100002). module: timetable. Fallback for schools without the OS product (MAP B.11).';
