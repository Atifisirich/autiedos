/**
 * Payments adapter: Razorpay subscriptions (decision #32), with a mock for dev and tests.
 * No database dependency: persistence is behind the WebhookStore / SubscriptionRepo interfaces
 * below and gets implemented against the `billing` / `core.subscriptions` tables later.
 *
 * Razorpay references (cited from memory of the public docs; the docs host was NOT reachable from
 * the build environment, so every shape below is UNVERIFIED unless a comment says otherwise):
 *  - Auth + base URL (HTTP Basic key_id:key_secret, https://api.razorpay.com/v1):
 *      https://razorpay.com/docs/api/authentication/
 *  - Customers:             https://razorpay.com/docs/api/customers/create/
 *  - Plans:                 https://razorpay.com/docs/api/payments/subscriptions/create-plan/
 *  - Create subscription:   https://razorpay.com/docs/api/payments/subscriptions/create-subscription/
 *    (a web search confirmed: POST /v1/subscriptions, plan_id and total_count required,
 *     customer_notify optional, plus quantity/start_at/expire_by/addons/notes; id starts "sub_")
 *  - Cancel subscription:   https://razorpay.com/docs/api/payments/subscriptions/cancel-subscription/
 *  - Payment links:         https://razorpay.com/docs/api/payments/payment-links/create-standard/
 *  - Fetch payment:         https://razorpay.com/docs/api/payments/fetch-with-id/
 *  - Webhook validation:    https://razorpay.com/docs/webhooks/validate-test/
 *      (X-Razorpay-Signature = hex HMAC-SHA256 of the RAW body with the webhook secret;
 *       X-Razorpay-Event-Id = unique per event, used here for idempotency)
 *  - Subscription events:   https://razorpay.com/docs/webhooks/subscriptions/
 *
 * Environment: RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET, RAZORPAY_MODE
 * (test|live, default test), PAYMENTS_PROVIDER=razorpay to select the real adapter in getPayments().
 * Nothing here reads a key at import time and nothing logs or returns secrets.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { applyEvent, DEFAULT_BILLING_POLICY, type BillingPolicy, type ProductKey, type SubscriptionEvent, type SubscriptionState, type SubscriptionStatus } from '@autoed/shared';

// ===================================================================== config

export type RazorpayMode = 'test' | 'live';

export interface RazorpayConfig {
  keyId: string;
  keySecret: string;
  webhookSecret: string;
  mode: RazorpayMode;
  baseUrl?: string;
  timeoutMs?: number;
}

export class PaymentsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaymentsConfigError';
  }
}

const PREFIX: Record<RazorpayMode, string> = { test: 'rzp_test_', live: 'rzp_live_' };

/** Throws when keys are missing or the key prefix does not match RAZORPAY_MODE (never prints the key). */
export function loadRazorpayConfig(env: Record<string, string | undefined> = process.env): RazorpayConfig {
  const modeRaw = (env.RAZORPAY_MODE ?? 'test').trim().toLowerCase();
  if (modeRaw !== 'test' && modeRaw !== 'live') throw new PaymentsConfigError(`RAZORPAY_MODE must be "test" or "live" (got "${modeRaw}")`);
  const mode: RazorpayMode = modeRaw;
  const keyId = env.RAZORPAY_KEY_ID?.trim();
  const keySecret = env.RAZORPAY_KEY_SECRET?.trim();
  const webhookSecret = env.RAZORPAY_WEBHOOK_SECRET?.trim();
  if (!keyId || !keySecret) throw new PaymentsConfigError('RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are required');
  if (!webhookSecret) throw new PaymentsConfigError('RAZORPAY_WEBHOOK_SECRET is required');
  const keyMode: RazorpayMode | null = keyId.startsWith(PREFIX.test) ? 'test' : keyId.startsWith(PREFIX.live) ? 'live' : null;
  if (!keyMode) throw new PaymentsConfigError('RAZORPAY_KEY_ID must start with rzp_test_ or rzp_live_');
  if (keyMode !== mode) {
    throw new PaymentsConfigError(`RAZORPAY_MODE=${mode} but RAZORPAY_KEY_ID is a ${keyMode} key; refusing to start (test/live keys mixed up)`);
  }
  return { keyId, keySecret, webhookSecret, mode };
}

