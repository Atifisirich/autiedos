/**
 * Unified staff login (decisions 35-37, docs/adr/shell-and-login.md). One sign-in for CRM, OS and ERP:
 * phone OTP, e-mail OTP and password, checked by Supabase Auth (or the dev provider) FROM THE SERVER, so every
 * attempt passes the platform's rate limit (app.rate_limit_hit), lockout (app.login_allowed /
 * app.record_login_event: 5 wrong passwords lock the account for 15 minutes) and login log (core.login_events).
 * A successful sign-in returns the platform session token carrying org + products (auth.issueSession);
 * a person with no product is refused (403 no_product). While core.user_security.must_change_password is set,
 * only GET /session and the password routes answer (403 password_change_required elsewhere).
 */
import { createHash } from 'node:crypto';
import { checkPassword, parseLoginIdentifier, PASSWORD_MIN_LENGTH_DEFAULT, PRODUCT_HOME, type LoginIdentifier, type PlatformSession, type ProductKeyName, type SignInResult } from '@autoed/shared';
import { asAnonymousServer, asUser, ForbiddenError, maybe, one, q, ValidationError } from '../db';
import { UnauthorizedError } from '../core';
import { endSession, issueSession, verifySupabaseToken, devLogin, type Session } from '../auth';
import { authProvider } from './provider';

export { authProvider, setAuthProvider, devProvider, supabaseProvider, devHash } from './provider';

export class RateLimitedError extends Error {
  status = 429;
  constructor() {
    super('rate_limited');
  }
}
export class LockedError extends Error {
  status = 423;
  constructor() {
    super('account_locked');
  }
}

export interface LoginRequest {
  ip?: string;
  userAgent?: string | null;
  platform?: 'web' | 'android' | 'ios';
}

const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
export const loginLimits = () => ({
  ipPerMinute: num(process.env.LOGIN_IP_PER_MINUTE, 30),
  identifierPer15Min: num(process.env.LOGIN_ID_PER_15_MIN, 10),
  otpSendPer15Min: num(process.env.OTP_SEND_PER_15_MIN, 5),
  passwordChangePer15Min: num(process.env.PASSWORD_CHANGE_PER_15_MIN, 10),
});
export const passwordMinLength = () => Math.max(8, num(process.env.PASSWORD_MIN_LENGTH, PASSWORD_MIN_LENGTH_DEFAULT));
const RESET_WINDOW_S = 15 * 60;

/** Fixed-window limit in the database (private.rate_limits), shared by every server instance. */
export async function rateLimitHit(key: string, limit: number, windowSeconds: number): Promise<void> {
  const r = await asAnonymousServer((c) => one<{ ok: boolean }>(c, `select app.rate_limit_hit($1, $2, $3) as ok`, [key.slice(0, 200), limit, windowSeconds]));
  if (!r.ok) throw new RateLimitedError();
}

const inet = (ip?: string) => (ip && (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip) || /^[0-9a-f:]+$/i.test(ip)) ? ip : null);
type Method = 'otp_phone' | 'otp_email' | 'password' | 'logout';

interface Lookup {
  user_id: string;
  org_id: string | null;
  member_status: string | null;
  platform_admin: boolean;
}
async function lookup(id: LoginIdentifier): Promise<Lookup | null> {
  return asAnonymousServer((c) => maybe<Lookup>(c, `select * from app.login_lookup($1)`, [id.value]));
}
/** Counts toward lockout (password failures) and resets it on success. Returns locked_until. */
async function recordAttempt(userId: string | null, method: Method, success: boolean, reason: string | null, req: LoginRequest): Promise<string | null> {
  const r = await asAnonymousServer((c) => maybe<{ locked_until: string | null }>(c, `select r.locked_until from app.record_login_event($1, $2, $3, $4, $5::inet, $6) r`, [userId, method, success, reason, inet(req.ip), req.userAgent?.slice(0, 300) ?? null]));
  return r?.locked_until ?? null;
}
/** A login event that does not touch the counter (refusals after the check, sign-out). */
async function note(userId: string | null, method: Method, success: boolean, reason: string, req: LoginRequest) {
  await asAnonymousServer((c) => c.query(`select app.record_login_note($1, $2, $3, $4, $5::inet, $6)`, [userId, method, success, reason, inet(req.ip), req.userAgent ?? null]));
}
async function loginAllowed(userId: string): Promise<boolean> {
  return (await asAnonymousServer((c) => one<{ ok: boolean }>(c, `select app.login_allowed($1) as ok`, [userId]))).ok;
}

