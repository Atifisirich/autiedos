/**
 * Subscription state machine (pure, no I/O, no clock reads: callers pass `at`/`now`).
 *
 *            payment_succeeded            payment_failed            grace over (tick) / halted
 *   trial ---------------------> active ---------------> past_due ---------------------------> suspended
 *     |  trial over, no payment (tick)  \__ payment_succeeded <__/                                  |
 *     +-----------------------------------------------------------------------------------> suspended
 *   payment_succeeded also reactivates a suspended subscription.
 *   cancelled is terminal (immediate cancel, provider cancel/complete, or cancel-at-period-end reached).
 *
 * Product access derived from this state lives in entitlements.ts.
 * Decision #42: 30 days read-only after non-payment, then export and delete.
 */

export const SUBSCRIPTION_STATUSES = ['trial', 'active', 'past_due', 'suspended', 'cancelled'] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export interface BillingPolicy {
  /** Days a failed payment keeps full access before suspension. CONFIRM with owner (not yet decided). */
  pastDueGraceDays: number;
  /** Days of read-only access after suspension or cancellation (decision #42 / #20 = 30). */
  readOnlyDays: number;
}

export const DEFAULT_BILLING_POLICY: BillingPolicy = { pastDueGraceDays: 7, readOnlyDays: 30 };

export interface SubscriptionState {
  status: SubscriptionStatus;
  trialEndsAt: Date | null;
  /** End of the currently paid period (from the provider). */
  currentPeriodEnd: Date | null;
  pastDueSince: Date | null;
  suspendedAt: Date | null;
  cancelledAt: Date | null;
  cancelAtPeriodEnd: boolean;
  /** Time of the latest provider event applied; older events are ignored (out-of-order delivery). */
  lastEventAt: Date | null;
}

export type SubscriptionEvent =
  | { type: 'payment_succeeded'; at: Date; currentPeriodEnd?: Date | null }
  | { type: 'payment_failed'; at: Date }
  /** The provider gave up retrying (Razorpay subscription.halted). */
  | { type: 'halted'; at: Date }
  | { type: 'cancel_requested'; at: Date; atPeriodEnd: boolean }
  /** Provider cancelled/completed the subscription. */
  | { type: 'cancelled'; at: Date }
  /** Time passed with no event: applies trial expiry, grace expiry and cancel-at-period-end. */
  | { type: 'tick'; at: Date };

export type IgnoredReason = 'stale' | 'terminal' | 'noop';

export interface TransitionResult {
  state: SubscriptionState;
  changed: boolean;
  ignored?: IgnoredReason;
}

const DAY_MS = 86400000;
const addDaysMs = (d: Date, n: number): Date => new Date(d.getTime() + n * DAY_MS);

export function newTrialState(trialEndsAt: Date | null, at: Date): SubscriptionState {
  return {
    status: trialEndsAt ? 'trial' : 'active',
    trialEndsAt,
    currentPeriodEnd: null,
    pastDueSince: null,
    suspendedAt: null,
    cancelledAt: null,
    cancelAtPeriodEnd: false,
    lastEventAt: at,
  };
}

function applyTick(s: SubscriptionState, at: Date, policy: BillingPolicy): SubscriptionState {
  let cur = s;
  // Loop because one tick can chain (e.g. past_due -> suspended); each rule moves forward only.
  for (let i = 0; i < 3; i++) {
    let next = cur;
    if (cur.status === 'trial' && cur.trialEndsAt && cur.trialEndsAt <= at) {
      next = { ...cur, status: 'suspended', suspendedAt: cur.trialEndsAt };
    } else if (cur.status === 'past_due' && cur.pastDueSince && addDaysMs(cur.pastDueSince, policy.pastDueGraceDays) <= at) {
      next = { ...cur, status: 'suspended', suspendedAt: addDaysMs(cur.pastDueSince, policy.pastDueGraceDays) };
    } else if ((cur.status === 'active' || cur.status === 'past_due') && cur.cancelAtPeriodEnd && cur.currentPeriodEnd && cur.currentPeriodEnd <= at) {
      next = { ...cur, status: 'cancelled', cancelledAt: cur.currentPeriodEnd };
    }
    if (next === cur) return cur;
    cur = next;
  }
  return cur;
}

/** Apply one event. Pure: returns a new state and whether anything changed. */
export function applyEvent(state: SubscriptionState, event: SubscriptionEvent, policy: BillingPolicy = DEFAULT_BILLING_POLICY): TransitionResult {
  if (event.type === 'tick') {
    const next = applyTick(state, event.at, policy);
    return { state: next, changed: next !== state, ...(next === state ? { ignored: 'noop' as const } : {}) };
  }
  if (state.status === 'cancelled') return { state, changed: false, ignored: 'terminal' };
  if (state.lastEventAt && event.at < state.lastEventAt) return { state, changed: false, ignored: 'stale' };

  // Time rules due before this event apply first, so e.g. a payment arriving after the grace
  // period still sees a suspended subscription being reactivated rather than a past_due one.
  const base = applyTick(state, event.at, policy);
  if (base.status === 'cancelled') return { state: { ...base, lastEventAt: event.at }, changed: true };

  let next: SubscriptionState = base;
  switch (event.type) {
    case 'payment_succeeded':
      next = {
        ...base,
        status: 'active',
        pastDueSince: null,
        suspendedAt: null,
        currentPeriodEnd: event.currentPeriodEnd ?? base.currentPeriodEnd,
      };
      break;
    case 'payment_failed':
      // A failed charge only matters once the client is a paying customer.
      if (base.status === 'active') next = { ...base, status: 'past_due', pastDueSince: event.at };
      break;
    case 'halted':
      if (base.status === 'trial' || base.status === 'active' || base.status === 'past_due') {
        next = { ...base, status: 'suspended', suspendedAt: event.at };
      }
      break;
    case 'cancel_requested':
      if (event.atPeriodEnd && base.currentPeriodEnd && base.status !== 'suspended') {
        next = { ...base, cancelAtPeriodEnd: true };
      } else {
        next = { ...base, status: 'cancelled', cancelledAt: event.at, cancelAtPeriodEnd: false };
      }
      break;
    case 'cancelled':
      next = { ...base, status: 'cancelled', cancelledAt: event.at, cancelAtPeriodEnd: false };
      break;
  }
  const final: SubscriptionState = { ...next, lastEventAt: event.at };
  const changed = fingerprint(final) !== fingerprint(state);
  return { state: final, changed, ...(changed ? {} : { ignored: 'noop' as const }) };
}

/** Everything except lastEventAt, which advances on every non-stale event. */
function fingerprint(s: SubscriptionState): string {
  return JSON.stringify({ ...s, lastEventAt: null });
}

/** Status after applying time rules at `now` (what to trust when a tick job has not run yet). */
export function effectiveState(state: SubscriptionState, now: Date, policy: BillingPolicy = DEFAULT_BILLING_POLICY): SubscriptionState {
  return applyTick(state, now, policy);
}
