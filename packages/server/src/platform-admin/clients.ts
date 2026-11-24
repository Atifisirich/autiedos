/**
 * Clients (organisations): list with health, create in one step (organisation + first branch + subscriptions + first
 * admin invite), edit, suspend / reactivate, branches. Client "suspended" is `core.organizations.status = 'closed'`:
 * `app.current_org_id()` and `app.org_has_product()` both require an active organisation, so every product loses
 * access on the next request; reactivating restores whatever the subscriptions say.
 */
import type { ProductKey } from '@autoed/shared';
import { maybe, q, type Tx } from './db';
import { conflict, invalid, notFound } from './errors';
import { computeHealth, type HealthLevel, type HealthReason } from './health';
import { addSubscription, listBranchProducts, listSubscriptions, type NewSubscription, type SubscriptionRow } from './subscriptions';
import { istToday, logEvent, requireOrg, type OrgRow } from './util';
import { createClientAdmin } from './users';
import type { AdminDeps } from './deps';
import { saveBillingAccount } from './billing';

export interface ClientSummary extends OrgRow {
  products: { product_key: ProductKey; status: string; plan_key: string | null; ends_on: string | null }[];
  stats: { branch_count: number; user_count: number; active_user_count: number; invited_count: number; locked_count: number; last_login_at: string | null };
  health: { level: HealthLevel; reasons: HealthReason[] };
  client_status: 'active' | 'suspended';
}

interface StatsRow {
  org_id: string;
  branch_count: number;
  user_count: number;
  active_user_count: number;
  invited_count: number;
  locked_count: number;
  last_login_at: Date | null;
}

export interface ClientFilters {
  q?: string;
  status?: 'active' | 'suspended';
  health?: HealthLevel;
  product?: ProductKey;
}

export async function listClients(c: Tx, deps: AdminDeps, f: ClientFilters = {}): Promise<ClientSummary[]> {
  const orgs = await q<OrgRow>(c, `select id, name, slug, kind, legal_name, time_zone, default_locale, status, created_at, updated_at from core.organizations order by name`);
  const subs = await q<SubscriptionRow>(c, `select id, org_id, product_key, status, plan_key, starts_on, ends_on, seats, notes, created_at, updated_at from core.subscriptions`);
  const stats = new Map((await q<StatsRow>(c, `select * from app.admin_client_stats()`)).map((s) => [s.org_id, s]));
  const today = istToday(deps.now());
  const needle = f.q?.toLowerCase();
  const out: ClientSummary[] = [];
  for (const o of orgs) {
    const mine = subs.filter((s) => s.org_id === o.id);
    const s = stats.get(o.id);
    const st = { branch_count: s?.branch_count ?? 0, user_count: s?.user_count ?? 0, active_user_count: s?.active_user_count ?? 0, invited_count: s?.invited_count ?? 0, locked_count: s?.locked_count ?? 0, last_login_at: s?.last_login_at ? new Date(s.last_login_at).toISOString() : null };
    const row: ClientSummary = {
      ...o,
      client_status: o.status === 'closed' ? 'suspended' : 'active',
      products: mine.map((m) => ({ product_key: m.product_key, status: m.status, plan_key: m.plan_key, ends_on: m.ends_on })),
      stats: st,
      health: computeHealth({
        orgStatus: o.status,
        orgCreatedOn: String(new Date(o.created_at).toISOString()).slice(0, 10),
        today,
        subs: mine,
        stats: { ...st, last_login_date: st.last_login_at ? st.last_login_at.slice(0, 10) : null },
      }),
    };
    if (needle && !`${o.name} ${o.slug} ${o.legal_name ?? ''}`.toLowerCase().includes(needle)) continue;
    if (f.status && row.client_status !== f.status) continue;
    if (f.health && row.health.level !== f.health) continue;
    if (f.product && !mine.some((m) => m.product_key === f.product)) continue;
    out.push(row);
  }
  return out;
}

export interface ClientCreateInput {
  name: string;
  slug: string;
  kind: string;
  legal_name?: string | null;
  time_zone: string;
  default_locale: string;
  branch: { name: string; code: string; city?: string | null; state_code?: string | null; time_zone?: string | null };
  subscriptions: NewSubscription[];
  admin: { email: string; display_name: string };
  billing?: { legal_name: string; gstin?: string | null; state_code: string; billing_email?: string | null; address?: string | null };
}

/**
 * One step, one transaction: organisation, first branch, a subscription per product with its built-in admin role,
 * optional billing profile, the first admin (auth invite + organisation link + admin role in every product).
 * If anything fails after the auth user was created, the user is removed again and the transaction rolls back.
 */