const ipKey = (req: LoginRequest) => `login:ip:${req.ip ?? 'unknown'}`;
const device = (req: LoginRequest) => ({ platform: req.platform ?? 'web', name: req.userAgent?.slice(0, 100) ?? null });

/** Checks that may refuse a user whose secret was right: lock, disabled member. */
async function guard(u: Lookup, method: Method, req: LoginRequest) {
  if (!(await loginAllowed(u.user_id))) {
    await note(u.user_id, method, false, 'locked', req);
    throw new LockedError();
  }
  if (!u.platform_admin && (!u.org_id || u.member_status === 'disabled')) {
    await note(u.user_id, method, false, 'disabled', req);
    throw new ForbiddenError('account_disabled');
  }
}

/** Issues the session; a refusal for "no product" is logged without counting as a wrong secret. */
async function finish(userId: string, method: Method, req: LoginRequest, purpose: 'login' | 'reset' = 'login', reason: string | null = null): Promise<SignInResult> {
  let s: SignInResult;
  try {
    s = await issueSession(userId, device(req), { purpose });
  } catch (e) {
    if (e instanceof ForbiddenError && e.message === 'no_product') await note(userId, method, false, 'no_product', req);
    throw e;
  }
  await recordAttempt(userId, method, true, reason, req);
  return s;
}

// ---------------------------------------------------------------- sign-in flows
export async function passwordLogin(input: { identifier: string; password: string }, req: LoginRequest): Promise<SignInResult> {
  const id = parseLoginIdentifier(input.identifier);
  await rateLimitHit(ipKey(req), loginLimits().ipPerMinute, 60);
  if (!id) throw new UnauthorizedError('invalid_credentials');
  await rateLimitHit(`login:id:${id.value}`, loginLimits().identifierPer15Min, 900);
  const u = await lookup(id);
  const provider = authProvider();
  if (!u) {
    await provider.verifyPassword(id, input.password, null);
    await recordAttempt(null, 'password', false, 'unknown_identifier', req);
    throw new UnauthorizedError('invalid_credentials');
  }
  if (!(await loginAllowed(u.user_id))) {
    await note(u.user_id, 'password', false, 'locked', req);
    throw new LockedError();
  }
  const who = await provider.verifyPassword(id, input.password, u.user_id);
  if (who !== u.user_id) {
    const lockedUntil = await recordAttempt(u.user_id, 'password', false, 'bad_password', req);
    if (lockedUntil && new Date(lockedUntil) > new Date()) throw new LockedError();
    throw new UnauthorizedError('invalid_credentials');
  }
  await guard(u, 'password', req);
  return finish(u.user_id, 'password', req);
}

export async function otpStart(input: { identifier: string }, req: LoginRequest): Promise<{ ok: true; channel: 'email' | 'phone' }> {
  const id = parseLoginIdentifier(input.identifier);
  await rateLimitHit(ipKey(req), loginLimits().ipPerMinute, 60);
  if (!id) throw new ValidationError('invalid_identifier');
  await rateLimitHit(`otp:send:${id.value}`, loginLimits().otpSendPer15Min, 900);
  const u = await lookup(id);
  // The answer is the same whether or not the identifier exists (no account discovery).
  if (u && (u.platform_admin || (u.org_id && u.member_status !== 'disabled')) && (await loginAllowed(u.user_id))) await authProvider().sendOtp(id);
  return { ok: true, channel: id.kind };
}

