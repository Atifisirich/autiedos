/**
 * Authentication for the CRM server. The CRM no longer has its own users, passwords, TOTP or sessions
 * (MAP-TABLES A.2 #3, #4): people sign in through the platform (Supabase Auth), which hands the client a session
 * token (the same HS256 token the OS server issues, signed with AUTH_JWT_SECRET, issuer AUTH_ISSUER, subject = auth
 * user id, claim `sid`). This module only VERIFIES that token and loads the person's CRM context.
 *
 * Revocation ("sign out this device") is the platform's: when a row `session:<sid>` exists in core.device_tokens
 * (visible to its owner under RLS) and has revoked_at set, the session is refused.
 */
import { jwtVerify } from 'jose';
import { asUser, UnauthorizedError, ForbiddenError, type Db, type Row } from './db';
import { type Perms, leadScope } from './perm';

function secret(): Uint8Array {
  const s = process.env.AUTH_JWT_SECRET;
  if (!s && process.env.NODE_ENV === 'production') throw new Error('AUTH_JWT_SECRET is required in production');
  return new TextEncoder().encode(s ?? 'dev-only-secret-change-me-dev-only-secret');
}
const issuer = () => process.env.AUTH_ISSUER ?? 'autoed-os';

export interface Session {
  userId: string;
  sid: string;
}

export async function verifySession(token: string | null | undefined): Promise<Session> {
  if (!token) throw new UnauthorizedError();
  let payload;
  try {
    ({ payload } = await jwtVerify(token, secret(), { issuer: issuer() }));
  } catch {
    throw new UnauthorizedError('invalid_session');
  }
  const sid = String(payload.sid ?? '');
  const userId = String(payload.sub ?? '');
  if (!userId) throw new UnauthorizedError('invalid_session');
  const dev = await asUser(userId, null, (db) => db.one('select revoked_at from core.device_tokens where token = $1', [`session:${sid}`]));
  if (dev?.revoked_at) throw new UnauthorizedError('session_revoked');
  return { userId, sid };
}

export type Ctx = {
  user: { id: string; name: string; email: string | null };
  orgId: string;
  org: Row;
  settings: Row;
  perms: Perms;
  roleKey: string;
  roleName: string;
  /** Branches this user may see. Empty means every branch in the organisation. */
  branchIds: string[];
  years: Row[];
  branches: Row[];
  yearId: string;
  /** Branch picked in the header, or null for all permitted branches. */
  branchId: string | null;
};

/**
 * Loads who the signed-in person is for the CRM: org, role and permission matrix, the branches they may see,
 * the academic years. Returns null when they have no CRM access (no staff link, no CRM grant, or the org has no
 * active CRM subscription) - the database decides that with app.user_has_product.
 */
export async function loadCtx(userId: string, prefs: { yearId?: string; branchId?: string } = {}): Promise<Ctx | null> {
  return asUser(userId, null, async (db) => {
    const me = await db.one('select u.org_id, u.display_name from core.org_users u where u.user_id = app.uid() and u.status = $1 and u.kind = $2', ['active', 'staff']);
    if (!me) return null;
    const orgId = me.org_id as string;
    if (!(await db.one("select 1 as ok where app.user_has_product($1, 'crm')", [orgId]))) return null;
    const role = await db.one(
      `select a.role_key, r.name, r.permissions from core.user_product_access a
         left join crm.roles r on r.org_id = a.org_id and r.key = a.role_key
        where a.user_id = app.uid() and a.org_id = $1 and a.product_key = 'crm' and a.revoked_at is null`,
      [orgId],
    );
    if (!role) return null;
    const [org, settings, years, allBranches, mine, staff] = await Promise.all([
      db.one('select * from core.organizations where id = $1', [orgId]),
      db.one('select settings from crm.settings where org_id = $1', [orgId]),
      db.q('select * from core.academic_years where org_id = $1 and deleted_at is null order by seq', [orgId]),
      db.q('select * from core.branches where org_id = $1 and active order by name', [orgId]),
      db.one('select app.user_branch_ids() as ids'),
      db.one('select email from core.staff where org_id = $1 and user_id = app.uid()', [orgId]),
    ]);
    const perms: Perms = role.permissions ?? {};
    const own: string[] = (mine?.ids as string[]) ?? [];
    const wide = leadScope(perms) === 'all' || own.length >= allBranches.length;
    const branches = wide ? allBranches : allBranches.filter((b) => own.includes(b.id));
    const yearId = years.find((x) => x.id === prefs.yearId)?.id ?? years.find((x) => x.is_current)?.id ?? years[0]?.id;
    const branchId = branches.find((x) => x.id === prefs.branchId)?.id ?? (branches.length === 1 ? branches[0]!.id : null);
    return {
      user: { id: userId, name: me.display_name, email: staff?.email ?? null }, orgId, org: org!, settings: settings?.settings ?? {}, perms, roleKey: role.role_key, roleName: role.name ?? '',
      branchIds: wide ? [] : own, years, branches, yearId, branchId,
    } satisfies Ctx;
  });
}

export async function requireCtx(userId: string, prefs?: { yearId?: string; branchId?: string }): Promise<Ctx> {
  const ctx = await loadCtx(userId, prefs);
  if (!ctx) throw new ForbiddenError('no_crm_access');
  return ctx;
}

/**
 * SQL fragment narrowing enquiries (alias e) to the branch picked in the header. Tenant, record scope (own / team /
 * branch / org) and the per-branch product switch are NOT filtered here any more: the RLS policies on crm.enquiries
 * decide them, so the same rows are visible whatever query is written.
 */
export function scopeSql(ctx: Ctx, params: unknown[], alias = 'e', useHeaderBranch = true): string {
  params.push(ctx.orgId);
  let sql = `${alias}.org_id = $${params.length}`;
  if (leadScope(ctx.perms) === 'none') sql += ' and false';
  if (useHeaderBranch && ctx.branchId) {
    params.push(ctx.branchId);
    sql += ` and ${alias}.branch_id = $${params.length}`;
  }
  return sql;
}

export type { Db };
