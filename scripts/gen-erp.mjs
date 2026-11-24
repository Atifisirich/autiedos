#!/usr/bin/env node
// Generates the ERP migrations supabase/migrations/202611180000NN_erp_*.sql (schema `erp`) from
//   schema/erp-tables.mjs   the table definitions (the ERP's compact DSL, reduced to the tables MAP-TABLES assigns to erp)
//   schema/erp-roles.mjs    ERP capabilities and default roles -> erp.seed_roles(org)
//   schema/erp-sql/*.sql    hand-written functions and triggers (money, approvals, portal, HR), copied verbatim
// The generated SQL is committed; re-running must produce no diff:
//
//   node scripts/gen-erp.mjs             # writes the migrations
//   node scripts/gen-erp.mjs --summary   # prints the table list used in docs/erp-port.md
//
// Every table gets the R3 standard columns, unique (org_id, id), composite organisation foreign keys, indexes that
// start with org_id, the updated_at trigger, and policies through app.apply_rls(schema, table, 'product', 'erp', module)
// plus the portal / own-row policies the table options ask for. See schema/erp-tables.mjs for the option list.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FILES } from '../schema/erp-tables.mjs';
import { CAP_MODULES, ROLE_MATRIX, ROLE_NAMES } from '../schema/erp-roles.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIG = join(root, 'supabase/migrations');
const SQL_DIR = join(root, 'schema/erp-sql');
const PREFIX = '20261118';

// tables that live in core (ERP rows point at them with composite foreign keys)
const CORE_TABLES = new Set(['students', 'staff', 'households', 'guardians', 'programmes', 'sections', 'subjects', 'rooms', 'academic_years',
  'files', 'class_posts', 'events', 'approval_requests', 'branches', 'terms']);
const RESERVED = new Set(['user', 'order', 'group', 'limit', 'offset', 'end', 'from', 'to', 'table', 'check', 'default', 'desc', 'asc', 'all', 'and', 'any', 'array', 'as',
  'both', 'case', 'cast', 'collate', 'column', 'constraint', 'create', 'distinct', 'do', 'else', 'except', 'fetch', 'for', 'foreign', 'grant', 'having', 'in', 'into', 'leading',
  'not', 'null', 'on', 'only', 'or', 'placing', 'primary', 'references', 'returning', 'select', 'some', 'then', 'trailing', 'union', 'unique', 'using', 'when', 'where', 'with']);
const qid = (s) => (RESERVED.has(s) ? `"${s}"` : s);
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;
const REQUEST_ROLES = 'authenticated, erp_server';

// ------------------------------------------------------------------------------------------------ column parser
const TYPES = { text: 'text', int: 'integer', numeric: 'numeric', money: 'numeric(14,2)', bool: 'boolean', date: 'date', time: 'time', ts: 'timestamptz', jsonb: 'jsonb', uuid: 'uuid' };
function parseCol(spec) {
  let m = spec.match(/^(\w+)>(@?\w+)(!)?(?:=(.*))?$/);
  if (m) return { key: m[1], ref: m[2], req: !!m[3], def: m[4], type: 'uuid' };
  m = spec.match(/^(\w+)(?::(\w+))?(!)?(.*)$/);
  if (!m) throw new Error('bad column spec ' + spec);
  const type = m[2] ?? 'text';
  if (!TYPES[type]) throw new Error(`unknown type ${type} in ${spec}`);
  let rest = m[4];
  let opts;
  let def;
  const om = rest.match(/^\{([^}]*)\}(.*)$/);
  if (om) { opts = om[1].split('|'); rest = om[2]; }
  if (rest.startsWith('=')) def = rest.slice(1);
  else if (rest) throw new Error('bad column spec ' + spec);
  return { key: m[1], type, req: !!m[3], def, opts };
}

function defaultSql(c) {
  if (c.def === undefined || c.def === '') return '';
  if (c.def === 'now') return ' default now()';
  if (c.def === 'today') return ' default current_date';
  if (c.def === 'uid') return ' default app.uid()';
  if (c.type === 'text' || c.type === 'date' || c.type === 'time' || c.type === 'jsonb') return ` default ${lit(c.def)}${c.type === 'jsonb' ? '::jsonb' : ''}`;
  return ` default ${c.def}`;
}

