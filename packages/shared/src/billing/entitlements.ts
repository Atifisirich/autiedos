/**
 * Entitlement rules: given a client's subscriptions and "now", which products may they use and
 * is the access read-only? Pure; the database layer (core.subscriptions) feeds it rows later.
 *
 * Access levels per product:
 *  - full:      trial running, active, or past_due still inside the grace period
 *  - read_only: suspended or cancelled, within `readOnlyDays` (decision #42: 30) of the
 *               suspension/cancellation date. Data can be viewed and exported, not changed.
 *  - none:      no subscription, or the read-only window is over (export + delete is due).
 */
import { PRODUCT_KEYS, type ProductKey } from './plans';
import { DEFAULT_BILLING_POLICY, effectiveState, type BillingPolicy, type SubscriptionState } from './subscription';

export type AccessLevel = 'full' | 'read_only' | 'none';

export type AccessReason = 'trial' | 'active' | 'past_due_grace' | 'suspended_read_only' | 'cancelled_read_only' | 'expired_purge_due' | 'no_subscription';

export interface ProductEntitlement {
  productKey: ProductKey;
  access: AccessLevel;
  reason: AccessReason;
  /** Status after applying time rules at `now`. */
  status: SubscriptionState['status'] | 'none';
  /** When full access ends if payment does not arrive (past_due grace end, or trial end). */
  fullAccessEndsAt: Date | null;
  /** When read-only access ends and export/delete becomes due. */
  readOnlyUntil: Date | null;
}

export interface EntitlementSubscription {
  productKey: ProductKey;
  state: SubscriptionState;
}

export interface EntitlementResult {
  products: Record<ProductKey, ProductEntitlement>;
  /** Products usable at all (full or read-only). */
  accessible: ProductKey[];
  fullAccess: ProductKey[];
  readOnly: ProductKey[];
  /** Products whose read-only window is over: the export and delete job should run. */
  purgeDue: ProductKey[];
}

const DAY_MS = 86400000;
const RANK: Record<AccessLevel, number> = { none: 0, read_only: 1, full: 2 };

export function entitlementForSubscription(sub: EntitlementSubscription, now: Date, policy: BillingPolicy = DEFAULT_BILLING_POLICY): ProductEntitlement {
  const s = effectiveState(sub.state, now, policy);
  const base = { productKey: sub.productKey, status: s.status, fullAccessEndsAt: null as Date | null, readOnlyUntil: null as Date | null };
  switch (s.status) {
    case 'trial':
      return { ...base, access: 'full', reason: 'trial', fullAccessEndsAt: s.trialEndsAt };
    case 'active':
      return { ...base, access: 'full', reason: 'active', fullAccessEndsAt: s.cancelAtPeriodEnd ? s.currentPeriodEnd : null };
    case 'past_due':
      return {
        ...base,
        access: 'full',
        reason: 'past_due_grace',
        fullAccessEndsAt: s.pastDueSince ? new Date(s.pastDueSince.getTime() + policy.pastDueGraceDays * DAY_MS) : null,
      };
    case 'suspended':
    case 'cancelled': {
      const since = s.status === 'suspended' ? s.suspendedAt : s.cancelledAt;
      // Missing timestamp should not happen; fail closed rather than grant indefinite read access.
      const readOnlyUntil = since ? new Date(since.getTime() + policy.readOnlyDays * DAY_MS) : null;
      if (readOnlyUntil && now < readOnlyUntil) {
        return { ...base, access: 'read_only', reason: s.status === 'suspended' ? 'suspended_read_only' : 'cancelled_read_only', readOnlyUntil };
      }
      return { ...base, access: 'none', reason: 'expired_purge_due', readOnlyUntil };
    }
  }
}

/** Combine all subscriptions for each product (best access wins) and list accessible products. */
export function computeEntitlements(subs: EntitlementSubscription[], now: Date, policy: BillingPolicy = DEFAULT_BILLING_POLICY): EntitlementResult {
  const products = {} as Record<ProductKey, ProductEntitlement>;
  for (const key of PRODUCT_KEYS) {
    products[key] = { productKey: key, access: 'none', reason: 'no_subscription', status: 'none', fullAccessEndsAt: null, readOnlyUntil: null };
  }
  for (const sub of subs) {
    const e = entitlementForSubscription(sub, now, policy);
    const cur = products[sub.productKey];
    const better =
      RANK[e.access] > RANK[cur.access] ||
      (RANK[e.access] === RANK[cur.access] && cur.reason === 'no_subscription') ||
      (RANK[e.access] === RANK[cur.access] && (e.readOnlyUntil?.getTime() ?? 0) > (cur.readOnlyUntil?.getTime() ?? 0));
    if (better) products[sub.productKey] = e;
  }
  const list = (f: (e: ProductEntitlement) => boolean) => PRODUCT_KEYS.filter((k) => f(products[k]));
  return {
    products,
    accessible: list((e) => e.access !== 'none'),
    fullAccess: list((e) => e.access === 'full'),
    readOnly: list((e) => e.access === 'read_only'),
    purgeDue: list((e) => e.reason === 'expired_purge_due'),
  };
}

/** Convenience guard for request handlers: may this product be used for the given kind of call? */
export function canUseProduct(result: EntitlementResult, product: ProductKey, kind: 'read' | 'write'): boolean {
  const a = result.products[product].access;
  return kind === 'read' ? a !== 'none' : a === 'full';
}
