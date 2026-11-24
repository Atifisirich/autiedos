/**
 * Creating the login behind an invited person. Credentials belong to Supabase Auth, which the database role of the
 * console cannot (and must not) write, so this is an injected adapter:
 *  - Supabase: GoTrue admin API `POST /auth/v1/invite` (needs SUPABASE_URL and an auth admin key). NEVER RUN against a
 *    real project from this build: written from the public API shape, untested.
 *  - Dev: inserts into the local auth.users shim over ADMIN_DEV_AUTH_DATABASE_URL (only when AUTH_PROVIDER=dev).
 *  - Memory: tests.
 * `remove` undoes `invite` when the database part of "create client" fails afterwards.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';

export interface InviteInput {
  email: string;
  displayName: string;
}

export interface AuthProvisioner {
  /** `created` is false when the login already existed; only a login created by this call may be removed again. */
  invite(input: InviteInput): Promise<{ userId: string; created: boolean }>;
  remove(userId: string): Promise<void>;
}

export function createMemoryProvisioner(): AuthProvisioner & { invited: { userId: string; email: string }[]; removed: string[] } {
  const invited: { userId: string; email: string }[] = [];
  const removed: string[] = [];
  return {
    invited,
    removed,
    async invite({ email }) {
      const userId = randomUUID();
      invited.push({ userId, email });
      return { userId, created: true };
    },
    async remove(userId) {
      removed.push(userId);
    },
  };
}

export function createSupabaseProvisioner(env: Record<string, string | undefined> = process.env, fetchImpl: typeof fetch = fetch): AuthProvisioner {
  const base = env.SUPABASE_URL;
  const key = env.SUPABASE_AUTH_ADMIN_KEY;
  if (!base || !key) throw new Error('SUPABASE_URL and SUPABASE_AUTH_ADMIN_KEY are required to invite users');
  const headers = { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' };
  return {
    async invite({ email, displayName }) {
      const res = await fetchImpl(`${base}/auth/v1/invite`, { method: 'POST', headers, body: JSON.stringify({ email, data: { display_name: displayName } }) });
      if (!res.ok) throw new Error(`invite failed (${res.status})`);
      const body = (await res.json()) as { id?: string };
      if (!body.id) throw new Error('invite returned no user id');
      return { userId: body.id, created: true };
    },
    async remove(userId) {
      await fetchImpl(`${base}/auth/v1/admin/users/${encodeURIComponent(userId)}`, { method: 'DELETE', headers });
    },
  };
}

export function createDevProvisioner(connectionString: string): AuthProvisioner {
  const pool = new pg.Pool({ connectionString, max: 2 });
  return {
    async invite({ email, displayName }) {
      const ins = await pool.query(
        `insert into auth.users (email, raw_user_meta_data) values ($1, jsonb_build_object('display_name', $2::text))
         on conflict (email) do nothing returning id`,
        [email, displayName],
      );
      if (ins.rows[0]) return { userId: ins.rows[0].id as string, created: true };
      const existing = await pool.query(`select id from auth.users where email = $1`, [email]);
      return { userId: existing.rows[0].id as string, created: false };
    },
    async remove(userId) {
      await pool.query(`delete from auth.users where id = $1`, [userId]);
    },
  };
}

export function createProvisionerFromEnv(env: Record<string, string | undefined> = process.env): AuthProvisioner {
  if (env.AUTH_PROVIDER === 'dev' && env.NODE_ENV !== 'production' && env.ADMIN_DEV_AUTH_DATABASE_URL) return createDevProvisioner(env.ADMIN_DEV_AUTH_DATABASE_URL);
  // Built lazily: the console works without invite support until someone actually invites a person.
  let real: AuthProvisioner | null = null;
  const get = () => (real ??= createSupabaseProvisioner(env));
  return { invite: (i) => get().invite(i), remove: (u) => get().remove(u) };
}