export async function createClient(c: Tx, deps: AdminDeps, input: ClientCreateInput) {
  const products = input.subscriptions.map((s) => s.product_key);
  if (new Set(products).size !== products.length) throw invalid('duplicate_product');
  const org = (
    await q<OrgRow>(
      c,
      `insert into core.organizations (name, slug, kind, legal_name, time_zone, default_locale) values ($1, $2, $3, $4, $5, $6)
       returning id, name, slug, kind, legal_name, time_zone, default_locale, status, created_at, updated_at`,
      [input.name, input.slug, input.kind, input.legal_name ?? null, input.time_zone, input.default_locale],
    )
  )[0]!;
  const branchId = (await c.query(`select app.admin_save_branch($1, null, $2, $3, $4, $5, $6, true) as id`, [org.id, input.branch.name, input.branch.code, input.branch.city ?? null, input.branch.state_code ?? null, input.branch.time_zone ?? null])).rows[0].id as string;
  const subs: SubscriptionRow[] = [];
  for (const s of input.subscriptions) subs.push(await addSubscription(c, deps, org.id, s));
  if (input.billing) await saveBillingAccount(c, org.id, input.billing);
  const admin = await createClientAdmin(c, deps, org.id, { ...input.admin, home_branch_id: null, products });
  await logEvent(c, org.id, 'admin.client.create', { name: org.name, slug: org.slug, products, first_branch: branchId, admin_user_id: admin.user_id }, org.id);
  return { org, branch_id: branchId, subscriptions: subs, admin };
}

export async function getClient(c: Tx, deps: AdminDeps, orgId: string) {
  const summary = (await listClients(c, deps)).find((x) => x.id === orgId);
  if (!summary) throw notFound('client_not_found');
  const branches = await q(c, `select id, org_id, name, code, city, state_code, time_zone, active, created_at from app.admin_list_branches($1)`, [orgId]);
  const subscriptions = await listSubscriptions(c, orgId);
  const branch_products = await listBranchProducts(c, orgId);
  const billing = await maybe(c, `select legal_name, gstin, state_code, billing_email, address from billing.accounts where org_id = $1`, [orgId]);
  return { client: summary, branches, subscriptions, branch_products, billing_account: billing };
}

export async function patchClient(c: Tx, orgId: string, patch: Partial<Pick<OrgRow, 'name' | 'legal_name' | 'kind' | 'time_zone' | 'default_locale'>>): Promise<OrgRow> {
  const cur = await requireOrg(c, orgId);
  const next = { ...cur, ...patch };
  const row = (
    await q<OrgRow>(
      c,
      `update core.organizations set name = $2, legal_name = $3, kind = $4, time_zone = $5, default_locale = $6 where id = $1
       returning id, name, slug, kind, legal_name, time_zone, default_locale, status, created_at, updated_at`,
      [orgId, next.name, next.legal_name, next.kind, next.time_zone, next.default_locale],
    )
  )[0]!;
  await logEvent(c, orgId, 'admin.client.update', { fields: Object.keys(patch) }, orgId);
  return row;
}

async function setClientStatus(c: Tx, orgId: string, to: 'active' | 'closed', reason: string): Promise<OrgRow> {
  const cur = await requireOrg(c, orgId);
  if (cur.status === to) throw conflict(to === 'closed' ? 'already_suspended' : 'already_active');
  const row = (
    await q<OrgRow>(c, `update core.organizations set status = $2 where id = $1 returning id, name, slug, kind, legal_name, time_zone, default_locale, status, created_at, updated_at`, [orgId, to])
  )[0]!;
  await logEvent(c, orgId, to === 'closed' ? 'admin.client.suspend' : 'admin.client.reactivate', { reason }, orgId);
  return row;
}
export const suspendClient = (c: Tx, orgId: string, reason: string) => setClientStatus(c, orgId, 'closed', reason);
export const reactivateClient = (c: Tx, orgId: string, reason: string) => setClientStatus(c, orgId, 'active', reason);

export async function saveBranch(c: Tx, orgId: string, branchId: string | null, input: { name: string; code: string; city?: string | null; state_code?: string | null; time_zone?: string | null; active: boolean }) {
  const id = (await c.query(`select app.admin_save_branch($1, $2, $3, $4, $5, $6, $7, $8) as id`, [orgId, branchId, input.name, input.code, input.city ?? null, input.state_code ?? null, input.time_zone ?? null, input.active])).rows[0].id as string;
  await logEvent(c, orgId, branchId ? 'admin.branch.update' : 'admin.branch.create', { name: input.name, code: input.code, active: input.active }, id);
  return (await q(c, `select id, org_id, name, code, city, state_code, time_zone, active, created_at from app.admin_list_branches($1) where id = $2`, [orgId, id]))[0];
}

/** Dashboard numbers for the home page. */
export async function overview(c: Tx, deps: AdminDeps) {
  const clients = await listClients(c, deps);
  const byHealth = { ok: 0, attention: 0, critical: 0 };
  const byProduct: Record<string, Record<string, number>> = {};
  for (const x of clients) {
    byHealth[x.health.level] += 1;
    for (const p of x.products) {
      const m = (byProduct[p.product_key] ??= {});
      m[p.status] = (m[p.status] ?? 0) + 1;
    }
  }
  const openSessions = Number((await c.query(`select count(*)::int as n from core.support_sessions where ended_at is null and expires_at > now()`)).rows[0].n);
  return { clients: clients.length, suspended: clients.filter((x) => x.client_status === 'suspended').length, by_health: byHealth, by_product: byProduct, open_support_sessions: openSessions };
}