// ===================================================================== adapter interface

export interface CreateCustomerInput {
  name: string;
  email?: string;
  contact?: string;
  gstin?: string;
  notes?: Record<string, string>;
}
export interface ProviderCustomer {
  id: string;
}

export interface CreatePlanInput {
  period: 'monthly' | 'yearly';
  interval: number;
  name: string;
  /** Amount charged per cycle in paise, GST-inclusive (Razorpay does not add GST itself). */
  amountPaise: number;
  description?: string;
  notes?: Record<string, string>;
}
export interface ProviderPlan {
  id: string;
}

export interface CreateSubscriptionInput {
  planId: string;
  /** Number of billing cycles; required by Razorpay unless an end date is given. */
  totalCount: number;
  quantity?: number;
  /** First charge time; later than now to start after a trial or on the 1st of next month. */
  startAt?: Date;
  expireBy?: Date;
  customerNotify?: boolean;
  /** One-off amounts added to the first charge, e.g. the pro-rata stub. UNVERIFIED semantics. */
  addons?: { name: string; amountPaise: number }[];
  /** UNVERIFIED: Razorpay may attach the customer at checkout instead of accepting this field. */
  customerId?: string;
  notes?: Record<string, string>;
}

/** Razorpay subscription statuses (docs list: created, authenticated, active, pending, halted, cancelled, completed, expired, paused). */
export type ProviderSubscriptionStatus = string;

export interface ProviderSubscription {
  id: string;
  planId: string;
  status: ProviderSubscriptionStatus;
  quantity: number;
  totalCount: number | null;
  paidCount: number | null;
  currentStart: Date | null;
  currentEnd: Date | null;
  chargeAt: Date | null;
  /** Hosted authorisation page for the customer. */
  shortUrl: string | null;
  notes: Record<string, string>;
}

export interface CreatePaymentLinkInput {
  amountPaise: number;
  description: string;
  referenceId: string;
  customer?: { name?: string; email?: string; contact?: string };
  notifyEmail?: boolean;
  notifySms?: boolean;
  callbackUrl?: string;
  expireBy?: Date;
  notes?: Record<string, string>;
}
export interface ProviderPaymentLink {
  id: string;
  shortUrl: string;
  status: string;
}

export interface ProviderPayment {
  id: string;
  amountPaise: number;
  currency: string;
  status: string;
  method: string | null;
  orderId: string | null;
  invoiceId: string | null;
  email: string | null;
  contact: string | null;
  capturedAt: Date | null;
  errorCode: string | null;
  errorDescription: string | null;
  notes: Record<string, string>;
}

export interface PaymentsAdapter {
  readonly name: 'razorpay' | 'mock';
  readonly mode: RazorpayMode;
  createCustomer(input: CreateCustomerInput): Promise<ProviderCustomer>;
  createPlan(input: CreatePlanInput): Promise<ProviderPlan>;
  createSubscription(input: CreateSubscriptionInput): Promise<ProviderSubscription>;
  fetchSubscription(id: string): Promise<ProviderSubscription>;
  cancelSubscription(id: string, opts?: { atCycleEnd?: boolean }): Promise<ProviderSubscription>;
  createPaymentLink(input: CreatePaymentLinkInput): Promise<ProviderPaymentLink>;
  fetchPayment(id: string): Promise<ProviderPayment>;
  /** Constant-time check of X-Razorpay-Signature against the exact raw request body. */
  verifyWebhookSignature(rawBody: string | Buffer, signature: string | null | undefined): boolean;
}

