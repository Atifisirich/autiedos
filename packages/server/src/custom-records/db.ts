/**
 * Database access of the custom records engine. Every request runs as a PRODUCT role (crm_server, os_server or
 * erp_server) with the signed-in user's claims, so the per-object policies of core.custom_objects / custom_records apply;
 * reminders run as job_runner. Never service_role, never the table owner.
 *
 * Production: one pool per login role, CRM_DATABASE_URL / OS_DATABASE_URL / ERP_DATABASE_URL / JOB_RUNNER_DATABASE_URL,
 * else DATABASE_URL with the user name switched to the role (password from <ROLE>_DB_PASSWORD; the local cluster trusts
 * these logins). Tests: createSetRoleRecordsDb(pool) switches with SET LOCAL ROLE inside each transaction.
 */
import pg from 'pg';

export type RecordsRole = 'crm_server' | 'os_server' | 'erp_server' | 'job_runner';
export const PRODUCT_ROLES: Record<'crm' | 'os' | 'erp', RecordsRole> = { crm: 'crm_server', os: 'os_server', erp: 'erp_server' };
const ROLES: readonly RecordsRole[] = ['crm_server', 'os_server', 'erp_server', 'job_runner'];

export interface Queryable {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, params?: unknown[]): Promise<{ rows: R[]; rowCount: number | null }>;
}

export interface RecordsDb {
  /** One transaction as `role`; with `userId` the request claims are set (RLS applies as that person). */
  run<T>(role: RecordsRole, userId: string | null, fn: (q: Queryable) => Promise<T>): Promise<T>;
}

async function runTx<T>(client: pg.PoolClient, setRole: RecordsRole | null, userId: string | null, fn: (q: Queryable) => Promise<T>): Promise<T> {
  try {
    await client.query('begin');
    if (userId) await client.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: userId, role: 'authenticated' })]);
    if (setRole) await client.query(`set local role ${setRole}`); // from the closed list above, never from input
    const out = await fn(client);
    await client.query('commit');
    return out;
  } catch (e) {
    await client.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

const ENV: Record<RecordsRole, [string, string]> = {
  crm_server: ['CRM_DATABASE_URL', 'CRM_SERVER_DB_PASSWORD'],
  os_server: ['OS_DATABASE_URL', 'OS_SERVER_DB_PASSWORD'],
  erp_server: ['ERP_DATABASE_URL', 'ERP_SERVER_DB_PASSWORD'],
  job_runner: ['JOB_RUNNER_DATABASE_URL', 'JOB_RUNNER_DB_PASSWORD'],
};

export function roleConnectionString(role: RecordsRole, env: NodeJS.ProcessEnv = process.env): string {
  const [urlVar, pwVar] = ENV[role];
  if (env[urlVar]) return env[urlVar]!;
  const u = new URL(env.DATABASE_URL ?? 'postgres://postgres@localhost:54322/postgres');
  u.username = role;
  u.password = env[pwVar] ?? '';
  return u.toString();
}

/** Production shape: a pool per login role. */
export function createPoolRecordsDb(env: NodeJS.ProcessEnv = process.env): RecordsDb & { close(): Promise<void> } {
  const pools = new Map<RecordsRole, pg.Pool>();
  return {
    async run(role, userId, fn) {
      if (!ROLES.includes(role)) throw new Error(`unknown role ${role}`);
      let pool = pools.get(role);
      if (!pool) {
        pool = new pg.Pool({ connectionString: roleConnectionString(role, env), max: Number(env.DB_POOL_MAX ?? 5), ssl: env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined });
        pools.set(role, pool);
      }
      return runTx(await pool.connect(), null, userId, fn);
    },
    async close() {
      await Promise.all([...pools.values()].map((p) => p.end()));
      pools.clear();
    },
  };
}

/** Tests / local tools: one privileged pool that switches to the role inside each transaction (like the harness). */
export function createSetRoleRecordsDb(pool: pg.Pool): RecordsDb {
  return {
    async run(role, userId, fn) {
      if (!ROLES.includes(role)) throw new Error(`unknown role ${role}`);
      return runTx(await pool.connect(), role, userId, fn);
    },
  };
}

let defaultDb: (RecordsDb & { close(): Promise<void> }) | null = null;
export function defaultRecordsDb(): RecordsDb & { close(): Promise<void> } {
  defaultDb ??= createPoolRecordsDb();
  return defaultDb;
}
export async function closeRecordsDb() {
  if (defaultDb) await defaultDb.close();
  defaultDb = null;
}
