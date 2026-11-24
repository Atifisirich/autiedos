/**
 * Unified staff login and the platform session (docs/adr/shell-and-login.md): password lockout, must-change
 * enforcement, database rate limits, the session token carrying org + products, refusal of a person without a
 * product, OTP (dev provider) and the Supabase token exchange. Runs on the seeded demo school (OS only).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodeJwt, SignJWT } from 'jose';
import { dispatch, type ApiResponse } from '../src/api';
import { asOwner, closePool, one, q } from '../src/db';
import { devHash, isBreached, supabaseProvider } from '../src/login';

let n = 0;
const ip = () => `10.9.${Math.floor(++n / 250)}.${n % 250}`;
async function call(method: string, path: string, body: unknown = {}, token?: string, reqIp = ip()): Promise<ApiResponse & { json: any }> {
  return (await dispatch({ method, path, query: {}, headers: token ? { authorization: `Bearer ${token}`, 'user-agent': 'vitest' } : { 'user-agent': 'vitest' }, body, ip: reqIp })) as ApiResponse & { json: any };
}
const owner = <T = any>(sql: string, params: unknown[] = []) => asOwner((c) => q<T>(c, sql, params));
async function userId(email: string): Promise<string> {
  return (await asOwner((c) => one<{ id: string }>(c, `select id from auth.users where email = $1`, [email]))).id;
}
async function setPassword(email: string, pw: string) {
  const id = await userId(email);
  const h = await devHash(pw);
  await owner(`select auth.dev_set_password($1, $2)`, [id, h]);
  await owner(`insert into core.user_security (user_id, org_id) select $1, org_id from core.org_users where user_id = $1 on conflict (user_id) do update set password_set_at = now(), failed_attempts = 0, locked_until = null, must_change_password = false`, [id]);
  await owner(`update core.user_security set password_set_at = now() where user_id = $1`, [id]);
  // each test starts with a fresh per-identifier budget (app.rate_limit_hit windows are 15 minutes)
  await owner(`delete from private.rate_limits where key like $1`, [`%${email}%`]);
}
const sec = async (email: string) => (await owner<{ failed_attempts: number; locked_until: string | null; must_change_password: boolean; password_changed_at: string | null }>(`select * from core.user_security where user_id = $1`, [await userId(email)]))[0]!;

const TEACHER = 'deepa.teacher9@demo.school';
const COORD = 'coordinator@demo.school';
const PRINCIPAL = 'principal@demo.school';
const PW = 'Correct-Horse-42';
let orgId = '';

beforeAll(async () => {
  orgId = (await asOwner((c) => one<{ id: string }>(c, `select id from core.organizations where slug = 'demo'`))).id;
});
afterAll(async () => {
  await closePool();
});

describe('session token carries org and products', () => {
  it('dev login returns org + products and puts them in the token', async () => {
    const r = await call('POST', '/auth/dev-login', { email: PRINCIPAL });
    expect(r.status).toBe(200);
    expect(r.json.products).toEqual(['os']);
    expect(r.json.org).toEqual({ id: orgId, name: 'Demo International School' });
    expect(r.json.must_change_password).toBe(false);
    const claims = decodeJwt(r.json.token);
    expect(claims.org).toBe(orgId);
    expect(claims.products).toEqual(['os']);
    expect(r.setSession?.token).toBe(r.json.token);
  });

  it('GET /session answers without OS staff context: org branding, products, modules', async () => {
    const t = (await call('POST', '/auth/dev-login', { email: PRINCIPAL })).json.token;
    const s = await call('GET', '/session', {}, t);
    expect(s.status).toBe(200);
    expect(s.json.org.slug).toBe('demo');
    expect(s.json.org.branding.color).toBe('#1d4ed8');
    expect(s.json.products.map((p: any) => p.key)).toEqual(['os']);
    expect(s.json.products[0].home).toBe('/os');
    expect(Array.isArray(s.json.products[0].modules)).toBe(true);
    expect(s.json.user.name).toBeTruthy();
    expect((await call('GET', '/session', {})).status).toBe(401);
  });

  it('an org with OS + ERP gives a user granted both two products', async () => {
    await owner(`insert into core.subscriptions (org_id, product_key, status, plan_key) values ($1, 'erp', 'active', null) on conflict do nothing`, [orgId]);
    await owner(`insert into core.roles (org_id, product_key, key, name) values ($1, 'erp', 'shell_test', 'Shell test') on conflict do nothing`, [orgId]);
    const uid = await userId(COORD);
    await owner(`insert into core.user_product_access (org_id, user_id, product_key, role_key) values ($1, $2, 'erp', 'shell_test')`, [orgId, uid]);
    try {
      const r = await call('POST', '/auth/dev-login', { email: COORD });
      expect(r.json.products).toEqual(['erp', 'os']);
      const s = await call('GET', '/session', {}, r.json.token);
      expect(s.json.products.map((p: any) => p.key)).toEqual(['os', 'erp']);
      // the teacher was not granted ERP: still OS only
      expect((await call('POST', '/auth/dev-login', { email: TEACHER })).json.products).toEqual(['os']);
    } finally {
      await owner(`delete from core.user_product_access where user_id = $1 and product_key = 'erp'`, [uid]);
      await owner(`delete from core.subscriptions where org_id = $1 and product_key = 'erp'`, [orgId]);
    }
  });
});

describe('a user without a product is refused', () => {
  let email = '';
  beforeAll(async () => {
    email = `noproduct-${Date.now()}@demo.school`;
    await asOwner(async (c) => {
      const u = await one<{ id: string }>(c, `insert into auth.users (email) values ($1) returning id`, [email]);
      await c.query(`insert into core.org_users (org_id, user_id, kind, display_name) values ($1, $2, 'staff', 'No Product')`, [orgId, u.id]);
    });
    await setPassword(email, PW);
  });

  it('password sign-in with the right password: 403 no_product, logged, no session', async () => {
    const r = await call('POST', '/auth/password', { identifier: email, password: PW });
    expect(r.status).toBe(403);
    expect(r.json.error).toBe('no_product');
    expect(r.setSession).toBeUndefined();
    const ev = await owner(`select method, success, reason from core.login_events where user_id = $1 order by created_at desc limit 1`, [await userId(email)]);
    expect(ev[0]).toEqual({ method: 'password', success: false, reason: 'no_product' });
    expect((await sec(email)).failed_attempts).toBe(0);
  });

  it('a revoked product grant is refused the same way', async () => {
    const uid = await userId(TEACHER);
    await setPassword(TEACHER, PW);
    await owner(`update core.user_product_access set revoked_at = now() where user_id = $1 and product_key = 'os'`, [uid]);
    try {
      const r = await call('POST', '/auth/password', { identifier: TEACHER, password: PW });
      expect(r.status).toBe(403);
      expect(r.json.error).toBe('no_product');
    } finally {
      await owner(`update core.user_product_access set revoked_at = null where user_id = $1 and product_key = 'os'`, [uid]);
    }
    expect((await call('POST', '/auth/password', { identifier: TEACHER, password: PW })).status).toBe(200);
  });
});

describe('password lockout (core.user_security via app.record_login_event / app.login_allowed)', () => {
  it('five wrong passwords lock the account; the right one is then refused; unlocking restores it', async () => {
    await setPassword(TEACHER, PW);
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await call('POST', '/auth/password', { identifier: TEACHER, password: `wrong-${i}` })).status);
    expect(codes).toEqual([401, 401, 401, 401, 423]);
    const s = await sec(TEACHER);
    expect(s.failed_attempts).toBe(5);
    expect(new Date(s.locked_until!).getTime()).toBeGreaterThan(Date.now() + 14 * 60_000);
    const locked = await call('POST', '/auth/password', { identifier: TEACHER, password: PW });
    expect(locked.status).toBe(423);
    expect(locked.json.error).toBe('account_locked');
    // OTP is refused too while locked (the lock is per user, not per method)
    expect((await call('POST', '/auth/otp/verify', { identifier: TEACHER, code: '123456' })).status).toBe(423);
    const ev = await owner<{ success: boolean; reason: string }>(`select success, reason from core.login_events where user_id = $1 and method = 'password' order by created_at desc limit 7`, [await userId(TEACHER)]);
    expect(ev.filter((e) => e.reason === 'bad_password').length).toBeGreaterThanOrEqual(5);
    expect(ev[0]!.reason).toBe('locked');
    await owner(`update core.user_security set locked_until = null where user_id = $1`, [await userId(TEACHER)]);
    const ok = await call('POST', '/auth/password', { identifier: TEACHER, password: PW });
    expect(ok.status).toBe(200);
    expect((await sec(TEACHER)).failed_attempts).toBe(0);
  });

  it('unknown identifiers get the same answer as a wrong password and are logged without a user', async () => {
    const before = Number((await owner(`select count(*) as n from core.login_events where user_id is null and reason = 'unknown_identifier'`))[0].n);
    const r = await call('POST', '/auth/password', { identifier: 'nobody@nowhere.example', password: 'whatever-123' });
    expect(r.status).toBe(401);
    expect(r.json.error).toBe('invalid_credentials');
    expect(Number((await owner(`select count(*) as n from core.login_events where user_id is null and reason = 'unknown_identifier'`))[0].n)).toBe(before + 1);
  });

  it('phone numbers work as the identifier', async () => {
    await setPassword(TEACHER, PW);
    const phone = (await owner(`select phone from auth.users where email = $1`, [TEACHER]))[0].phone as string;
    expect((await call('POST', '/auth/password', { identifier: phone, password: PW })).status).toBe(200);
  });
});

describe('must_change_password', () => {
  it('blocks every product route until a new password is set, then lifts', async () => {
    await setPassword(TEACHER, PW);
    await owner(`update core.user_security set must_change_password = true where user_id = $1`, [await userId(TEACHER)]);
    const r = await call('POST', '/auth/password', { identifier: TEACHER, password: PW });
    expect(r.status).toBe(200);
    expect(r.json.must_change_password).toBe(true);
    const t = r.json.token;
    const blocked = await call('GET', '/tasks', {}, t);
    expect(blocked.status).toBe(403);
    expect(blocked.json.error).toBe('password_change_required');
    expect((await call('GET', '/me', {}, t)).json.error).toBe('password_change_required');
    // the shell can still read the session to send the user to the password page
    const s = await call('GET', '/session', {}, t);
    expect(s.status).toBe(200);
    expect(s.json.must_change_password).toBe(true);
    // policy: too short, same as identifier, common
    const weak = await call('POST', '/auth/password/change', { new_password: 'short' }, t);
    expect(weak.status).toBe(422);
    expect(weak.json.error).toBe('weak_password');
    expect(weak.json.details).toContain('too_short');
    expect((await call('POST', '/auth/password/change', { new_password: 'deepa.teacher9-2026' }, t)).json.details).toContain('same_as_identifier');
    expect((await call('POST', '/auth/password/change', { new_password: 'abcdefghijkl' }, t)).json.details).toContain('too_simple');
    const changed = await call('POST', '/auth/password/change', { new_password: 'Blue-Mango-Tree-77' }, t);
    expect(changed.status).toBe(200);
    expect(changed.json.must_change_password).toBe(false);
    expect(changed.setSession?.token).toBe(changed.json.token);
    const after = await sec(TEACHER);
    expect(after.must_change_password).toBe(false);
    expect(after.password_changed_at).toBeTruthy();
    expect((await call('GET', '/tasks', {}, changed.json.token)).status).toBe(200);
    // the old session was ended
    expect((await call('GET', '/tasks', {}, t)).status).toBe(401);
    // the new password signs in, the old one does not
    expect((await call('POST', '/auth/password', { identifier: TEACHER, password: 'Blue-Mango-Tree-77' })).status).toBe(200);
    expect((await call('POST', '/auth/password', { identifier: TEACHER, password: PW })).status).toBe(401);
  });

  it('changing an existing password needs the current one (wrong current counts toward lockout)', async () => {
    await setPassword(TEACHER, PW);
    const t = (await call('POST', '/auth/password', { identifier: TEACHER, password: PW })).json.token;
    expect((await call('POST', '/auth/password/change', { new_password: 'Another-Good-One-9' }, t)).json.error).toBe('current_password_required');
    const wrong = await call('POST', '/auth/password/change', { current_password: 'nope', new_password: 'Another-Good-One-9' }, t);
    expect(wrong.json.error).toBe('current_password_wrong');
    expect((await sec(TEACHER)).failed_attempts).toBe(1);
    const ok = await call('POST', '/auth/password/change', { current_password: PW, new_password: 'Another-Good-One-9' }, t);
    expect(ok.status).toBe(200);
  });

  it('forgot password: an OTP sign-in for reset may set a new password without the old one', async () => {
    await setPassword(TEACHER, PW);
    expect((await call('POST', '/auth/otp/start', { identifier: TEACHER })).json).toEqual({ ok: true, channel: 'email' });
    expect((await call('POST', '/auth/otp/verify', { identifier: TEACHER, code: '000000' })).status).toBe(401);
    const r = await call('POST', '/auth/otp/verify', { identifier: TEACHER, code: '123456', purpose: 'reset' });
    expect(r.status).toBe(200);
    expect(typeof decodeJwt(r.json.token).pwr).toBe('number');
    const ch = await call('POST', '/auth/password/change', { new_password: 'Reset-Via-Code-31' }, r.json.token);
    expect(ch.status).toBe(200);
    const ev = await owner(`select method, success, reason from core.login_events where user_id = $1 and method = 'otp_email' order by created_at desc limit 2`, [await userId(TEACHER)]);
    expect(ev).toEqual([
      { method: 'otp_email', success: true, reason: 'password_reset' },
      { method: 'otp_email', success: false, reason: 'bad_code' },
    ]);
  });
});

describe('rate limits (app.rate_limit_hit)', () => {
  it('per identifier: the 11th attempt in 15 minutes is refused, whatever the IP', async () => {
    const who = `ratelimit-${Date.now()}@demo.school`;
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) codes.push((await call('POST', '/auth/password', { identifier: who, password: 'x' })).status);
    expect(codes.slice(0, 10).every((c) => c === 401)).toBe(true);
    expect(codes[10]).toBe(429);
    const rows = await owner(`select hits from private.rate_limits where key = $1`, [`login:id:${who}`]);
    expect(Number(rows[0].hits)).toBe(11);
  });

  it('per IP: more than 30 sign-in calls a minute from one address are refused', async () => {
    const one_ip = '10.200.0.1';
    const codes: number[] = [];
    for (let i = 0; i < 31; i++) codes.push((await call('POST', '/auth/password', { identifier: `ip-${i}-${Date.now()}@demo.school`, password: 'x' }, undefined, one_ip)).status);
    expect(codes.slice(0, 30).every((c) => c === 401)).toBe(true);
    expect(codes[30]).toBe(429);
  });

  it('OTP sends are limited per identifier and answer the same for unknown people', async () => {
    const who = `otp-${Date.now()}@demo.school`;
    const res = [];
    for (let i = 0; i < 6; i++) res.push(await call('POST', '/auth/otp/start', { identifier: who }));
    expect(res.slice(0, 5).map((r) => r.json)).toEqual(Array(5).fill({ ok: true, channel: 'email' }));
    expect(res[5]!.status).toBe(429);
  });
});

describe('Supabase token exchange and providers', () => {
  it('POST /auth/session exchanges a Supabase access token for a session with org + products', async () => {
    process.env.SUPABASE_JWT_SECRET = 'test-supabase-secret-test-supabase-secret';
    try {
      const sub = await userId(PRINCIPAL);
      const at = await new SignJWT({ role: 'authenticated' }).setProtectedHeader({ alg: 'HS256' }).setSubject(sub).setExpirationTime('5m').sign(new TextEncoder().encode(process.env.SUPABASE_JWT_SECRET));
      const r = await call('POST', '/auth/session', { accessToken: at, method: 'otp_phone' });
      expect(r.status).toBe(200);
      expect(r.json.products).toEqual(['os']);
      expect(decodeJwt(r.json.token).org).toBe(orgId);
      const last = await owner(`select method, success from core.login_events where user_id = $1 order by created_at desc limit 1`, [sub]);
      expect(last[0]).toEqual({ method: 'otp_phone', success: true });
      expect((await call('POST', '/auth/session', { accessToken: `${at}x` })).status).toBe(401);
    } finally {
      delete process.env.SUPABASE_JWT_SECRET;
    }
  });

  it('the Supabase provider calls GoTrue with the right endpoints', async () => {
    const calls: { url: string; body: any; key: string }[] = [];
    const f = (async (url: string, init: any) => {
      calls.push({ url, body: JSON.parse(init.body), key: init.headers.apikey });
      const ok = !String(url).includes('grant_type=password') || JSON.parse(init.body).password === 'good';
      return new Response(JSON.stringify(ok ? { user: { id: 'u-1' } } : { error: 'invalid_grant' }), { status: ok ? 200 : 400 });
    }) as unknown as typeof fetch;
    const p = supabaseProvider({ SUPABASE_URL: 'https://x.supabase.co/', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'service' } as NodeJS.ProcessEnv, f);
    await p.sendOtp({ kind: 'phone', value: '+919000000001' });
    expect(await p.verifyOtp({ kind: 'email', value: 'a@b.in' }, '123456', null)).toBe('u-1');
    expect(await p.verifyPassword({ kind: 'email', value: 'a@b.in' }, 'good', null)).toBe('u-1');
    expect(await p.verifyPassword({ kind: 'email', value: 'a@b.in' }, 'bad', null)).toBeNull();
    await p.setPassword('u-1', 'New-Password-1');
    expect(calls.map((c) => c.url)).toEqual([
      'https://x.supabase.co/auth/v1/otp',
      'https://x.supabase.co/auth/v1/verify',
      'https://x.supabase.co/auth/v1/token?grant_type=password',
      'https://x.supabase.co/auth/v1/token?grant_type=password',
      'https://x.supabase.co/auth/v1/admin/users/u-1',
    ]);
    expect(calls[0]!.body).toEqual({ phone: '+919000000001', create_user: false });
    expect(calls[1]!.body).toEqual({ email: 'a@b.in', token: '123456', type: 'email' });
    expect(calls[4]!.key).toBe('service');
  });

  it('breached-password check is off by default and uses k-anonymity when on', async () => {
    let asked = '';
    const f = (async (url: string) => {
      asked = url;
      return new Response('0018A45C4D1DEF81644B54AB7F969B88D65:3\r\nFFFFF:1', { status: 200 });
    }) as unknown as typeof fetch;
    expect(await isBreached('password1', f)).toBe(false);
    expect(asked).toBe('');
    process.env.PASSWORD_BREACH_CHECK = 'on';
    try {
      // sha1('password1') = E38AD214943DAAD1D64C102FAEC29DE4AFE9DA3D
      const f2 = (async (url: string) => {
        asked = url;
        return new Response('214943DAAD1D64C102FAEC29DE4AFE9DA3D:2427\nAAAA:1', { status: 200 });
      }) as unknown as typeof fetch;
      expect(await isBreached('password1', f2)).toBe(true);
      expect(asked).toBe('https://api.pwnedpasswords.com/range/E38AD');
    } finally {
      delete process.env.PASSWORD_BREACH_CHECK;
    }
  });
});
