/**
 * Users of a client, seen by AutoEd staff: list, invite, lock / unlock, force a password change, product access
 * (who may use which product, with which role key) and the read-only "what can this user see" preview.
 * Everything goes through the audited app.admin_* functions; the console role has no direct grant on these tables.
 */
import type { EntitlementResult } from '@autoed/shared';
import { maybe, q, type Tx } from './db';
import { conflict, invalid, notFound } from './errors';
import { entitlementsOf, listSubscriptions } from './subscriptions';
import { istToday, logEvent, requireOrg } from './util';
import type { AdminDeps } from './deps';

export interface OrgUserRow {
  user_id: string;
  kind: string;
  display_name: string;
  status: string;
  home_branch_id: string | null;
  email: string | null;
  phone: string | null;
  created_at: string;
  must_change_password: boolean;
  locked_until: string | null;
  failed_attempts: number;
  mfa_required: boolean;
  last_login_at: string | null;
  access: { product_key: string; role_key: string; granted_at: string }[];
  locked: boolean;
}

export async function listUsers(c: Tx, orgId: string): Promise<OrgUserRow[]> {
  await requireOrg(c, orgId);
  const rows = await q<Omit<OrgUserRow, 'locked'>>(c, `select * from app.admin_list_users($1)`, [orgId]);
  const now = Date.now();
  return rows.map((r) => ({ ...r, locked: !!r.locked_until && new Date(r.locked_until).getTime() > now }));
}

export async function listRoles(c: Tx, orgId: string) {
  await requireOrg(c, orgId);
  return q<{ product_key: string; key: string; name: string; permission_count: number }>(c, `select * from app.admin_list_roles($1)`, [orgId]);
}

async function requireMember(c: Tx, orgId: string, userId: string): Promise<void> {
  const m = await maybe(c, `select 1 from app.admin_list_users($1) where user_id = $2`, [orgId, userId]);
  if (!m) throw notFound('user_not_found');
}

async function requireSubscribed(c: Tx, orgId: string, product: string): Promise<void> {
  const s = await maybe(c, `select 1 from core.subscriptions where org_id = $1 and product_key = $2`, [orgId, product]);
  if (!s) throw invalid('product_not_subscribed', { product });
}

interface InviteBase {
  email: string;
  display_name: string;
  home_branch_id?: string | null;
}

/** Creates the login (provisioner), links it to the client and grants access; undoes the login on failure. */
async function inviteInto(c: Tx, deps: AdminDeps, orgId: string, kind: string, input: InviteBase, access: { product_key: string; role_key: string }[]): Promise<{ user_id: string; email: string }> {
  for (const a of access) await requireSubscribed(c, orgId, a.product_key);
  const { userId, created } = await deps.provisioner.invite({ email: input.email.toLowerCase(), displayName: input.display_name });
  try {
    await c.query(`select app.admin_create_org_user($1, $2, $3, $4, $5, 'invited')`, [orgId, userId, kind, input.display_name, input.home_branch_id ?? null]);
    for (const a of access) await c.query(`select app.admin_set_product_access($1, $2, $3, $4)`, [orgId, userId, a.product_key, a.role_key]);
    await logEvent(c, orgId, 'admin.user.invite', { user_id: userId, email: input.email.toLowerCase(), kind, access }, userId);
  } catch (e) {
    if (created) await deps.provisioner.remove(userId).catch(() => undefined);
    throw e;
  }
  return { user_id: userId, email: input.email.toLowerCase() };
}

/** First admin of a new client: admin role in every product the client bought. */
export async function createClientAdmin(c: Tx, deps: AdminDeps, orgId: string, input: InviteBase & { products: string[] }) {
  return inviteInto(c, deps, orgId, 'staff', input, input.products.map((p) => ({ product_key: p, role_key: 'admin' })));
}