export async function otpVerify(input: { identifier: string; code: string; purpose?: 'login' | 'reset' }, req: LoginRequest): Promise<SignInResult> {
  const id = parseLoginIdentifier(input.identifier);
  await rateLimitHit(ipKey(req), loginLimits().ipPerMinute, 60);
  if (!id) throw new UnauthorizedError('invalid_code');
  await rateLimitHit(`login:id:${id.value}`, loginLimits().identifierPer15Min, 900);
  const method: Method = id.kind === 'email' ? 'otp_email' : 'otp_phone';
  const u = await lookup(id);
  if (!u) {
    await recordAttempt(null, method, false, 'unknown_identifier', req);
    throw new UnauthorizedError('invalid_code');
  }
  if (!(await loginAllowed(u.user_id))) {
    await note(u.user_id, method, false, 'locked', req);
    throw new LockedError();
  }
  const who = await authProvider().verifyOtp(id, input.code, u.user_id);
  if (who !== u.user_id) {
    await recordAttempt(u.user_id, method, false, 'bad_code', req);
    throw new UnauthorizedError('invalid_code');
  }
  await guard(u, method, req);
  return finish(u.user_id, method, req, input.purpose ?? 'login', input.purpose === 'reset' ? 'password_reset' : null);
}

/** Exchange of a Supabase access token obtained by the client itself (mobile apps, portal). */
export async function exchange(input: { accessToken: string; method?: 'otp_phone' | 'otp_email' | 'password'; purpose?: 'login' | 'reset' }, req: LoginRequest): Promise<SignInResult> {
  await rateLimitHit(ipKey(req), loginLimits().ipPerMinute, 60);
  const userId = await verifySupabaseToken(input.accessToken);
  const method = input.method ?? 'otp_email';
  if (!(await loginAllowed(userId))) {
    await note(userId, method, false, 'locked', req);
    throw new LockedError();
  }
  return finish(userId, method, req, input.purpose ?? 'login');
}

/** AUTH_PROVIDER=dev: e-mail only demo login (unchanged behaviour, now rate limited in the database and logged). */
export async function devEmailLogin(input: { email: string }, req: LoginRequest): Promise<SignInResult> {
  await rateLimitHit(ipKey(req), loginLimits().ipPerMinute, 60);
  const userId = await devLogin(input.email);
  if (!(await loginAllowed(userId))) {
    await note(userId, 'otp_email', false, 'locked', req);
    throw new LockedError();
  }
  return finish(userId, 'otp_email', req, 'login', 'dev_login');
}

export async function logoutNote(userId: string, req: LoginRequest) {
  await note(userId, 'logout', true, 'logout', req).catch(() => undefined);
}

// ---------------------------------------------------------------- passwords
async function identity(userId: string): Promise<{ email: string | null; phone: string | null }> {
  return (await asAnonymousServer((c) => maybe<{ email: string | null; phone: string | null }>(c, `select * from app.login_identity($1)`, [userId]))) ?? { email: null, phone: null };
}

/** Optional breached-password check (PASSWORD_BREACH_CHECK=on; off by default). k-anonymity: only 5 hex chars leave. */
export async function isBreached(password: string, f: typeof fetch = fetch): Promise<boolean> {
  if (process.env.PASSWORD_BREACH_CHECK !== 'on') return false;
  const h = createHash('sha1').update(password).digest('hex').toUpperCase();
  try {
    const res = await f(`https://api.pwnedpasswords.com/range/${h.slice(0, 5)}`, { headers: { 'add-padding': 'true' } });
    if (!res.ok) return false;
    const body = await res.text();
    return body.split('\n').some((l) => l.split(':')[0]?.trim() === h.slice(5) && Number(l.split(':')[1]) > 0);
  } catch {
    return false; // fail open: the check is advisory, the length rule still applies
  }
}

export async function validateNewPassword(password: string, identifiers: (string | null)[]): Promise<void> {
  const problems: string[] = checkPassword(password, { minLength: passwordMinLength(), identifiers });
  if (!problems.length && (await isBreached(password))) problems.push('breached');
  if (problems.length) throw new ValidationError('weak_password', problems);
}

/**
 * Sets or changes the signed-in user's password. The current password is required unless none was set yet,
 * an admin asked for a change (must_change_password) or the session is a fresh "forgot password" OTP sign-in.
 * Returns a new session (the old one is ended) without the must-change flag.
 */