// ===================================================================== signatures

export function signWebhookBody(rawBody: string | Buffer, secret: string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

/**
 * Verifies the hex HMAC-SHA256 signature of the raw body. Compares digests with timingSafeEqual
 * after checking both are the same length (length is not secret). Returns false for any malformed
 * signature rather than throwing.
 */
export function verifyWebhookSignature(rawBody: string | Buffer, signature: string | null | undefined, secret: string): boolean {
  if (!secret || !signature || !/^[0-9a-fA-F]{64}$/.test(signature)) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  const got = Buffer.from(signature, 'hex');
  return got.length === expected.length && timingSafeEqual(expected, got);
}

// ===================================================================== Razorpay REST implementation

export class RazorpayApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string | null,
    public readonly description: string,
    public readonly field: string | null = null,
  ) {
    super(`Razorpay API error ${status}${code ? ` ${code}` : ''}: ${description}`);
    this.name = 'RazorpayApiError';
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
type Json = Record<string, unknown>;

const unix = (d: Date) => Math.floor(d.getTime() / 1000);
const fromUnix = (v: unknown): Date | null => (typeof v === 'number' && Number.isFinite(v) ? new Date(v * 1000) : null);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
// Razorpay returns notes as {} when empty and as an array [] in some responses.
const notesOf = (v: unknown): Record<string, string> =>
  v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as Json).map(([k, x]) => [k, String(x)])) : {};

function assertPaise(name: string, v: number): void {
  if (!Number.isSafeInteger(v) || v <= 0) throw new RangeError(`${name} must be a positive integer number of paise`);
}

