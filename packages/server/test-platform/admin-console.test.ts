/**
 * Platform admin console, end to end against the real platform database, through the same dispatchAdmin() the web
 * route uses and a real login as platform_admin_server. Covers plan section 8 T2/T3/T4/T9 through the console
 * services: a CRM-only client and an OS + ERP client are created in one step each, then proven isolated from the
 * other products; suspension and subscription changes bite on the next request; every write is in audit.log.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { computeInvoice } from '@autoed/shared';
import { owner, tx } from './helpers';
import { buildAdminWorld, plantProbes, visible, type AdminWorld } from './admin-helpers';
import { clientSupportSessions, currentViewAs } from '../src/platform-admin';

let w: AdminWorld;
const tag = Math.random().toString(36).slice(2, 8);

let crm: { orgId: string; adminId: string; branchId: string; email: string };
let osErp: { orgId: string; adminId: string; branchId: string };

const counts = (userId: string, orgId: string) =>
  Promise.all((['crm', 'os', 'erp'] as const).map((s) => visible('authenticated', userId, s, orgId)));

beforeAll(async () => {
  w = await buildAdminWorld(tag);
}, 120000);

afterAll(async () => {
  await w.cleanup();
  await owner.end();
});

describe('plans', () => {
  it('creates the price list the clients refer to', async () => {
    for (const p of ['crm', 'os', 'erp']) {
      const r = await w.write('PUT', `/plans/adm_${p}_m`, { product_key: p, name: `${p.toUpperCase()} monthly`, billing_interval: 'month', price_paise: 499900, sac_code: '998314', gst_rate: 18, active: true });
      expect(r.json.key).toBe(`adm_${p}_m`);
    }
    const list = await w.call('GET', '/plans');
    expect(list.json.map((x: { key: string }) => x.key)).toEqual(expect.arrayContaining(['adm_crm_m', 'adm_os_m', 'adm_erp_m']));
  });
});

describe('create a client in one step (T2: a CRM-only client has nothing in OS or ERP)', () => {
  it('creates organisation + first branch + subscription + first admin invite + billing profile', async () => {
    const email = `owner@crm-only-${tag}.test`;
    const r = await w.write('POST', '/clients', {
      name: `CRM Only School ${tag}`,
      slug: `crm-only-${tag}`,
      kind: 'school',
      branch: { name: 'Main campus', code: 'MAIN', state_code: '36', city: 'Hyderabad' },
      subscriptions: [{ product_key: 'crm', plan_key: 'adm_crm_m', status: 'trial' }],
      admin: { email, display_name: 'CRM Owner' },
      billing: { legal_name: 'CRM Only Education Pvt Ltd', gstin: '36AABCA1234A1Z5', state_code: '36', billing_email: email },
    });
    w.orgIds.push(r.json.org.id);
    crm = { orgId: r.json.org.id, adminId: r.json.admin.user_id, branchId: r.json.branch_id, email };
    expect(r.json.subscriptions).toHaveLength(1);
    expect(w.provisioner.created).toContain(crm.adminId);

    const users = await w.call('GET', `/clients/${crm.orgId}/users`);
    expect(users.json).toHaveLength(1);
    expect(users.json[0]).toMatchObject({ user_id: crm.adminId, status: 'invited', kind: 'staff', email });
    expect(users.json[0].access).toMatchObject([{ product_key: 'crm', role_key: 'admin' }]);
    const detail = await w.call('GET', `/clients/${crm.orgId}`);
    expect(detail.json.branches).toHaveLength(1);
    expect(detail.json.billing_account).toMatchObject({ legal_name: 'CRM Only Education Pvt Ltd', state_code: '36' });
  });

  it('an invited (not yet active) admin has no access; once active, CRM rows are visible and OS / ERP rows are not', async () => {
    await plantProbes(crm.orgId, crm.branchId);
    expect(await counts(crm.adminId, crm.orgId)).toEqual([0, 0, 0]);
    await w.write('POST', `/clients/${crm.orgId}/users/${crm.adminId}/status`, { status: 'active', reason: 'accepted the invite' });
    expect(await counts(crm.adminId, crm.orgId)).toEqual([1, 0, 0]);
    // as the OS and ERP server roles too
    expect(await tx('os_server', crm.adminId, async (c) => Number((await c.query(`select count(*)::int as n from os.harness_probe`)).rows[0].n))).toBe(0);
    expect(await tx('erp_server', crm.adminId, async (c) => Number((await c.query(`select count(*)::int as n from erp.harness_probe`)).rows[0].n))).toBe(0);
  });

  it('refuses a duplicate slug, an unknown plan, and a plan of another product', async () => {
    const base = { name: 'X school', slug: `crm-only-${tag}`, branch: { name: 'Main', code: 'M' }, subscriptions: [{ product_key: 'crm' }], admin: { email: `dup@x-${tag}.test`, display_name: 'Dup Admin' } };
    expect((await w.call('POST', '/clients', base)).status).toBe(409);
    expect((await w.call('POST', '/clients', { ...base, slug: `x-${tag}-1`, subscriptions: [{ product_key: 'crm', plan_key: 'nope' }] })).status).toBe(422);
    expect((await w.call('POST', '/clients', { ...base, slug: `x-${tag}-2`, subscriptions: [{ product_key: 'crm', plan_key: 'adm_os_m' }] })).status).toBe(422);
    // a failed create leaves nothing behind (one transaction) and removes the login it created
    const n = Number((await owner.query(`select count(*)::int as n from core.organizations where slug like $1`, [`x-${tag}%`])).rows[0].n);
    expect(n).toBe(0);
  });

  it('one person belongs to one client: an existing login is refused and never deleted; a new login is removed when the database part fails', async () => {
    const before = w.provisioner.removed.length;
    const dupAdmin = await w.call('POST', '/clients', {
      name: 'Dup admin school',
      slug: `dup-admin-${tag}`,
      branch: { name: 'Main', code: 'M' },
      subscriptions: [{ product_key: 'crm' }],
      admin: { email: crm.email, display_name: 'Same person' },
    });
    expect(dupAdmin.status).toBe(409);
    expect(dupAdmin.json.error).toBe('user_already_in_client'); // decision 37
    expect(w.provisioner.removed.length).toBe(before); // the existing login was not created by this call: not removed
    expect(Number((await owner.query(`select count(*)::int as n from auth.users where id = $1`, [crm.adminId])).rows[0].n)).toBe(1);
    expect(Number((await owner.query(`select count(*)::int as n from core.organizations where slug = $1`, [`dup-admin-${tag}`])).rows[0].n)).toBe(0);
  });
});

describe('create an OS + ERP client (T3: the CRM stays closed to it)', () => {
  it('creates the client with two products and an admin in both', async () => {
    const r = await w.write('POST', '/clients', {
      name: `OS ERP College ${tag}`,
      slug: `os-erp-${tag}`,
      kind: 'college',
      branch: { name: 'City', code: 'CITY', state_code: '27' },
      subscriptions: [
        { product_key: 'os', plan_key: 'adm_os_m', status: 'active' },
        { product_key: 'erp', plan_key: 'adm_erp_m', status: 'trial', trial_days: 30 },
      ],
      admin: { email: `principal@os-erp-${tag}.test`, display_name: 'Principal' },
    });
    w.orgIds.push(r.json.org.id);
    osErp = { orgId: r.json.org.id, adminId: r.json.admin.user_id, branchId: r.json.branch_id };
    await w.write('POST', `/clients/${osErp.orgId}/users/${osErp.adminId}/status`, { status: 'active', reason: 'accepted the invite' });
    await plantProbes(osErp.orgId, osErp.branchId);
    expect(await counts(osErp.adminId, osErp.orgId)).toEqual([0, 1, 1]);
    // the CRM-only client's admin sees nothing of this org, and the reverse
    expect(await counts(crm.adminId, osErp.orgId)).toEqual([0, 0, 0]);
    expect(await counts(osErp.adminId, crm.orgId)).toEqual([0, 0, 0]);
    // the CRM server role cannot even see OS rows for it
    expect(await tx('crm_server', osErp.adminId, async (c) => Number((await c.query(`select count(*)::int as n from crm.harness_probe`)).rows[0].n))).toBe(0);
  });

  it('what-can-this-user-see preview agrees with the database', async () => {
    const p = (await w.call('GET', `/clients/${crm.orgId}/users/${crm.adminId}/preview`)).json;
    expect(p.visible_products).toEqual(['crm']);
    const byKey = Object.fromEntries(p.products.map((x: { product_key: string }) => [x.product_key, x]));
    expect(byKey.crm).toMatchObject({ db_gate: 'on', role_key: 'admin', billing_access: 'full' });
    expect(byKey.crm.modules.map((m: { module_key: string }) => m.module_key)).toContain('harness');
    expect(byKey.crm.branches).toMatchObject([{ code: 'MAIN', on: true }]);
    expect(byKey.os).toMatchObject({ db_gate: 'off', role_key: null, billing_access: 'none' });
    expect(byKey.os.off_reasons).toEqual(expect.arrayContaining(['no_subscription', 'no_access_row']));
    const q = (await w.call('GET', `/clients/${osErp.orgId}/users/${osErp.adminId}/preview`)).json;
    expect(q.visible_products).toEqual(['erp', 'os']);
    expect(q.products.find((x: { product_key: string }) => x.product_key === 'crm').db_gate).toBe('off');
    expect((await w.call('GET', `/clients/${crm.orgId}/users/${osErp.adminId}/preview`)).status).toBe(404);
  });
});

describe('suspend and reactivate (T4: access goes on the next request)', () => {
  it('a suspended client loses every product at once, shows as critical, and returns on reactivation', async () => {
    expect((await w.call('POST', `/clients/${osErp.orgId}/suspend`, { reason: 'x' })).status).toBe(422); // reason too short
    await w.write('POST', `/clients/${osErp.orgId}/suspend`, { reason: 'invoice unpaid for 3 months, owner approved' });
    expect(await counts(osErp.adminId, osErp.orgId)).toEqual([0, 0, 0]);
    expect((await w.call('POST', `/clients/${osErp.orgId}/suspend`, { reason: 'again please' })).status).toBe(409);
    const list = (await w.call('GET', '/clients?status=suspended')).json as { id: string; health: { level: string; reasons: string[] } }[];
    const mine = list.find((x) => x.id === osErp.orgId)!;
    expect(mine.health.level).toBe('critical');
    expect(mine.health.reasons).toContain('client_suspended');
    expect(list.some((x) => x.id === crm.orgId)).toBe(false);
    await w.write('POST', `/clients/${osErp.orgId}/reactivate`, { reason: 'paid in full' });
    expect(await counts(osErp.adminId, osErp.orgId)).toEqual([0, 1, 1]);
  });

  it('suspending one product leaves the others', async () => {
    await w.write('POST', `/clients/${osErp.orgId}/subscriptions/erp/transition`, { event: 'suspend', reason: 'ERP unpaid, OS fine' });
    expect(await counts(osErp.adminId, osErp.orgId)).toEqual([0, 1, 0]);
    const detail = (await w.call('GET', `/clients/${osErp.orgId}`)).json;
    expect(detail.client.health.reasons).toContain('product_off');
    await w.write('POST', `/clients/${osErp.orgId}/subscriptions/erp/transition`, { event: 'activate', reason: 'paid in full', period_end: '2099-01-01' });
    expect(await counts(osErp.adminId, osErp.orgId)).toEqual([0, 1, 1]);
  });
});

describe('subscriptions follow the state machine', () => {
  const sub = async (orgId: string, product = 'crm') => (await w.call('GET', `/clients/${orgId}/subscriptions`)).json.find((s: { product_key: string }) => s.product_key === product);

  it('trial -> active -> past_due -> (grace over, tick) suspended -> active -> cancelled (terminal) -> restart', async () => {
    expect((await sub(crm.orgId)).status).toBe('trial');
    // a trial cannot be "past due": the state machine ignores it, the console says so
    const nope = await w.call('POST', `/clients/${crm.orgId}/subscriptions/crm/transition`, { event: 'mark_past_due', reason: 'try it' });
    expect(nope.status).toBe(409);
    expect(nope.json.error).toBe('transition_not_allowed');

    await w.write('POST', `/clients/${crm.orgId}/subscriptions/crm/transition`, { event: 'activate', reason: 'first payment received', period_end: '2099-12-01' });
    expect(await sub(crm.orgId)).toMatchObject({ status: 'active', ends_on: '2099-11-30' });

    await w.write('POST', `/clients/${crm.orgId}/subscriptions/crm/transition`, { event: 'mark_past_due', reason: 'renewal failed' });
    expect((await sub(crm.orgId)).status).toBe('past_due');
    expect((await visible('authenticated', crm.adminId, 'crm', crm.orgId))).toBe(1); // still inside the grace period

    // the grace period (7 days) is over: pretend the status change happened 8 days ago, then run the tick
    await owner.query(`update audit.config_history set created_at = now() - interval '8 days' where table_name = 'subscriptions' and after->>'status' = 'past_due' and org_id = $1`, [crm.orgId]);
    const tick = await w.write('POST', '/billing/tick');
    expect(tick.json.changed).toContainEqual({ org_id: crm.orgId, product_key: 'crm', from: 'past_due', to: 'suspended' });
    expect((await sub(crm.orgId)).status).toBe('suspended');
    expect(await visible('authenticated', crm.adminId, 'crm', crm.orgId)).toBe(0);
    const billing = (await w.call('GET', `/clients/${crm.orgId}/billing`)).json;
    expect(billing.entitlements.products.crm).toMatchObject({ access: 'read_only', reason: 'suspended_read_only' }); // 30 days read-only (decision 42)

    await w.write('POST', `/clients/${crm.orgId}/subscriptions/crm/transition`, { event: 'activate', reason: 'paid after reminder' });
    expect(await sub(crm.orgId)).toMatchObject({ status: 'active', ends_on: null });
    expect(await visible('authenticated', crm.adminId, 'crm', crm.orgId)).toBe(1);

    await w.write('POST', `/clients/${crm.orgId}/subscriptions/crm/transition`, { event: 'cancel', reason: 'client left' });
    expect((await sub(crm.orgId)).status).toBe('cancelled');
    expect(await visible('authenticated', crm.adminId, 'crm', crm.orgId)).toBe(0);
    const term = await w.call('POST', `/clients/${crm.orgId}/subscriptions/crm/transition`, { event: 'activate', reason: 'maybe' });
    expect(term.status).toBe(409);
    expect(term.json.details.ignored).toBe('terminal');
    expect((await w.call('POST', `/clients/${crm.orgId}/subscriptions/crm/restart`, { reason: 'x', status: 'trial' })).status).toBe(422);

    await w.write('POST', `/clients/${crm.orgId}/subscriptions/crm/restart`, { reason: 'client came back', status: 'trial', trial_days: 10 });
    expect((await sub(crm.orgId)).status).toBe('trial');
    expect(await visible('authenticated', crm.adminId, 'crm', crm.orgId)).toBe(1);
  });

  it('restart is only for cancelled subscriptions; plan and seats can be changed with validation', async () => {
    expect((await w.call('POST', `/clients/${crm.orgId}/subscriptions/crm/restart`, { reason: 'not cancelled', status: 'active' })).status).toBe(409);
    await w.write('PATCH', `/clients/${crm.orgId}/subscriptions/crm`, { seats: 40, notes: 'pilot' });
    expect((await sub(crm.orgId)).seats).toBe(40);
    expect((await w.call('PATCH', `/clients/${crm.orgId}/subscriptions/crm`, { plan_key: 'adm_os_m' })).status).toBe(422); // OS plan on a CRM subscription
    await w.write('PUT', '/plans/adm_crm_y', { product_key: 'crm', name: 'CRM yearly', billing_interval: 'year', price_paise: 4999000, gst_rate: 18, active: true });
    await w.write('PATCH', `/clients/${crm.orgId}/subscriptions/crm`, { plan_key: 'adm_crm_y' });
    expect((await sub(crm.orgId)).plan_key).toBe('adm_crm_y');
  });

  it('adds a product to an existing client with its admin role; the existing admin can then be given access', async () => {
    const add = await w.write('POST', `/clients/${crm.orgId}/subscriptions`, { product_key: 'os', plan_key: 'adm_os_m', status: 'trial' });
    expect(add.json.product_key).toBe('os');
    expect((await w.call('POST', `/clients/${crm.orgId}/subscriptions`, { product_key: 'os', status: 'trial' })).status).toBe(409);
    await w.write('PUT', `/clients/${crm.orgId}/users/${crm.adminId}/access`, { product_key: 'os', role_key: 'admin' });
    expect(await counts(crm.adminId, crm.orgId)).toEqual([1, 1, 0]);
  });
});

describe('branches and the per-branch product switch (decision 34)', () => {
  it('adds a branch and switches CRM off for it', async () => {
    const b = await w.write('POST', `/clients/${crm.orgId}/branches`, { name: 'North', code: 'NORTH', state_code: '36', active: true });
    const second = b.json.id as string;
    await plantProbes(crm.orgId, second); // one more row per product, in the second branch
    expect(await visible('authenticated', crm.adminId, 'crm', crm.orgId)).toBe(2);
    await w.write('PATCH', `/clients/${crm.orgId}/branches/${second}`, { name: 'North campus', code: 'NORTH', state_code: '36', active: true });
    await w.write('PUT', `/clients/${crm.orgId}/branch-products`, { branch_id: second, product_key: 'crm', enabled: false });
    expect(await visible('authenticated', crm.adminId, 'crm', crm.orgId)).toBe(1);
    expect(await visible('authenticated', crm.adminId, 'os', crm.orgId)).toBe(2);
    const p = (await w.call('GET', `/clients/${crm.orgId}/users/${crm.adminId}/preview`)).json;
    expect(p.products.find((x: { product_key: string }) => x.product_key === 'crm').branches.map((x: { code: string; on: boolean }) => [x.code, x.on])).toEqual([['MAIN', true], ['NORTH', false]]);
    await w.write('PUT', `/clients/${crm.orgId}/branch-products`, { branch_id: second, product_key: 'crm', enabled: true });
    expect(await visible('authenticated', crm.adminId, 'crm', crm.orgId)).toBe(2);
    // a product the client does not have, and a branch of another client
    expect((await w.call('PUT', `/clients/${crm.orgId}/branch-products`, { branch_id: second, product_key: 'erp', enabled: false })).status).toBe(404);
    expect((await w.call('PUT', `/clients/${osErp.orgId}/branch-products`, { branch_id: second, product_key: 'os', enabled: false })).status).toBe(404);
  });
});

describe('users, product access, lock and forced password change', () => {
  let user: string;
  it('invites a second user; access to a product the client did not buy is refused', async () => {
    const created = w.provisioner.created.length;
    const bad = await w.call('POST', `/clients/${crm.orgId}/users`, { email: `teacher@crm-only-${tag}.test`, display_name: 'Teacher', access: [{ product_key: 'erp', role_key: 'admin' }] });
    expect(bad.status).toBe(422);
    expect(bad.json.error).toBe('product_not_subscribed');
    expect(w.provisioner.created.length).toBe(created); // nobody was invited
    const ok = await w.write('POST', `/clients/${crm.orgId}/users`, { email: `teacher@crm-only-${tag}.test`, display_name: 'Teacher', access: [{ product_key: 'crm', role_key: 'admin' }] });
    user = ok.json.user_id;
    const list = (await w.call('GET', `/clients/${crm.orgId}/users`)).json;
    expect(list.map((u: { user_id: string }) => u.user_id)).toContain(user);
    // one person belongs to one client: inviting the same login into another client fails, and the login stays
    const removed = w.provisioner.removed.length;
    const again = await w.call('POST', `/clients/${osErp.orgId}/users`, { email: `teacher@crm-only-${tag}.test`, display_name: 'Teacher', access: [] });
    expect(again.status).toBe(409);
    expect(again.json.error).toBe('user_already_in_client');
    expect(w.provisioner.removed.length).toBe(removed);
    // a brand new login whose link then fails (home branch of another client) is removed again
    const orphan = await w.call('POST', `/clients/${osErp.orgId}/users`, { email: `orphan@os-erp-${tag}.test`, display_name: 'Orphan', home_branch_id: crm.branchId, access: [] });
    expect(orphan.status).toBe(422);
    expect(w.provisioner.removed.length).toBe(removed + 1);
    expect(Number((await owner.query(`select count(*)::int as n from auth.users where email = $1`, [`orphan@os-erp-${tag}.test`])).rows[0].n)).toBe(0);
  });

  it('grants, changes and revokes access; a role that does not exist is refused', async () => {
    await w.write('POST', `/clients/${crm.orgId}/users/${user}/status`, { status: 'active', reason: 'accepted' });
    await owner.query(`insert into core.roles (org_id, product_key, key, name) values ($1, 'os', 'viewer', 'Viewer')`, [crm.orgId]);
    const role = (await owner.query(`select id from core.roles where org_id = $1 and product_key = 'os' and key = 'viewer'`, [crm.orgId])).rows[0].id;
    await owner.query(`insert into core.role_permissions (org_id, role_id, module_key, action, scope) values ($1, $2, 'harness', 'view', 'org')`, [crm.orgId, role]);
    expect((await w.call('PUT', `/clients/${crm.orgId}/users/${user}/access`, { product_key: 'os', role_key: 'ghost' })).status).toBe(422);
    expect(await counts(user, crm.orgId)).toEqual([2, 0, 0]);
    await w.write('PUT', `/clients/${crm.orgId}/users/${user}/access`, { product_key: 'os', role_key: 'viewer' });
    expect(await counts(user, crm.orgId)).toEqual([2, 2, 0]);
    const roles = (await w.call('GET', `/clients/${crm.orgId}/roles`)).json as { product_key: string; key: string }[];
    expect(roles.map((r) => `${r.product_key}:${r.key}`)).toEqual(expect.arrayContaining(['crm:admin', 'os:admin', 'os:viewer']));
    await w.write('DELETE', `/clients/${crm.orgId}/users/${user}/access/os`);
    expect(await counts(user, crm.orgId)).toEqual([2, 0, 0]);
    expect((await w.call('DELETE', `/clients/${crm.orgId}/users/${user}/access/os`)).status).toBe(409);
  });

  it('locks and unlocks an account (the login check reads it) and sets the forced password change flag', async () => {
    const allowed = async () => (await owner.query(`select app.login_allowed($1) as ok`, [user])).rows[0].ok as boolean;
    expect(await allowed()).toBe(true);
    await w.write('POST', `/clients/${crm.orgId}/users/${user}/lock`, { locked: true, reason: 'phone reported stolen', minutes: 120 });
    expect(await allowed()).toBe(false);
    let u = (await w.call('GET', `/clients/${crm.orgId}/users`)).json.find((x: { user_id: string }) => x.user_id === user);
    expect(u.locked).toBe(true);
    await w.write('POST', `/clients/${crm.orgId}/users/${user}/lock`, { locked: false, reason: 'verified by phone call' });
    expect(await allowed()).toBe(true);
    await w.write('POST', `/clients/${crm.orgId}/users/${user}/force-password-reset`, { required: true, reason: 'password shared in a chat' });
    u = (await w.call('GET', `/clients/${crm.orgId}/users`)).json.find((x: { user_id: string }) => x.user_id === user);
    expect(u).toMatchObject({ must_change_password: true, locked: false, failed_attempts: 0 });
    // a user of another client cannot be reached through this client's path
    expect((await w.call('POST', `/clients/${osErp.orgId}/users/${user}/lock`, { locked: true, reason: 'wrong client' })).status).toBe(404);
    // lock shows in the client's health
    const h = (await w.call('GET', `/clients/${crm.orgId}`)).json.client.health;
    expect(h.reasons).not.toContain('locked_users');
    await w.write('POST', `/clients/${crm.orgId}/users/${user}/lock`, { locked: true, reason: 'checking health flag' });
    expect((await w.call('GET', `/clients/${crm.orgId}`)).json.client.health.reasons).toContain('locked_users');
    await w.write('POST', `/clients/${crm.orgId}/users/${user}/lock`, { locked: false, reason: 'done checking' });
    // disabled accounts lose their organisation link's effect immediately
    await w.write('POST', `/clients/${crm.orgId}/users/${user}/status`, { status: 'disabled', reason: 'left the school' });
    expect(await counts(user, crm.orgId)).toEqual([0, 0, 0]);
  });
});

describe('view-as support sessions (T9 through the console)', () => {
  it('needs a reason of 10+ characters and at most 4 hours; opens read-only, shows a banner, is listed to the client admin and ended', async () => {
    expect((await w.call('POST', `/clients/${osErp.orgId}/view-as`, { reason: 'short' })).status).toBe(422);
    expect((await w.call('POST', `/clients/${osErp.orgId}/view-as`, { reason: 'ticket 91: timetable wrong', minutes: 600 })).status).toBe(422);
    const start = await w.write('POST', `/clients/${osErp.orgId}/view-as`, { reason: 'ticket 91: timetable looks wrong', minutes: 30 });
    expect(start.json).toMatchObject({ org_id: osErp.orgId, read_only: true, reason: 'ticket 91: timetable looks wrong' });
    expect(start.json.seconds_left).toBeGreaterThan(1700);
    expect((await w.call('GET', '/view-as/current')).json.id).toBe(start.json.id);
    expect((await w.call('GET', '/me')).json.view_as.org_name).toBe(`OS ERP College ${tag}`);

    // while it is open the admin's claims see that client in a PRODUCT role, read-only, with the banner available there
    await tx('os_server', w.adminId, async (c) => {
      expect(Number((await c.query(`select count(*)::int as n from os.harness_probe`)).rows[0].n)).toBe(1);
      expect((await currentViewAs(c))?.id).toBe(start.json.id);
      await c.query('savepoint s');
      await expect(c.query(`insert into os.harness_probe (org_id, title) values ($1, 'by support')`, [osErp.orgId])).rejects.toMatchObject({ code: '42501' });
    });
    // another admin has no session of their own
    await tx('os_server', w.admin2Id, async (c) => expect(await currentViewAs(c)).toBeNull());

    // the client's own admin sees the support log (reason, times, read-only), not the staff member's name
    const seen = await tx('authenticated', osErp.adminId, (c) => clientSupportSessions(c));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ id: start.json.id, reason: 'ticket 91: timetable looks wrong', read_only: true, state: 'open' });
    expect(Object.keys(seen[0]!)).not.toContain('platform_user_id');
    // someone of the same client without audit.view does not
    await owner.query(`insert into core.roles (org_id, product_key, key, name) values ($1, 'os', 'viewer', 'Viewer')`, [osErp.orgId]);
    const vr = (await owner.query(`select id from core.roles where org_id = $1 and key = 'viewer'`, [osErp.orgId])).rows[0].id;
    await owner.query(`insert into core.role_permissions (org_id, role_id, module_key, action, scope) values ($1, $2, 'harness', 'view', 'org')`, [osErp.orgId, vr]);
    const viewer = await w.write('POST', `/clients/${osErp.orgId}/users`, { email: `viewer@os-erp-${tag}.test`, display_name: 'Viewer', access: [{ product_key: 'os', role_key: 'viewer' }] });
    await w.write('POST', `/clients/${osErp.orgId}/users/${viewer.json.user_id}/status`, { status: 'active', reason: 'accepted' });
    expect(await visible('authenticated', viewer.json.user_id, 'os', osErp.orgId)).toBe(1); // they do work in the OS ...
    expect(await tx('authenticated', viewer.json.user_id, (c) => clientSupportSessions(c))).toHaveLength(0); // ... but not the support log

    const listed = (await w.call('GET', `/clients/${osErp.orgId}/support-sessions`)).json;
    expect(listed[0]).toMatchObject({ id: start.json.id, admin_name: 'Console Admin', state: 'open' });
    const ended = await w.write('POST', '/view-as/end');
    expect(ended.json.ended).toBe(true);
    expect((await w.call('GET', '/view-as/current')).json).toBeNull();
    expect(Number((await tx('os_server', w.adminId, (c) => c.query(`select count(*)::int as n from os.harness_probe`))).rows[0].n)).toBe(0);
    expect((await w.call('GET', '/support-sessions')).json[0].state).toBe('ended');
    const events = (await owner.query(`select action from audit.log where support_session_id = $1 order by id`, [start.json.id])).rows.map((r) => r.action);
    expect(events).toEqual(expect.arrayContaining(['support_session.start', 'support_session.end']));
  });
});

describe('billing: profile, usage, GST draft invoices', () => {
  it('shows plans, usage and entitlements; usage rows are read from billing.usage', async () => {
    await owner.query(`insert into billing.usage (org_id, product_key, metric, quantity, period_start, period_end) values ($1, 'os', 'ai_credits', 42.5, date_trunc('month', current_date), current_date)`, [osErp.orgId]);
    const b = (await w.call('GET', `/clients/${osErp.orgId}/billing`)).json;
    expect(b.usage).toMatchObject([{ product_key: 'os', metric: 'ai_credits', quantity: 42.5 }]);
    expect(b.plans.map((p: { key: string }) => p.key).sort()).toEqual(['adm_erp_m', 'adm_os_m']);
    expect(b.entitlements.accessible.sort()).toEqual(['erp', 'os']);
    expect(['test', 'live', 'not_configured']).toContain(b.razorpay_mode);
    expect(b.wallets).toBeNull();
    const s = (await w.call('GET', `/clients/${osErp.orgId}/invoice-suggestion`)).json;
    expect(s.map((x: { product_key: string; unit_price_paise: number }) => [x.product_key, x.unit_price_paise])).toEqual([['erp', 499900], ['os', 499900]]);
  });

  it('creates GST drafts: intra-state CGST+SGST, inter-state IGST, sequential numbers per financial year, no live provider call', async () => {
    // the OS + ERP client has no billing profile yet
    expect((await w.call('POST', `/clients/${osErp.orgId}/invoices`, { lines: [{ description: 'OS monthly', quantity: 1, unit_price_paise: 499900 }] })).json.error).toBe('billing_account_missing');
    await w.write('PUT', `/clients/${osErp.orgId}/billing-account`, { legal_name: 'OS ERP College Trust', gstin: '27AABCA1234A1Z5', state_code: '27' });
    expect((await w.call('PUT', `/clients/${osErp.orgId}/billing-account`, { legal_name: 'Bad', gstin: '36AABCA1234A1Z5', state_code: '27' })).status).toBe(422); // GSTIN state differs

    const lastSeq = Number((await owner.query(`select coalesce(max(substring(invoice_number from '([0-9]+)$')::int), 0) as n from billing.invoices where financial_year = '2026-27'`)).rows[0].n);
    const lines = [{ product_key: 'os', description: 'OS monthly', quantity: 2, unit_price_paise: 499900, discount_paise: 100 }, { product_key: 'erp', description: 'ERP monthly', quantity: 1, unit_price_paise: 333333 }];
    // supplier is Telangana (36): client in Maharashtra (27) => IGST
    const inter = await w.write('POST', `/clients/${osErp.orgId}/invoices`, { invoice_date: '2026-11-24', lines });
    const expectInter = computeInvoice({ supplierStateCode: '36', placeOfSupplyStateCode: '27', lines: lines.map((l) => ({ description: l.description, quantity: l.quantity, unitPricePaise: l.unit_price_paise, discountPaise: l.discount_paise })) });
    expect(inter.json).toMatchObject({ status: 'draft', place_of_supply: '27', supplier_state_code: '36', cgst_paise: 0, sgst_paise: 0, igst_paise: expectInter.igstPaise, taxable_paise: expectInter.taxablePaise, total_paise: expectInter.totalPaise });
    expect(inter.json.invoice_number).toBe(`AE/26-27/${String(lastSeq + 1).padStart(6, '0')}`);
    expect(inter.json.lines).toHaveLength(2);
    expect(inter.json.lines[0]).toMatchObject({ sac_code: '998314', gst_rate: 18 });

    // CRM-only client is in Telangana (36): intra-state
    const intra = await w.write('POST', `/clients/${crm.orgId}/invoices`, { invoice_date: '2026-12-01', lines: [{ description: 'CRM monthly', quantity: 1, unit_price_paise: 1050 }] });
    expect(intra.json).toMatchObject({ igst_paise: 0, cgst_paise: 95, sgst_paise: 95, total_paise: 1050 + 190 });
    expect(intra.json.invoice_number).toBe(`AE/26-27/${String(lastSeq + 2).padStart(6, '0')}`);

    // new financial year restarts the series
    const fy2 = await w.write('POST', `/clients/${crm.orgId}/invoices`, { invoice_date: '2027-04-02', lines: [{ description: 'CRM monthly', quantity: 1, unit_price_paise: 499900 }] });
    expect(fy2.json).toMatchObject({ financial_year: '2027-28', invoice_number: 'AE/27-28/000001' });

    // missing supplier configuration is refused rather than guessed
    const res = await (await import('../src/platform-admin')).dispatchAdmin(
      { method: 'POST', path: `/clients/${crm.orgId}/invoices`, query: {}, headers: { authorization: `Bearer ${await w.token(w.adminId)}`, 'x-admin-client': '1' }, body: { lines: [{ description: 'x line', quantity: 1, unit_price_paise: 100 }] } },
      { ...w.deps, config: { ...w.deps.config, supplierStateCode: null } },
    );
    expect(res.status).toBe(422);

    const list = (await w.call('GET', `/clients/${crm.orgId}/billing`)).json.invoices;
    expect(list.map((i: { invoice_number: string }) => i.invoice_number)).toEqual(expect.arrayContaining([intra.json.invoice_number, 'AE/27-28/000001']));

    // a draft can be voided once, and keeps its number
    const v = await w.write('POST', `/invoices/${fy2.json.id}/void`, { reason: 'wrong period' });
    expect(v.json).toMatchObject({ status: 'void', invoice_number: 'AE/27-28/000001' });
    expect((await w.call('POST', `/invoices/${fy2.json.id}/void`, { reason: 'again' })).status).toBe(409);
    expect((await w.call('GET', `/invoices/${fy2.json.id}`)).json.lines).toHaveLength(1);
  });
});

describe('edit a client; audit viewer', () => {
  it('edits name and details', async () => {
    const r = await w.write('PATCH', `/clients/${crm.orgId}`, { name: `CRM Only School ${tag} (renamed)`, kind: 'coaching_centre' });
    expect(r.json).toMatchObject({ name: `CRM Only School ${tag} (renamed)`, kind: 'coaching_centre' });
    expect((await w.call('PATCH', `/clients/${crm.orgId}`, {})).status).toBe(422);
    expect((await w.call('PATCH', `/clients/${crm.orgId}`, { kind: 'bank' })).status).toBe(422);
    const list = (await w.call('GET', `/clients?q=renamed&product=crm`)).json;
    expect(list.map((x: { id: string }) => x.id)).toEqual([crm.orgId]);
  });

  it('filters by client, actor, action prefix, table and text; pages with a cursor; reads configuration history', async () => {
    const all = (await w.call('GET', `/audit?org_id=${crm.orgId}&limit=200`)).json;
    expect(all.rows.length).toBeGreaterThan(10);
    expect(all.rows.every((r: { org_id: string }) => r.org_id === crm.orgId)).toBe(true);
    const created = (await w.call('GET', `/audit?org_id=${crm.orgId}&action=admin.client`)).json.rows.map((r: { action: string }) => r.action);
    expect(created).toEqual(expect.arrayContaining(['admin.client.create', 'admin.client.update']));
    expect(created.every((a: string) => a.startsWith('admin.client'))).toBe(true);
    const mine = (await w.call('GET', `/audit?actor=${w.adminId}&action=admin.user.lock&org_id=${crm.orgId}`)).json.rows;
    expect(mine.length).toBeGreaterThanOrEqual(2);
    expect(mine[0]).toMatchObject({ actor_name: 'Console Admin', org_name: expect.stringContaining('CRM Only') });
    expect(mine[0].detail.reason).toBeTruthy();
    const subs = (await w.call('GET', `/audit?org_id=${crm.orgId}&table=subscriptions`)).json.rows;
    expect(subs.length).toBeGreaterThan(3);
    expect(subs.every((r: { table_name: string }) => r.table_name === 'subscriptions')).toBe(true);
    const text = (await w.call('GET', `/audit?org_id=${crm.orgId}&q=phone%20reported%20stolen`)).json.rows;
    expect(text.length).toBeGreaterThan(0);
    const page1 = (await w.call('GET', `/audit?org_id=${crm.orgId}&limit=5`)).json;
    expect(page1.rows).toHaveLength(5);
    expect(page1.next_before_id).toBe(page1.rows[4].id);
    const page2 = (await w.call('GET', `/audit?org_id=${crm.orgId}&limit=5&before_id=${page1.next_before_id}`)).json;
    expect(page2.rows[0].id).toBeLessThan(page1.rows[4].id);
    const cfg = (await w.call('GET', `/audit?source=config&org_id=${crm.orgId}&table=subscriptions`)).json.rows;
    expect(cfg.length).toBeGreaterThan(3);
    expect(cfg[0]).toHaveProperty('before');
    expect((await w.call('GET', `/audit?from=2999-01-01`)).json.rows).toHaveLength(0);
    expect((await w.call('GET', `/audit?limit=9999`)).status).toBe(422);
  });

  it('overview counts clients by health and product', async () => {
    const o = (await w.call('GET', '/overview')).json;
    expect(o.clients).toBeGreaterThanOrEqual(2);
    expect(o.by_health.ok + o.by_health.attention + o.by_health.critical).toBe(o.clients);
  });
});

describe('every admin write is audited', () => {
  it('each write route of the console was driven above and left admin.* events by the admin in audit.log', async () => {
    const { listAdminRoutes } = await import('../src/platform-admin');
    const writes = listAdminRoutes().filter((r) => !r.public && r.method !== 'GET').map((r) => `${r.method} ${r.path}`);
    const missing = writes.filter((x) => !w.exercised.has(x));
    expect(missing).toEqual([]);
  });
});
