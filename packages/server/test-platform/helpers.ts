/**
 * Helpers for the platform isolation harness. Talks to Postgres directly (no app code), so what is
 * tested is the database guarantee itself (plan 4.3 layer 1 + layer 2 grants).
 */
import pg from 'pg';

export const DATABASE_URL =
  process.env.PLATFORM_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgres://postgres@localhost:54322/postgres';

/** Superuser / migration owner pool: bypasses RLS, used for fixtures and catalogue checks only. */
export const owner = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });

export const REQUEST_ROLES = ['authenticated', 'crm_server', 'os_server', 'erp_server', 'platform_admin_server', 'job_runner', 'anon'] as const;
export type RequestRole = (typeof REQUEST_ROLES)[number];

/** Schemas each server role is meant to reach (grants), used by T1/T5/T7. */
export const ROLE_SCHEMAS: Record<Exclude<RequestRole, 'anon' | 'job_runner'>, string[]> = {
  authenticated: ['core', 'crm', 'os', 'erp', 'audit', 'billing'],
  crm_server: ['core', 'crm'],
  os_server: ['core', 'os'],
  erp_server: ['core', 'erp'],
  platform_admin_server: ['core', 'audit', 'billing'],
};

export const PRODUCT_SCHEMAS = ['crm', 'os', 'erp'] as const;
export const ALL_SCHEMAS = ['core', 'app', 'audit', 'billing', 'private', 'crm', 'os', 'erp'] as const;

/**
 * One request: a transaction running as `role` (switched with SET LOCAL ROLE from the owner connection)
 * with request.jwt.claims for `userId`, exactly like the product servers do. Rolled back unless commit.
 */
export async function tx<T>(role: RequestRole, userId: string | null, fn: (c: pg.PoolClient) => Promise<T>, commit = false): Promise<T> {
  if (!(REQUEST_ROLES as readonly string[]).includes(role)) throw new Error(`unknown role ${role}`);
  const c = await owner.connect();
  try {
    await c.query('begin');
    if (userId) {
      await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: userId, role: 'authenticated' })]);
    }
    await c.query(`set local role ${role}`);
    const out = await fn(c);
    await c.query(commit ? 'commit' : 'rollback');
    return out;
  } catch (e) {
    await c.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

export async function count(role: RequestRole, userId: string | null, sql: string, params: unknown[] = []): Promise<number> {
  return tx(role, userId, async (c) => Number((await c.query(`select count(*)::int as n from (${sql}) x`, params)).rows[0].n));
}

/** Runs SQL in its own request and returns the error code it failed with ('' if it succeeded). */
export async function errorCode(role: RequestRole, userId: string | null, sql: string, params: unknown[] = []): Promise<string> {
  try {
    await tx(role, userId, (c) => c.query(sql, params));
    return '';
  } catch (e) {
    return (e as { code?: string }).code ?? String(e);
  }
}

/** A real login connection as a database role (trust auth locally / in CI), for T5 and T11. */
export async function loginAs(role: string): Promise<pg.Client> {
  const u = new URL(DATABASE_URL);
  u.username = role;
  u.password = '';
  const c = new pg.Client({ connectionString: u.toString() });
  await c.connect();
  return c;
}

export async function ownerQuery<R extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, params: unknown[] = []) {
  return (await owner.query<R>(sql, params)).rows;
}

export const qi = (schema: string, table: string) => `"${schema}"."${table}"`;

/** Tables with an org_id column in the given schemas. */
export async function orgTables(schemas: readonly string[]): Promise<{ schema: string; table: string }[]> {
  const rows = await ownerQuery<{ schema: string; table: string }>(
    `select c.table_schema as schema, c.table_name as "table"
       from information_schema.columns c
       join pg_tables t on t.schemaname = c.table_schema and t.tablename = c.table_name
      where c.table_schema = any($1) and c.column_name = 'org_id'
      order by 1, 2`,
    [schemas],
  );
  return rows;
}

export async function allTables(schemas: readonly string[]): Promise<{ schema: string; table: string; rls: boolean }[]> {
  return ownerQuery(
    `select schemaname as schema, tablename as "table", rowsecurity as rls from pg_tables where schemaname = any($1) order by 1, 2`,
    [schemas],
  );
}

/** ERP tables with no direct access (select policy closed, no DML): read and saved through logged erp.* functions. */
export const RPC_ONLY_TABLES = ['erp.staff_payroll', 'erp.student_sensitive'];