export async function inviteUser(c: Tx, deps: AdminDeps, orgId: string, input: InviteBase & { kind: string; access: { product_key: string; role_key: string }[] }) {
  await requireOrg(c, orgId);
  return inviteInto(c, deps, orgId, input.kind, input, input.access);
}

export async function setLock(c: Tx, orgId: string, userId: string, input: { locked: boolean; reason: string; minutes?: number }) {
  await requireMember(c, orgId, userId);
  // "Lock" without a length means until an admin unlocks (ten years).
  await c.query(`select app.admin_set_user_lock($1, $2, $3)`, [userId, input.locked, input.locked ? (input.minutes ?? 5256000) : null]);
  await logEvent(c, orgId, input.locked ? 'admin.user.lock' : 'admin.user.unlock', { user_id: userId, reason: input.reason, minutes: input.locked ? (input.minutes ?? 5256000) : null }, userId);
  return (await listUsers(c, orgId)).find((u) => u.user_id === userId)!;
}

export async function setForceReset(c: Tx, orgId: string, userId: string, input: { required: boolean; reason: string }) {
  await requireMember(c, orgId, userId);
  await c.query(`select app.admin_set_must_change_password($1, $2)`, [userId, input.required]);
  await logEvent(c, orgId, 'admin.user.force_password_reset', { user_id: userId, required: input.required, reason: input.reason }, userId);
  return (await listUsers(c, orgId)).find((u) => u.user_id === userId)!;
}

export async function setStatus(c: Tx, orgId: string, userId: string, input: { status: string; reason: string }) {
  await requireMember(c, orgId, userId);
  await c.query(`select app.admin_set_user_status($1, $2)`, [userId, input.status]);
  await logEvent(c, orgId, 'admin.user.status', { user_id: userId, status: input.status, reason: input.reason }, userId);
  return (await listUsers(c, orgId)).find((u) => u.user_id === userId)!;
}

export async function setAccess(c: Tx, orgId: string, userId: string, input: { product_key: string; role_key: string }) {
  await requireMember(c, orgId, userId);
  await requireSubscribed(c, orgId, input.product_key);
  await c.query(`select app.admin_set_product_access($1, $2, $3, $4)`, [orgId, userId, input.product_key, input.role_key]);
  await logEvent(c, orgId, 'admin.user.access_set', { user_id: userId, ...input }, userId);
  return (await listUsers(c, orgId)).find((u) => u.user_id === userId)!;
}

export async function revokeAccess(c: Tx, orgId: string, userId: string, product: string) {
  await requireMember(c, orgId, userId);
  const done = (await c.query(`select app.admin_revoke_product_access($1, $2, $3) as ok`, [orgId, userId, product])).rows[0].ok as boolean;
  if (!done) throw conflict('no_access_to_revoke');
  await logEvent(c, orgId, 'admin.user.access_revoke', { user_id: userId, product_key: product }, userId);
  return (await listUsers(c, orgId)).find((u) => u.user_id === userId)!;
}

// ---------------------------------------------------------------- entitlement preview

interface RawPreview {
  user: { user_id: string; kind: string; display_name: string; status: string; home_branch_id: string | null };
  org: { id: string; name: string; status: string };
  all_branches: boolean;
  learner_link_count: number;
  branches: { id: string; name: string; code: string; active: boolean; visible: boolean }[];
  products: {
    product_key: string;
    subscription_status: string | null;
    org_on: boolean;
    access: { role_key: string; granted_at: string } | null;
    permissions: { module_key: string; action: string; scope: 'own' | 'branch' | 'org' }[];
    branches_on: { branch_id: string; on: boolean }[];
  }[];
}

export type OffReason = 'client_suspended' | 'no_subscription' | 'subscription_suspended' | 'subscription_cancelled' | 'outside_dates' | 'no_access_row';

