/**
 * Catalogue check for compliance (data-subject-rights-procedure.md 5.5): every table with a person-identifying column
 * must be registered in core.pii_registry, or CI fails, so a new table cannot dodge export and erasure.
 *
 * The scratch database holds every 20261115* migration (platform + compliance). When a table lands in a platform
 * migration without a registry row, THIS test fails; the fix is one row in core.pii_registry (see the ADR).
 *
 * It also replays the harness T7 checks (RLS, policies, org_id, audit trigger, search_path, no PUBLIC execute) on that
 * database, so the compliance objects cannot break catalogue.test.ts once the migration joins the harness.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findRegistryProblems, findUnregisteredTables, PERSONAL_COLUMN_PATTERN } from '../src/compliance/catalogue';
import { createWorld, type World } from './compliance-support';

let w: World;
beforeAll(async () => {
  w = await createWorld();
}, 300000);
afterAll(async () => {
  await w?.close();
});

const owner = { query: (sql: string, params?: unknown[]) => w.pool.query(sql, params) as never };

describe('every table with a person-identifying column is registered', () => {
  it('no platform table is missing from core.pii_registry', async () => {
    const missing = await findUnregisteredTables(owner);
    expect(missing, `register these in core.pii_registry (personal or exempt): ${JSON.stringify(missing)}`).toEqual([]);
  });

  it('the registry points only at tables and columns that exist and can be applied', async () => {
    expect(await findRegistryProblems(owner)).toEqual([]);
  });

  it('the check really fails for a new table that holds a person: a new product table without a registry row is caught', async () => {
    await w.q(`create table erp.guardians_extra (id uuid primary key default gen_random_uuid(), org_id uuid not null references core.organizations(id), mobile text, notes text)`);
    try {
      const missing = await findUnregisteredTables(owner);
      expect(missing).toEqual([{ schema: 'erp', table: 'guardians_extra', columns: ['mobile'] }]);
      // registering it (as personal) clears it, and the registry problem check accepts a sound row
      await w.q(`insert into core.pii_registry (schema_name, table_name, person_type, key_column, pii_columns, erasure_mode) values ('erp', 'guardians_extra', 'guardian', 'id', array['mobile'], 'delete')`);
      expect(await findUnregisteredTables(owner)).toEqual([]);
      expect(await findRegistryProblems(owner)).toEqual([]);
      await w.q(`drop table erp.guardians_extra`);
      expect(await findRegistryProblems(owner)).toEqual(['erp.guardians_extra: registered but the table does not exist']);
    } finally {
      await w.q(`drop table if exists erp.guardians_extra`);
      await w.q(`delete from core.pii_registry where table_name = 'guardians_extra'`);
    }
  });

  it('an exempt row needs a real reason; a personal row needs a person type and key column', async () => {
    await expect(w.q(`insert into core.pii_registry (schema_name, table_name, classification, exempt_reason) values ('core', 'x1', 'exempt', 'no')`)).rejects.toMatchObject({ code: '23514' });
    await expect(w.q(`insert into core.pii_registry (schema_name, table_name, person_type, key_column, erasure_mode, pii_columns) values ('core', 'x2', 'staff', null, 'delete', '{a}')`)).rejects.toMatchObject({ code: '23514' });
    await expect(w.q(`insert into core.pii_registry (schema_name, table_name, person_type, key_column, erasure_mode, pii_columns) values ('core', 'x3', 'staff', 'user_id', 'delete', '{}')`)).rejects.toMatchObject({ code: '23514' });
    await expect(w.q(`insert into core.pii_registry (schema_name, table_name, person_type, key_column, erasure_mode, pii_columns, retain_reason) values ('core', 'x4', 'staff', 'user_id', 'retain', '{user_id}', 'short')`)).rejects.toMatchObject({ code: '23514' });
  });

  it('flags an anonymise rule that would null a NOT NULL column, and a dropped column', async () => {
    await w.q(`create table crm.parents_x (id uuid primary key default gen_random_uuid(), org_id uuid not null references core.organizations(id), parent_name text not null, phone text)`);
    await w.q(`insert into core.pii_registry (schema_name, table_name, person_type, key_column, pii_columns, erasure_mode) values ('crm', 'parents_x', 'guardian', 'id', array['parent_name','phone'], 'anonymise')`);
    expect(await findRegistryProblems(owner)).toEqual(['crm.parents_x: anonymise sets parent_name to null but it is NOT NULL; add a replacement to anonymise_values']);
    await w.q(`update core.pii_registry set anonymise_values = '{"parent_name":"Erased person"}' where table_name = 'parents_x'`);
    expect(await findRegistryProblems(owner)).toEqual([]);
    await w.q(`alter table crm.parents_x drop column phone`);
    expect(await findRegistryProblems(owner)).toEqual(['crm.parents_x: registered column phone does not exist']);
    await w.q(`drop table crm.parents_x`);
    await w.q(`delete from core.pii_registry where table_name = 'parents_x'`);
    expect(await findRegistryProblems(owner)).toEqual([]);
  });

  it('the column heuristic is broad (a false positive costs one row, a false negative leaks)', () => {
    for (const c of ['email', 'billing_email', 'phone', 'mobile', 'guardian_phone', 'first_name', 'display_name', 'dob', 'user_id', 'platform_user_id', 'student_id', 'learner_id', 'lead_id', 'owner_id', 'ip', 'user_agent', 'ip_address', 'address', 'contact', 'photo_url', 'aadhaar_no', 'person_id']) {
      expect(PERSONAL_COLUMN_PATTERN.test(c), c).toBe(true);
    }
    for (const c of ['org_id', 'branch_id', 'title', 'amount_paise', 'created_at', 'status', 'plan_key', 'state_code', 'time_zone', 'description', 'ipsum']) {
      expect(PERSONAL_COLUMN_PATTERN.test(c), c).toBe(false);
    }
  });
});

describe('the seeded registry covers the foundation tables and decides erasure per table', () => {
  it('financial and proof tables are configured, not hard-coded', async () => {
    const rows = await w.q<{ table_name: string; person_type: string; erasure_mode: string }>(
      `select table_name, person_type, erasure_mode from core.pii_registry where org_id is null and classification = 'personal' and schema_name = 'core' order by table_name, person_type, key_column`);
    const by = (t: string) => rows.filter((r) => r.table_name === t).map((r) => r.erasure_mode);
    expect(new Set(by('org_users'))).toEqual(new Set(['delete']));
    expect(new Set(by('login_events'))).toEqual(new Set(['anonymise']));
    expect(new Set(by('consents'))).toEqual(new Set(['retain']));
    // changing a table from delete to anonymise is an update of one row (here: for one org only)
    await w.q(`insert into core.pii_registry (org_id, schema_name, table_name, person_type, key_column, pii_columns, anonymise_values, erasure_mode)
               values ($1, 'core', 'org_users', 'staff', 'user_id', array['display_name'], '{"display_name":"Erased person"}', 'anonymise')`, [w.A.id]);
    const eff = await w.q<{ erasure_mode: string }>(`select erasure_mode from app._compliance_registry_for($1, 'staff') where table_name = 'org_users'`, [w.A.id]);
    expect(eff).toEqual([{ erasure_mode: 'anonymise' }]);
    const other = await w.q<{ erasure_mode: string }>(`select erasure_mode from app._compliance_registry_for($1, 'staff') where table_name = 'org_users'`, [w.B.id]);
    expect(other).toEqual([{ erasure_mode: 'delete' }]);
    await w.q(`delete from core.pii_registry where org_id = $1`, [w.A.id]);
  });
});

describe('harness T7 checks hold with the compliance migration applied', () => {
  const ALL = ['core', 'app', 'audit', 'billing', 'private', 'crm', 'os', 'erp'];
  const GLOBAL = ['billing.plans', 'core.platform_admins', 'core.product_modules', 'core.products'];

  it('RLS on every table, a policy on every non-private table, none on private', async () => {
    const off = await w.q<{ t: string }>(`select schemaname || '.' || tablename as t from pg_tables where schemaname = any($1) and not rowsecurity`, [ALL]);
    expect(off).toEqual([]);
    const nopol = await w.q<{ t: string }>(
      `select t.schemaname || '.' || t.tablename as t from pg_tables t where t.schemaname = any($1)
        and not exists (select 1 from pg_policies p where p.schemaname = t.schemaname and p.tablename = t.tablename)`, [['core', 'crm', 'os', 'erp', 'audit', 'billing']]);
    expect(nopol).toEqual([]);
    expect(await w.q(`select 1 from pg_policies where schemaname = 'private'`)).toEqual([]);
  });

  it('org_id on every table except the reviewed global ones', async () => {
    const rows = await w.q<{ t: string }>(
      `select t.schemaname || '.' || t.tablename as t from pg_tables t where t.schemaname = any($1)
        and not exists (select 1 from information_schema.columns c where c.table_schema = t.schemaname and c.table_name = t.tablename and c.column_name = 'org_id') order by 1`, [ALL]);
    expect(rows.map((r) => r.t)).toEqual(GLOBAL);
  });

  it('audit trigger on every table of core, crm, os, erp, billing except the login log', async () => {
    const rows = await w.q<{ t: string }>(
      `select t.schemaname || '.' || t.tablename as t from pg_tables t where t.schemaname in ('core','crm','os','erp','billing')
        and not exists (select 1 from pg_trigger g where g.tgrelid = (quote_ident(t.schemaname) || '.' || quote_ident(t.tablename))::regclass and g.tgname = 'trg_platform_audit') order by 1`);
    expect(rows.map((r) => r.t)).toEqual(['core.login_events']);
  });

  it('every security definer function pins search_path; no function is executable by PUBLIC or anon', async () => {
    expect(await w.q(`select n.nspname || '.' || p.proname as f from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = any($1) and p.prosecdef and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')`, [ALL])).toEqual([]);
    expect(await w.q(`select n.nspname || '.' || p.proname as f from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname in ('app','private','audit','core','billing','crm','os','erp')
          and (has_function_privilege('anon', p.oid, 'execute')
               or exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE'))`)).toEqual([]);
  });

  it('policies use app.uid(), never auth.uid(); product policies keep the product check', async () => {
    expect(await w.q(`select tablename from pg_policies where schemaname = any($1) and (coalesce(qual,'') ~ 'auth\\.' or coalesce(with_check,'') ~ 'auth\\.')`, [['core', 'crm', 'os', 'erp', 'audit', 'billing']])).toEqual([]);
    expect(await w.q(`select tablename, policyname from pg_policies where schemaname = any($1) and coalesce(qual,'') !~ 'user_has_product' and coalesce(with_check,'') !~ 'user_has_product'`, [['crm', 'os', 'erp']])).toEqual([]);
  });

  it('who may execute what: compliance tools only for platform_admin_server / job_runner / service_role; consent helpers also for product roles', async () => {
    const rows = await w.q<{ f: string; roles: string[] }>(
      `select p.proname as f, array(select r from unnest(array['anon','authenticated','crm_server','os_server','erp_server','platform_admin_server','job_runner','service_role']) r
                                      where has_function_privilege(r, p.oid, 'execute')) as roles
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app' and p.proname like '%compliance%' order by 1`);
    const by = Object.fromEntries(rows.map((r) => [r.f, r.roles]));
    const consent = ['authenticated', 'crm_server', 'erp_server', 'os_server', 'platform_admin_server', 'service_role'];
    for (const f of ['compliance_record_consent', 'compliance_consent_status', 'compliance_may_send', 'compliance_normalise_contact']) expect([...by[f]!].sort(), f).toEqual(consent);
    expect([...by.compliance_retention_purge!].sort()).toEqual(['job_runner', 'platform_admin_server', 'service_role']);
    expect([...by.compliance_enqueue_purge_jobs!].sort()).toEqual(['job_runner', 'platform_admin_server', 'service_role']);
    for (const f of ['compliance_person_export', 'compliance_person_erasure_plan', 'compliance_person_erasure_execute', 'compliance_org_deletion_plan', 'compliance_org_deletion_execute', 'compliance_org_export_start', 'compliance_read_rows', 'compliance_table_counts']) {
      expect([...by[f]!].sort(), f).toEqual(['platform_admin_server', 'service_role']);
    }
    // internal helpers are owner-only
    for (const f of ['_compliance_erase', '_compliance_delete_scope', '_compliance_count', '_compliance_log_purge', '_compliance_org_tables']) expect(by[f], f).toEqual(['service_role']);
  });

  it('product roles do not gain access to other schemas through the new objects', async () => {
    for (const [role, own] of [['crm_server', 'crm'], ['os_server', 'os'], ['erp_server', 'erp']] as const) {
      const schemas = await w.q<{ s: string }>(`select s from unnest(array['core','crm','os','erp','audit','billing','private']) s where has_schema_privilege($1, s, 'usage')`, [role]);
      expect(schemas.map((x) => x.s).sort(), role).toEqual(['core', own].sort());
    }
    const tbl = await w.q<{ t: string }>(
      `select c.relname as t from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'audit' and c.relname = 'purge_log' and (has_table_privilege('crm_server', c.oid, 'select') or has_table_privilege('os_server', c.oid, 'select') or has_table_privilege('erp_server', c.oid, 'select'))`);
    expect(tbl).toEqual([]);
  });

  it('RLS scopes the compliance tables to the caller org (requests, purge log, holds, export jobs)', async () => {
    await w.q(`insert into core.compliance_requests (org_id, kind, status) values ($1, 'person_export', 'executed'), ($2, 'person_export', 'executed')`, [w.A.id, w.B.id]);
    await w.q(`insert into audit.purge_log (org_id, source, action, status) values ($1, 'retention', 'skip', 'skipped_disabled'), ($2, 'retention', 'skip', 'skipped_disabled')`, [w.A.id, w.B.id]);
    const orgs = async (userId: string, table: string) => w.db.run('platform_admin_server', { actorUserId: userId }, async (q) => (await q.query<{ org_id: string }>(`select distinct org_id from ${table}`)).rows.map((r) => r.org_id).sort());
    for (const t of ['core.compliance_requests', 'audit.purge_log']) {
      expect(await orgs(w.u.aAdmin!, t), t).toEqual([w.A.id]);
      expect(await orgs(w.u.bAdmin!, t), t).toEqual([w.B.id]);
      expect(await orgs(w.u.aStaffNoCompliance!, t), `${t} without compliance.view or audit.view`).toEqual([]);
      expect((await orgs(w.u.platform!, t)).length, `${t} platform`).toBeGreaterThanOrEqual(2);
    }
  });
});
