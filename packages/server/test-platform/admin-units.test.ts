/** Pure parts of the admin console: client health rules and the invite adapters. No database needed. */
import { describe, expect, it } from 'vitest';
import { computeHealth, type HealthInput } from '../src/platform-admin/health';
import { createSupabaseProvisioner } from '../src/platform-admin/provisioner';

const base: HealthInput = {
  orgStatus: 'active',
  orgCreatedOn: '2026-10-01',
  today: '2026-11-24',
  subs: [{ status: 'active', starts_on: '2026-10-01', ends_on: null }],
  stats: { user_count: 3, active_user_count: 3, invited_count: 0, locked_count: 0, last_login_date: '2026-11-23' },
};

describe('client health', () => {
  it('is ok for an active client that signs in', () => {
    expect(computeHealth(base)).toEqual({ level: 'ok', reasons: [] });
  });

  it('is critical when suspended, when no product is on, or when the access period is over', () => {
    expect(computeHealth({ ...base, orgStatus: 'closed' })).toMatchObject({ level: 'critical', reasons: ['client_suspended'] });
    expect(computeHealth({ ...base, subs: [{ status: 'cancelled', starts_on: '2026-10-01', ends_on: '2026-11-01' }] })).toMatchObject({ level: 'critical', reasons: ['no_active_product'] });
    expect(computeHealth({ ...base, subs: [{ status: 'active', starts_on: '2026-10-01', ends_on: '2026-11-01' }] }).reasons).toContain('access_expired');
  });

  it('needs attention for past due, an ending trial, a switched-off product, locked or silent users, and a new client with no product', () => {
    expect(computeHealth({ ...base, subs: [{ status: 'past_due', starts_on: '2026-10-01', ends_on: null }] })).toMatchObject({ level: 'attention', reasons: ['past_due'] });
    expect(computeHealth({ ...base, subs: [{ status: 'trial', starts_on: '2026-11-10', ends_on: '2026-11-30' }] })).toMatchObject({ level: 'attention', reasons: ['trial_ending'] });
    expect(computeHealth({ ...base, subs: [...base.subs, { status: 'suspended', starts_on: '2026-10-01', ends_on: '2026-11-01' }] })).toMatchObject({ level: 'attention', reasons: ['product_off'] });
    expect(computeHealth({ ...base, stats: { ...base.stats, locked_count: 1 } }).reasons).toEqual(['locked_users']);
    expect(computeHealth({ ...base, stats: { ...base.stats, last_login_date: '2026-09-01' } }).reasons).toEqual(['inactive']);
    expect(computeHealth({ ...base, stats: { user_count: 1, active_user_count: 0, invited_count: 1, locked_count: 0, last_login_date: null } }).reasons).toEqual(['no_active_user']);
    expect(computeHealth({ ...base, subs: [] })).toMatchObject({ level: 'attention', reasons: ['no_subscription'] });
  });

  it('a trial that is far from its end is fine', () => {
    expect(computeHealth({ ...base, subs: [{ status: 'trial', starts_on: '2026-11-20', ends_on: '2026-12-20' }] }).level).toBe('ok');
  });
});

describe('Supabase invite adapter (no network: fetch is faked)', () => {
  const env = { SUPABASE_URL: 'https://example.test', SUPABASE_AUTH_ADMIN_KEY: 'key-123' };

  it('posts the invite with the admin key and returns the new user id; the key never appears in the result', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ id: 'user-1' }), { status: 200 });
    }) as unknown as typeof fetch;
    const p = createSupabaseProvisioner(env, fake);
    const r = await p.invite({ email: 'a@b.test', displayName: 'A B' });
    expect(r).toEqual({ userId: 'user-1', created: true });
    expect(calls[0]!.url).toBe('https://example.test/auth/v1/invite');
    expect(JSON.stringify(r)).not.toContain('key-123');
    await p.remove('user-1');
    expect(calls[1]!.url).toBe('https://example.test/auth/v1/admin/users/user-1');
    expect(calls[1]!.init.method).toBe('DELETE');
  });

  it('fails when the provider refuses (for example the e-mail is already registered)', async () => {
    const p = createSupabaseProvisioner(env, (async () => new Response('{}', { status: 422 })) as unknown as typeof fetch);
    await expect(p.invite({ email: 'a@b.test', displayName: 'A B' })).rejects.toThrow(/422/);
  });

  it('refuses to start without its configuration', () => {
    expect(() => createSupabaseProvisioner({})).toThrow(/SUPABASE_URL/);
  });
});
