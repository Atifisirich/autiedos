/**
 * Who may use the platform admin console, and what the console's database role can and cannot do.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { count, errorCode, owner } from './helpers';
import { buildAdminWorld, newUser, roleUrl, type AdminWorld } from './admin-helpers';
import { createAdminAuth, createAdminDb, dispatchAdmin, listAdminRoutes } from '../src/platform-admin';

let w: AdminWorld;
let clientAdmin: string;
let orgId: string;
const tag = Math.random().toString(36).slice(2, 8);

beforeAll(async () => {
  w = await buildAdminWorld(`sec-${tag}`);
  const r = await w.write('POST', '/clients', {
    name: `Security School ${tag}`,
    slug: `sec-${tag}`,
    branch: { name: 'Main', code: 'M' },
    subscriptions: [{ product_key: 'crm' }],
    admin: { email: `owner@sec-${tag}.test`, display_name: 'Client Owner' },
  });
  orgId = r.json.org.id;
  w.orgIds.push(orgId);
  clientAdmin = r.json.admin.user_id;
  await w.write('POST', `/clients/${orgId}/users/${clientAdmin}/status`, { status: 'active', reason: 'accepted the invite' });
}, 120000);

afterAll(async () => {
  await w.cleanup();
  await owner.end();
});

/** Fills :params of a route pattern with plausible values. */
const fill = (path: string) =>
  path
    .replace(':id', orgId)
    .replace(':uid', clientAdmin)
    .replace(':branchId', orgId)
    .replace(':invoiceId', orgId)
    .replace(':product', 'crm')
    .replace(':key', 'adm_x');

const adminRoutes = listAdminRoutes().filter((r) => !r.public);

describe('non-platform users are refused every admin route', () => {
  it('there are admin routes to test (read and write)', () => {
    expect(adminRoutes.length).toBeGreaterThan(30);
    expect(adminRoutes.some((r) => r.method === 'GET')).toBe(true);
    expect(adminRoutes.some((r) => r.method !== 'GET')).toBe(true);
  });

  it('a client admin, a signed-in user with no client, and a deactivated platform admin all get 403 on every route, whatever the body; nothing is written', async () => {
    const retired = await newUser(`retired-${tag}@autoed.test`);
    w.userIds.push(retired);
    await owner.query(`insert into core.platform_admins (user_id, name, active) values ($1, 'Retired', false)`, [retired]);
    const before = {
      audit: Number((await owner.query(`select count(*)::int as n from audit.log`)).rows[0].n),
      orgs: Number((await owner.query(`select count(*)::int as n from core.organizations`)).rows[0].n),
    };
    const bodies = [{}, { reason: 'a perfectly good reason here', name: 'Evil', slug: 'evil', locked: true }];
    const leaks: string[] = [];
    for (const who of [clientAdmin, w.nonAdminId, retired]) {
      for (const r of adminRoutes) {
        for (const body of bodies) {
          const res = await w.call(r.method, fill(r.path), body, who);
          if (res.status !== 403) leaks.push(`${r.method} ${r.path} as ${who === clientAdmin ? 'client admin' : who === retired ? 'retired admin' : 'no-client user'} -> ${res.status}`);
        }
      }
    }
    expect(leaks).toEqual([]);
    expect(Number((await owner.query(`select count(*)::int as n from audit.log`)).rows[0].n)).toBe(before.audit);
    expect(Number((await owner.query(`select count(*)::int as n from core.organizations`)).rows[0].n)).toBe(before.orgs);
  });

  it('no session, a garbage token and a token signed with another secret get 401 on every route', async () => {
    const other = await createAdminAuth({ AUTH_JWT_SECRET: 'some-other-secret-some-other-secret' }).issue(w.adminId);
    for (const r of adminRoutes) {
      for (const header of [undefined, 'Bearer nonsense', `Bearer ${other.token}`]) {
        const res = await dispatchAdmin({ method: r.method, path: fill(r.path), query: {}, headers: { ...(header ? { authorization: header } : {}), 'x-admin-client': '1' }, body: {} }, w.deps);
        expect(res.status, `${r.method} ${r.path} with ${header ?? 'no header'}`).toBe(401);
      }
    }
  });

  it('a console session of a client user (signed with the right secret) still gets 403 because the database decides', async () => {
    const res = await w.call('GET', '/clients', undefined, clientAdmin);
    expect(res.status).toBe(403);
    expect(res.json.error).toBe('not_platform_admin');
  });

  it('removing admin rights takes effect on the very next request', async () => {
    const temp = await newUser(`temp-${tag}@autoed.test`);
    w.userIds.push(temp);
    await owner.query(`insert into core.platform_admins (user_id, name) values ($1, 'Temp')`, [temp]);
    expect((await w.call('GET', '/clients', undefined, temp)).status).toBe(200);
    await owner.query(`update core.platform_admins set active = false where user_id = $1`, [temp]);
    expect((await w.call('GET', '/clients', undefined, temp)).status).toBe(403);
  });

  it('a write without the client header is refused even for an admin (cross-site form posts)', async () => {
    const res = await dispatchAdmin({ method: 'POST', path: '/billing/tick', query: {}, headers: { authorization: `Bearer ${await w.token(w.adminId)}` }, body: {} }, w.deps);
    expect(res.status).toBe(403);
    expect(res.json).toMatchObject({ error: 'missing_client_header' });
  });
});

