/**
 * Role-aware database access for the compliance services.
 *
 * The services never open a connection themselves: they ask a ComplianceDb for a transaction as one of the
 * platform roles (docs/adr/001). Privileged work goes through security definer functions that only
 * `platform_admin_server` (org and person tools) and `job_runner` (retention purge) may execute; the product roles
 * are used only for the consent helpers, on the caller's own org. A product role is never asked to read another schema.
 */
import pg from 'pg';
import { ComplianceError } from './types';

export type ComplianceRole = 'platform_admin_server' | 'job_runner' | 'crm_server' | 'os_server' | 'erp_server';

export interface Queryable {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, params?: unknown[]): Promise<{ rows: R[]; rowCount: number | null }>;
}

export interface TxOptions {
  /** The signed-in user (sub claim). Required by the tools that authorise a person; null for the job role. */
  actorUserId?: string | null;
  /** One consistent snapshot, for exports (counts and rows must agree). */
  repeatableRead?: boolean;
  /** Per-call override of the role's statement_timeout, for bulk work. */
  statementTimeoutMs?: number;
}

export interface ComplianceDb {
  run<T>(role: ComplianceRole, opts: TxOptions, fn: (q: Queryable) => Promise<T>): Promise<T>;
}

const ROLES: readonly ComplianceRole[] = ['platform_admin_server', 'job_runner', 'crm_server', 'os_server', 'erp_server'];

async function runTx<T>(client: pg.PoolClient, role: ComplianceRole | null, opts: TxOptions, fn: (q: Queryable) => Promise<T>): Promise<T> {
  try {
    await client.query(opts.repeatableRead ? 'begin isolation level repeatable read' : 'begin');
    if (opts.actorUserId) {
      await client.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: opts.actorUserId, role: 'authenticated' })]);
    }
    if (role) await client.query(`set local role ${role}`); // role comes from the closed union above, never from input
    if (opts.statementTimeoutMs !== undefined) {
      await client.query(`select set_config('statement_timeout', $1, true)`, [String(Math.max(0, Math.floor(opts.statementTimeoutMs)))]);
    }
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

/**
 * Production shape: one pool per role, each connecting as that login role (crm_server, platform_admin_server ...).
 * A missing URL means the role is not available to this process.
 */
export function createPoolDb(urls: Partial<Record<ComplianceRole, string>>, ssl = false): ComplianceDb & { close(): Promise<void> } {
  const pools = new Map<ComplianceRole, pg.Pool>();
  return {
    async run(role, opts, fn) {
      if (!ROLES.includes(role)) throw new Error(`unknown role ${role}`);
      let pool = pools.get(role);
      if (!pool) {
        const url = urls[role];
        if (!url) throw new Error(`no connection string configured for ${role}`);
        pool = new pg.Pool({ connectionString: url, max: 4, ssl: ssl ? { rejectUnauthorized: false } : undefined });
        pools.set(role, pool);
      }
      return runTx(await pool.connect(), null, opts, fn);
    },
    async close() {
      await Promise.all([...pools.values()].map((p) => p.end()));
      pools.clear();
    },
  };
}

/** Each variable holds the connection string of that login role. */
export function poolDbFromEnv(env: NodeJS.ProcessEnv = process.env): ComplianceDb & { close(): Promise<void> } {
  const urls: Partial<Record<ComplianceRole, string>> = {};
  const map: [ComplianceRole, string][] = [
    ['platform_admin_server', 'PLATFORM_ADMIN_DATABASE_URL'],
    ['job_runner', 'JOB_RUNNER_DATABASE_URL'],
    ['crm_server', 'CRM_DATABASE_URL'],
    ['os_server', 'OS_DATABASE_URL'],
    ['erp_server', 'ERP_DATABASE_URL'],
  ];
  for (const [role, name] of map) {
    const v = env[name];
    if (v) urls[role] = v;
  }
  return createPoolDb(urls, env.DATABASE_SSL === 'true');
}

/**
 * Local/test shape: one pool connected as a privileged user, switching with `set local role` inside each
 * transaction (exactly what the isolation harness does). Behaves like real logins for grants and RLS.
 */
export function createSetRoleDb(pool: pg.Pool): ComplianceDb {
  return {
    async run(role, opts, fn) {
      if (!ROLES.includes(role)) throw new Error(`unknown role ${role}`);
      return runTx(await pool.connect(), role, opts, fn);
    },
  };
}

/** Runs fn and converts the SQL functions' own error codes (42501 forbidden, 22023 invalid) to ComplianceError. */
export async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ComplianceError) throw e;
    const err = e as { code?: string; message?: string };
    const msg = (err.message ?? '').replace(/^(compliance|consent): /, '');
    if (err.code === '42501') throw new ComplianceError('forbidden', msg);
    if (err.code === '22023') throw new ComplianceError('invalid', msg);
    throw e;
  }
}
