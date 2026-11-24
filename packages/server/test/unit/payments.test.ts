import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newTrialState } from '@autoed/shared';
import {
  PaymentsConfigError,
  RazorpayApiError,
  createMemorySubscriptionRepo,
  createMemoryWebhookStore,
  createMockPayments,
  createRazorpayAdapter,
  getPayments,
  handleRazorpayWebhook,
  loadRazorpayConfig,
  signWebhookBody,
  verifyWebhookSignature,
  webhookHttpStatus,
  type BillingSubscriptionRecord,
  type RazorpayConfig,
} from '../../src/adapters/payments';

const cfg: RazorpayConfig = { keyId: 'rzp_test_abc123', keySecret: 'sekret', webhookSecret: 'whsec_test', mode: 'test' };
const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// No test may touch the network.
beforeEach(() => {
  vi.stubGlobal('fetch', () => {
    throw new Error('real network call attempted in a unit test');
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('loadRazorpayConfig', () => {
  const base = { RAZORPAY_KEY_ID: 'rzp_test_abc', RAZORPAY_KEY_SECRET: 's', RAZORPAY_WEBHOOK_SECRET: 'w' };
  it('defaults to test mode and accepts matching keys', () => {
    expect(loadRazorpayConfig(base)).toMatchObject({ mode: 'test', keyId: 'rzp_test_abc' });
    expect(loadRazorpayConfig({ ...base, RAZORPAY_KEY_ID: 'rzp_live_abc', RAZORPAY_MODE: 'live' }).mode).toBe('live');
  });
  it('refuses live mode with a test key and test mode with a live key', () => {
    expect(() => loadRazorpayConfig({ ...base, RAZORPAY_MODE: 'live' })).toThrow(PaymentsConfigError);
    expect(() => loadRazorpayConfig({ ...base, RAZORPAY_KEY_ID: 'rzp_live_abc' })).toThrow(/mixed up/);
    expect(() => loadRazorpayConfig({ ...base, RAZORPAY_KEY_ID: 'rzp_live_abc', RAZORPAY_MODE: 'test' })).toThrow(/mixed up/);
  });
  it('refuses unknown prefixes, bad mode and missing values, without echoing secrets', () => {
    expect(() => loadRazorpayConfig({ ...base, RAZORPAY_KEY_ID: 'key_123' })).toThrow(/rzp_test_ or rzp_live_/);
    expect(() => loadRazorpayConfig({ ...base, RAZORPAY_MODE: 'prod' })).toThrow(/RAZORPAY_MODE/);
    expect(() => loadRazorpayConfig({})).toThrow(/required/);
    expect(() => loadRazorpayConfig({ ...base, RAZORPAY_WEBHOOK_SECRET: '' })).toThrow(/WEBHOOK_SECRET/);
    try {
      loadRazorpayConfig({ ...base, RAZORPAY_KEY_SECRET: 'topsecret', RAZORPAY_MODE: 'live' });
    } catch (e) {
      expect(String(e)).not.toContain('topsecret');
    }
  });
  it('getPayments returns the mock by default and validates keys for razorpay', () => {
    expect(getPayments({}).name).toBe('mock');
    expect(getPayments({ ...base, PAYMENTS_PROVIDER: 'razorpay' }).name).toBe('razorpay');
    expect(() => getPayments({ PAYMENTS_PROVIDER: 'razorpay', RAZORPAY_KEY_ID: 'rzp_live_x', RAZORPAY_KEY_SECRET: 's', RAZORPAY_WEBHOOK_SECRET: 'w' })).toThrow(/mixed up/);
  });
});

describe('webhook signature', () => {
  const body = '{"event":"subscription.charged"}';
  const sig = signWebhookBody(body, 'whsec_test');
  it('accepts the correct signature for the exact raw body', () => {
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyWebhookSignature(body, sig, 'whsec_test')).toBe(true);
    expect(verifyWebhookSignature(Buffer.from(body), sig.toUpperCase(), 'whsec_test')).toBe(true);
  });
  it('rejects wrong secret, tampered or re-serialised body, and malformed signatures', () => {
    expect(verifyWebhookSignature(body, sig, 'other')).toBe(false);
    expect(verifyWebhookSignature(body + ' ', sig, 'whsec_test')).toBe(false);
    expect(verifyWebhookSignature(JSON.stringify(JSON.parse(body), null, 2), sig, 'whsec_test')).toBe(false);
    for (const bad of [undefined, null, '', 'abc', 'z'.repeat(64), sig.slice(1), sig + '00']) {
      expect(verifyWebhookSignature(body, bad, 'whsec_test')).toBe(false);
    }
    expect(verifyWebhookSignature(body, sig, '')).toBe(false);
  });
});

describe('Razorpay REST adapter (mocked fetch)', () => {
  function adapterWith(responder: (url: string, init: RequestInit) => Response) {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => responder(url, init ?? {}));
    return { fetchMock, adapter: createRazorpayAdapter(cfg, fetchMock) };
  }
  const lastCall = (m: ReturnType<typeof vi.fn>) => {
    const [url, init] = m.mock.calls.at(-1) as [string, RequestInit];
    return { url, init, body: init.body ? JSON.parse(String(init.body)) : undefined, headers: init.headers as Record<string, string> };
  };

  it('sends basic auth and creates a customer', async () => {
    const { adapter, fetchMock } = adapterWith(() => ok({ id: 'cust_1' }));
    await expect(adapter.createCustomer({ name: 'Sunrise School', email: 'a@b.in', gstin: '27AAPFU0939F1ZV' })).resolves.toEqual({ id: 'cust_1' });
    const c = lastCall(fetchMock);
    expect(c.url).toBe('https://api.razorpay.com/v1/customers');
    expect(c.init.method).toBe('POST');
    expect(c.headers.authorization).toBe(`Basic ${Buffer.from('rzp_test_abc123:sekret').toString('base64')}`);
    expect(c.body).toMatchObject({ name: 'Sunrise School', email: 'a@b.in', gstin: '27AAPFU0939F1ZV' });
    expect(c.init.signal).toBeInstanceOf(AbortSignal);
  });

  it('creates a plan in paise with INR', async () => {
    const { adapter, fetchMock } = adapterWith(() => ok({ id: 'plan_1' }));
    await adapter.createPlan({ period: 'monthly', interval: 1, name: 'AutoEd OS', amountPaise: 118000 });
    expect(lastCall(fetchMock)).toMatchObject({ url: 'https://api.razorpay.com/v1/plans', body: { period: 'monthly', interval: 1, item: { name: 'AutoEd OS', amount: 118000, currency: 'INR' } } });
    await expect(adapter.createPlan({ period: 'monthly', interval: 1, name: 'x', amountPaise: 10.5 })).rejects.toThrow(/paise/);
  });

  it('creates a subscription and normalises the response', async () => {
    const { adapter, fetchMock } = adapterWith(() =>
      ok({ id: 'sub_1', plan_id: 'plan_1', status: 'created', quantity: 2, total_count: 120, paid_count: 0, current_start: null, current_end: 1796083200, charge_at: 1793491200, short_url: 'https://rzp.io/i/x', notes: [] }),
    );
    const s = await adapter.createSubscription({
      planId: 'plan_1',
      totalCount: 120,
      quantity: 2,
      startAt: new Date('2026-12-01T00:00:00Z'),
      customerNotify: true,
      addons: [{ name: 'Pro-rata Nov', amountPaise: 50000 }],
      notes: { autoed_subscription_id: 'sub-uuid' },
    });
    expect(lastCall(fetchMock)).toMatchObject({
      url: 'https://api.razorpay.com/v1/subscriptions',
      body: { plan_id: 'plan_1', total_count: 120, quantity: 2, start_at: 1796083200, customer_notify: true, addons: [{ item: { name: 'Pro-rata Nov', amount: 50000, currency: 'INR' } }], notes: { autoed_subscription_id: 'sub-uuid' } },
    });
    expect(s).toMatchObject({ id: 'sub_1', status: 'created', quantity: 2, shortUrl: 'https://rzp.io/i/x', notes: {} });
    expect(s.currentEnd?.toISOString()).toBe('2026-12-01T00:00:00.000Z');
    await expect(adapter.createSubscription({ planId: 'p', totalCount: 0 })).rejects.toThrow(/totalCount/);
  });

  it('fetches and cancels subscriptions, encoding ids', async () => {
    const { adapter, fetchMock } = adapterWith(() => ok({ id: 'sub_1', plan_id: 'plan_1', status: 'active' }));
    await adapter.fetchSubscription('sub_1');
    expect(lastCall(fetchMock)).toMatchObject({ url: 'https://api.razorpay.com/v1/subscriptions/sub_1' });
    expect(lastCall(fetchMock).init.method).toBe('GET');
    expect(lastCall(fetchMock).init.body).toBeUndefined();
    await adapter.cancelSubscription('sub_1', { atCycleEnd: true });
    expect(lastCall(fetchMock)).toMatchObject({ url: 'https://api.razorpay.com/v1/subscriptions/sub_1/cancel', body: { cancel_at_cycle_end: 1 } });
    await adapter.cancelSubscription('sub_1');
    expect(lastCall(fetchMock).body).toEqual({ cancel_at_cycle_end: 0 });
    await adapter.fetchSubscription('../x');
    expect(lastCall(fetchMock).url).toBe('https://api.razorpay.com/v1/subscriptions/..%2Fx');
  });

  it('creates payment links and fetches payments', async () => {
    const { adapter, fetchMock } = adapterWith((url) =>
      url.endsWith('/payment_links') ? ok({ id: 'plink_1', short_url: 'https://rzp.io/i/abc', status: 'created' }) : ok({ id: 'pay_1', amount: 118000, currency: 'INR', status: 'captured', method: 'upi', invoice_id: 'inv_1', created_at: 1796083200, notes: {} }),
    );
    const link = await adapter.createPaymentLink({ amountPaise: 118000, description: 'Invoice AE/26-27/000001', referenceId: 'AE-26-27-000001', customer: { email: 'a@b.in' }, expireBy: new Date('2026-12-31T00:00:00Z') });
    expect(link).toEqual({ id: 'plink_1', shortUrl: 'https://rzp.io/i/abc', status: 'created' });
    expect(lastCall(fetchMock).body).toMatchObject({ amount: 118000, currency: 'INR', reference_id: 'AE-26-27-000001', accept_partial: false, expire_by: 1798675200, notify: { email: true, sms: false } });
    const p = await adapter.fetchPayment('pay_1');
    expect(p).toMatchObject({ id: 'pay_1', amountPaise: 118000, status: 'captured', method: 'upi', invoiceId: 'inv_1' });
    expect(lastCall(fetchMock).url).toBe('https://api.razorpay.com/v1/payments/pay_1');
  });

  it('maps API errors without leaking credentials', async () => {
    const { adapter } = adapterWith(() => ok({ error: { code: 'BAD_REQUEST_ERROR', description: 'The amount must be atleast INR 1.00', field: 'amount' } }, 400));
    const err = await adapter.createPlan({ period: 'monthly', interval: 1, name: 'x', amountPaise: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(RazorpayApiError);
    expect(err).toMatchObject({ status: 400, code: 'BAD_REQUEST_ERROR', field: 'amount' });
    expect(String(err.message)).not.toContain('sekret');
    const html = createRazorpayAdapter(cfg, async () => new Response('<html>bad gateway</html>', { status: 502 }));
    await expect(html.fetchSubscription('sub_1')).rejects.toMatchObject({ status: 502 });
  });

  it('verifies webhooks with its own webhook secret', () => {
    const a = createRazorpayAdapter(cfg, vi.fn());
    const body = '{"a":1}';
    expect(a.verifyWebhookSignature(body, signWebhookBody(body, cfg.webhookSecret))).toBe(true);
    expect(a.verifyWebhookSignature(body, signWebhookBody(body, 'nope'))).toBe(false);
  });
});

describe('mock adapter', () => {
  it('works offline with deterministic ids and signs/verifies its own webhooks', async () => {
    const m = createMockPayments();
    const c = await m.createCustomer({ name: 'x' });
    const p = await m.createPlan({ period: 'monthly', interval: 1, name: 'x', amountPaise: 100 });
    const s = await m.createSubscription({ planId: p.id, totalCount: 12 });
    expect([c.id, p.id, s.id]).toEqual(['cust_mock0001', 'plan_mock0002', 'sub_mock0003']);
    expect((await m.cancelSubscription(s.id)).status).toBe('cancelled');
    await expect(m.fetchSubscription('nope')).rejects.toBeInstanceOf(RazorpayApiError);
    const w = m.signedWebhook({ event: 'x' });
    expect(m.verifyWebhookSignature(w.rawBody, w.signature)).toBe(true);
    expect(m.verifyWebhookSignature(w.rawBody, 'a'.repeat(64))).toBe(false);
  });
});

// ---------------------------------------------------------------- webhook handler
const T = (s: string) => Math.floor(new Date(s).getTime() / 1000);
const evt = (event: string, at: string, sub: Record<string, unknown> | null, payment?: Record<string, unknown>) => ({
  entity: 'event',
  event,
  created_at: T(at),
  payload: { ...(sub ? { subscription: { entity: { id: 'sub_rz1', plan_id: 'plan_1', ...sub } } } : {}), ...(payment ? { payment: { entity: payment } } : {}) },
});

function setup(initial?: Partial<BillingSubscriptionRecord>) {
  const adapter = createMockPayments({ webhookSecret: 'whsec_test' });
  const store = createMemoryWebhookStore();
  const record: BillingSubscriptionRecord = {
    id: 'sub-uuid-1',
    productKey: 'os',
    providerSubscriptionId: 'sub_rz1',
    state: newTrialState(new Date('2026-12-01T00:00:00Z'), new Date('2026-11-17T00:00:00Z')),
    ...initial,
  };
  const subscriptions = createMemorySubscriptionRepo([record]);
  const payments: unknown[] = [];
  const deps = { adapter, store, subscriptions, recordPayment: async (p: unknown) => void payments.push(p) };
  const send = (e: unknown, eventId?: string) => {
    const w = adapter.signedWebhook(e as Record<string, unknown>, eventId);
    return handleRazorpayWebhook({ rawBody: w.rawBody, signature: w.signature, eventId: w.eventId }, deps);
  };
  const status = () => subscriptions.rows.get('sub-uuid-1')!.state.status;
  return { adapter, store, subscriptions, payments, deps, send, status };
}

describe('handleRazorpayWebhook', () => {
  it('rejects a bad signature without touching state or the idempotency store', async () => {
    const t = setup();
    const w = t.adapter.signedWebhook(evt('subscription.charged', '2026-12-01T00:00:10Z', { current_end: T('2027-01-01T00:00:00Z') }));
    const out = await handleRazorpayWebhook({ rawBody: w.rawBody, signature: 'f'.repeat(64), eventId: 'evt_x' }, t.deps);
    expect(out).toEqual({ status: 'rejected', reason: 'bad_signature' });
    expect(webhookHttpStatus(out)).toBe(401);
    expect(t.status()).toBe('trial');
    expect(t.subscriptions.saves).toHaveLength(0);
    // The same event id is still claimable afterwards: a forged request must not burn it.
    expect(await t.store.claim('evt_x')).toBe(true);
    // Body tampered after signing is also rejected.
    const tampered = await handleRazorpayWebhook({ rawBody: w.rawBody.replace('charged', 'halted'), signature: w.signature, eventId: 'evt_y' }, t.deps);
    expect(tampered).toMatchObject({ status: 'rejected', reason: 'bad_signature' });
  });

  it('rejects a correctly signed but malformed payload', async () => {
    const t = setup();
    const rawBody = 'not json';
    const out = await handleRazorpayWebhook({ rawBody, signature: signWebhookBody(rawBody, 'whsec_test'), eventId: 'e1' }, t.deps);
    expect(out).toEqual({ status: 'rejected', reason: 'bad_payload' });
    expect(webhookHttpStatus(out)).toBe(400);
  });

  it('subscription.activated and charged move trial -> active and extend the period', async () => {
    const t = setup();
    const a = await t.send(evt('subscription.activated', '2026-12-01T00:00:05Z', { status: 'active', current_end: T('2027-01-01T00:00:00Z') }), 'evt_1');
    expect(a).toMatchObject({ status: 'applied', changed: true, newStatus: 'active', subscriptionId: 'sub-uuid-1' });
    await t.send(evt('subscription.charged', '2027-01-01T00:00:05Z', { status: 'active', current_end: T('2027-02-01T00:00:00Z') }), 'evt_2');
    expect(t.subscriptions.rows.get('sub-uuid-1')!.state.currentPeriodEnd?.toISOString()).toBe('2027-02-01T00:00:00.000Z');
  });

  it('replaying the same event id is idempotent (one save, duplicate outcome)', async () => {
    const t = setup();
    const e = evt('subscription.charged', '2026-12-01T00:00:05Z', { current_end: T('2027-01-01T00:00:00Z') });
    const first = await t.send(e, 'evt_replay');
    const second = await t.send(e, 'evt_replay');
    const third = await t.send(e, 'evt_replay');
    expect(first.status).toBe('applied');
    expect(second).toEqual({ status: 'duplicate', eventId: 'evt_replay' });
    expect(third.status).toBe('duplicate');
    expect(t.subscriptions.saves).toHaveLength(1);
    expect(t.status()).toBe('active');
  });

  it('is idempotent even without an event id header (body hash) and across different ids for identical content', async () => {
    const t = setup();
    const e = evt('subscription.charged', '2026-12-01T00:00:05Z', { current_end: T('2027-01-01T00:00:00Z') });
    const w = t.adapter.signedWebhook(e);
    const run = () => handleRazorpayWebhook({ rawBody: w.rawBody, signature: w.signature }, t.deps);
    expect((await run()).status).toBe('applied');
    expect((await run()).status).toBe('duplicate');
    // Same content redelivered under a new id: the state machine still yields no change.
    const again = await t.send(e, 'evt_other_id');
    expect(again).toMatchObject({ status: 'applied', changed: false });
    expect(t.status()).toBe('active');
  });

  it('full failure path: charged -> pending (past_due) -> halted (suspended)', async () => {
    const t = setup();
    await t.send(evt('subscription.charged', '2026-12-01T00:00:05Z', { current_end: T('2027-01-01T00:00:00Z') }), 'e1');
    await t.send(evt('subscription.pending', '2027-01-01T00:00:30Z', { status: 'pending' }), 'e2');
    expect(t.status()).toBe('past_due');
    expect(t.subscriptions.rows.get('sub-uuid-1')!.state.pastDueSince?.toISOString()).toBe('2027-01-01T00:00:30.000Z');
    await t.send(evt('subscription.halted', '2027-01-04T00:00:00Z', { status: 'halted' }), 'e3');
    expect(t.status()).toBe('suspended');
    // Customer pays later: reactivated.
    await t.send(evt('subscription.charged', '2027-01-10T00:00:00Z', { current_end: T('2027-02-10T00:00:00Z') }), 'e4');
    expect(t.status()).toBe('active');
  });

  it('subscription.cancelled and completed cancel; later events are ignored by the machine', async () => {
    const t = setup();
    await t.send(evt('subscription.charged', '2026-12-01T00:00:05Z', { current_end: T('2027-01-01T00:00:00Z') }), 'e1');
    await t.send(evt('subscription.cancelled', '2026-12-10T00:00:00Z', { status: 'cancelled' }), 'e2');
    expect(t.status()).toBe('cancelled');
    const late = await t.send(evt('subscription.charged', '2026-12-11T00:00:00Z', { current_end: T('2027-02-01T00:00:00Z') }), 'e3');
    expect(late).toMatchObject({ status: 'applied', changed: false, ignoredByMachine: 'terminal', newStatus: 'cancelled' });
    const t2 = setup();
    await t2.send(evt('subscription.completed', '2026-12-10T00:00:00Z', { status: 'completed' }), 'c1');
    expect(t2.status()).toBe('cancelled');
  });

  it('ignores out-of-order delivery (older event arriving late)', async () => {
    const t = setup();
    await t.send(evt('subscription.charged', '2026-12-01T00:00:05Z', { current_end: T('2027-01-01T00:00:00Z') }), 'e1');
    await t.send(evt('subscription.halted', '2027-01-04T00:00:00Z', {}), 'e2');
    const stale = await t.send(evt('subscription.pending', '2027-01-02T00:00:00Z', {}), 'e3');
    expect(stale).toMatchObject({ status: 'applied', changed: false, ignoredByMachine: 'stale' });
    expect(t.status()).toBe('suspended');
  });

  it('payment.failed on a subscription payment -> past_due; payment.captured records the payment', async () => {
    const t = setup({ state: { ...newTrialState(null, new Date('2026-12-01T00:00:00Z')), currentPeriodEnd: new Date('2027-01-01T00:00:00Z') } });
    expect(t.status()).toBe('active');
    const pay = { id: 'pay_1', amount: 118000, currency: 'INR', status: 'failed', error_code: 'BAD_REQUEST_ERROR', error_description: 'declined', notes: { autoed_subscription_id: 'sub-uuid-1' } };
    await t.send(evt('payment.failed', '2027-01-01T00:00:10Z', null, pay), 'p1');
    expect(t.status()).toBe('past_due');
    expect(t.payments).toHaveLength(1);
    expect(t.payments[0]).toMatchObject({ eventType: 'payment.failed', subscriptionId: 'sub-uuid-1', payment: { id: 'pay_1', errorCode: 'BAD_REQUEST_ERROR' } });
    await t.send(evt('payment.captured', '2027-01-02T00:00:10Z', { current_end: T('2027-02-01T00:00:00Z') }, { ...pay, status: 'captured' }), 'p2');
    expect(t.status()).toBe('active');
  });

  it('payment events without a subscription (e.g. a payment link) are recorded but change nothing', async () => {
    const t = setup();
    const out = await t.send(evt('payment.captured', '2026-12-01T00:00:00Z', null, { id: 'pay_9', amount: 5000, currency: 'INR', status: 'captured' }), 'p9');
    expect(out).toMatchObject({ status: 'ignored', reason: 'payment_without_subscription' });
    expect(t.payments).toHaveLength(1);
    expect(t.status()).toBe('trial');
  });

  it('unknown subscription releases the claim so a retry works once the row exists', async () => {
    const t = setup();
    const e = evt('subscription.charged', '2026-12-01T00:00:05Z', { id: 'sub_unknown', current_end: T('2027-01-01T00:00:00Z') });
    const first = await t.send(e, 'evt_race');
    expect(first).toEqual({ status: 'unknown_subscription', eventId: 'evt_race' });
    expect(webhookHttpStatus(first)).toBe(202);
    t.subscriptions.rows.set('late', { id: 'late', productKey: 'crm', providerSubscriptionId: 'sub_unknown', state: newTrialState(new Date('2026-12-01T00:00:00Z'), new Date('2026-11-01T00:00:00Z')) });
    const retry = await t.send(e, 'evt_race');
    expect(retry).toMatchObject({ status: 'applied', subscriptionId: 'late', newStatus: 'active' });
  });

  it('a failure while saving releases the claim and rethrows so the provider retries', async () => {
    const t = setup();
    const save = vi.spyOn(t.subscriptions, 'save').mockRejectedValueOnce(new Error('db down'));
    const e = evt('subscription.charged', '2026-12-01T00:00:05Z', { current_end: T('2027-01-01T00:00:00Z') });
    await expect(t.send(e, 'evt_fail')).rejects.toThrow('db down');
    const retry = await t.send(e, 'evt_fail');
    expect(retry).toMatchObject({ status: 'applied', changed: true });
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('ignores events that carry no state change', async () => {
    const t = setup();
    for (const [i, name] of ['subscription.authenticated', 'subscription.updated', 'order.paid'].entries()) {
      const out = await t.send(evt(name, '2026-12-01T00:00:00Z', { status: 'authenticated' }), `i${i}`);
      expect(out.status).toBe('ignored');
    }
    expect(t.status()).toBe('trial');
    expect(t.subscriptions.saves).toHaveLength(0);
  });
});
