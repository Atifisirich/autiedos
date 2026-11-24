import { describe, expect, it } from 'vitest';
import {
  applyEvent,
  canUseProduct,
  computeEntitlements,
  DEFAULT_BILLING_POLICY,
  effectiveState,
  newTrialState,
  subscriptionStateSchema,
  type SubscriptionEvent,
  type SubscriptionState,
} from '../src';

const D = (s: string) => new Date(`${s}T00:00:00Z`);
const day = (base: string, n: number) => new Date(D(base).getTime() + n * 86400000);
const run = (s: SubscriptionState, ...events: SubscriptionEvent[]) => events.reduce((st, e) => applyEvent(st, e).state, s);

const active = (periodEnd = '2026-12-01'): SubscriptionState =>
  run(newTrialState(D('2026-11-10'), D('2026-10-27')), { type: 'payment_succeeded', at: D('2026-11-10'), currentPeriodEnd: D(periodEnd) });

describe('state machine', () => {
  it('trial -> active on first payment, extends the period on later payments', () => {
    const t = newTrialState(D('2026-11-10'), D('2026-10-27'));
    expect(t.status).toBe('trial');
    const a = applyEvent(t, { type: 'payment_succeeded', at: D('2026-11-10'), currentPeriodEnd: D('2026-12-01') });
    expect(a.changed).toBe(true);
    expect(a.state.status).toBe('active');
    const b = applyEvent(a.state, { type: 'payment_succeeded', at: D('2026-12-01'), currentPeriodEnd: D('2027-01-01') });
    expect(b.state.currentPeriodEnd).toEqual(D('2027-01-01'));
  });

  it('active -> past_due on failure, back to active on payment', () => {
    const pd = applyEvent(active(), { type: 'payment_failed', at: D('2026-12-01') });
    expect(pd.state).toMatchObject({ status: 'past_due', pastDueSince: D('2026-12-01') });
    const second = applyEvent(pd.state, { type: 'payment_failed', at: D('2026-12-03') });
    expect(second.state.pastDueSince).toEqual(D('2026-12-01')); // first failure date is kept
    expect(second.changed).toBe(false);
    const ok = applyEvent(second.state, { type: 'payment_succeeded', at: D('2026-12-04'), currentPeriodEnd: D('2027-01-01') });
    expect(ok.state).toMatchObject({ status: 'active', pastDueSince: null });
  });

  it('past_due grace: still past_due on day 6, suspended exactly at day 7', () => {
    const pd = applyEvent(active(), { type: 'payment_failed', at: D('2026-12-01') }).state;
    expect(effectiveState(pd, day('2026-12-01', 6)).status).toBe('past_due');
    const s = effectiveState(pd, day('2026-12-01', 7));
    expect(s).toMatchObject({ status: 'suspended', suspendedAt: day('2026-12-01', 7) });
    // tick persists the same result and stamps suspendedAt at the grace end, not at tick time
    const t = applyEvent(pd, { type: 'tick', at: day('2026-12-01', 20) });
    expect(t.changed).toBe(true);
    expect(t.state.suspendedAt).toEqual(day('2026-12-01', 7));
  });

  it('a payment after the grace period reactivates a suspended subscription', () => {
    const pd = applyEvent(active(), { type: 'payment_failed', at: D('2026-12-01') }).state;
    const r = applyEvent(pd, { type: 'payment_succeeded', at: day('2026-12-01', 12), currentPeriodEnd: D('2027-02-01') });
    expect(r.state).toMatchObject({ status: 'active', suspendedAt: null, pastDueSince: null });
  });

  it('trial ends without payment -> suspended at trial end', () => {
    const t = newTrialState(D('2026-11-10'), D('2026-10-27'));
    expect(effectiveState(t, D('2026-11-09')).status).toBe('trial');
    expect(effectiveState(t, D('2026-11-10'))).toMatchObject({ status: 'suspended', suspendedAt: D('2026-11-10') });
  });

  it('halted suspends from active or past_due; a failure during trial does not', () => {
    expect(applyEvent(active(), { type: 'halted', at: D('2026-12-05') }).state).toMatchObject({ status: 'suspended', suspendedAt: D('2026-12-05') });
    const t = newTrialState(D('2026-11-10'), D('2026-10-27'));
    expect(applyEvent(t, { type: 'payment_failed', at: D('2026-10-28') }).state.status).toBe('trial');
  });

  it('cancel at period end keeps access until the period ends, then cancels', () => {
    const c = applyEvent(active('2026-12-01'), { type: 'cancel_requested', at: D('2026-11-15'), atPeriodEnd: true }).state;
    expect(c).toMatchObject({ status: 'active', cancelAtPeriodEnd: true });
    expect(effectiveState(c, D('2026-11-30')).status).toBe('active');
    expect(effectiveState(c, D('2026-12-01'))).toMatchObject({ status: 'cancelled', cancelledAt: D('2026-12-01') });
  });

  it('immediate cancel is terminal and ignores everything after', () => {
    const c = applyEvent(active(), { type: 'cancel_requested', at: D('2026-11-15'), atPeriodEnd: false }).state;
    expect(c).toMatchObject({ status: 'cancelled', cancelledAt: D('2026-11-15') });
    const after = applyEvent(c, { type: 'payment_succeeded', at: D('2026-11-20'), currentPeriodEnd: D('2027-01-01') });
    expect(after).toMatchObject({ changed: false, ignored: 'terminal' });
    expect(after.state.status).toBe('cancelled');
  });

  it('ignores out-of-order (stale) events and replays', () => {
    const pd = applyEvent(active(), { type: 'payment_failed', at: D('2026-12-05') });
    const stale = applyEvent(pd.state, { type: 'payment_succeeded', at: D('2026-12-01'), currentPeriodEnd: D('2027-01-01') });
    expect(stale).toMatchObject({ changed: false, ignored: 'stale' });
    expect(stale.state.status).toBe('past_due');
    const replay = applyEvent(pd.state, { type: 'payment_failed', at: D('2026-12-05') });
    expect(replay.changed).toBe(false);
  });

  it('does not mutate its input', () => {
    const s = active();
    const copy = JSON.stringify(s);
    applyEvent(s, { type: 'halted', at: D('2026-12-05') });
    expect(JSON.stringify(s)).toBe(copy);
  });

  it('subscriptionStateSchema round-trips JSON', () => {
    const s = active();
    expect(subscriptionStateSchema.parse(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });
});

describe('entitlements', () => {
  const policy = DEFAULT_BILLING_POLICY;

  it('no subscriptions -> nothing accessible', () => {
    const r = computeEntitlements([], D('2026-12-01'));
    expect(r.accessible).toEqual([]);
    expect(r.products.crm.reason).toBe('no_subscription');
  });

  it('trial and active give full access; mixed products', () => {
    const r = computeEntitlements(
      [
        { productKey: 'os', state: active() },
        { productKey: 'crm', state: newTrialState(D('2026-12-10'), D('2026-11-26')) },
      ],
      D('2026-11-28'),
    );
    expect(r.fullAccess).toEqual(['crm', 'os']);
    expect(r.products.crm.reason).toBe('trial');
    expect(r.products.erp.access).toBe('none');
    expect(canUseProduct(r, 'os', 'write')).toBe(true);
    expect(canUseProduct(r, 'erp', 'read')).toBe(false);
  });

  it('past_due keeps full access during the grace period, then read-only for 30 days, then none', () => {
    const pd = applyEvent(active(), { type: 'payment_failed', at: D('2026-12-01') }).state;
    const at = (n: number) => computeEntitlements([{ productKey: 'os', state: pd }], day('2026-12-01', n)).products.os;
    expect(at(3)).toMatchObject({ access: 'full', reason: 'past_due_grace', fullAccessEndsAt: day('2026-12-01', policy.pastDueGraceDays) });
    expect(at(6).access).toBe('full');
    // suspended on day 7 -> read-only through day 7+30
    expect(at(7)).toMatchObject({ access: 'read_only', reason: 'suspended_read_only', readOnlyUntil: day('2026-12-01', 37) });
    expect(at(36).access).toBe('read_only');
    expect(at(37)).toMatchObject({ access: 'none', reason: 'expired_purge_due' });
    const r = computeEntitlements([{ productKey: 'os', state: pd }], day('2026-12-01', 40));
    expect(r.purgeDue).toEqual(['os']);
    expect(r.accessible).toEqual([]);
  });

  it('read-only allows reads and blocks writes', () => {
    const s = applyEvent(active(), { type: 'halted', at: D('2026-12-05') }).state;
    const r = computeEntitlements([{ productKey: 'os', state: s }], D('2026-12-20'));
    expect(r.readOnly).toEqual(['os']);
    expect(canUseProduct(r, 'os', 'read')).toBe(true);
    expect(canUseProduct(r, 'os', 'write')).toBe(false);
  });

  it('exactly 30 days read-only after a halt (decision #42)', () => {
    const s = applyEvent(active(), { type: 'halted', at: D('2026-12-05') }).state;
    const at = (n: number) => computeEntitlements([{ productKey: 'os', state: s }], day('2026-12-05', n)).products.os.access;
    expect([at(0), at(29), at(30), at(31)]).toEqual(['read_only', 'read_only', 'none', 'none']);
  });

  it('cancelled products are read-only for the export window, then purge-due', () => {
    const c = applyEvent(active(), { type: 'cancelled', at: D('2026-12-05') }).state;
    expect(computeEntitlements([{ productKey: 'os', state: c }], D('2026-12-10')).products.os).toMatchObject({ access: 'read_only', reason: 'cancelled_read_only' });
    expect(computeEntitlements([{ productKey: 'os', state: c }], D('2027-01-05')).products.os.reason).toBe('expired_purge_due');
  });

  it('unpaid trial that expires is read-only for 30 days', () => {
    const t = newTrialState(D('2026-11-10'), D('2026-10-27'));
    expect(computeEntitlements([{ productKey: 'crm', state: t }], D('2026-11-20')).products.crm).toMatchObject({ access: 'read_only' });
  });

  it('best subscription per product wins and reactivation restores full access', () => {
    const suspended = applyEvent(active(), { type: 'halted', at: D('2026-12-05') }).state;
    const both = computeEntitlements([{ productKey: 'os', state: suspended }, { productKey: 'os', state: active('2027-01-01') }], D('2026-12-10'));
    expect(both.products.os.access).toBe('full');
    const back = applyEvent(suspended, { type: 'payment_succeeded', at: D('2026-12-12'), currentPeriodEnd: D('2027-01-12') }).state;
    expect(computeEntitlements([{ productKey: 'os', state: back }], D('2026-12-13')).products.os.access).toBe('full');
  });

  it('honours a custom policy', () => {
    const pd = applyEvent(active(), { type: 'payment_failed', at: D('2026-12-01') }).state;
    const p = { pastDueGraceDays: 2, readOnlyDays: 10 };
    expect(computeEntitlements([{ productKey: 'os', state: pd }], day('2026-12-01', 3), p).products.os.access).toBe('read_only');
    expect(computeEntitlements([{ productKey: 'os', state: pd }], day('2026-12-01', 12), p).products.os.access).toBe('none');
  });
});
