/**
 * Subscriptions per client and product (CRM / OS / ERP), and the state machine from @autoed/shared.
 *
 * core.subscriptions stores status, plan, dates and seats only, not the full SubscriptionState of the pure
 * state machine, so the state is rebuilt from the row:
 *   trial      trialEndsAt = end of ends_on (IST)
 *   active     currentPeriodEnd = end of ends_on (null = open-ended)
 *   past_due   pastDueSince = when the row last became past_due (audit.config_history)
 *   suspended / cancelled   stamped by ends_on, which a transition sets to the last day of access
 * Not modelled by the table (so not offered): cancel at period end. Documented in docs/adr/admin-console.md.
 */
import { addDays, applyEvent, computeEntitlements, newTrialState, DEFAULT_BILLING_POLICY, type EntitlementResult, type ProductKey, type SubscriptionEvent, type SubscriptionState } from '@autoed/shared';
import { maybe, q, type Tx } from './db';
import { conflict, invalid, notFound } from './errors';
import { endOfDateIST, istToday, lastAccessDate, logEvent, requireOrg } from './util';
import type { AdminDeps } from './deps';

export interface SubscriptionRow {
  id: string;
  org_id: string;
  product_key: ProductKey;
  status: SubscriptionState['status'];
  plan_key: string | null;
  starts_on: string;
  ends_on: string | null;
  seats: number | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

const COLS = 'id, org_id, product_key, status, plan_key, starts_on, ends_on, seats, notes, created_at, updated_at';

export async function listSubscriptions(c: Tx, orgId: string): Promise<SubscriptionRow[]> {
  return q<SubscriptionRow>(c, `select ${COLS} from core.subscriptions where org_id = $1 order by product_key`, [orgId]);
}

export async function getSubscription(c: Tx, orgId: string, product: string): Promise<SubscriptionRow> {
  const r = await maybe<SubscriptionRow>(c, `select ${COLS} from core.subscriptions where org_id = $1 and product_key = $2`, [orgId, product]);
  if (!r) throw notFound('subscription_not_found');
  return r;
}

async function pastDueSince(c: Tx, row: SubscriptionRow): Promise<Date | null> {
  const h = await maybe<{ created_at: Date }>(
    c,
    `select created_at from audit.config_history
      where schema_name = 'core' and table_name = 'subscriptions' and row_id = $1 and after->>'status' = 'past_due'
        and (before is null or before->>'status' is distinct from 'past_due') order by id desc limit 1`,
    [row.id],
  );
  return h ? new Date(h.created_at) : new Date(row.updated_at);
}

export async function stateOf(c: Tx, row: SubscriptionRow): Promise<SubscriptionState> {
  const end = row.ends_on ? endOfDateIST(row.ends_on) : null;
  return {
    status: row.status,
    trialEndsAt: row.status === 'trial' ? end : null,
    currentPeriodEnd: row.status === 'active' || row.status === 'past_due' ? end : null,
    pastDueSince: row.status === 'past_due' ? await pastDueSince(c, row) : null,
    suspendedAt: row.status === 'suspended' ? (end ?? new Date(row.updated_at)) : null,
    cancelledAt: row.status === 'cancelled' ? (end ?? new Date(row.updated_at)) : null,
    cancelAtPeriodEnd: false,
    lastEventAt: null,
  };
}

/** Access per product by the billing rules (full / read-only for 30 days / none), on top of the database gate. */
export async function entitlementsOf(c: Tx, rows: SubscriptionRow[], now: Date): Promise<EntitlementResult> {
  const subs = [];
  for (const r of rows) subs.push({ productKey: r.product_key, state: await stateOf(c, r) });
  return computeEntitlements(subs, now, DEFAULT_BILLING_POLICY);
}

async function checkPlan(c: Tx, product: string, planKey: string | null | undefined): Promise<void> {
  if (!planKey) return;
  const p = await maybe<{ product_key: string; active: boolean }>(c, `select product_key, active from billing.plans where key = $1`, [planKey]);
  if (!p) throw invalid('plan_not_found');
  if (p.product_key !== product) throw invalid('plan_product_mismatch');
  if (!p.active) throw invalid('plan_inactive');
}

export interface NewSubscription {
  product_key: ProductKey;
  plan_key?: string | null;
  status: 'trial' | 'active';
  trial_days?: number;
  seats?: number | null;
  starts_on?: string;
  ends_on?: string | null;
}

/** Adds one product to a client: the row, the product's built-in client admin role, and an audit event. */
export async function addSubscription(c: Tx, deps: AdminDeps, orgId: string, input: NewSubscription): Promise<SubscriptionRow> {
  await requireOrg(c, orgId);
  await checkPlan(c, input.product_key, input.plan_key);
  const today = istToday(deps.now());
  const startsOn = input.starts_on ?? today;
  const trialDays = input.trial_days ?? deps.config.defaultTrialDays;
  const endsOn = input.status === 'trial' ? addDays(startsOn > today ? startsOn : today, trialDays) : (input.ends_on ?? null);
  if (endsOn && endsOn < startsOn) throw invalid('ends_before_start');
  const row = (
    await q<SubscriptionRow>(
      c,
      `insert into core.subscriptions (org_id, product_key, status, plan_key, starts_on, ends_on, seats) values ($1, $2, $3, $4, $5, $6, $7) returning ${COLS}`,
      [orgId, input.product_key, input.status, input.plan_key ?? null, startsOn, endsOn, input.seats ?? null],
    )
  )[0]!;
  await c.query(`select app.admin_ensure_admin_role($1, $2)`, [orgId, input.product_key]);
  await logEvent(c, orgId, 'admin.subscription.create', { product: input.product_key, status: input.status, plan_key: input.plan_key ?? null, ends_on: endsOn }, row.id);
  return row;
}

export async function patchSubscription(c: Tx, orgId: string, product: string, patch: { plan_key?: string | null; seats?: number | null; ends_on?: string | null; notes?: string | null }): Promise<SubscriptionRow> {
  const cur = await getSubscription(c, orgId, product);
  if (patch.plan_key !== undefined) await checkPlan(c, product, patch.plan_key);
  const next = {
    plan_key: patch.plan_key !== undefined ? patch.plan_key : cur.plan_key,
    seats: patch.seats !== undefined ? patch.seats : cur.seats,
    ends_on: patch.ends_on !== undefined ? patch.ends_on : cur.ends_on,
    notes: patch.notes !== undefined ? patch.notes : cur.notes,
  };
  if (next.ends_on && next.ends_on < cur.starts_on) throw invalid('ends_before_start');
  const row = (await q<SubscriptionRow>(c, `update core.subscriptions set plan_key = $3, seats = $4, ends_on = $5, notes = $6 where org_id = $1 and product_key = $2 returning ${COLS}`, [orgId, product, next.plan_key, next.seats, next.ends_on, next.notes]))[0]!;
  await logEvent(c, orgId, 'admin.subscription.update', { product, before: { plan_key: cur.plan_key, seats: cur.seats, ends_on: cur.ends_on }, after: { plan_key: next.plan_key, seats: next.seats, ends_on: next.ends_on } }, row.id);
  return row;
}

export type TransitionName = 'activate' | 'mark_past_due' | 'suspend' | 'cancel' | 'tick';

function toEvent(name: TransitionName, at: Date, periodEnd?: string): SubscriptionEvent {
  switch (name) {
    case 'activate':
      return { type: 'payment_succeeded', at, currentPeriodEnd: periodEnd ? endOfDateIST(addDays(periodEnd, -1)) : null };
    case 'mark_past_due':
      return { type: 'payment_failed', at };
    case 'suspend':
      return { type: 'halted', at };
    case 'cancel':
      return { type: 'cancelled', at };
    case 'tick':
      return { type: 'tick', at };
  }
}

/** Writes a new state back to the row (see the mapping in the file header). */
async function persist(c: Tx, row: SubscriptionRow, next: SubscriptionState, periodEnd: string | undefined, activate: boolean): Promise<SubscriptionRow> {
  let endsOn = row.ends_on;
  if (activate && next.status === 'active') endsOn = periodEnd ? addDays(periodEnd, -1) : null;
  else if (next.status !== row.status && (next.status === 'suspended' || next.status === 'cancelled')) {
    const stamp = next.status === 'suspended' ? next.suspendedAt : next.cancelledAt;
    const d = stamp ? lastAccessDate(stamp) : row.ends_on;
    endsOn = d && d < row.starts_on ? row.starts_on : d;
  }
  return (await q<SubscriptionRow>(c, `update core.subscriptions set status = $2, ends_on = $3 where id = $1 returning ${COLS}`, [row.id, next.status, endsOn]))[0]!;
}

export interface TransitionResult {
  subscription: SubscriptionRow;
  from: string;
  to: string;
}

/** Manual billing event for one product, through the shared state machine. A refused transition is a 409. */
export async function transition(c: Tx, deps: AdminDeps, orgId: string, product: string, input: { event: TransitionName; reason: string; period_end?: string }): Promise<TransitionResult> {
  const row = await getSubscription(c, orgId, product);
  const at = deps.now();
  const res = applyEvent(await stateOf(c, row), toEvent(input.event, at, input.period_end), DEFAULT_BILLING_POLICY);
  if (!res.changed) throw conflict('transition_not_allowed', { from: row.status, event: input.event, ignored: res.ignored ?? 'noop' });
  const saved = await persist(c, row, res.state, input.period_end, input.event === 'activate');
  await logEvent(c, orgId, `admin.subscription.${input.event}`, { product, from: row.status, to: saved.status, reason: input.reason, period_end: input.period_end ?? null }, row.id);
  return { subscription: saved, from: row.status, to: saved.status };
}

/** Applies time rules (trial over, grace over) to every live subscription; what the nightly job will do. */
export async function tickAll(c: Tx, deps: AdminDeps): Promise<{ changed: { org_id: string; product_key: string; from: string; to: string }[] }> {
  const rows = await q<SubscriptionRow>(c, `select ${COLS} from core.subscriptions where status in ('trial','active','past_due')`);
  const changed: { org_id: string; product_key: string; from: string; to: string }[] = [];
  for (const row of rows) {
    const res = applyEvent(await stateOf(c, row), { type: 'tick', at: deps.now() }, DEFAULT_BILLING_POLICY);
    if (!res.changed) continue;
    const saved = await persist(c, row, res.state, undefined, false);
    await logEvent(c, row.org_id, 'admin.subscription.tick', { product: row.product_key, from: row.status, to: saved.status }, row.id);
    changed.push({ org_id: row.org_id, product_key: row.product_key, from: row.status, to: saved.status });
  }
  return { changed };
}

/** A cancelled subscription is terminal in the state machine; this starts the product again as a fresh trial or active period. */
export async function restart(c: Tx, deps: AdminDeps, orgId: string, product: string, input: { reason: string; status: 'trial' | 'active'; trial_days?: number; plan_key?: string | null }): Promise<SubscriptionRow> {
  const row = await getSubscription(c, orgId, product);
  if (row.status !== 'cancelled') throw conflict('restart_needs_cancelled', { status: row.status });
  if (input.plan_key !== undefined) await checkPlan(c, product, input.plan_key);
  const now = deps.now();
  const today = istToday(now);
  const days = input.trial_days ?? deps.config.defaultTrialDays;
  const fresh = newTrialState(input.status === 'trial' ? new Date(now.getTime() + days * 86400000) : null, now);
  const endsOn = fresh.status === 'trial' ? addDays(today, days) : null;
  const saved = (
    await q<SubscriptionRow>(c, `update core.subscriptions set status = $2, starts_on = $3, ends_on = $4, plan_key = coalesce($5, plan_key) where id = $1 returning ${COLS}`, [row.id, fresh.status, today, endsOn, input.plan_key ?? null])
  )[0]!;
  await logEvent(c, orgId, 'admin.subscription.restart', { product, to: saved.status, reason: input.reason }, row.id);
  return saved;
}

/** Per-branch product switch (decision 34): a row with enabled = false turns the product off for that branch. */
export async function setBranchProduct(c: Tx, orgId: string, input: { branch_id: string; product_key: string; enabled: boolean }): Promise<{ branch_id: string; product_key: string; enabled: boolean }> {
  const b = await maybe(c, `select 1 from app.admin_list_branches($1) where id = $2`, [orgId, input.branch_id]);
  if (!b) throw notFound('branch_not_found');
  await getSubscription(c, orgId, input.product_key);
  await c.query(
    `insert into core.org_branch_products (org_id, branch_id, product_key, enabled) values ($1, $2, $3, $4)
     on conflict (branch_id, product_key) do update set enabled = excluded.enabled`,
    [orgId, input.branch_id, input.product_key, input.enabled],
  );
  await logEvent(c, orgId, 'admin.branch_product.set', { branch_id: input.branch_id, product: input.product_key, enabled: input.enabled }, input.branch_id);
  return input;
}

export async function listBranchProducts(c: Tx, orgId: string): Promise<{ branch_id: string; product_key: string; enabled: boolean }[]> {
  return q(c, `select branch_id, product_key, enabled from core.org_branch_products where org_id = $1 order by branch_id, product_key`, [orgId]);
}

export type { ProductKey };
