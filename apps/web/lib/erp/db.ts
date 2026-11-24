/**
 * Data API access for the ERP (decision 51): every call goes to PostgREST / Supabase as the signed-in user, so row level security is
 * the only barrier. No service key is used anywhere in the ERP pages. The caller's access token lives in the `erp_token` cookie
 * (production: the Supabase Auth access token set by /api/erp/session; local development: a token signed by the dev-only shim,
 * see lib/erp/dev-auth.ts).
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export const TOKEN_COOKIE = 'erp_token';
export type Sb = SupabaseClient<any, any, any>;

/** PostgREST on its own port has no /rest/v1 prefix (Supabase does): rewrite the path when ERP_DATA_API_URL is set. */
const plainPostgrest = () => !!process.env.ERP_DATA_API_URL;
export const dataApiUrl = () => process.env.ERP_DATA_API_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'http://127.0.0.1:3400';
const anonKey = () => process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.ERP_ANON_KEY ?? 'anon';

const noStore: typeof fetch = (input, init) => fetch(input, { ...init, cache: 'no-store' });
const rewrite: typeof fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  return fetch(url.replace('/rest/v1/', '/'), { ...init, cache: 'no-store' });
};

/** A client that acts as the holder of `token` (or anonymous without one). */
export function userClient(token?: string | null): Sb {
  return createClient(dataApiUrl(), anonKey(), {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: token ? { Authorization: `Bearer ${token}` } : {}, fetch: plainPostgrest() ? rewrite : noStore },
    db: { schema: 'erp' },
  }) as Sb;
}

export const core = (sb: Sb) => sb.schema('core');
export const erp = (sb: Sb) => sb.schema('erp');
export const auditDb = (sb: Sb) => sb.schema('audit');

/** Table by "schema.table" or by bare ERP name. */
export function tbl(sb: Sb, name: string) {
  const [s, t] = name.includes('.') ? name.split('.') : ['erp', name];
  return sb.schema(s!).from(t!);
}

/** Throws a readable error when a Data API call failed. */
export function must<T>(r: { data: T | null; error: { message: string } | null }): T {
  if (r.error) throw new Error(r.error.message);
  return r.data as T;
}

export function jwtPayload(token: string): { sub?: string; exp?: number; email?: string } | null {
  try {
    const p = token.split('.')[1];
    if (!p) return null;
    return JSON.parse(Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch {
    return null;
  }
}