// ------------------------------------------------------------------------------------------------ table emitter
const created = new Set(); // erp tables created so far
const pendingFks = new Map(); // target erp table -> [sql]
const allTables = FILES.flatMap((f) => f.tables);
const byName = new Map(allTables.map((t) => [t.name, t]));
if (byName.size !== allTables.length) throw new Error('duplicate table name');

function shortName(base) {
  return base.length <= 63 ? base : base.slice(0, 54) + '_' + (base.split('').reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7) % 100000);
}

function tableSql(t) {
  const T = `erp.${t.name}`;
  const cols = t.cols.map(parseCol);
  const lines = [
    'id uuid primary key default gen_random_uuid()',
    'org_id uuid not null default app.current_org_id() references core.organizations(id) on delete cascade',
  ];
  const cons = ['unique (org_id, id)'];
  const idx = [];
  const money = !!t.immutable || ['fee_demands', 'wallets'].includes(t.name);
  if (t.branch) {
    lines.push('branch_id uuid default erp.my_branch_id()');
    cons.push('foreign key (org_id, branch_id) references core.branches(org_id, id)');
    idx.push(`create index ${shortName(`${t.name}_branch`)} on ${T}(org_id, branch_id);`);
  }
  if (t.year) {
    lines.push('academic_year_id uuid');
    cons.push('foreign key (org_id, academic_year_id) references core.academic_years(org_id, id)');
    idx.push(`create index ${shortName(`${t.name}_academic_year`)} on ${T}(org_id, academic_year_id);`);
  }
  const deferred = [];
  for (const c of cols) {
    const ty = c.ref ? 'uuid' : TYPES[c.type];
    const notNull = c.req || (!c.ref && c.def !== undefined && c.def !== '' && c.def !== 'uid');
    let l = `${qid(c.key)} ${ty}${notNull ? ' not null' : ''}${defaultSql(c)}`;
    if (c.opts) l += ` check (${qid(c.key)} in (${c.opts.map(lit).join(', ')}))`;
    lines.push(l);
    if (!c.ref) continue;
    const onDel = money ? 'restrict' : c.req ? 'cascade' : `set null (${qid(c.key)})`;
    let fk;
    if (c.ref === '@users') {
      fk = `foreign key (org_id, ${qid(c.key)}) references core.org_users(org_id, user_id) on delete ${c.req ? 'cascade' : `set null (${qid(c.key)})`}`;
    } else if (CORE_TABLES.has(c.ref)) {
      fk = `foreign key (org_id, ${qid(c.key)}) references core.${c.ref}(org_id, id) on delete ${onDel}`;
    } else if (byName.has(c.ref)) {
      fk = `foreign key (org_id, ${qid(c.key)}) references erp.${c.ref}(org_id, id) on delete ${onDel}`;
      if (!created.has(c.ref) && c.ref !== t.name) {
        deferred.push({ target: c.ref, sql: `alter table ${T} add constraint ${shortName(`${t.name}_${c.key}_fk`)} ${fk};` });
        fk = null;
      }
    } else throw new Error(`${t.name}.${c.key}: unknown reference table ${c.ref}`);
    if (fk) cons.push(fk);
    idx.push(`create index ${shortName(`${t.name}_${c.key}`)} on ${T}(org_id, ${qid(c.key)});`);
  }
  lines.push('created_at timestamptz not null default now()', 'created_by uuid default app.uid()', 'updated_at timestamptz not null default now()', 'deleted_at timestamptz');
  for (const [i, f] of (t.fk ?? []).entries()) {
    const target = f[f.length - 1];
    const own = f.slice(0, -1);
    cons.push(`foreign key (${own.map(qid).join(', ')}) references ${target}(${own.map(qid).join(', ')})`);
    void i;
  }
  for (const u of t.unique ?? []) {
    const ucols = Array.isArray(u) ? u : u.cols;
    cons.push(`unique ${!Array.isArray(u) && u.nnd ? 'nulls not distinct ' : ''}(org_id, ${ucols.map(qid).join(', ')})`);
  }
  for (const ch of t.checks ?? []) cons.push(`check (${ch})`);
  const fkCols = new Set(cols.filter((c) => c.ref).map((c) => c.key));
  for (const ix of (t.index ?? []).filter((x) => !(x.length === 1 && fkCols.has(x[0])))) idx.push(`create index ${shortName(`${t.name}_${ix.join('_')}`)} on ${T}(org_id, ${ix.map(qid).join(', ')});`);

  const out = [];
  if (t.desc) out.push(`-- ${t.desc}`);
  out.push(`create table ${T} (\n  ${[...lines, ...cons].join(',\n  ')}\n);`);
  out.push(...idx);
  out.push(`create trigger trg_touch before update on ${T} for each row execute function app.touch_updated_at();`);
  out.push(...rlsSql(t));
  out.push(`comment on table ${T} is ${lit(`erp product data (generated by scripts/gen-erp.mjs). module: ${t.module}`)};`);
  created.add(t.name);
  for (const d of deferred) {
    const list = pendingFks.get(d.target) ?? [];
    list.push(d.sql);
    pendingFks.set(d.target, list);
  }
  for (const sql of pendingFks.get(t.name) ?? []) out.push(sql);
  pendingFks.delete(t.name);
  return out.join('\n');
}