export function createRazorpayAdapter(config: RazorpayConfig, fetchImpl: FetchLike = fetch as FetchLike): PaymentsAdapter {
  const base = config.baseUrl ?? 'https://api.razorpay.com/v1';
  const auth = `Basic ${Buffer.from(`${config.keyId}:${config.keySecret}`).toString('base64')}`;

  async function call(method: 'GET' | 'POST', path: string, body?: Json): Promise<Json> {
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers: { authorization: auth, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(config.timeoutMs ?? 15000),
    });
    const text = await res.text();
    let parsed: Json = {};
    try {
      parsed = text ? (JSON.parse(text) as Json) : {};
    } catch {
      if (res.ok) throw new RazorpayApiError(res.status, null, 'Response was not valid JSON');
    }
    if (!res.ok) {
      const e = (parsed.error ?? {}) as Json;
      throw new RazorpayApiError(res.status, str(e.code), str(e.description) ?? `HTTP ${res.status}`, str(e.field));
    }
    return parsed;
  }

  const toSubscription = (j: Json): ProviderSubscription => ({
    id: String(j.id),
    planId: String(j.plan_id),
    status: String(j.status),
    quantity: num(j.quantity) ?? 1,
    totalCount: num(j.total_count),
    paidCount: num(j.paid_count),
    currentStart: fromUnix(j.current_start),
    currentEnd: fromUnix(j.current_end),
    chargeAt: fromUnix(j.charge_at),
    shortUrl: str(j.short_url),
    notes: notesOf(j.notes),
  });

  return {
    name: 'razorpay',
    mode: config.mode,

    async createCustomer(i) {
      const j = await call('POST', '/customers', {
        name: i.name,
        ...(i.email ? { email: i.email } : {}),
        ...(i.contact ? { contact: i.contact } : {}),
        ...(i.gstin ? { gstin: i.gstin } : {}),
        // Return the existing customer instead of failing on a duplicate email/contact (UNVERIFIED value format: "0"/"1").
        fail_existing: '0',
        ...(i.notes ? { notes: i.notes } : {}),
      });
      return { id: String(j.id) };
    },

    async createPlan(i) {
      assertPaise('amountPaise', i.amountPaise);
      const j = await call('POST', '/plans', {
        period: i.period,
        interval: i.interval,
        item: { name: i.name, amount: i.amountPaise, currency: 'INR', ...(i.description ? { description: i.description } : {}) },
        ...(i.notes ? { notes: i.notes } : {}),
      });
      return { id: String(j.id) };
    },

    async createSubscription(i) {
      if (!Number.isSafeInteger(i.totalCount) || i.totalCount < 1) throw new RangeError('totalCount must be a positive integer');
      const j = await call('POST', '/subscriptions', {
        plan_id: i.planId,
        total_count: i.totalCount,
        ...(i.quantity !== undefined ? { quantity: i.quantity } : {}),
        ...(i.startAt ? { start_at: unix(i.startAt) } : {}),
        ...(i.expireBy ? { expire_by: unix(i.expireBy) } : {}),
        ...(i.customerNotify !== undefined ? { customer_notify: i.customerNotify } : {}),
        ...(i.addons?.length ? { addons: i.addons.map((a) => ({ item: { name: a.name, amount: a.amountPaise, currency: 'INR' } })) } : {}),
        ...(i.customerId ? { customer_id: i.customerId } : {}),
        ...(i.notes ? { notes: i.notes } : {}),
      });
      return toSubscription(j);
    },

    async fetchSubscription(id) {
      return toSubscription(await call('GET', `/subscriptions/${encodeURIComponent(id)}`));
    },

    async cancelSubscription(id, opts) {
      // Docs: body { cancel_at_cycle_end: 0|1 } (UNVERIFIED whether boolean is also accepted).
      return toSubscription(await call('POST', `/subscriptions/${encodeURIComponent(id)}/cancel`, { cancel_at_cycle_end: opts?.atCycleEnd ? 1 : 0 }));
    },

    async createPaymentLink(i) {
      assertPaise('amountPaise', i.amountPaise);
      const j = await call('POST', '/payment_links', {
        amount: i.amountPaise,
        currency: 'INR',
        accept_partial: false,
        reference_id: i.referenceId,
        description: i.description,
        ...(i.customer ? { customer: i.customer } : {}),
        notify: { sms: i.notifySms ?? false, email: i.notifyEmail ?? true },
        reminder_enable: true,
        ...(i.callbackUrl ? { callback_url: i.callbackUrl, callback_method: 'get' } : {}),
        ...(i.expireBy ? { expire_by: unix(i.expireBy) } : {}),
        ...(i.notes ? { notes: i.notes } : {}),
      });
      return { id: String(j.id), shortUrl: String(j.short_url), status: String(j.status) };
    },

    async fetchPayment(id) {
      return toPayment(await call('GET', `/payments/${encodeURIComponent(id)}`));
    },

    verifyWebhookSignature(rawBody, signature) {
      return verifyWebhookSignature(rawBody, signature, config.webhookSecret);
    },
  };
}

function toPayment(j: Json): ProviderPayment {
  return {
    id: String(j.id),
    amountPaise: num(j.amount) ?? 0,
    currency: str(j.currency) ?? 'INR',
    status: str(j.status) ?? 'unknown',
    method: str(j.method),
    orderId: str(j.order_id),
    invoiceId: str(j.invoice_id),
    email: str(j.email),
    contact: str(j.contact),
    capturedAt: fromUnix(j.created_at),
    errorCode: str(j.error_code),
    errorDescription: str(j.error_description),
    notes: notesOf(j.notes),
  };
}

// ===================================================================== mock adapter

export interface MockPaymentsAdapter extends PaymentsAdapter {
  readonly calls: { method: string; args: unknown[] }[];
  /** Build a signed webhook delivery for the mock's secret (for dev and tests). */
  signedWebhook(event: Json, eventId?: string): { rawBody: string; signature: string; eventId: string };
}

