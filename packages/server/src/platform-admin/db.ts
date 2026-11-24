/**
 * Database access of the platform admin console.
 *
 * The console connects ONLY as the login role `platform_admin_server` (ADMIN_DATABASE_URL, no fallback to
 * DATABASE_URL, never service_role or postgres). Every request is one transaction with the admin's JWT claims
 * set, and the first thing it asks the database is `app.is_platform_admin()`; a request from anyone else is
 * refused before any route code runs. `current_user` is verified on every request, so a mis-set connection string
 * fails loudly instead of silently bypassing row level security.
 */
import pg from 'pg';
import { AdminError, forbidden } from './errors';

// Same type parsers as the OS db layer: dates as ISO strings, numerics and bigints as numbers.
pg.types.setTypeParser(1082, (v) => v);
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

export const ADMIN_ROLE = 'platform_admin_server';
export type Tx = pg.PoolClient;

export interface AdminDb {
  /** One request as platform admin `userId`: claims set, admin check done, committed on success. */
  tx<T>(userId: string, fn: (c: Tx) => Promise<T>): Promise<T>;
  /** One request with no signed-in user (login lookups only). Same connection role check. */
  anon<T>(fn: (c: Tx) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export function createAdminDb(connectionString: string | undefined = process.env.ADMIN_DATABASE_URL, opts: { max?: number; ssl?: boolean } = {}): AdminDb {
  if (!connectionString) throw new Error('ADMIN_DATABASE_URL is required (a connection as platform_admin_server; there is no fallback)');
  const pool = new pg.Pool({
    connectionString,
    max: opts.max ?? Number(process.env.ADMIN_DB_POOL_MAX ?? 5),
    ssl: (opts.ssl ?? process.env.DATABASE_SSL === 'true') ? { rejectUnauthorized: false } : undefined,
  });

  async function run<T>(userId: string | null, fn: (c: Tx) => Promise<T>): Promise<T> {
    const c = await pool.connect();
    try {
      await c.query('begin');
      if (userId) {
        await c.query(
          `select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true), set_config('request.jwt.claim.role', 'authenticated', true)`,
          [JSON.stringify({ sub: userId, role: 'authenticated' }), userId],
        );
      }
      const who = (await c.query(`select current_user::text as u, session_user::text as s, app.is_platform_admin() as admin`)).rows[0] as { u: string; s: string; admin: boolean };
      if (who.u !== ADMIN_ROLE || who.s !== ADMIN_ROLE) {
        throw new AdminError(500, 'admin_db_wrong_role', { current_user: who.u });
      }
      if (userId && !who.admin) throw forbidden('not_platform_admin');
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

  return {
    tx: (userId, fn) => run(userId, fn),
    anon: (fn) => run(null, fn),
    close: () => pool.end(),
  };
}

export async function q<T = Record<string, unknown>>(c: Tx, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await c.query(sql, params)).rows as T[];
}

export async function maybe<T = Record<string, unknown>>(c: Tx, sql: string, params: unknown[] = []): Promise<T | null> {
  return (await q<T>(c, sql, params))[0] ?? null;
}
