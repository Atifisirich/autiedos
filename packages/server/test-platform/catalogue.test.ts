/**
 * T7 and friends: catalogue checks over the live database. These need no fixture rows, so a new table
 * that forgets RLS, a policy, org_id or the audit trigger fails CI the moment its migration lands.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { ALL_SCHEMAS, allTables, owner, ownerQuery, PRODUCT_SCHEMAS, ROLE_SCHEMAS } from './helpers';

/** Reviewed global tables (plan rule 4). Adding one here needs an ADR / DECISIONS entry. */
export const GLOBAL_TABLES = ['billing.plans', 'core.platform_admins', 'core.product_modules', 'core.products'];
/** Tables that are logs themselves and carry no audit trigger. */
/** erp.trips / erp.trip_positions are GPS telemetry (a row or update every few seconds per bus): not audited row by row. */
const NO_AUDIT_TRIGGER = ['core.login_events', 'erp.trip_positions', 'erp.trips'];
const POLICY_SCHEMAS = ['core', 'crm', 'os', 'erp', 'audit', 'billing'];

afterAll(async () => {
  await owner.end();
});

describe('T7 catalogue', () => {
  it('every table in every platform schema has row level security enabled', async () => {
    const off = (await allTables(ALL_SCHEMAS)).filter((t) => !t.rls).map((t) => `${t.schema}.${t.table}`);
    expect(off).toEqual([]);
  });

  it('every table in core, crm, os, erp, audit, billing has at least one policy', async () => {
    const rows = await ownerQuery<{ t: string }>(
      `select t.schemaname || '.' || t.tablename as t from pg_tables t
        where t.schemaname = any($1)
          and not exists (select 1 from pg_policies p where p.schemaname = t.schemaname and p.tablename = t.tablename)
        order by 1`,
      [POLICY_SCHEMAS],
    );
    expect(rows.map((r) => r.t)).toEqual([]);
  });

  it('private tables have no policies at all (reachable only through security definer functions)', async () => {
    const rows = await ownerQuery<{ t: string }>(`select schemaname || '.' || tablename as t from pg_policies where schemaname = 'private'`);
    expect(rows).toEqual([]);
  });

  it('every table has org_id except the reviewed global list', async () => {
    const rows = await ownerQuery<{ t: string }>(
      `select t.schemaname || '.' || t.tablename as t from pg_tables t
        where t.schemaname = any($1)
          and not exists (select 1 from information_schema.columns c
                           where c.table_schema = t.schemaname and c.table_name = t.tablename and c.column_name = 'org_id')
        order by 1`,
      [ALL_SCHEMAS],
    );
    expect(rows.map((r) => r.t)).toEqual(GLOBAL_TABLES);
  });

  it('every product-schema table is guarded by the product check (app.user_has_product) in every policy', async () => {
    const rows = await ownerQuery<{ t: string; policyname: string }>(
      `select schemaname || '.' || tablename as t, policyname from pg_policies
        where schemaname = any($1)
          and coalesce(qual, '') !~ 'user_has_product' and coalesce(with_check, '') !~ 'user_has_product'
        order by 1, 2`,
      [PRODUCT_SCHEMAS],
    );
    expect(rows).toEqual([]);
  });

  it('policies call app.uid(), never auth.uid() (server roles have no access to the auth schema)', async () => {
    const rows = await ownerQuery<{ t: string }>(
      `select schemaname || '.' || tablename || ':' || policyname as t from pg_policies
        where schemaname = any($1) and (coalesce(qual, '') ~ 'auth\\.' or coalesce(with_check, '') ~ 'auth\\.')`,
      [POLICY_SCHEMAS],
    );
    expect(rows).toEqual([]);
  });

  it('every table in core, crm, os, erp, billing has the audit trigger', async () => {
    const rows = await ownerQuery<{ t: string }>(
      `select t.schemaname || '.' || t.tablename as t from pg_tables t
        where t.schemaname in ('core','crm','os','erp','billing')
          and not exists (select 1 from pg_trigger g
                           where g.tgrelid = (quote_ident(t.schemaname) || '.' || quote_ident(t.tablename))::regclass
                             and g.tgname = 'trg_platform_audit')
        order by 1`,
    );
    expect(rows.map((r) => r.t)).toEqual(NO_AUDIT_TRIGGER);
  });

  it('every security definer function in the platform schemas pins search_path', async () => {
    const rows = await ownerQuery<{ f: string }>(
      `select n.nspname || '.' || p.proname as f from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = any($1) and p.prosecdef
          and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')
        order by 1`,
      [ALL_SCHEMAS],
    );
    expect(rows).toEqual([]);
  });

  it('no platform function is executable by PUBLIC or anon', async () => {
    const rows = await ownerQuery<{ f: string }>(
      `select n.nspname || '.' || p.proname as f from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname in ('app','private','audit','core','billing','crm','os','erp')
          and (has_function_privilege('anon', p.oid, 'execute')
               or exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE'))
        order by 1`,
    );
    expect(rows).toEqual([]);
  });

  it('schema grants: each server role reaches core + its own schema only; anon reaches none', async () => {
    const roles = [...Object.keys(ROLE_SCHEMAS), 'job_runner', 'anon'];
    const rows = await ownerQuery<{ role: string; schema: string }>(
      `select r as role, s as schema from unnest($1::text[]) r, unnest($2::text[]) s
        where has_schema_privilege(r, s, 'usage') order by 1, 2`,
      [roles, ALL_SCHEMAS],
    );
    const got: Record<string, string[]> = {};
    for (const r of rows) (got[r.role] ??= []).push(r.schema);
    const app = (xs: string[]) => [...xs, 'app'].sort();
    expect(got).toEqual({
      authenticated: app(ROLE_SCHEMAS.authenticated),
      crm_server: app(ROLE_SCHEMAS.crm_server),
      os_server: app(ROLE_SCHEMAS.os_server),
      erp_server: app(ROLE_SCHEMAS.erp_server),
      platform_admin_server: app(ROLE_SCHEMAS.platform_admin_server),
      job_runner: ['app', 'core', 'private'],
    });
  });

  it('product server roles are not members of authenticated, anon or each other (no SET ROLE escape)', async () => {
    const rows = await ownerQuery<{ member: string; role: string }>(
      `select m.rolname as member, r.rolname as role from pg_auth_members a
         join pg_roles m on m.oid = a.member join pg_roles r on r.oid = a.roleid
        where m.rolname in ('crm_server','os_server','erp_server','platform_admin_server','job_runner')`,
    );
    expect(rows).toEqual([]);
    const bypass = await ownerQuery<{ rolname: string }>(
      `select rolname from pg_roles where rolname in ('crm_server','os_server','erp_server','platform_admin_server','job_runner','authenticated','anon') and (rolbypassrls or rolsuper)`,
    );
    expect(bypass).toEqual([]);
  });
});
