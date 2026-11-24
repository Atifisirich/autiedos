# ADR: Billing with Razorpay subscriptions and GST invoices

Status: proposed (code written, nothing deployed, no database tables wired). Date: 2026-11-24.
Source decisions: DECISIONS.md #32 (Razorpay with GST, not manual), #33 (no paid resource without the
owner's written yes), #35, #42 (30 days read-only, then export and delete), #45 (whole products only).
Plan references: PLAN-unified-platform.md sections 4.1, 4.2, 12.

## 1. What was built (no database dependency)

| Piece | Where | Notes |
|---|---|---|
| GST invoice maths | `packages/shared/src/billing/gst.ts` | Integer paise, rate in basis points (default 1800), CGST+SGST vs IGST, per-line half-up rounding |
| Financial year and invoice numbers | `.../invoiceNumber.ts` | FY = 1 Apr to 31 Mar evaluated in IST; `AE/26-27/000123` |
| Plan pricing, seats, trial, proration | `.../plans.ts` | Per-student or flat (+ extra seats); monthly calendar-aligned proration; yearly no proration |
| Subscription state machine | `.../subscription.ts` | trial, active, past_due, suspended, cancelled; pure `applyEvent(state, event)` |
| Entitlement rules | `.../entitlements.ts` | Full / read-only / none per product from subscriptions and `now` |
| zod schemas | `.../schemas.ts` | Plan, invoice input, GSTIN, state code, subscription state |
| Payments adapter | `packages/server/src/adapters/payments.ts` | `PaymentsAdapter`, Razorpay REST via `fetch`, mock, HMAC verification, idempotent webhook handler |

Persistence is behind two small interfaces, `WebhookStore` (atomic "claim this event id") and
`SubscriptionRepo` (find by Razorpay id or our id, save). In-memory versions exist for tests. When the
`billing` tables land, implement these two against Postgres; no other code changes.

## 2. Design

### 2.1 Money and GST
* All amounts are integer paise. Plan prices are stored **ex-GST**; GST is added on the invoice.
* Intra-state (supplier state = place of supply): CGST and SGST each at half the rate. Inter-state: IGST.
* Rounding is per invoice line and per tax component, half-up to the paisa. Because CGST and SGST are
  rounded separately, an odd-paise base can make intra-state tax one paisa higher than the IGST figure
  (10.50 -> IGST 1.89, CGST 0.95 + SGST 0.95 = 1.90). The tests pin this behaviour.
* Place of supply for B2B software services is taken as the client's state. State codes are the two-digit GST codes
  (Telangana 36, Andhra Pradesh 37, Ladakh 38, 97 other territory, 99 centre).
* Default SAC `998314` is a placeholder (see open questions).

### 2.2 Invoice numbers
`<prefix>/<FY>/<6-digit sequence>`, sequence restarts at 1 every 1 April (IST). GST Rule 46 limits the
serial number to 16 characters (letters, digits, `-`, `/`). The requested `AE/2026-27/000123` is 17
characters, so the default is **`AE/26-27/000123`** (15). The long form is still available through an option and
`validateInvoiceNumber` rejects it. Allocation must happen in a transaction with a lock on the per-FY counter so the
series has no gaps.

### 2.3 Plans, trial, proration
* `per_student`: unit price x billable students (optional minimum). `flat`: flat price covering N seats, optional per-extra-seat price (without it, exceeding N is refused).
* Trial: `trialDays` from the start instant; billing starts on the IST date the trial ends.
* Monthly mid-cycle start: the first partial month is charged pro rata by calendar days (inclusive of the start day,
  half-up), and recurring billing then runs on the 1st of each month. Yearly plans run 12 months from the start date, unprorated.

### 2.4 Razorpay and GST: charge the GST-inclusive amount
Razorpay subscriptions charge a fixed plan amount; they do not add GST and they do not issue a GST tax invoice.
So AutoEd issues its own GST invoice and creates the Razorpay plan at the **GST-inclusive invoice total**
(`grossForTaxable`), quantity 1. Consequence: one Razorpay plan per (plan, seat count, tax regime), created on demand and
cached; a seat change or a change of regime means a new Razorpay plan and subscription (or an update, see open questions).
Doing it per-unit with `quantity = seats` would let Razorpay's multiplication drift from the invoice by a few paise
after per-line rounding. The pro-rata first month is sent as a one-off add-on with `start_at` on the 1st of next month.

