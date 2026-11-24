/**
 * Plans, billing profile, invoices, payments and usage per client. Invoices are created as DRAFTS only, with the
 * GST engine and invoice numbering of @autoed/shared; nothing here calls Razorpay (decision 33: no live account
 * without the owner's written yes). Issuing, payment links and webhooks belong to the billing integration stream.
 */
import {
  computeInvoice,
  financialYearOfDate,
  formatInvoiceNumber,
  isValidStateCode,
  nextInvoiceSequence,
  parseInvoiceNumber,
  validateInvoiceNumber,
  type InvoiceLineInput,
} from '@autoed/shared';
import { loadRazorpayConfig } from '../adapters/payments';
import { maybe, q, type Tx } from './db';
import { conflict, invalid, notFound } from './errors';
import { entitlementsOf, listSubscriptions } from './subscriptions';
import { istToday, logEvent, requireOrg } from './util';
import type { AdminDeps } from './deps';

export interface PlanRow {
  key: string;
  product_key: string;
  name: string;
  billing_interval: 'month' | 'year';
  price_paise: number;
  sac_code: string | null;
  gst_rate: number;
  razorpay_plan_id: string | null;
  active: boolean;
}

export async function listPlans(c: Tx): Promise<PlanRow[]> {
  return q<PlanRow>(c, `select key, product_key, name, billing_interval, price_paise, sac_code, gst_rate, razorpay_plan_id, active from billing.plans order by product_key, key`);
}

export async function upsertPlan(c: Tx, key: string, input: Omit<PlanRow, 'key'>): Promise<PlanRow> {
  if (!/^[a-z][a-z0-9_]*$/.test(key)) throw invalid('invalid_plan_key');
  const row = (
    await q<PlanRow>(
      c,
      `insert into billing.plans (key, product_key, name, billing_interval, price_paise, sac_code, gst_rate, razorpay_plan_id, active)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       on conflict (key) do update set product_key = excluded.product_key, name = excluded.name, billing_interval = excluded.billing_interval,
         price_paise = excluded.price_paise, sac_code = excluded.sac_code, gst_rate = excluded.gst_rate, razorpay_plan_id = excluded.razorpay_plan_id, active = excluded.active
       returning key, product_key, name, billing_interval, price_paise, sac_code, gst_rate, razorpay_plan_id, active`,
      [key, input.product_key, input.name, input.billing_interval, input.price_paise, input.sac_code ?? null, input.gst_rate, input.razorpay_plan_id ?? null, input.active],
    )
  )[0]!;
  await logEvent(c, null, 'admin.plan.upsert', { key, product: input.product_key, price_paise: input.price_paise, active: input.active });
  return row;
}

export interface BillingAccountInput {
  legal_name: string;
  gstin?: string | null;
  state_code: string;
  billing_email?: string | null;
  address?: string | null;
}

export async function saveBillingAccount(c: Tx, orgId: string, input: BillingAccountInput) {
  if (!isValidStateCode(input.state_code)) throw invalid('invalid_state_code');
  if (input.gstin && input.gstin.slice(0, 2) !== input.state_code) throw invalid('gstin_state_mismatch');
  const row = (
    await q(
      c,
      `insert into billing.accounts (org_id, legal_name, gstin, state_code, billing_email, address) values ($1, $2, $3, $4, $5, $6)
       on conflict (org_id) do update set legal_name = excluded.legal_name, gstin = excluded.gstin, state_code = excluded.state_code,
         billing_email = excluded.billing_email, address = excluded.address
       returning legal_name, gstin, state_code, billing_email, address`,
      [orgId, input.legal_name, input.gstin ?? null, input.state_code, input.billing_email ?? null, input.address ?? null],
    )
  )[0];
  await logEvent(c, orgId, 'admin.billing_account.save', { legal_name: input.legal_name, state_code: input.state_code, has_gstin: !!input.gstin });
  return row;
}