export function createMockPayments(opts: { webhookSecret?: string; mode?: RazorpayMode } = {}): MockPaymentsAdapter {
  const secret = opts.webhookSecret ?? 'mock_webhook_secret';
  let n = 0;
  const id = (p: string) => `${p}_mock${String(++n).padStart(4, '0')}`;
  const subs = new Map<string, ProviderSubscription>();
  const payments = new Map<string, ProviderPayment>();
  const calls: MockPaymentsAdapter['calls'] = [];
  const rec = (method: string, ...args: unknown[]) => void calls.push({ method, args });
  return {
    name: 'mock',
    mode: opts.mode ?? 'test',
    calls,
    async createCustomer(i) {
      rec('createCustomer', i);
      return { id: id('cust') };
    },
    async createPlan(i) {
      rec('createPlan', i);
      assertPaise('amountPaise', i.amountPaise);
      return { id: id('plan') };
    },
    async createSubscription(i) {
      rec('createSubscription', i);
      const s: ProviderSubscription = {
        id: id('sub'),
        planId: i.planId,
        status: 'created',
        quantity: i.quantity ?? 1,
        totalCount: i.totalCount,
        paidCount: 0,
        currentStart: null,
        currentEnd: null,
        chargeAt: i.startAt ?? null,
        shortUrl: `https://mock.invalid/pay/${n}`,
        notes: i.notes ?? {},
      };
      subs.set(s.id, s);
      return s;
    },
    async fetchSubscription(sid) {
      rec('fetchSubscription', sid);
      const s = subs.get(sid);
      if (!s) throw new RazorpayApiError(400, 'BAD_REQUEST_ERROR', 'The id provided does not exist');
      return s;
    },
    async cancelSubscription(sid, o) {
      rec('cancelSubscription', sid, o);
      const s = subs.get(sid);
      if (!s) throw new RazorpayApiError(400, 'BAD_REQUEST_ERROR', 'The id provided does not exist');
      const next = { ...s, status: o?.atCycleEnd ? s.status : 'cancelled' };
      subs.set(sid, next);
      return next;
    },
    async createPaymentLink(i) {
      rec('createPaymentLink', i);
      const lid = id('plink');
      return { id: lid, shortUrl: `https://mock.invalid/l/${lid}`, status: 'created' };
    },
    async fetchPayment(pid) {
      rec('fetchPayment', pid);
      const p = payments.get(pid);
      if (p) return p;
      return toPayment({ id: pid, amount: 0, currency: 'INR', status: 'captured' });
    },
    verifyWebhookSignature(rawBody, signature) {
      return verifyWebhookSignature(rawBody, signature, secret);
    },
    signedWebhook(event, eventId = id('evt')) {
      const rawBody = JSON.stringify(event);
      return { rawBody, signature: signWebhookBody(rawBody, secret), eventId };
    },
  };
}

/** Real adapter when PAYMENTS_PROVIDER=razorpay (validates keys/mode), otherwise the mock. */
export function getPayments(env: Record<string, string | undefined> = process.env): PaymentsAdapter {
  return env.PAYMENTS_PROVIDER === 'razorpay' ? createRazorpayAdapter(loadRazorpayConfig(env)) : createMockPayments();
}

// ===================================================================== webhook handling

/** Persistence seam: record that an event id was seen. `claim` must be atomic (unique-key insert). */
export interface WebhookStore {
  /** True when this call recorded the id first; false when it was already recorded. */
  claim(eventId: string): Promise<boolean>;
  /** Forget an id so the provider's retry can be processed (called when processing failed). */
  release(eventId: string): Promise<void>;
}

export function createMemoryWebhookStore(): WebhookStore {
  const seen = new Set<string>();
  return {
    async claim(eventId) {
      if (seen.has(eventId)) return false;
      seen.add(eventId);
      return true;
    },
    async release(eventId) {
      seen.delete(eventId);
    },
  };
}

export interface BillingSubscriptionRecord {
  /** Our own subscription id (core.subscriptions.id). */
  id: string;
  productKey: ProductKey;
  providerSubscriptionId: string;
  state: SubscriptionState;
}