export async function changePassword(session: Session, input: { current_password?: string | null; new_password: string }, req: LoginRequest): Promise<SignInResult> {
  await rateLimitHit(`pwchange:${session.userId}`, loginLimits().passwordChangePer15Min, 900);
  const sec = await asUser({ userId: session.userId }, (c) => maybe<{ password_set_at: string | null; must_change_password: boolean }>(c, `select password_set_at, must_change_password from core.user_security where user_id = $1`, [session.userId]));
  const who = await identity(session.userId);
  const freshReset = !!session.resetAt && Date.now() / 1000 - session.resetAt < RESET_WINDOW_S;
  const needCurrent = !!sec?.password_set_at && !sec.must_change_password && !freshReset;
  const provider = authProvider();
  if (needCurrent) {
    if (!input.current_password) throw new ValidationError('current_password_required');
    const id: LoginIdentifier | null = who.email ? { kind: 'email', value: who.email } : who.phone ? parseLoginIdentifier(who.phone) : null;
    if (!(await loginAllowed(session.userId))) throw new LockedError();
    const ok = id ? await provider.verifyPassword(id, input.current_password, session.userId) : null;
    if (ok !== session.userId) {
      const lockedUntil = await recordAttempt(session.userId, 'password', false, 'bad_current_password', req);
      if (lockedUntil && new Date(lockedUntil) > new Date()) throw new LockedError();
      throw new ValidationError('current_password_wrong');
    }
  }
  await validateNewPassword(input.new_password, [who.email, who.phone]);
  await provider.setPassword(session.userId, input.new_password);
  await asAnonymousServer((c) => c.query(`select app.record_password_set($1, false)`, [session.userId]));
  await endSession(session.sid, session.userId);
  return issueSession(session.userId, device(req));
}

// ---------------------------------------------------------------- GET /session
/** The platform session for the shell: org (with branding), products with their modules, must-change state. */
export async function platformSession(session: Session): Promise<PlatformSession> {
  const who = await identity(session.userId);
  return asUser({ userId: session.userId }, async (c) => {
    const org = await maybe<NonNullable<PlatformSession['org']> & { default_locale: string }>(
      c,
      `select o.id, o.name, o.slug, o.kind, o.branding, o.default_locale,
              (select f.storage_path from core.files f where f.org_id = o.id and f.id = o.logo_file_id) as logo_path
         from core.organizations o where o.id = app.current_org_id()`,
    );
    const member = await maybe<{ kind: string; display_name: string }>(c, `select kind, display_name from core.org_users where user_id = $1`, [session.userId]);
    const admin = await maybe<{ name: string }>(c, `select name from core.platform_admins where user_id = $1 and active`, [session.userId]);
    const staff = await maybe<{ language: string }>(c, `select language from core.staff where user_id = $1 and deleted_at is null limit 1`, [session.userId]);
    const sec = await maybe<{ must_change_password: boolean; password_set_at: string | null }>(c, `select must_change_password, password_set_at from core.user_security where user_id = $1`, [session.userId]);
    const products = await q<{ key: ProductKeyName; name: string }>(c, `select p.key, p.name from core.products p where p.active and app.user_has_product(app.current_org_id(), p.key) order by array_position(array['os','crm','erp'], p.key)`);
    const modules = products.length ? await q<{ product_key: string; module_key: string; name: string }>(c, `select product_key, module_key, name from core.product_modules where active and product_key = any($1) order by product_key, module_key`, [products.map((p) => p.key)]) : [];
    const lang = [staff?.language, org?.default_locale].find((l) => l === 'en' || l === 'hi' || l === 'te') as PlatformSession['lang'] | undefined;
    return {
      user: { id: session.userId, name: member?.display_name ?? admin?.name ?? who.email ?? '', kind: member?.kind ?? (admin ? 'platform_admin' : null), email: who.email, phone: who.phone },
      org: org ? { id: org.id, name: org.name, slug: org.slug, kind: org.kind, branding: org.branding ?? {}, logo_path: org.logo_path ?? null } : null,
      products: products.map((p) => ({ key: p.key, name: p.name, home: PRODUCT_HOME[p.key], modules: modules.filter((m) => m.product_key === p.key).map((m) => ({ key: m.module_key, name: m.name })) })),
      must_change_password: !!sec?.must_change_password,
      password_set: !!sec?.password_set_at,
      is_platform_admin: !!admin,
      lang: lang ?? 'en',
      password_min_length: passwordMinLength(),
    };
  });
}
