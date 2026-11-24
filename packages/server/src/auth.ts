/**
 * Sessions. Supabase Auth handles phone OTP and email login in production; the client sends the
 * Supabase access token once to /api/auth/session and receives an AutoEd session token (cookie for
 * web, bearer for mobile). Sessions are tracked as devices so they can be signed out remotely.
 * AUTH_PROVIDER=dev enables email-only login for local development and tests.
 * The session token carries the user id; the org, its products and the user's product access are read from the
 * platform tables on every request (app.current_org_id, core.user_product_access), so a suspended subscription
 * or a revoked grant applies to the next request.
 */
import { randomUUID } from 'node:crypto';
import { SignJWT, jwtVerify, createRemoteJWKSet } from 'jose';
import { asAnonymousServer, asUser, maybe } from './db';
import { UnauthorizedError } from './core';

const SESSION_TTL_SECONDS = Number(process.env.SESSION_TTL_SECONDS ?? 60 * 60 * 24 * 14);

function secret(): Uint8Array {
  const s = process.env.AUTH_JWT_SECRET;
  if (!s && process.env.NODE_ENV === 'production') throw new Error('AUTH_JWT_SECRET is required in production');
  return new TextEncoder().encode(s ?? 'dev-only-secret-change-me-dev-only-secret');
}

export interface Session {
  userId: string;
  sid: string;
  /** Org and products at sign-in (informational; every request re-reads both from the database). */
  orgId?: string | null;
  products?: string[];
}

export async function issueSession(userId: string, device: { platform: 'web' | 'android' | 'ios'; name?: string | null }): Promise<{ token: string; expires_at: string }> {
  const sid = randomUUID();
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  // Runs as the user (core.device_tokens: own rows only). A platform admin without an org gets no device row.
  const me = await asUser({ userId }, async (c) => {
    const m = await maybe<{ org_id: string | null; staff_id: string | null; products: string[] }>(
      c,
      `select app.current_org_id() as org_id, app.my_core_staff_id() as staff_id,
              coalesce((select array_agg(p.key order by p.key) from core.products p where app.user_has_product(app.current_org_id(), p.key)), '{}') as products`,
    );
    if (m?.org_id && m.products.length) await c.query(`insert into core.device_tokens (org_id, user_id, staff_id, token, platform, device_name, last_seen_at) values ($1,$2,$3,$4,$5,$6, now())`, [m.org_id, userId, m.staff_id, `session:${sid}`, device.platform, device.name ?? null]);
    return m;
  });
  const token = await new SignJWT({ sid, org: me?.org_id ?? null, products: me?.products ?? [] }).setProtectedHeader({ alg: 'HS256' }).setSubject(userId).setIssuedAt().setExpirationTime(exp).setIssuer('autoed-os').sign(secret());
  return { token, expires_at: new Date(exp * 1000).toISOString() };
}

export async function verifySession(token: string | null | undefined): Promise<Session> {
  if (!token) throw new UnauthorizedError();
  let payload;
  try {
    ({ payload } = await jwtVerify(token, secret(), { issuer: 'autoed-os' }));
  } catch {
    throw new UnauthorizedError('invalid_session');
  }
  const sid = String(payload.sid ?? '');
  const userId = String(payload.sub ?? '');
  const orgId = typeof payload.org === 'string' ? payload.org : null;
  const products = Array.isArray(payload.products) ? payload.products.map(String) : [];
  const revoked = await asUser({ userId }, (c) => maybe<{ revoked_at: string | null }>(c, `select revoked_at from core.device_tokens where token = $1`, [`session:${sid}`]));
  if (revoked?.revoked_at) throw new UnauthorizedError('session_revoked');
  if (revoked) void asUser({ userId }, (c) => c.query(`update core.device_tokens set last_seen_at = now() where token = $1 and (last_seen_at is null or last_seen_at < now() - interval '5 minutes')`, [`session:${sid}`])).catch(() => undefined);
  return { userId, sid, orgId, products };
}

export async function endSession(sid: string, userId: string) {
  await asUser({ userId }, (c) => c.query(`update core.device_tokens set revoked_at = now() where token = $1`, [`session:${sid}`]));
}

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

/** Verifies a Supabase access token (asymmetric JWKS or legacy HS256 secret). */
export async function verifySupabaseToken(accessToken: string): Promise<string> {
  const url = process.env.SUPABASE_URL;
  try {
    if (process.env.SUPABASE_JWT_SECRET) {
      const { payload } = await jwtVerify(accessToken, new TextEncoder().encode(process.env.SUPABASE_JWT_SECRET));
      return String(payload.sub);
    }
    if (!url) throw new Error('SUPABASE_URL missing');
    jwks ??= createRemoteJWKSet(new URL(`${url}/auth/v1/.well-known/jwks.json`));
    const { payload } = await jwtVerify(accessToken, jwks);
    return String(payload.sub);
  } catch {
    throw new UnauthorizedError('invalid_supabase_token');
  }
}

/** Dev / test login by email (disabled unless AUTH_PROVIDER=dev). */
export async function devLogin(email: string): Promise<string> {
  if (process.env.AUTH_PROVIDER !== 'dev') throw new UnauthorizedError('dev_login_disabled');
  // os.dev_login_user: an OS staff login or a platform admin (security definer; not granted to users).
  const u = await asAnonymousServer((c) => maybe<{ id: string | null }>(c, `select os.dev_login_user($1) as id`, [email]));
  if (!u?.id) throw new UnauthorizedError('unknown_user');
  return u.id;
}
// ---------------------------------------------------------------- rate limiting (login and AI)
const buckets = new Map<string, { tokens: number; at: number }>();

/** Token bucket per key. Single-instance memory; put a shared store in front for multi-instance. */
export function rateLimit(key: string, perMinute: number): boolean {
  const nowMs = Date.now();
  const b = buckets.get(key) ?? { tokens: perMinute, at: nowMs };
  b.tokens = Math.min(perMinute, b.tokens + ((nowMs - b.at) / 60000) * perMinute);
  b.at = nowMs;
  if (b.tokens < 1) {
    buckets.set(key, b);
    return false;
  }
  b.tokens -= 1;
  buckets.set(key, b);
  return true;
}
