/**
 * Database access (OS on the shared platform, docs/adr/os-move.md).
 *
 * The OS server connects as the database role `os_server` (USAGE on core + os only, no BYPASSRLS). Every
 * request runs in one transaction with `request.jwt.claims` set for the signed-in user, so Row Level Security
 * applies to every query; there is no `set role`. System work (jobs, scheduled sweeps, checked side effects for
 * other users) runs as the org's OS system actor (`os.system_user_id(org)`): still bounded by tenant and product.
 * `service_role` is never used by request handlers. The job queue (private.jobs) is claimed by `job_runner`.
 *
 * Connection strings: OS_DATABASE_URL, else DATABASE_URL with the user switched to os_server (password from
 * OS_SERVER_DB_PASSWORD); JOB_DATABASE_URL / job_runner (JOB_RUNNER_DB_PASSWORD) and ADMIN_DATABASE_URL /
 * platform_admin_server (PLATFORM_ADMIN_DB_PASSWORD) likewise. Locally the cluster trusts these logins.
 */
import pg from 'pg';

// Return dates as ISO strings and numerics as numbers.
pg.types.setTypeParser(1082, (v) => v); // date
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v))); // numeric
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v))); // int8

export type Tx = pg.PoolClient;

const BASE_URL = () => process.env.DATABASE_URL ?? 'postgres://postgres@localhost:54322/postgres';

/** DATABASE_URL with the login switched to a platform role (unless an explicit URL is configured). */
export function roleUrl(role: 'os_server' | 'crm_server' | 'erp_server' | 'job_runner' | 'platform_admin_server', explicit: string | undefined, password: string | undefined): string {
  if (explicit) return explicit;
  const u = new URL(BASE_URL());
  u.username = role;
  u.password = password ?? '';
  return u.toString();
}

const pools = new Map<string, pg.Pool>();
function pool(name: string, url: () => string): pg.Pool {
  let p = pools.get(name);
  if (!p) {
    p = new pg.Pool({
      connectionString: url(),
      max: Number(process.env.DB_POOL_MAX ?? 10),
      ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
    });
    pools.set(name, p);
  }
  return p;
}

/** Requests: the os_server login. */
export const getPool = () => pool('os', () => roleUrl('os_server', process.env.OS_DATABASE_URL, process.env.OS_SERVER_DB_PASSWORD));
/** Job queue (private.claim_jobs / finish_job only). */
export const getJobPool = () => pool('jobs', () => roleUrl('job_runner', process.env.JOB_DATABASE_URL, process.env.JOB_RUNNER_DB_PASSWORD));
/** Platform console actions of AutoEd staff (entitlements, billing). */
export const getAdminPool = () => pool('admin', () => roleUrl('platform_admin_server', process.env.ADMIN_DATABASE_URL, process.env.PLATFORM_ADMIN_DB_PASSWORD));
/**
 * The other products' server logins, for work that must run as that product (the AI designer applies CRM blocks as
 * crm_server and ERP blocks as erp_server, with the signed-in person's claims). CRM_DATABASE_URL / ERP_DATABASE_URL
 * (or ERP_SERVER_DATABASE_URL), else DATABASE_URL with the login switched (CRM_SERVER_DB_PASSWORD / ERP_SERVER_DB_PASSWORD).
 */
export type ProductRole = 'os_server' | 'crm_server' | 'erp_server';
export function getProductPool(role: ProductRole): pg.Pool {
  if (role === 'os_server') return getPool();
  if (role === 'crm_server') return pool('crm', () => roleUrl('crm_server', process.env.CRM_DATABASE_URL, process.env.CRM_SERVER_DB_PASSWORD));
  return pool('erp', () => roleUrl('erp_server', process.env.ERP_DATABASE_URL ?? process.env.ERP_SERVER_DATABASE_URL, process.env.ERP_SERVER_DB_PASSWORD));
}
/** Table owner: migrations, the demo seed and tests ONLY (never a request path). */
export const getOwnerPool = () => pool('owner', BASE_URL);

export async function closePool() {
  await Promise.all([...pools.values()].map((p) => p.end()));
  pools.clear();
  systemUsers.clear();
}

export interface DbUser {
  userId: string;
  staffId?: string | null;
  device?: string | null;
}