/** Everything the billing tab shows for one client. */
export async function clientBilling(c: Tx, deps: AdminDeps, orgId: string) {
  await requireOrg(c, orgId);
  const subs = await listSubscriptions(c, orgId);
  const entitlements = await entitlementsOf(c, subs, deps.now());
  const account = await maybe(c, `select legal_name, gstin, state_code, billing_email, address, razorpay_customer_id from billing.accounts where org_id = $1`, [orgId]);
  const invoices = await q(
    c,
    `select id, invoice_number, financial_year, invoice_date, status, taxable_paise, cgst_paise, sgst_paise, igst_paise, total_paise, place_of_supply, created_at
       from billing.invoices where org_id = $1 order by created_at desc limit 50`,
    [orgId],
  );
  const payments = await q(c, `select id, invoice_id, amount_paise, method, status, captured_at, razorpay_payment_id, created_at from billing.payments where org_id = $1 order by created_at desc limit 50`, [orgId]);
  const usage = await q(
    c,
    `select product_key, metric, date_trunc('month', period_start)::date as month, sum(quantity) as quantity
       from billing.usage where org_id = $1 and period_start >= (date_trunc('month', current_date) - interval '5 months')::date
      group by 1, 2, 3 order by 3 desc, 1, 2`,
    [orgId],
  );
  const razorpay = await q(c, `select subscription_id, plan_key, status, current_start, current_end from billing.razorpay_subscriptions where org_id = $1`, [orgId]);
  const plans = await listPlans(c);
  return {
    account,
    subscriptions: subs,
    entitlements,
    invoices,
    payments,
    usage,
    razorpay_subscriptions: razorpay,
    plans: plans.filter((p) => subs.some((s) => s.plan_key === p.key)),
    // Wallet balances (AI credits, messaging) have no table yet; usage rows above are what exists.
    wallets: null,
    razorpay_mode: razorpayMode(),
  };
}

/** 'test' | 'live' when keys are configured and consistent, else 'not_configured'. Never returns a key. */
function razorpayMode(): 'test' | 'live' | 'not_configured' {
  try {
    return loadRazorpayConfig().mode;
  } catch {
    return 'not_configured';
  }
}

/** One draft line per subscription that has a plan, priced from billing.plans (ex-GST). The admin edits it before creating. */
export async function invoiceSuggestion(c: Tx, orgId: string) {
  await requireOrg(c, orgId);
  return q(
    c,
    `select s.product_key, p.name || ' (' || p.billing_interval || 'ly)' as description, 1 as quantity, p.price_paise as unit_price_paise, p.sac_code
       from core.subscriptions s join billing.plans p on p.key = s.plan_key where s.org_id = $1 and s.status in ('trial','active','past_due') order by s.product_key`,
    [orgId],
  );
}

export interface InvoiceCreateInput {
  invoice_date?: string;
  rate_bps?: number;
  place_of_supply?: string;
  lines: { product_key?: string | null; description: string; sac_code?: string; quantity: number; unit_price_paise: number; discount_paise?: number }[];
}

/**
 * Creates a DRAFT GST invoice. Supplier state comes from configuration (AUTOED_SUPPLIER_STATE_CODE); the customer from
 * the client's billing profile. The number is allocated under an advisory lock so the series per financial year has no
 * gaps or duplicates; a voided draft keeps its number.
 */
