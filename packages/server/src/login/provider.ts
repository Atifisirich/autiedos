/**
 * Who checks OTP codes and passwords (decision 36). Production: Supabase Auth (GoTrue) over its HTTP API, called
 * from the server so that every attempt goes through the platform's rate limits, lockout and login log.
 * AUTH_PROVIDER=dev (never in production): a local provider for development and tests - the OTP code is
 * DEV_OTP_CODE (default 123456) and passwords live in the local-only auth.dev_passwords table (supabase/local/shim.sql).
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { LoginIdentifier } from '@autoed/shared';
import { asAnonymousServer, maybe } from '../db';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export interface AuthProvider {
  name: 'dev' | 'supabase';
  /** Sends a one-time code. Never reveals whether the identifier exists. */
  sendOtp(id: LoginIdentifier): Promise<void>;
  /** Returns the auth user id when the code is right, else null. */
  verifyOtp(id: LoginIdentifier, code: string, knownUserId: string | null): Promise<string | null>;
  /** Returns the auth user id when the password is right, else null. */
  verifyPassword(id: LoginIdentifier, password: string, knownUserId: string | null): Promise<string | null>;
  /** Sets the password of a user (already authorised by the caller). */
  setPassword(userId: string, password: string): Promise<void>;
}

export class ProviderError extends Error {
  status = 502;
  constructor(message = 'auth_provider_error') {
    super(message);
  }
}

// ---------------------------------------------------------------- dev
export async function devHash(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 32);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function devVerifyHash(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const [kind, salt, hash] = stored.split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const want = Buffer.from(hash, 'base64');
  const got = await scrypt(password, Buffer.from(salt, 'base64'), want.length);
  return timingSafeEqual(want, got);
}

let dummy: string | undefined;

export const devProvider: AuthProvider = {
  name: 'dev',
  async sendOtp() {
    /* the code is DEV_OTP_CODE; nothing is sent */
  },
  async verifyOtp(_id, code, knownUserId) {
    return knownUserId && code === (process.env.DEV_OTP_CODE || '123456') ? knownUserId : null;
  },
  async verifyPassword(_id, password, knownUserId) {
    if (!knownUserId) {
      await devVerifyHash(password, (dummy ??= await devHash('unknown-user'))); // same work for unknown users
      return null;
    }
    const row = await asAnonymousServer((c) => maybe<{ h: string | null }>(c, `select auth.dev_password_hash($1) as h`, [knownUserId]));
    return (await devVerifyHash(password, row?.h ?? null)) ? knownUserId : null;
  },
  async setPassword(userId, password) {
    const h = await devHash(password);
    await asAnonymousServer((c) => c.query(`select auth.dev_set_password($1, $2)`, [userId, h]));
  },
};

// ---------------------------------------------------------------- Supabase Auth (GoTrue HTTP API)
type Fetch = typeof fetch;

export function supabaseProvider(env: NodeJS.ProcessEnv = process.env, f: Fetch = fetch): AuthProvider {
  const url = () => {
    const u = env.SUPABASE_URL ?? env.NEXT_PUBLIC_SUPABASE_URL;
    if (!u) throw new ProviderError('supabase_not_configured');
    return u.replace(/\/+$/, '');
  };
  const anon = () => env.SUPABASE_ANON_KEY ?? env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
  const call = async (path: string, init: { method: string; body: unknown; key?: string }) => {
    const key = init.key ?? anon();
    const res = await f(`${url()}/auth/v1${path}`, { method: init.method, headers: { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(init.body) });
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    return { ok: res.ok, status: res.status, data };
  };
  const who = (id: LoginIdentifier) => (id.kind === 'email' ? { email: id.value } : { phone: id.value });
  const userIdOf = (d: Record<string, unknown> | null) => {
    const u = (d?.user ?? null) as { id?: string } | null;
    return u?.id ? String(u.id) : null;
  };
  return {
    name: 'supabase',
    async sendOtp(id) {
      const r = await call('/otp', { method: 'POST', body: { ...who(id), create_user: false } });
      // GoTrue answers 4xx for unknown users when create_user is false; the caller never tells the user which.
      if (r.status >= 500) throw new ProviderError();
    },
    async verifyOtp(id, code) {
      const r = await call('/verify', { method: 'POST', body: { ...who(id), token: code, type: id.kind === 'email' ? 'email' : 'sms' } });
      if (r.status >= 500) throw new ProviderError();
      return r.ok ? userIdOf(r.data) : null;
    },
    async verifyPassword(id, password) {
      const r = await call('/token?grant_type=password', { method: 'POST', body: { ...who(id), password } });
      if (r.status >= 500) throw new ProviderError();
      return r.ok ? userIdOf(r.data) : null;
    },
    async setPassword(userId, password) {
      const service = env.SUPABASE_SERVICE_ROLE_KEY;
      if (!service) throw new ProviderError('supabase_service_key_missing');
      const r = await call(`/admin/users/${encodeURIComponent(userId)}`, { method: 'PUT', body: { password }, key: service });
      if (!r.ok) throw new ProviderError(r.status === 422 ? 'weak_password' : 'auth_provider_error');
    },
  };
}

let override: AuthProvider | null = null;
/** Tests can swap the provider. */
export function setAuthProvider(p: AuthProvider | null) {
  override = p;
}

export function authProvider(): AuthProvider {
  if (override) return override;
  if (process.env.AUTH_PROVIDER === 'dev') {
    // Same rule as the existing dev login: never on a Vercel production deployment.
    if (process.env.VERCEL_ENV === 'production') throw new ProviderError('dev_auth_in_production');
    return devProvider;
  }
  return supabaseProvider();
}