/** Persistence seam for subscription rows. */
export interface SubscriptionRepo {
  findByProviderId(providerSubscriptionId: string): Promise<BillingSubscriptionRecord | null>;
  findById(id: string): Promise<BillingSubscriptionRecord | null>;
  save(record: BillingSubscriptionRecord, meta: { eventId: string; eventType: string }): Promise<void>;
}

export function createMemorySubscriptionRepo(initial: BillingSubscriptionRecord[] = []): SubscriptionRepo & { rows: Map<string, BillingSubscriptionRecord>; saves: { eventId: string; eventType: string }[] } {
  const rows = new Map(initial.map((r) => [r.id, r]));
  const saves: { eventId: string; eventType: string }[] = [];
  return {
    rows,
    saves,
    async findByProviderId(pid) {
      return [...rows.values()].find((r) => r.providerSubscriptionId === pid) ?? null;
    },
    async findById(rid) {
      return rows.get(rid) ?? null;
    },
    async save(record, meta) {
      rows.set(record.id, record);
      saves.push(meta);
    },
  };
}

export interface RecordedPayment {
  eventId: string;
  eventType: string;
  payment: ProviderPayment;
  subscriptionId: string | null;
}

export interface WebhookDeps {
  adapter: Pick<PaymentsAdapter, 'verifyWebhookSignature'>;
  store: WebhookStore;
  subscriptions: SubscriptionRepo;
  /** Optional hook to write payments to billing.payments. Called for payment.* events. */
  recordPayment?: (p: RecordedPayment) => Promise<void>;
  policy?: BillingPolicy;
}

export type WebhookOutcome =
  | { status: 'rejected'; reason: 'bad_signature' | 'bad_payload' }
  | { status: 'duplicate'; eventId: string }
  | { status: 'ignored'; eventId: string; reason: string }
  /** We do not know this subscription (yet). The claim is released so a retry can succeed. */
  | { status: 'unknown_subscription'; eventId: string }
  | { status: 'applied'; eventId: string; subscriptionId: string; changed: boolean; newStatus: SubscriptionStatus; ignoredByMachine?: string };

/** Suggested HTTP status per outcome (route layer). Razorpay retries non-2xx responses. */
export function webhookHttpStatus(o: WebhookOutcome): number {
  switch (o.status) {
    case 'rejected':
      return o.reason === 'bad_signature' ? 401 : 400;
    case 'unknown_subscription':
      return 202;
    default:
      return 200;
  }
}

export interface RazorpayEvent {
  event: string;
  created_at?: number;
  payload?: {
    subscription?: { entity?: Json };
    payment?: { entity?: Json };
  };
}

type Mapped =
  | { kind: 'subscription'; event: SubscriptionEvent }
  | { kind: 'payment'; event: SubscriptionEvent | null }
  | { kind: 'ignored'; reason: string };

/**
 * Map a Razorpay event to a state-machine event. `payment.*` events only move subscription state
 * when the payload also carries a subscription (or our own notes); subscription.* events are the
 * authority for subscription state.
 */
export function mapRazorpayEvent(ev: RazorpayEvent): Mapped {
  const at = fromUnix(ev.created_at) ?? new Date(0);
  const sub = ev.payload?.subscription?.entity;
  const periodEnd = fromUnix(sub?.current_end);
  switch (ev.event) {
    case 'subscription.activated':
    case 'subscription.charged':
      return { kind: 'subscription', event: { type: 'payment_succeeded', at, currentPeriodEnd: periodEnd } };
    case 'subscription.pending': // charge failed, Razorpay is retrying
      return { kind: 'subscription', event: { type: 'payment_failed', at } };
    case 'subscription.halted': // retries exhausted
      return { kind: 'subscription', event: { type: 'halted', at } };
    case 'subscription.cancelled':
    case 'subscription.completed':
    case 'subscription.expired': // UNVERIFIED that an "expired" event exists; harmless if it never fires
      return { kind: 'subscription', event: { type: 'cancelled', at } };
    case 'payment.captured':
      return { kind: 'payment', event: sub ? { type: 'payment_succeeded', at, currentPeriodEnd: periodEnd } : null };
    case 'payment.failed':
      return { kind: 'payment', event: { type: 'payment_failed', at } };
    case 'subscription.authenticated':
    case 'subscription.updated':
    case 'subscription.paused':
    case 'subscription.resumed':
      return { kind: 'ignored', reason: `no_state_change:${ev.event}` };
    default:
      return { kind: 'ignored', reason: `unhandled_event:${ev.event}` };
  }
}

