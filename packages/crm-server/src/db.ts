/**
 * Database access for the CRM server (plan 4.1, ADR 001, docs/adr/crm-port.md).
 *
 *  - The server connects as the login role `crm_server` (CRM_DATABASE_URL): not the owner, not service_role, no
 *    BYPASSRLS, no grants on os/erp/audit/billing/private. Every request runs in a transaction with
 *    request.jwt.claims set, exactly like the OS server, so the platform's RLS decides what the request sees.
 *  - `asUser` runs as the signed-in staff user (their role, scope and branches apply).
 *  - `asSystem` runs as the org's automation user (crm.system_actor): webhooks, public forms, the cron sweep and
 *    the lead-capture / de-duplication path, which must see the whole org. It is still RLS-bound to ONE org and
 *    to the CRM product, and is refused for an org without an active CRM subscription.
 *  - Jobs are claimed with a second pool, logged in as `job_runner` (JOB_DATABASE_URL), which can only call
 *    private.* functions.
 */
import pg from 'pg';

pg.types.setTypeParser(1082, (v) => v); // date as 'YYYY-MM-DD'
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v))); // numeric
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v))); // int8

export type Row = Record<string, any>;

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
export class UnauthorizedError extends Error {
  status = 401;
  constructor(message = 'unauthorized') {
    super(message);
  }
}
export class ValidationError extends Error {
  status = 422;
}

let crmPool: pg.Pool | null = null;
let jobPool: pg.Pool | null = null;

const ssl = (url: string) => (process.env.DATABASE_SSL === 'true' && !/localhost|127\.0\.0\.1/.test(url) ? { rejectUnauthorized: false } : undefined);

export function crmUrl(): string {
  return process.env.CRM_DATABASE_URL ?? 'postgres://crm_server@localhost:54322/postgres';
}
export function jobUrl(): string {
  return process.env.JOB_DATABASE_URL ?? 'postgres://job_runner@localhost:54322/postgres';
}

export function getPool(): pg.Pool {
  crmPool ??= new pg.Pool({ connectionString: crmUrl(), max: Number(process.env.DB_POOL_MAX ?? 10), ssl: ssl(crmUrl()) });
  return crmPool;
}
export function getJobPool(): pg.Pool {
  jobPool ??= new pg.Pool({ connectionString: jobUrl(), max: 2, ssl: ssl(jobUrl()) });
  return jobPool;
}
export async function closePools() {
  await crmPool?.end();
  await jobPool?.end();
  crmPool = null;
  jobPool = null;
}

// ---------------------------------------------------------------- column types (jsonb vs arrays)
const columnTypes = new Map<string, Map<string, string>>();
async function typesOf(c: pg.PoolClient, table: string): Promise<Map<string, string>> {
  let m = columnTypes.get(table);
  if (!m) {
    const [schema, name] = table.split('.') as [string, string];
    const rows = (await c.query(`select column_name, data_type from information_schema.columns where table_schema = $1 and table_name = $2`, [schema, name])).rows as {
      column_name: string;
      data_type: string;
    }[];
    m = new Map(rows.map((r) => [r.column_name, r.data_type]));
    if (m.size) columnTypes.set(table, m);
  }
  return m;
}

/** Arrays and objects are sent as JSON (the CRM stores jsonb); Dates and scalars pass through. */
const prep = (v: unknown) => (v !== null && typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : v);

const IDENT = /^[a-z_][a-z0-9_]*$/;
function ident(s: string): string {
  if (!IDENT.test(s)) throw new Error(`bad identifier ${s}`);
  return `"${s}"`;
}
function qualified(table: string): string {
  const parts = table.split('.');
  if (parts.length !== 2) throw new Error(`table must be schema-qualified: ${table}`);
  return parts.map(ident).join('.');
}

/** One transaction as one actor. All CRM logic in this package takes a Db. */
export class Db {
  constructor(
    readonly client: pg.PoolClient,
    /** The org the request is bound to (null only for pre-login lookups). */
    readonly orgId: string | null,
    /** The auth user whose claims are set: a staff user, or the org's automation user. */
    readonly userId: string | null,
    /** True when this is the org's automation user. */
    readonly system = false,
  ) {}

  async q(text: string, params: unknown[] = []): Promise<Row[]> {
    return (await this.client.query(text, params.map(prep))).rows;
  }

  async one(text: string, params: unknown[] = []): Promise<Row | null> {
    return (await this.q(text, params))[0] ?? null;
  }