export interface PreviewProduct {
  product_key: string;
  /** What the database enforces for this person right now. */
  db_gate: 'on' | 'off';
  off_reasons: OffReason[];
  role_key: string | null;
  /** Modules with at least view permission, and the widest scope. */
  modules: { module_key: string; view_scope: 'own' | 'branch' | 'org'; actions: string[] }[];
  branches: { id: string; name: string; code: string; on: boolean }[];
  /** Billing rules on top of the gate (30 days read-only after non-payment, decision 42). */
  billing_access: 'full' | 'read_only' | 'none';
}

export interface EntitlementPreview {
  user: RawPreview['user'];
  org: RawPreview['org'];
  all_branches: boolean;
  learner_link_count: number;
  products: PreviewProduct[];
  /** Products the person can open right now (gate on and a role with something to view, or portal access). */
  visible_products: string[];
}

const RANK = { own: 1, branch: 2, org: 3 } as const;

export async function entitlementPreview(c: Tx, deps: AdminDeps, orgId: string, userId: string): Promise<EntitlementPreview> {
  await requireOrg(c, orgId);
  await requireMember(c, orgId, userId);
  const raw = (await c.query(`select app.admin_entitlement_preview($1, $2) as j`, [orgId, userId])).rows[0].j as RawPreview;
  const subs = await listSubscriptions(c, orgId);
  const today = istToday(deps.now());
  const ent: EntitlementResult = await entitlementsOf(c, subs, deps.now());
  const modulesByProduct = new Map<string, string[]>();
  for (const m of await q<{ product_key: string; module_key: string }>(c, `select product_key, module_key from core.product_modules where active order by module_key`)) {
    (modulesByProduct.get(m.product_key) ?? modulesByProduct.set(m.product_key, []).get(m.product_key)!).push(m.module_key);
  }
  const isStaff = raw.user.kind === 'staff';
  const products: PreviewProduct[] = raw.products.map((p) => {
    const sub = subs.find((s) => s.product_key === p.product_key);
    const off: OffReason[] = [];
    if (raw.org.status === 'closed') off.push('client_suspended');
    if (!sub) off.push('no_subscription');
    else {
      if (sub.status === 'suspended') off.push('subscription_suspended');
      if (sub.status === 'cancelled') off.push('subscription_cancelled');
      if ((sub.starts_on > today || (sub.ends_on && sub.ends_on < today)) && ['trial', 'active', 'past_due'].includes(sub.status)) off.push('outside_dates');
    }
    if (!p.access) off.push('no_access_row');
    const gateOn = p.org_on && !!p.access;
    const modules: PreviewProduct['modules'] = [];
    if (gateOn && isStaff) {
      for (const m of modulesByProduct.get(p.product_key) ?? []) {
        const perms = p.permissions.filter((x) => (x.module_key === m || x.module_key === '*'));
        const view = perms.filter((x) => x.action === 'view' || x.action === '*');
        if (!view.length) continue;
        const widest = view.reduce((a, b) => (RANK[b.scope] > RANK[a] ? b.scope : a), 'own' as 'own' | 'branch' | 'org');
        modules.push({ module_key: m, view_scope: widest, actions: [...new Set(perms.map((x) => x.action))].sort() });
      }
    }
    const visible = new Set(raw.branches.filter((b) => b.visible).map((b) => b.id));
    return {
      product_key: p.product_key,
      db_gate: gateOn ? 'on' : 'off',
      off_reasons: off,
      role_key: p.access?.role_key ?? null,
      modules,
      branches: raw.branches.map((b) => ({ id: b.id, name: b.name, code: b.code, on: gateOn && visible.has(b.id) && (p.branches_on.find((x) => x.branch_id === b.id)?.on ?? true) })),
      billing_access: ent.products[p.product_key as 'crm']?.access ?? 'none',
    };
  });
  const visible_products = products.filter((p) => p.db_gate === 'on' && (p.modules.length > 0 || !isStaff)).map((p) => p.product_key);
  return { user: raw.user, org: raw.org, all_branches: raw.all_branches, learner_link_count: raw.learner_link_count, products, visible_products };
}