async function inTx<T>(p: pg.Pool, setup: (c: Tx) => Promise<void>, fn: (c: Tx) => Promise<T>): Promise<T> {
  const client = await p.connect();
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

/** Sets the request claims (user id, platform role) on the current transaction. */
export async function setClaims(c: Tx, userId: string, extra: { onBehalfOf?: string | null; device?: string | null; staffId?: string | null } = {}) {
  await c.query(
    `select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true),
            set_config('request.jwt.claim.role', 'authenticated', true), set_config('app.device', $3, true),
            set_config('app.actor_staff_id', $4, true)`,
    [JSON.stringify({ sub: userId, role: 'authenticated', ...(extra.onBehalfOf ? { on_behalf_of: extra.onBehalfOf } : {}) }), userId, extra.device ?? '', extra.staffId ?? ''],
  );
}

/** Runs fn as os_server with RLS applied for this user. */
export function asUser<T>(u: DbUser, fn: (c: Tx) => Promise<T>): Promise<T> {
  return inTx(getPool(), (c) => setClaims(c, u.userId, { device: u.device, staffId: u.staffId }), fn);
}

/** Runs fn as a product's server login with RLS applied for this user (same claims as asUser). */
export function asUserIn<T>(role: ProductRole, u: DbUser, fn: (c: Tx) => Promise<T>): Promise<T> {
  return inTx(getProductPool(role), (c) => setClaims(c, u.userId, { device: u.device, staffId: u.staffId }), fn);
}

/**
 * Opens a transaction as a product's server login with this user's claims and leaves it open: the caller commits or
 * rolls it back (the designer keeps one per product for a publish and finishes them together).
 */
export async function openUserTx(role: ProductRole, u: DbUser): Promise<{ c: Tx; finish: (commit: boolean) => Promise<void> }> {
  const c = await getProductPool(role).connect();
  try {
    await c.query('begin');
    await setClaims(c, u.userId, { device: u.device, staffId: u.staffId });
  } catch (e) {
    c.release();
    throw e;
  }
  let done = false;
  return {
    c,
    async finish(commit) {
      if (done) return;
      done = true;
      try {
        await c.query(commit ? 'commit' : 'rollback');
      } finally {
        c.release();
      }
    },
  };
}

const systemUsers = new Map<string, string>();

/** The org's OS system actor (created on first use); null when the org does not have the OS product. */
export async function systemUserId(c: Tx, orgId: string): Promise<string | null> {
  const hit = systemUsers.get(orgId);
  if (hit) return hit;
  const r = await c.query<{ id: string | null }>(`select os.system_user_id($1) as id`, [orgId]);
  const id = r.rows[0]?.id ?? null;
  if (id) systemUsers.set(orgId, id);
  return id;
}

/**
 * Runs fn as the org's OS system actor (scheduled work, checked side effects). Bounded by the org and the OS
 * product like any other user; callers must have checked the requesting user's permission first.
 */
export function asSystem<T>(orgId: string, fn: (c: Tx) => Promise<T>, actor?: DbUser): Promise<T> {
  return inTx(getPool(), async (c) => {
    const sys = await systemUserId(c, orgId);
    if (!sys) throw new ForbiddenError('product_not_available');
    await setClaims(c, sys, { onBehalfOf: actor?.userId, device: actor?.device, staffId: actor?.staffId });
  }, fn);
}

/**
 * Inside an open transaction: runs fn with the claims of the org's OS system actor, then restores the caller's
 * claims (same transaction, so the request still commits or rolls back as one). For checked side effects that
 * cross users (notifications, system tasks); the caller must have checked permission first.
 */
export async function withSystem<T>(c: Tx, orgId: string, fn: () => Promise<T>): Promise<T> {
  const cur = (await c.query<{ cl: string | null; sub: string | null }>(`select current_setting('request.jwt.claims', true) as cl, current_setting('request.jwt.claim.sub', true) as sub`)).rows[0];
  const sys = await systemUserId(c, orgId);
  if (!sys) throw new ForbiddenError('product_not_available');
  if (cur?.sub === sys) return fn();
  await setClaims(c, sys, { onBehalfOf: cur?.sub || null });
  const restore = () => c.query(`select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)`, [cur?.cl ?? '', cur?.sub ?? '']);
  let out: T;
  try {
    out = await fn();
  } catch (e) {
    await restore().catch(() => undefined); // aborted transaction: keep the original error
    throw e;
  }
  await restore();
  return out;
}

/** Pre-login work with no user and no org (dev login lookup). Only security definer functions are useful here. */
export function asAnonymousServer<T>(fn: (c: Tx) => Promise<T>): Promise<T> {
  return inTx(getPool(), async () => undefined, fn);
}

/** Platform console: platform_admin_server with the platform admin's claims (RLS: app.is_platform_admin()). */
export function asPlatformAdmin<T>(userId: string, fn: (c: Tx) => Promise<T>): Promise<T> {
  return inTx(getAdminPool(), (c) => setClaims(c, userId), fn);
}

/** Table owner: the demo seed and tests only. */
export function asOwner<T>(fn: (c: Tx) => Promise<T>): Promise<T> {
  return inTx(getOwnerPool(), async () => undefined, fn);
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

/** 'os.tasks' / 'core.staff' -> quoted, checked name. Only os, core and billing tables are written by the OS. */
function tableName(t: string): { schema: string; table: string; sql: string } {
  const [schema, table] = t.includes('.') ? t.split('.') as [string, string] : ['os', t];
  if (!['os', 'core'].includes(schema)) throw new Error(`table ${t} is not in os or core`);
  return { schema, table, sql: `${ident(schema)}.${ident(table)}` };
}

const columnTypes = new Map<string, Map<string, string>>();

/** Column -> data_type for a table (cached per process). */
async function typesOf(c: Tx, t: string): Promise<Map<string, string>> {
  let m = columnTypes.get(t);
  if (!m) {
    const { schema, table } = tableName(t);
    const rows = (await c.query(`select column_name, data_type from information_schema.columns where table_schema = $1 and table_name = $2`, [schema, table])).rows as { column_name: string; data_type: string }[];
    m = new Map(rows.map((r) => [r.column_name, r.data_type]));
    if (m.size) columnTypes.set(t, m);
  }
  return m;
}

function prep(v: unknown, type: string | undefined): unknown {
  if (v === undefined) return null;
  if (type === 'jsonb' || type === 'json') return v === null ? null : JSON.stringify(v);
  if (v !== null && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v)) return JSON.stringify(v);
  return v;
}

/** Insert one row into 'os.x' or 'core.x'; returns it. Objects are stored as JSON. */
export async function insert<T = Record<string, unknown>>(c: Tx, table: string, row: Record<string, unknown>, opts: { onConflict?: string } = {}): Promise<T> {
  const t = tableName(table);
  const keys = Object.keys(row).filter((k) => row[k] !== undefined);
  const cols = keys.map(ident).join(', ');
  const vals = keys.map((_, i) => `$${i + 1}`).join(', ');
  const conflict = opts.onConflict ? ` on conflict ${opts.onConflict}` : '';
  const types = await typesOf(c, table);
  const rows = await q<T>(c, `insert into ${t.sql} (${cols}) values (${vals})${conflict} returning *`, keys.map((k) => prep(row[k], types.get(k))));
  return rows[0] as T;
}

export async function insertMany(c: Tx, table: string, rows: Record<string, unknown>[], chunk = 500): Promise<void> {
  if (!rows.length) return;
  const t = tableName(table);
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const types = await typesOf(c, table);
  for (let i = 0; i < rows.length; i += chunk) {
    const part = rows.slice(i, i + chunk);
    const params: unknown[] = [];
    const tuples = part.map((r) => `(${keys.map((k) => (params.push(prep(r[k], types.get(k))), `$${params.length}`)).join(', ')})`);
    await c.query(`insert into ${t.sql} (${keys.map(ident).join(', ')}) values ${tuples.join(', ')}`, params);
  }
}

/** Update by id; returns the updated row or throws NotFound (also when RLS hides it). */
export async function update<T = Record<string, unknown>>(c: Tx, table: string, id: string, patch: Record<string, unknown>): Promise<T> {
  const t = tableName(table);
  const keys = Object.keys(patch).filter((k) => patch[k] !== undefined);
  if (!keys.length) return one<T>(c, `select * from ${t.sql} where id = $1`, [id]);
  const sets = keys.map((k, i) => `${ident(k)} = $${i + 2}`).join(', ');
  const types = await typesOf(c, table);
  const rows = await q<T>(c, `update ${t.sql} set ${sets} where id = $1 returning *`, [id, ...keys.map((k) => prep(patch[k], types.get(k)))]);
  if (!rows[0]) throw new NotFoundError();
  return rows[0];
}

/** Splits a display name into the core first_name / last_name columns (core.staff, core.students: OQ-1). */
export function splitName(full: string): { first_name: string; last_name: string | null } {
  const parts = full.trim().split(/\s+/);
  if (parts.length === 1) return { first_name: parts[0]!, last_name: null };
  return { first_name: parts.slice(0, -1).join(' '), last_name: parts[parts.length - 1]! };
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
