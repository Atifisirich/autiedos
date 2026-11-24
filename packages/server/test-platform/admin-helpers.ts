/**
 * Helpers for the platform admin console tests. They drive the console exactly as the web route does
 * (dispatchAdmin with a real session token) against the real database, with the console connected as the real login
 * role platform_admin_server. The owner pool (RLS bypass) is used only to plant fixtures, to read what the console
 * must not be able to read, and to clean up.
 */
import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { DATABASE_URL, owner, tx } from './helpers';
import {
  createAdminAuth,
  createAdminDb,
  dispatchAdmin,
  listAdminRoutes,
  type AdminAuth,
  type AdminDb,
  type AdminDeps,
  type AuthProvisioner,
} from '../src/platform-admin';

export function roleUrl(role: string): string {
  const u = new URL(DATABASE_URL);
  u.username = role;
  u.password = '';
  return u.toString();
}

/** Plays the part of Supabase Auth: the invited person gets a row in auth.users. */
export function testProvisioner(): AuthProvisioner & { created: string[]; removed: string[] } {
  const created: string[] = [];
  const removed: string[] = [];
  return {
    created,
    removed,
    async invite({ email }) {
      const r = await owner.query(`insert into auth.users (email) values ($1) on conflict (email) do nothing returning id`, [email]);
      if (r.rows[0]) {
        created.push(r.rows[0].id as string);
        return { userId: r.rows[0].id as string, created: true };
      }
      const existing = await owner.query(`select id from auth.users where email = $1`, [email]);
      return { userId: existing.rows[0].id as string, created: false };
    },
    async remove(userId) {
      removed.push(userId);
      await owner.query(`delete from auth.users where id = $1`, [userId]);
    },
  };
}

export interface AdminWorld {
  db: AdminDb;
  auth: AdminAuth;
  deps: AdminDeps;
  provisioner: ReturnType<typeof testProvisioner>;
  adminId: string;
  admin2Id: string;
  nonAdminId: string;
  /** Console session token for a user id. */
  token(userId: string): Promise<string>;
  /** Calls the console as `userId` (default: the platform admin). */
  call(method: string, path: string, body?: unknown, as?: string | null): Promise<{ status: number; json: any }>;
  /** Same, but asserts the write was audited: new audit.log rows by the admin, including a named admin.* event. */
  write(method: string, path: string, body?: unknown, expectStatus?: number): Promise<{ status: number; json: any }>;
  /** Method + route pattern of every write route a test has driven through write(). */
  exercised: Set<string>;
  orgIds: string[];
  userIds: string[];
  cleanup(): Promise<void>;
}

export async function newUser(email: string): Promise<string> {
  const id = randomUUID();
  await owner.query(`insert into auth.users (id, email) values ($1, $2)`, [id, email]);
  return id;
}

export async function buildAdminWorld(tag: string): Promise<AdminWorld> {
  const db = createAdminDb(roleUrl('platform_admin_server'));
  const auth = createAdminAuth({ AUTH_JWT_SECRET: 'admin-test-secret-admin-test-secret', AUTH_PROVIDER: 'dev', NODE_ENV: 'test' });
  const provisioner = testProvisioner();
  const deps: AdminDeps = {
    db,
    auth,
    provisioner,
    config: { supplierStateCode: '36', supplierGstin: '36AAAAA0000A1Z5', defaultViewAsMinutes: 60, defaultTrialDays: 14 },
    now: () => new Date(),
  };
  const adminId = await newUser(`admin-${tag}@autoed.test`);
  const admin2Id = await newUser(`admin2-${tag}@autoed.test`);
  const nonAdminId = await newUser(`nobody-${tag}@elsewhere.test`);
  await owner.query(`insert into core.platform_admins (user_id, name) values ($1, 'Console Admin'), ($2, 'Console Admin Two')`, [adminId, admin2Id]);
  const exercised = new Set<string>();
  const routes = listAdminRoutes().filter((r) => !r.public && r.method !== 'GET');
  const matchRoute = (method: string, path: string) =>
    routes.find((r) => r.method === method && new RegExp(`^${r.path.replace(/:\w+/g, '[^/]+')}$`).test(path));

  const world: AdminWorld = {
    db,
    auth,
    deps,
    provisioner,
    adminId,
    admin2Id,
    nonAdminId,
    exercised,
    orgIds: [],
    userIds: [adminId, admin2Id, nonAdminId],
    token: async (userId) => (await auth.issue(userId)).token,
    async call(method, path, body, as = adminId) {
      const [p, qs] = path.split('?');
      const res = await dispatchAdmin(
        {
          method,
          path: p!,
          query: Object.fromEntries(new URLSearchParams(qs ?? '')),
          headers: { ...(as ? { authorization: `Bearer ${await world.token(as)}` } : {}), 'x-admin-client': '1' },
          body: body ?? {},
          ip: '127.0.0.1',
        },
        deps,
      );
      return { status: res.status, json: res.json };
    },
    async write(method, path, body, expectStatus = 200) {
      const before = Number((await owner.query(`select coalesce(max(id), 0)::int as n from audit.log`)).rows[0].n);
      const res = await world.call(method, path, body);
      expect(res.status, `${method} ${path} -> ${JSON.stringify(res.json)}`).toBe(expectStatus);
      if (expectStatus === 200) {
        const rows = (await owner.query(`select action, actor_user_id from audit.log where id > $1`, [before])).rows as { action: string; actor_user_id: string | null }[];
        expect(rows.length, `${method} ${path} wrote nothing to audit.log`).toBeGreaterThan(0);
        expect(rows.some((r) => r.action.startsWith('admin.') && r.actor_user_id === adminId), `${method} ${path} has no admin.* event by the admin`).toBe(true);
        expect(rows.every((r) => r.actor_user_id === adminId || r.actor_user_id === null), 'only the admin acts').toBe(true);
        const hit = matchRoute(method, path.split('?')[0]!);
        if (hit) exercised.add(`${hit.method} ${hit.path}`);
      }
      return res;
    },
    async cleanup() {
      const orgs = world.orgIds;
      await owner.query(`delete from audit.log where actor_user_id = any($1) or org_id = any($2)`, [world.userIds, orgs]);
      await owner.query(`delete from audit.config_history where org_id = any($1)`, [orgs]);
      await owner.query(`delete from core.organizations where id = any($1)`, [orgs]);
      await owner.query(`delete from billing.plans where key like 'adm\\_%'`);
      await owner.query(`delete from auth.users where id = any($1)`, [[...world.userIds, ...provisioner.created]]);
      await owner.query(`delete from audit.log where actor_user_id = any($1) or org_id = any($2)`, [world.userIds, orgs]);
      await db.close();
    },
  };
  return world;
}

/** Counts rows as a product server role would see them for a client user (RLS applies). */
export async function visible(role: 'crm_server' | 'os_server' | 'erp_server' | 'authenticated', userId: string, schema: 'crm' | 'os' | 'erp', orgId?: string): Promise<number> {
  return tx(role, userId, async (c) => Number((await c.query(`select count(*)::int as n from ${schema}.harness_probe ${orgId ? 'where org_id = $1' : ''}`, orgId ? [orgId] : [])).rows[0].n));
}

export async function plantProbes(orgId: string, branchId: string | null) {
  for (const s of ['crm', 'os', 'erp']) await owner.query(`insert into ${s}.harness_probe (org_id, branch_id, title) values ($1, $2, $3)`, [orgId, branchId, `${s} probe`]);
}