  /** org_id is added for every table that has the column; pass it explicitly to override. */
  async insert(table: string, data: Row, opts: { returning?: boolean } = {}): Promise<Row> {
    const types = await typesOf(this.client, table);
    const row: Row = { ...data };
    if (types.has('org_id') && row.org_id === undefined) row.org_id = this.requireOrg();
    const keys = Object.keys(row).filter((k) => row[k] !== undefined);
    // returning = false for rows the caller may not be able to read back (a notification for a colleague)
    const sql = `insert into ${qualified(table)} (${keys.map(ident).join(',')}) values (${keys.map((_, i) => `$${i + 1}`).join(',')})${opts.returning === false ? '' : ' returning *'}`;
    const vals = keys.map((k) => {
      const v = row[k];
      const t = types.get(k);
      if (t === 'ARRAY') return v;
      return prep(v);
    });
    return (await this.client.query(sql, vals)).rows[0] ?? {};
  }

  /** Update by id inside the bound org; null when no visible row matched. */
  async update(table: string, id: string, data: Row): Promise<Row | null> {
    const types = await typesOf(this.client, table);
    const keys = Object.keys(data).filter((k) => data[k] !== undefined);
    if (!keys.length) return null;
    const org = types.has('org_id') ? ` and org_id = $${keys.length + 2}` : '';
    const sql = `update ${qualified(table)} set ${keys.map((k, i) => `${ident(k)} = $${i + 2}`).join(',')} where id = $1${org} returning *`;
    const params: unknown[] = [id, ...keys.map((k) => (types.get(k) === 'ARRAY' ? data[k] : prep(data[k])))];
    if (org) params.push(this.requireOrg());
    return (await this.client.query(sql, params)).rows[0] ?? null;
  }

  requireOrg(): string {
    if (!this.orgId) throw new Error('no organisation bound to this connection');
    return this.orgId;
  }

  private sp = 0;
  /** Runs fn inside a savepoint: an error rolls back only what fn did, then rethrows. */
  async sub<T>(fn: () => Promise<T>): Promise<T> {
    const name = `sp_${++this.sp}`;
    await this.client.query(`savepoint ${name}`);
    try {
      const out = await fn();
      await this.client.query(`release savepoint ${name}`);
      return out;
    } catch (e) {
      await this.client.query(`rollback to savepoint ${name}`);
      throw e;
    }
  }
}

async function inTx<T>(pool: pg.Pool, claims: { orgId: string | null; userId: string | null; system: boolean }, fn: (db: Db) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    if (claims.userId) {
      await client.query(
        `select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true), set_config('request.jwt.claim.role', 'authenticated', true)`,
        [JSON.stringify({ sub: claims.userId, role: 'authenticated' }), claims.userId],
      );
    }
    const out = await fn(new Db(client, claims.orgId, claims.userId, claims.system));
    await client.query('commit');
    return out;
  } catch (e) {
    await client.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

/** Runs fn as a signed-in staff user: their permissions, scope and branches decide what they see and change. */
export async function asUser<T>(userId: string, orgId: string | null, fn: (db: Db) => Promise<T>): Promise<T> {
  return inTx(getPool(), { orgId, userId, system: false }, fn);
}

/** The org's automation user id, or null when the org has no active CRM subscription. Never cached: a subscription change applies to the next request. */
export async function systemActor(orgId: string): Promise<string | null> {
  return ((await getPool().query('select crm.system_actor($1) as id', [orgId])).rows[0]?.id as string | null | undefined) ?? null;
}

export class OrgInactiveError extends ForbiddenError {
  constructor(orgId: string) {
    super(`organisation ${orgId} has no active CRM subscription`);
  }
}

/** Runs fn as the org's automation user (see the header). RLS still binds it to this org and the CRM product. */
export async function asSystem<T>(orgId: string, fn: (db: Db) => Promise<T>): Promise<T> {
  const actor = await systemActor(orgId);
  if (!actor) throw new OrgInactiveError(orgId);
  return inTx(getPool(), { orgId, userId: actor, system: true }, fn);
}

/** Pre-login lookup (no claims): resolves a public key to an org and its automation user. */
export async function resolvePublic(kind: 'webhook' | 'form' | 'enquiry' | 'payment' | 'api_key', token: string): Promise<{ orgId: string; refId: string; name: string | null; sourceId: string | null } | null> {
  const r = (await getPool().query('select org_id, system_user_id, ref_id, name, source_id from crm.resolve_public($1, $2)', [kind, token])).rows[0];
  if (!r) return null;
  return { orgId: r.org_id, refId: r.ref_id, name: r.name, sourceId: r.source_id };
}

/** Runs fn with the job-worker login (private.claim_jobs / finish_job / enqueue_tick_jobs only). */
export async function asJobRunner<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await getJobPool().connect();
  try {
    return await fn(c);
  } finally {
    c.release();
  }
}