export async function createInvoice(c: Tx, deps: AdminDeps, orgId: string, input: InvoiceCreateInput) {
  await requireOrg(c, orgId);
  const supplierState = deps.config.supplierStateCode;
  if (!supplierState || !isValidStateCode(supplierState)) throw invalid('supplier_state_not_configured');
  const account = await maybe<{ legal_name: string; gstin: string | null; state_code: string }>(c, `select legal_name, gstin, state_code from billing.accounts where org_id = $1`, [orgId]);
  if (!account) throw invalid('billing_account_missing');
  const placeOfSupply = input.place_of_supply ?? account.state_code;
  const lines: InvoiceLineInput[] = input.lines.map((l) => ({ description: l.description, sacCode: l.sac_code, quantity: l.quantity, unitPricePaise: l.unit_price_paise, discountPaise: l.discount_paise }));
  let totals;
  try {
    totals = computeInvoice({ supplierStateCode: supplierState, placeOfSupplyStateCode: placeOfSupply, lines, rateBps: input.rate_bps });
  } catch (e) {
    throw invalid('invoice_calculation_failed', { message: (e as Error).message });
  }
  const invoiceDate = input.invoice_date ?? istToday(deps.now());
  const fy = financialYearOfDate(invoiceDate);
  await c.query(`select pg_advisory_xact_lock(hashtext('billing.invoice_number'))`);
  const existing = await q<{ invoice_number: string }>(c, `select invoice_number from billing.invoices where financial_year = $1`, [fy.label]);
  const last = existing.reduce((m, r) => Math.max(m, parseInvoiceNumber(r.invoice_number)?.sequence ?? 0), 0);
  const number = formatInvoiceNumber(fy, nextInvoiceSequence(last || null));
  const ok = validateInvoiceNumber(number);
  if (!ok.ok) throw conflict('invoice_number_invalid', { reason: ok.reason });
  const inv = (
    await q<{ id: string }>(
      c,
      `insert into billing.invoices (org_id, invoice_number, financial_year, invoice_date, status, supplier_gstin, supplier_state_code, customer_legal_name, customer_gstin, place_of_supply,
                                    taxable_paise, cgst_paise, sgst_paise, igst_paise, total_paise)
       values ($1, $2, $3, $4, 'draft', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) returning id`,
      [orgId, number, fy.label, invoiceDate, deps.config.supplierGstin, supplierState, account.legal_name, account.gstin, placeOfSupply, totals.taxablePaise, totals.cgstPaise, totals.sgstPaise, totals.igstPaise, totals.totalPaise],
    )
  )[0]!;
  for (const [i, l] of totals.lines.entries()) {
    await c.query(
      `insert into billing.invoice_lines (org_id, invoice_id, product_key, description, sac_code, quantity, unit_paise, taxable_paise, gst_rate) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [orgId, inv.id, input.lines[i]?.product_key ?? null, l.description, l.sacCode, l.quantity, l.unitPricePaise, l.taxablePaise, totals.rateBps / 100],
    );
  }
  await logEvent(c, orgId, 'admin.invoice.create_draft', { invoice_number: number, total_paise: totals.totalPaise, regime: totals.regime }, inv.id);
  return getInvoice(c, inv.id);
}

export async function getInvoice(c: Tx, invoiceId: string) {
  const inv = await maybe(c, `select i.*, o.name as org_name from billing.invoices i join core.organizations o on o.id = i.org_id where i.id = $1`, [invoiceId]);
  if (!inv) throw notFound('invoice_not_found');
  const lines = await q(c, `select id, product_key, description, sac_code, quantity, unit_paise, taxable_paise, gst_rate from billing.invoice_lines where invoice_id = $1 order by id`, [invoiceId]);
  return { ...inv, lines };
}

/** A draft that should not be issued is voided (number kept, so the series stays continuous). */
export async function voidDraft(c: Tx, invoiceId: string, reason: string) {
  const cur = await maybe<{ org_id: string; status: string; invoice_number: string }>(c, `select org_id, status, invoice_number from billing.invoices where id = $1`, [invoiceId]);
  if (!cur) throw notFound('invoice_not_found');
  if (cur.status !== 'draft') throw conflict('only_drafts_can_be_voided', { status: cur.status });
  await c.query(`update billing.invoices set status = 'void' where id = $1`, [invoiceId]);
  await logEvent(c, cur.org_id, 'admin.invoice.void_draft', { invoice_number: cur.invoice_number, reason }, invoiceId);
  return getInvoice(c, invoiceId);
}
