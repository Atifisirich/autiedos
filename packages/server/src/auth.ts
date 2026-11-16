/**
 * Sessions. Supabase Auth handles phone OTP and email login in production; the client sends the
 * Supabase access token once to /api/auth/session and receives an AutoEd session token (cookie for
 * web, bearer for mobile). Sessions are tracked as devices so they can be signed out remotely.
 * AUTH_PROVIDER=dev enables email-only login for local development and tests.
 */
import { randomUUID } from 'node:crypto';
import { SignJWT, jwtVerify, createRemoteJWKSet } from 'jose';
import { asService, maybe } from './db';
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
}

export async function issueSession(userId: string, device: { platform: 'web' | 'android' | 'ios'; name?: string | null }): Promise<{ token: string; expires_at: string }> {
  const sid = randomUUID();
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  await asService(async (c) => {
    const staff = await maybe<{ id: string; org_id: string; branch_id: string | null }>(c, `select id, org_id, branch_id from public.staff where user_id = $1 and deleted_at is null and status in ('active','invited')`, [userId]);
    if (staff) await c.query(`insert into public.device_tokens (org_id, branch_id, staff_id, token, platform, device_name) values ($1,$2,$3,$4,$5,$6)`, [staff.org_id, staff.branch_id, staff.id, `session:${sid}`, device.platform, device.name ?? null]);
  });
  const token = await new SignJWT({ sid }).setProtectedHeader({ alg: 'HS256' }).setSubject(userId).setIssuedAt().setExpirationTime(exp).setIssuer('autoed-os').sign(secret());
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
  const revoked = await asService((c) => maybe<{ revoked_at: string | null }>(c, `select revoked_at from public.device_tokens where token = $1`, [`session:${sid}`]));
  if (revoked?.revoked_at) throw new UnauthorizedError('session_revoked');
  if (revoked) void asService((c) => c.query(`update public.device_tokens set last_seen_at = now() where token = $1 and last_seen_at < now() - interval '5 minutes'`, [`session:${sid}`])).catch(() => undefined);
  return { userId, sid };
}

export async function endSession(sid: string) {
  await asService((c) => c.query(`update public.device_tokens set revoked_at = now() where token = $1`, [`session:${sid}`]));
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
  const u = await asService((c) => maybe<{ id: string }>(c, `select id from auth.users where lower(email) = lower($1)`, [email]));
  if (!u) throw new UnauthorizedError('unknown_user');
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