### 2.5 State machine
```
trial --pay--> active --fail--> past_due --grace over / halted--> suspended --pay--> active
trial --trial over, unpaid--> suspended          any non-terminal --cancel--> cancelled (terminal)
active --cancel at period end--> cancelled when the period ends
```
* Time rules (trial end, grace end, cancel at period end) are applied by `tick`/`effectiveState` and stamp the
  date they became due, not the date the job ran, so a late cron cannot lengthen access.
* Out-of-order protection: events older than the last applied one are ignored (`lastEventAt`).
* Grace period default 7 days (`pastDueGraceDays`), **not yet decided by the owner**; read-only 30 days (decision #42).

### 2.6 Entitlements
`computeEntitlements(subscriptions, now)` returns per product `full` (trial, active, past_due inside grace),
`read_only` (suspended or cancelled, up to 30 days), or `none` (after that: `purgeDue` lists products whose export
and delete is due). Several subscriptions for one product: best access wins. `canUseProduct(result, product, 'read'|'write')`
is the request guard. This matches plan 4.2 (`suspended`/`cancelled` fail `org_has_product`; the read-only layer is on top).

### 2.7 Adapter, keys and webhooks
* Keys come from `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`; `RAZORPAY_MODE` is `test` (default) or `live`.
  Startup fails if the key prefix (`rzp_test_` / `rzp_live_`) disagrees with the mode. `PAYMENTS_PROVIDER=razorpay` selects the real adapter; default is the mock.
* Signature: hex HMAC-SHA256 of the **raw** body with the webhook secret, compared with `timingSafeEqual`. Malformed signatures return false.
  The route must hand the raw bytes to the handler (disable JSON body parsing on that route).
* Idempotency: `X-Razorpay-Event-Id` (fallback: body hash) is claimed atomically before processing; replays return `duplicate`.
  If processing throws the claim is released and the error rethrown so the route returns 5xx and Razorpay retries.
  A forged request never consumes an id (signature is checked first). The state machine is also naturally idempotent
  (period end comes from the payload, not a counter).
* Event mapping: `subscription.activated|charged` -> payment succeeded; `.pending` -> payment failed (past_due); `.halted` -> suspended;
  `.cancelled|completed` -> cancelled; `payment.failed` -> payment failed only when a subscription can be resolved;
  `payment.captured` is recorded and moves state only when the payload carries a subscription; everything else is ignored.
  The subscription is found through our `notes.autoed_subscription_id` (set at creation) or Razorpay's subscription id.
* Unknown subscription: claim released, outcome `unknown_subscription`, suggested HTTP 202 (a webhook can beat our own insert).

## 3. Not verified (marked in code comments too)

The Razorpay docs host was not reachable from the build environment (no direct fetch; one web search result confirmed only
the create-subscription endpoint, `plan_id`, `total_count`, optional `customer_notify`, `quantity`, `start_at`, `expire_by`, `addons`, `notes`).
Everything below was written from memory of the public docs and has **never been run against Razorpay**, test mode included:

* Request/response field names for customers, plans, payment links, fetch payment, cancel (`cancel_at_cycle_end` as 0/1).
* `customer_id` on create-subscription, `fail_existing` format on customers, boolean vs 0/1 for `customer_notify`.
* Add-on semantics on the first charge, `start_at` behaviour for trials, maximum `total_count`.
* Exact webhook event set and payload shape (`subscription.expired` may not exist; `payment.*` events may not carry a subscription id).
* Header names `X-Razorpay-Signature` and `X-Razorpay-Event-Id`, and that retries use the same event id.
* Whether `subscription.activated` fires on the first charge or at authentication when `start_at` is in the future.
* Razorpay webhook retry/disable policy for repeated non-2xx responses.

First step when a test key exists: run one end-to-end test-mode flow (create customer, plan, subscription, pay with a test card,
receive each webhook) and fix any field-name drift, then add recorded real payloads as fixtures.

## 4. Open questions (owner / accountant)

All CONFIRM with a chartered accountant before the first real invoice:

1. **AutoEd's GSTIN and legal entity.** AutoEd is a registered company under Arfan Group Private Limited (decision #31). Which entity invoices
   (its own GSTIN or the parent's), and what is its state? The supplier state code drives CGST/SGST vs IGST. Nothing is hard-coded; it is configuration.
2. **SAC code and rate.** `998314` (IT design and development) is a placeholder; alternatives `998313`, `998315`, `997331`. Is 18% right?
3. **Is GST charged to educational institutions at all?** Exemptions for services *by* schools are well known; whether software services *to*
   schools, coaching centres and colleges are taxable (and at what rate) needs a ruling. Colleges and trusts may be unregistered, so also the
   place-of-supply rule when the client has no GSTIN.
4. **E-invoicing (IRN/QR via the IRP).** Mandatory above an annual turnover threshold (it has been reduced over time; current figure and
   whether AutoEd or the parent entity's combined turnover counts must be checked). If applicable, invoices need an IRP call and a different
   flow than "create row, render PDF". Also check the rule on reporting invoices within a time window after issue.
5. **Invoice number format.** Accept `AE/26-27/000123` (16-character limit) or choose another prefix/width. Separate series for credit notes?
6. **Rounding.** Per-line, per-component rounding vs invoice-level; any round-off to the whole rupee; the one-paisa CGST+SGST vs IGST difference.
7. **Credit notes, refunds, discounts**, and GST on advance payments (receipt voucher) are not modelled.
8. **TDS.** Clients that are companies or institutions may deduct TDS on payments; Razorpay subscriptions cannot handle partial payments. A manual path may be needed.
9. **Past-due grace days** (7 assumed) and **what happens to a trial that expires unpaid** (modelled as 30 days read-only like a lapsed customer; decision #42 does not say).
10. **Plan prices** (per student and flat), trial length, and minimums. None are decided; the code ships no price list.
11. **Seat changes mid-cycle.** Currently means a new Razorpay plan (section 2.4). Decide between immediate prorated add-on, next-cycle change, or Razorpay's subscription update API (not verified).
12. **Payment methods.** Card recurring in India is mandate-based (RBI e-mandate rules); UPI AutoPay and eNACH have per-transaction limits that may be too low for annual or large school invoices. Payment links (supported by the adapter) may be needed for large amounts.
13. **Razorpay account and cost.** Fees and activation are a paid resource; decision #33 requires the owner's written yes before any live account. Everything here runs on the mock until then.
14. **Retention.** Invoices and books of account are commonly kept 8 years (plan section 9); this conflicts with "delete 30 days after leaving" for client *data* only if invoice records contain personal data. Keep billing records out of the export-and-delete job, with the lawyer's/accountant's agreement.
15. **Webhook route design.** Which server owns the endpoint (platform admin server, per plan 4.1), how raw bodies are exposed, and the response code policy for `unknown_subscription`.

## 5. How it plugs in later

1. `billing` tables (another stream): `plans`, `subscriptions` links to `core.subscriptions`, `invoices`, `invoice_lines`, `payments`, `webhook_events (event_id primary key)`, `invoice_counters (fy primary key)`.
2. Implement `WebhookStore.claim` as `insert ... on conflict do nothing returning` and `SubscriptionRepo` over `core.subscriptions` (map `SubscriptionState` to its columns, adding `past_due_since`, `suspended_at`, `cancelled_at`, `cancel_at_period_end`, `last_event_at`, `provider_subscription_id`).
3. Replace the entitlement SQL helpers (`app.org_has_product`) so they agree with `computeEntitlements`; add a test that both give the same answer for the same rows.
4. A scheduled job calls `applyEvent(state, { type: 'tick', at })` for non-terminal subscriptions and runs the export and delete for `purgeDue` products.
5. Wire a raw-body webhook route to `handleRazorpayWebhook`, and invoice creation to `computeInvoice` + `formatInvoiceNumber`.