// ------------------------------------------------------------------------------------------------ policies
function rlsSql(t) {
  const T = `erp.${t.name}`;
  const hasBranch = !!t.branch;
  const base = `org_id = app.current_org_id() and app.user_has_product(org_id, 'erp')`;
  const branchOk = hasBranch ? ` and (branch_id is null or branch_id = any(app.user_branch_ids()))` : '';
  const staffKind = `app.my_member_kind() in ('staff','support')`;
  const portalKind = `app.my_member_kind() in ('guardian','parent','student')`;
  // named arguments: in a database that still has the legacy OS overload app.apply_rls(text x6) a positional 5-text call is ambiguous
  const out = [`select app.apply_rls(p_schema => 'erp', p_table => ${lit(t.name)}, p_kind => 'product', p_product => 'erp', p_module => ${lit(t.module)});`];
  const pol = (name, cmd, expr, check) => out.push(`create policy ${name} on ${T} for ${cmd} ${cmd === 'insert' ? `with check (${expr})` : `using (${expr})${check ? ` with check (${check})` : ''}`};`);

  if (t.rpcOnly) {
    // no direct access: the table is read and saved through erp.<rpcOnly>() / erp.save_*() which log the view
    out.push(`drop policy sel on ${T}; drop policy ins on ${T}; drop policy upd on ${T}; drop policy del on ${T};`);
    pol('sel_closed', 'select', `app.user_has_product(org_id, 'erp') and false`);
    out.push(`drop trigger trg_platform_audit on ${T};`);
    out.push(`create trigger trg_platform_audit after insert or update or delete on ${T} for each row execute function erp.audit_row_redacted(${lit((t.redact ?? []).join(','))});`);
    out.push(`revoke insert, update, delete on ${T} from ${REQUEST_ROLES};`);
    out.push(`-- ${t.name} is reached only through erp.${t.rpcOnly}() (logged) and the matching erp.save_* function.`);
    return out;
  }
  if (t.noStaffRead) {
    out.push(`drop policy sel on ${T};`);
    pol('sel_staff', 'select', `${base}${branchOk} and app.can('erp', ${lit(t.module)}, 'view', org_id, ${hasBranch ? 'branch_id' : 'null::uuid'}, null::uuid) and (${t.staffSel})`);
  }
  if (t.noInsert) out.push(`drop policy ins on ${T};`);
  if (t.noDelete || t.immutable) out.push(`drop policy del on ${T};`);

  if (t.read === 'members') pol('sel_members', 'select', `${base}${branchOk}`);
  else if (t.read === 'staff') pol('sel_staff_any', 'select', `${base}${branchOk} and ${staffKind}`);
  else if (t.read) pol('sel_read', 'select', `${base}${branchOk} and (${t.read})`);
  for (const [i, e] of (t.extraSel ?? []).entries()) pol(`sel_extra${i + 1}`, 'select', `${base} and (${e})`);
  if (t.student) pol('sel_family', 'select', `${base} and ${qid(t.student)} = any(app.my_learner_ids())${t.famWhere ? ` and (${t.famWhere})` : ''}`);
  if (t.famSql) pol('sel_family', 'select', `${base} and (${t.famSql})`);
  if (t.staffOwn) pol('sel_staff_own', 'select', `${base} and app.my_member_kind() = 'staff' and ${qid(t.staffOwn)} = app.my_core_staff_id()`);
  if (t.own) pol('sel_own', 'select', `${base} and ${qid(t.own)} = app.uid()`);
  if (t.own && t.ownKind !== 'none') {
    const kind = t.ownKind === 'staff' ? ` and ${staffKind}` : '';
    const stud = t.student ? ` and (${staffKind} or ${qid(t.student)} = any(app.my_learner_ids()))` : '';
    pol('ins_own', 'insert', `${base}${branchOk} and ${qid(t.own)} = app.uid()${kind}${stud}${t.ownCheck ? ` and (${t.ownCheck})` : ''}`);
  }
  if (t.famIns) pol('ins_family', 'insert', `${base}${branchOk} and ${portalKind} and (${t.famIns})`);
  if (t.famInsSql) pol('ins_family', 'insert', `${base}${branchOk} and ${portalKind} and (${t.famInsSql})`);
  if (t.updCols) {
    pol('upd_own', 'update', `${base} and ${qid(t.own)} = app.uid()`, `${base} and ${qid(t.own)} = app.uid()`);
    out.push(`revoke update on ${T} from ${REQUEST_ROLES};`);
    out.push(`grant update (${t.updCols.join(', ')}) on ${T} to ${REQUEST_ROLES};`);
  }
  if (t.immutable) {
    out.push(`create trigger trg_immutable before update or delete on ${T} for each row execute function erp.immutable_rows(${lit(t.immutable.mutable.join(','))}, ${lit(t.immutable.fnOnly.join(','))});`);
  }
  if (t.fnOnly) out.push(`create trigger trg_fn_only before insert or update on ${T} for each row execute function erp.fn_only_columns(${lit(t.fnOnly.join(','))});`);
  if (t.markLock) out.push(`create trigger trg_marks_lock before insert or update or delete on ${T} for each row execute function erp.guard_marks();`);
  if (t.redact) {
    out.push(`drop trigger trg_platform_audit on ${T};`);
    out.push(`create trigger trg_platform_audit after insert or update or delete on ${T} for each row execute function erp.audit_row_redacted(${lit(t.redact.join(','))});`);
  }
  if (t.audit === false) out.push(`drop trigger trg_platform_audit on ${T}; -- telemetry table, listed in the harness catalogue exemptions`);
  return out;
}

