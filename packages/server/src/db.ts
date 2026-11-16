/**
 * Database access. Every user request runs inside a transaction as the `authenticated` role
 * with the user's JWT claims set, so Row Level Security applies to every query the API makes.
 * System work (jobs, cross-user side effects after a permission check) uses `asService`.
 */
import pg from 'pg';

// Return dates as ISO strings and numerics as numbers.
pg.types.setTypeParser(1082, (v) => v); // date
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v))); // numeric
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v))); // int8

export type Tx = pg.PoolClient;

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL ?? 'postgres://postgres@localhost:54322/postgres',
      max: Number(process.env.DB_POOL_MAX ?? 10),
      ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
    });
  }
  return pool;
}

export async function closePool() {
  if (pool) await pool.end();
  pool = null;
}

export interface DbUser {
  userId: string;
  staffId?: string | null;
  device?: string | null;
}

async function inTx<T>(setup: (c: Tx) => Promise<void>, fn: (c: Tx) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('begin');
    await setup(client);
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

/** Runs fn with RLS applied for this user. */
export function asUser<T>(u: DbUser, fn: (c: Tx) => Promise<T>): Promise<T> {
  return inTx(async (c) => {
    await c.query(
      `select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true),
              set_config('request.jwt.claim.role', 'authenticated', true), set_config('app.device', $3, true),
              set_config('app.actor_staff_id', $4, true)`,
      [JSON.stringify({ sub: u.userId, role: 'authenticated' }), u.userId, u.device ?? '', u.staffId ?? ''],
    );
    await c.query('set local role authenticated');
  }, fn);
}

/** Runs fn as the service (bypasses RLS). Callers must have checked permission first. */
export function asService<T>(fn: (c: Tx) => Promise<T>, actor?: DbUser): Promise<T> {
  return inTx(async (c) => {
    if (actor) {
      await c.query(
        `select set_config('request.jwt.claim.sub', $1, true), set_config('app.device', $2, true), set_config('app.actor_staff_id', $3, true)`,
        [actor.userId, actor.device ?? '', actor.staffId ?? ''],
      );
    }
  }, fn);
}

export async function q<T = Record<string, unknown>>(c: Tx, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await c.query(sql, params)).rows as T[];
}

export async function one<T = Record<string, unknown>>(c: Tx, sql: string, params: unknown[] = []): Promise<T> {
  const rows = await q<T>(c, sql, params);
  if (!rows[0]) throw new NotFoundError();
  return rows[0];
}

export async function maybe<T = Record<string, unknown>>(c: Tx, sql: string, params: unknown[] = []): Promise<T | null> {
  return (await q<T>(c, sql, params))[0] ?? null;
}

const IDENT = /^[a-z_][a-z0-9_]*$/;
function ident(s: string): string {
  if (!IDENT.test(s)) throw new Error(`bad identifier ${s}`);
  return `"${s}"`;
}

const columnTypes = new Map<string, Map<string, string>>();

/** Column -> data_type for a public table (cached per process). */
async function typesOf(c: Tx, table: string): Promise<Map<string, string>> {
  let m = columnTypes.get(table);
  if (!m) {
    const rows = (await c.query(`select column_name, data_type from information_schema.columns where table_schema = 'public' and table_name = $1`, [table])).rows as { column_name: string; data_type: string }[];
    m = new Map(rows.map((r) => [r.column_name, r.data_type]));
    if (m.size) columnTypes.set(table, m);
  }
  return m;
}

function prep(v: unknown, type: string | undefined): unknown {
  if (v === undefined) return null;
  if (type === 'jsonb' || type === 'json') return v === null ? null : JSON.stringify(v);
  if (v !== null && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v)) return JSON.stringify(v);
  return v;
}

/** Insert one row; returns it. Objects are stored as JSON. */
export async function insert<T = Record<string, unknown>>(c: Tx, table: string, row: Record<string, unknown>, opts: { onConflict?: string } = {}): Promise<T> {
  const keys = Object.keys(row).filter((k) => row[k] !== undefined);
  const cols = keys.map(ident).join(', ');
  const vals = keys.map((_, i) => `$${i + 1}`).join(', ');
  const conflict = opts.onConflict ? ` on conflict ${opts.onConflict}` : '';
  const types = await typesOf(c, table);
  const rows = await q<T>(c, `insert into public.${ident(table)} (${cols}) values (${vals})${conflict} returning *`, keys.map((k) => prep(row[k], types.get(k))));
  return rows[0] as T;
}

export async function insertMany(c: Tx, table: string, rows: Record<string, unknown>[], chunk = 500): Promise<void> {
  if (!rows.length) return;
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const types = await typesOf(c, table);
  for (let i = 0; i < rows.length; i += chunk) {
    const part = rows.slice(i, i + chunk);
    const params: unknown[] = [];
    const tuples = part.map((r) => `(${keys.map((k) => (params.push(prep(r[k], types.get(k))), `$${params.length}`)).join(', ')})`);
    await c.query(`insert into public.${ident(table)} (${keys.map(ident).join(', ')}) values ${tuples.join(', ')}`, params);
  }
}

/** Update by id; returns the updated row or throws NotFound (also when RLS hides it). */
export async function update<T = Record<string, unknown>>(c: Tx, table: string, id: string, patch: Record<string, unknown>): Promise<T> {
  const keys = Object.keys(patch).filter((k) => patch[k] !== undefined);
  if (!keys.length) return one<T>(c, `select * from public.${ident(table)} where id = $1`, [id]);
  const sets = keys.map((k, i) => `${ident(k)} = $${i + 2}`).join(', ');
  const types = await typesOf(c, table);
  const rows = await q<T>(c, `update public.${ident(table)} set ${sets} where id = $1 returning *`, [id, ...keys.map((k) => prep(patch[k], types.get(k)))]);
  if (!rows[0]) throw new NotFoundError();
  return rows[0];
}

export class NotFoundError extends Error {
  status = 404;
  constructor(message = 'not_found') {
    super(message);
  }
}

export class ForbiddenError extends Error {
  status = 403;
  constructor(message = 'forbidden') {
    super(message);
  }
}

export class ValidationError extends Error {
  status = 422;
  constructor(
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export class ConflictError extends Error {
  status = 409;
  constructor(message = 'conflict') {
    super(message);
  }
}

export class PaymentRequiredError extends Error {
  status = 402;
  constructor(message: string) {
    super(message);
  }
}