describe('sign-in', () => {
  it('dev login works only for platform admins, only when AUTH_PROVIDER=dev, and the cookie session then works', async () => {
    const ok = await dispatchAdmin({ method: 'POST', path: '/auth/dev-login', query: {}, headers: {}, body: { email: `admin-sec-${tag}@autoed.test` }, ip: '1.1.1.1' }, w.deps);
    expect(ok.status).toBe(200);
    expect(ok.setSession?.token).toBeTruthy();
    expect(ok.json).toMatchObject({ user_id: w.adminId, name: 'Console Admin' });
    const me = await dispatchAdmin({ method: 'GET', path: '/me', query: {}, headers: { authorization: `Bearer ${ok.setSession!.token}` }, body: {} }, w.deps);
    expect(me.json).toMatchObject({ user_id: w.adminId });

    const client = await dispatchAdmin({ method: 'POST', path: '/auth/dev-login', query: {}, headers: {}, body: { email: `owner@sec-${tag}.test` }, ip: '1.1.1.1' }, w.deps);
    expect(client.status).toBe(401);
    expect(client.setSession).toBeUndefined();

    const prod = { ...w.deps, auth: createAdminAuth({ AUTH_JWT_SECRET: 'x'.repeat(40), NODE_ENV: 'production' }) };
    const off = await dispatchAdmin({ method: 'POST', path: '/auth/dev-login', query: {}, headers: {}, body: { email: `admin-sec-${tag}@autoed.test` } }, prod);
    expect(off.status).toBe(404);
    const out = await dispatchAdmin({ method: 'POST', path: '/auth/logout', query: {}, headers: {}, body: {} }, w.deps);
    expect(out.setSession).toBeNull();
  });
});

describe('the console database role', () => {
  it('refuses to run on any other connection (postgres, service role) and has no fallback URL', async () => {
    const wrong = createAdminDb(roleUrl('postgres'));
    try {
      const res = await dispatchAdmin({ method: 'GET', path: '/clients', query: {}, headers: { authorization: `Bearer ${await w.token(w.adminId)}` }, body: {} }, { ...w.deps, db: wrong });
      expect(res.status).toBe(500);
      expect(res.json).toMatchObject({ error: 'admin_db_wrong_role' });
    } finally {
      await wrong.close();
    }
    const saved = process.env.ADMIN_DATABASE_URL;
    delete process.env.ADMIN_DATABASE_URL;
    try {
      expect(() => createAdminDb()).toThrow(/ADMIN_DATABASE_URL/);
    } finally {
      if (saved !== undefined) process.env.ADMIN_DATABASE_URL = saved;
    }
  });

  it('as platform_admin_server an admin sees no client master or product data without a support session (T9 stays true)', async () => {
    for (const t of ['core.branches', 'core.org_users', 'core.user_product_access', 'core.roles']) {
      expect(await count('platform_admin_server', w.adminId, `select * from ${t}`), t).toBe(0);
    }
    for (const t of ['crm.harness_probe', 'os.harness_probe', 'erp.harness_probe', 'private.jobs']) {
      expect(await errorCode('platform_admin_server', w.adminId, `select * from ${t}`), t).toBe('42501');
    }
    // what the console does see: clients, subscriptions, billing, audit
    expect(await count('platform_admin_server', w.adminId, `select * from core.organizations where id = '${orgId}'`)).toBe(1);
    expect(await count('platform_admin_server', w.adminId, `select * from core.subscriptions where org_id = '${orgId}'`)).toBe(1);
    expect(await count('platform_admin_server', w.adminId, `select * from audit.log where org_id = '${orgId}'`)).toBeGreaterThan(0);
  });

  it('the app.admin_* functions are for platform_admin_server only, and check the claim as well', async () => {
    for (const role of ['authenticated', 'crm_server', 'os_server', 'erp_server', 'job_runner', 'anon'] as const) {
      expect(await errorCode(role, w.adminId, `select * from app.admin_client_stats()`), role).toBe('42501');
    }
    // right role, wrong person: the function itself refuses
    expect(await errorCode('platform_admin_server', clientAdmin, `select * from app.admin_client_stats()`)).toBe('42501');
    expect(await errorCode('platform_admin_server', null, `select app.admin_log_event(null, 'admin.x.y')`)).toBe('42501');
    // an admin cannot write a forged non-console event
    expect(await errorCode('platform_admin_server', w.adminId, `select app.admin_log_event(null, 'login.success')`)).toBe('22023');
    // nor change tables directly that the console only reaches through the functions
    expect(await errorCode('platform_admin_server', w.adminId, `update core.user_security set locked_until = null`)).toBe('42501');
    expect(await errorCode('platform_admin_server', w.adminId, `insert into audit.log (action) values ('forged')`)).toBe('42501');
  });
});