// ------------------------------------------------------------------------------------------------ static SQL, roles
const header = (title) => `-- AutoEd ERP port: ${title}.\n-- GENERATED by scripts/gen-erp.mjs (schema/erp-tables.mjs, schema/erp-roles.mjs, schema/erp-sql/*.sql). Edit those, not this file.\n`;
const sqlFile = (name) => readFileSync(join(SQL_DIR, name), 'utf8').trimEnd();

const tableModules = [...new Set(allTables.map((t) => t.module))];
const modules = [...new Set([...tableModules, ...Object.values(CAP_MODULES).flat()])].sort();
const modulesSql = `-- Permission modules of the ERP product (decision 45: whole products are sold; modules switch inside it).
insert into core.product_modules (product_key, module_key, name)
select 'erp', m, initcap(replace(m, '_', ' '))
from unnest(array[${[...new Set(tableModules.concat(['leadership']))].sort().map(lit).join(', ')}]) m
on conflict do nothing;
`;

function seedRolesSql() {
  const caps = Object.keys(CAP_MODULES);
  const rows = [];
  for (const [role, spec] of Object.entries(ROLE_MATRIX)) {
    const pairs = spec === 'ALL:F' ? caps.map((c) => [c, 'F']) : spec ? spec.split(',').map((p) => p.split(':')) : [];
    for (const [cap, lvl] of pairs) {
      if (!CAP_MODULES[cap]) throw new Error(`role ${role}: unknown capability ${cap}`);
      if (!'FBSOVR'.includes(lvl)) throw new Error(`role ${role}: bad level ${lvl}`);
      rows.push(`(${lit(role)}, ${lit(cap)}, ${lit(lvl)})`);
    }
  }
  const roles = Object.keys(ROLE_MATRIX).map((r) => `(${lit(r)}, ${lit(ROLE_NAMES[r] ?? r)})`);
  const capMods = Object.entries(CAP_MODULES).flatMap(([cap, ms]) => ms.map((m) => `(${lit(cap)}, ${lit(m)})`));
  return `-- erp.seed_roles(org): the ERP's default role matrix on the platform permission model (core.roles + core.role_permissions).
-- Levels: F view/create/edit/delete/configure/manage at org scope; B view/create/edit/delete at branch scope; S view/create/edit
-- at branch scope; V view at branch scope; O and R give no database permission (own-row and request policies cover them).
-- Safe to run again: existing roles and permissions are left alone. Called by the platform admin server when ERP is switched
-- on for a client (erp.setup_org), never by a signed-in school user.
create or replace function erp.seed_roles(p_org uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_n integer := 0;
begin
  if not exists (select 1 from core.organizations o where o.id = p_org) then
    raise exception 'unknown organization' using errcode = '22023';
  end if;
  insert into core.roles (org_id, product_key, key, name)
  select p_org, 'erp', r.key, r.name from (values ${roles.join(', ')}) as r(key, name)
  on conflict (org_id, product_key, key) do nothing;

  insert into core.role_permissions (org_id, role_id, module_key, action, scope)
  select p_org, ro.id, cm.module_key, a.action, a.scope
  from (values ${rows.join(', ')}) as m(role_key, cap, lvl)
  join (values ${capMods.join(', ')}) as cm(cap, module_key) on cm.cap = m.cap
  join (values
    ('F','view','org'),('F','create','org'),('F','edit','org'),('F','delete','org'),('F','configure','org'),('F','manage','org'),
    ('B','view','branch'),('B','create','branch'),('B','edit','branch'),('B','delete','branch'),
    ('S','view','branch'),('S','create','branch'),('S','edit','branch'),
    ('V','view','branch')
  ) as a(lvl, action, scope) on a.lvl = m.lvl
  join core.roles ro on ro.org_id = p_org and ro.product_key = 'erp' and ro.key = m.role_key
  on conflict (role_id, module_key, action) do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end $$;
`;
}