/**
 * Handle one Razorpay webhook delivery. Pass the RAW body exactly as received (not re-serialised
 * JSON). Idempotent: the same X-Razorpay-Event-Id (or, absent that header, the body hash) is
 * processed once; replays return `duplicate`. If processing throws, the claim is released and the
 * error rethrown so the route returns 5xx and Razorpay retries.
 */
export async function handleRazorpayWebhook(input: { rawBody: string | Buffer; signature: string | null | undefined; eventId?: string | null }, deps: WebhookDeps): Promise<WebhookOutcome> {
  if (!deps.adapter.verifyWebhookSignature(input.rawBody, input.signature)) return { status: 'rejected', reason: 'bad_signature' };

  let ev: RazorpayEvent;
  try {
    ev = JSON.parse(input.rawBody.toString('utf8')) as RazorpayEvent;
    if (!ev || typeof ev.event !== 'string') throw new Error('no event');
  } catch {
    return { status: 'rejected', reason: 'bad_payload' };
  }

  const eventId = input.eventId?.trim() || `body:${createHash('sha256').update(input.rawBody).digest('hex')}`;
  if (!(await deps.store.claim(eventId))) return { status: 'duplicate', eventId };

  try {
    const mapped = mapRazorpayEvent(ev);
    const subEntity = ev.payload?.subscription?.entity;
    const payEntity = ev.payload?.payment?.entity;

    // Locate our subscription: our own id in notes first, then Razorpay's subscription id.
    const notes = { ...notesOf(payEntity?.notes), ...notesOf(subEntity?.notes) };
    const record = notes.autoed_subscription_id
      ? await deps.subscriptions.findById(notes.autoed_subscription_id)
      : typeof subEntity?.id === 'string'
        ? await deps.subscriptions.findByProviderId(subEntity.id)
        : null;

    if (payEntity && deps.recordPayment) {
      await deps.recordPayment({ eventId, eventType: ev.event, payment: toPayment(payEntity), subscriptionId: record?.id ?? null });
    }

    if (mapped.kind === 'ignored') return { status: 'ignored', eventId, reason: mapped.reason };
    if (!mapped.event) return { status: 'ignored', eventId, reason: 'payment_without_subscription' };
    if (!record) {
      // Payment links and other one-off payments have no subscription: nothing to move.
      if (mapped.kind === 'payment') return { status: 'ignored', eventId, reason: 'payment_without_subscription' };
      await deps.store.release(eventId);
      return { status: 'unknown_subscription', eventId };
    }

    const result = applyEvent(record.state, mapped.event, deps.policy ?? DEFAULT_BILLING_POLICY);
    // Persist whenever the event was applied (even a no-op advances lastEventAt for out-of-order protection).
    if (result.ignored !== 'stale' && result.ignored !== 'terminal') await deps.subscriptions.save({ ...record, state: result.state }, { eventId, eventType: ev.event });
    return { status: 'applied', eventId, subscriptionId: record.id, changed: result.changed, newStatus: result.state.status, ...(result.ignored ? { ignoredByMachine: result.ignored } : {}) };
  } catch (err) {
    await deps.store.release(eventId).catch(() => undefined);
    throw err;
  }
}
