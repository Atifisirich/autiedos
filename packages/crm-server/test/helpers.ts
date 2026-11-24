/**
 * Test world helpers. Fixtures are written as the table owner (DATABASE_URL, RLS bypassed); the code under test
 * connects as the real login roles crm_server and job_runner, so RLS, grants and the automation user are exercised.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { SignJWT } from 'jose';
import { roleKey, seedStarterPack } from '../src/provision';
import { asSystem, closePools } from '../src/db';

export const OWNER_URL = process.env.DATABASE_URL ?? 'postgres://postgres@localhost:54322/postgres';
const as = (role: string) => {
  const u = new URL(OWNER_URL);
  u.username = role;
  u.password = '';
  return u.toString();
};
process.env.CRM_DATABASE_URL ??= as('crm_server');
process.env.JOB_DATABASE_URL ??= as('job_runner');
process.env.AUTH_JWT_SECRET ??= 'test-secret-test-secret-test-secret-123';

export const owner = new pg.Pool({ connectionString: OWNER_URL, max: 3 });

export async function shutdown() {
  await closePools();
  await owner.end();
}

export const ownerQ = async (sql: string, params: unknown[] = []) => (await owner.query(sql, params)).rows;

export interface TestOrg {
  orgId: string;
  branchId: string;
  branches: Record<string, string>;
  yearId: string;
  roles: Record<string, string>;
  users: Record<string, string>;
  systemUser: string;
}

let seq = 0;

/** An org with the CRM subscribed, one or more branches, and the CRM starter pack (what onboarding does). */
export async function createOrg(name: string, opts: { branches?: string[]; products?: string[]; pack?: string } = {}): Promise<TestOrg> {
  const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now()}-${++seq}`;
  const orgId = randomUUID();
  await owner.query(`insert into core.organizations (id, name, slug, kind) values ($1, $2, $3, 'school')`, [orgId, name, slug]);
  const branches: Record<string, string> = {};
  for (const b of opts.branches ?? ['Main campus']) {
    branches[b] = randomUUID();
    await owner.query(`insert into core.branches (id, org_id, name, code, state_code) values ($1, $2, $3, $4, '36')`, [branches[b], orgId, b, b.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 8) + seq, ]);
  }
  for (const p of opts.products ?? ['crm']) {
    await owner.query(`insert into core.subscriptions (org_id, product_key, status, plan_key) values ($1, $2, 'active', $3)`, [orgId, p, `${p}_monthly`]);
  }
  const branchId = Object.values(branches)[0]!;
  const sys = (await ownerQ(`select system_user_id from crm.settings where org_id = $1`, [orgId]))[0]?.system_user_id as string;
  const { roles, yearId } = await seedStarterPack(orgId, { branchId, pack: opts.pack ?? 'cbse_day', formSlug: `${slug}-enquiry` });
  return { orgId, branchId, branches, yearId, roles, users: {}, systemUser: sys };
}

/** A staff member with a CRM role. Everything is written as the owner; the CRM only reads it. */
export async function addStaff(org: TestOrg, name: string, roleName: string, o: { branchIds?: string[]; reportsTo?: string; onLeave?: boolean; capacity?: number } = {}): Promise<string> {
  const uid = randomUUID();
  const email = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '.')}.${uid.slice(0, 6)}@test.demo`;
  const home = o.branchIds?.[0] ?? null;
  await owner.query(`insert into auth.users (id, email) values ($1, $2)`, [uid, email]);
  await owner.query(`insert into core.org_users (org_id, user_id, kind, display_name, home_branch_id) values ($1, $2, 'staff', $3, $4)`, [org.orgId, uid, name, home]);
  for (const b of (o.branchIds ?? []).slice(1)) await owner.query(`insert into core.user_branch_access (org_id, user_id, branch_id) values ($1, $2, $3)`, [org.orgId, uid, b]);
  const [first, ...rest] = name.split(' ');
  const mgr = o.reportsTo ? ((await ownerQ(`select id from core.staff where org_id = $1 and user_id = $2`, [org.orgId, o.reportsTo]))[0]?.id ?? null) : null;
  await owner.query(`insert into core.staff (org_id, branch_id, user_id, first_name, last_name, email, status, staff_type, reports_to) values ($1, $2, $3, $4, $5, $6, 'active', 'admin', $7)`, [org.orgId, home, uid, first, rest.join(' ') || null, email, mgr]);
  await owner.query(`insert into core.user_product_access (org_id, user_id, product_key, role_key) values ($1, $2, 'crm', $3)`, [org.orgId, uid, org.roles[roleName] ?? roleKey(roleName)]);
  await owner.query(`insert into crm.counsellor_settings (org_id, user_id, daily_capacity, on_leave) values ($1, $2, $3, $4)`, [org.orgId, uid, o.capacity ?? 25, o.onLeave ?? false]);
  org.users[name] = uid;
  return uid;
}

/** A platform session token for a user, as the platform issues it (HS256, issuer autoed-os, claim sid). */
export async function sessionFor(userId: string): Promise<string> {
  return new SignJWT({ sid: randomUUID() })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime('1h')
    .setIssuer(process.env.AUTH_ISSUER ?? 'autoed-os')
    .sign(new TextEncoder().encode(process.env.AUTH_JWT_SECRET!));
}

export const sysOf = (org: TestOrg) => <T>(fn: Parameters<typeof asSystem<T>>[1]) => asSystem(org.orgId, fn);