// ------------------------------------------------------------------------------------------------ emit
if (process.argv.includes('--summary')) {
  console.log('| Table | Group | Module | Access |');
  console.log('|---|---|---|---|');
  for (const t of allTables) {
    const acc = [];
    if (t.rpcOnly) acc.push(`RPC only (erp.${t.rpcOnly})`);
    if (t.read) acc.push(t.read === 'members' || t.read === 'staff' ? `read: ${t.read}` : 'read: predicate');
    if (t.student) acc.push('family (own learners)');
    if (t.famSql) acc.push('family (via parent row)');
    if (t.staffOwn) acc.push('own staff row');
    if (t.own) acc.push(`own rows (${t.own})`);
    if (t.immutable) acc.push('immutable');
    if (t.noInsert) acc.push('written by functions');
    console.log(`| erp.${t.name} | ${t.group} | ${t.module} | ${acc.join('; ') || 'staff by module'} |`);
  }
  console.log(`\n${allTables.length} tables`);
  process.exit(0);
}

const outputs = [];
let n = 0;
const file = (slug, title, body) => {
  n += 1;
  outputs.push({ name: `${PREFIX}${String(n).padStart(6, '0')}_${slug}.sql`, body: `${header(title)}\n${body.trimEnd()}\n` });
};

file('erp_foundation', 'foundation (permission modules, helper functions, guard triggers)', `${modulesSql}\n${sqlFile('00_foundation.sql')}`);
for (const f of FILES) file(f.file, f.title, f.tables.map(tableSql).join('\n\n'));
if (pendingFks.size) throw new Error(`unresolved forward references: ${[...pendingFks.keys()].join(', ')}`);

const fnFiles = readdirSync(SQL_DIR).filter((x) => /^[1-8]\d_.*\.sql$/.test(x)).sort();
file('erp_functions', 'business functions (fees, receipts, approvals, portal, HR, transport, gate)', fnFiles.map((x) => `-- ---------------------------------------------------------------- ${x}\n${sqlFile(x)}`).join('\n\n'));

// function execute grants: every function in erp is closed to PUBLIC; callable ones are listed in 90_grants.sql
const grants = sqlFile('90_grants.sql');
const fnNames = new Set([...[sqlFile('00_foundation.sql'), ...fnFiles.map(sqlFile)].join('\n').matchAll(/create or replace function (erp\.\w+)\(/g)].map((m) => m[1]));
for (const g of grants.matchAll(/(erp\.\w+)\(/g)) {
  if (!fnNames.has(g[1])) throw new Error(`90_grants.sql grants unknown function ${g[1]}`);
}
file('erp_roles_grants', 'default roles, setup function, function grants', `${seedRolesSql()}\n${grants}`);

for (const o of outputs) {
  writeFileSync(join(MIG, o.name), o.body);
  console.log('wrote', o.name);
}
console.log(`${allTables.length} erp tables, ${modules.length} modules`);
