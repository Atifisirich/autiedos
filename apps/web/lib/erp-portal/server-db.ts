/**
 * Server-only database access of the portal's two server routes (payment settlement, document verification).
 * Those database functions are granted to the ERP server role only (`erp_server`), never to a signed-in user or to anon
 * (docs/adr/erp-schema.md, decision 8), so they cannot be called from the browser: the browser calls these routes.
 *
 *   ERP_SERVER_DATABASE_URL   a login as the `erp_server` role (production)
 *   DATABASE_URL              development only: any superuser login; the route switches to the role with SET LOCAL ROLE
 */
import pg from 'pg';

let pool: pg.Pool | null = null;
let switchRole = false;

function getPool(): pg.Pool | null {
  if (pool) return pool;
  const dedicated = process.env.ERP_SERVER_DATABASE_URL;
  const fallback = process.env.NODE_ENV !== 'production' ? process.env.DATABASE_URL : undefined;
  const url = dedicated ?? fallback;
  if (!url) return null;
  switchRole = !dedicated;
  pool = new pg.Pool({ connectionString: url, max: 3, ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined });
  return pool;
}

export const erpServerConfigured = (): boolean => getPool() !== null;

/** Runs `fn` in one transaction as the ERP server role. Throws `Error('not configured')` when no connection is set. */
export async function asErpServer<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const p = getPool();
  if (!p) throw new Error('not configured');
  const c = await p.connect();
  try {
    await c.query('begin');
    if (switchRole) await c.query('set local role erp_server');
    const out = await fn(c);
    await c.query('commit');
    return out;
  } catch (e) {
    await c.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

/** The mock payment provider settles orders without any money moving. It is on only when asked for, or by default outside production. */
export const mockPaymentsEnabled = (): boolean => (process.env.ERP_PAYMENTS_PROVIDER ?? (process.env.NODE_ENV === 'production' ? '' : 'mock')) === 'mock';
