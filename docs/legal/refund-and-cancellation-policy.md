# AutoEd Refund and Cancellation Policy

> **DRAFT - needs legal review - not legal advice**
> This is a working draft written by the product team, not by a lawyer. Do not publish, sign or rely on it until counsel has reviewed it. `[ASSUMPTION]` marks something we assumed; `[CONFIRM]` marks a figure, period or legal point we are unsure of.

| | |
|---|---|
| Version | 0.1 (draft) |
| Date | 2026-11-24 |
| Applies to | Paid subscriptions to AutoEd CRM, OS and ERP, billed through Razorpay with GST |
| Fixed by owner decisions | Billing via Razorpay with GST (#32); 30 days read-only after non-payment of a product, then export and deletion (#42); on leaving, CSV/Excel export and deletion 30 days later (#42) |

## 1. Billing basics

* **Billing method:** subscriptions and one-off payments through **Razorpay** `[ASSUMPTION: Razorpay Subscriptions API for recurring plans; manual invoice and bank transfer as a fallback for large Clients - owner to decide]`.
* **GST:** all fees are exclusive of GST. AutoEd issues a GST tax invoice for each payment `[CONFIRM: GSTIN, SAC code for SaaS, rate (assumed 18%), place-of-supply rules, e-invoicing threshold]`.
* **Billing cycle:** monthly or annual, as chosen on the order form `[ASSUMPTION; owner to confirm which cycles are offered]`. Products are billed separately because a Client may buy CRM, OS or ERP alone or in any combination.
* **Auto-renewal:** subscriptions renew automatically each cycle until cancelled. Reminder emails are sent `[7 days - CONFIRM]` before an annual renewal `[CONFIRM: RBI recurring-payment e-mandate rules for cards/UPI AutoPay, pre-debit notification]`.
* **Price changes:** notified at least `[30 days - CONFIRM]` in advance and apply from the next cycle.
* **AI credits and usage add-ons** (AI credits, WhatsApp messages) are charged as stated on the order form. Unused credits `[ASSUMPTION: expire at the end of the billing period and are not refundable - CONFIRM]`.

## 2. Free trial `[ASSUMPTION - owner to decide whether a trial is offered]`

If a trial is offered, it is for `[14 days - CONFIRM]`. No payment is taken until the trial ends. A trial Client can export its data any time. If it does not subscribe, the account moves to the read-only stage in section 5 for `[30 days]`, then data is deleted.

## 3. Cancellation by the Client

* The Client's administrator can cancel a product from the account settings or by emailing `[BILLING EMAIL]`.
* **Cancelling one product** stops renewal of that product at the end of the paid period. Access continues until then. Other products are unaffected.
* **Cancelling everything** is "leaving", see section 6.
* Cancellation is effective for the **next** cycle; we do not cancel mid-cycle with a pro-rata refund unless section 4 applies.

## 4. Refunds

| Situation | Refund | Notes |
|---|---|---|
| Monthly plan, cancelled during the cycle | No refund for the current month; access continues to the end of it | `[CONFIRM]` |
| Annual plan, cancelled within `[7 days - CONFIRM]` of first purchase or renewal | Full refund of the fee paid, less payment gateway fees if not recoverable | `[ASSUMPTION; owner to decide whether a cooling-off window is offered]` |
| Annual plan, cancelled later | No refund; access continues to the end of the paid year | `[CONFIRM]` |
| Duplicate or wrong charge, or charge after a valid cancellation | Full refund of the excess | |
| Service not delivered or major outage beyond the order-form SLA, if any | Pro-rata credit or refund | `[ASSUMPTION: no SLA at launch]` |
| Client closes its account for breach by AutoEd not cured in `[30 days]` | Pro-rata refund of unused prepaid period | `[CONFIRM]` |
| Termination by AutoEd for the Client's breach | No refund | |

* Refund requests: email `[BILLING EMAIL]` with the invoice number. We respond within `[5 business days - CONFIRM]`.
* Approved refunds go back to the original payment method through Razorpay and typically take `[5-10 business days - CONFIRM]`.
* Where a GST invoice has been issued, we issue a **credit note** as required by GST law `[CONFIRM time limits]`.
* Taxes, gateway fees and set-up or onboarding fees are non-refundable unless law requires otherwise `[CONFIRM]`.
* This section is not intended to reduce any right a consumer or institution has under applicable Indian law `[CONFIRM whether consumer-protection rules apply to institution purchases]`.

## 5. Non-payment of a product: 30 days read-only, then export and deletion

Applies product by product. Day 0 is the day the payment fails after the retry period.

| Day | What happens |
|---|---|
| Before day 0 | Failed payment: Razorpay retries per its schedule `[CONFIRM]`; we email the administrator at each failure. Status `past_due` with a short grace period during which access continues `[ASSUMPTION: 7 days grace - CONFIRM]` |
| Day 0 | Product status becomes `suspended` for writes. The product is **read-only** for the Client: users can view and **export** data but cannot add or change records. Messaging sends stop. |
| Day 0 to 30 | **Read-only period (30 days).** Paying the overdue amount restores full access immediately. |
| Day 30 | If unpaid, we prepare a **CSV/Excel export** of that product's data and make it available to the Client administrator. We email the administrator `[7 days - CONFIRM]` **before** deletion. |
| After day 30 `[ASSUMPTION: deletion runs after the export has been available for a short period, for example 7 days, and the Client was notified - CONFIRM; the owner decision says "30 days read-only, then export and deletion"]` | The product's data is **deleted** from live systems. Backups age out within `[CONFIRM backup retention, assumed up to 7 to 35 days]`. Legal-hold and financial records are excluded (`data-retention-schedule.md`). |

* Data of **other products** the Client has paid for is not touched.
* Shared master data (for example the student register) used by a product that is still active is **not** deleted; only data owned by the lapsed product is deleted `[ASSUMPTION; this follows the database design where each product owns its own tables - confirm shared-data handling with counsel]`.
* The Client can ask for earlier deletion, in writing, at any time.

## 6. Leaving AutoEd entirely

1. The Client's administrator gives notice of termination (or the last subscription lapses).
2. AutoEd provides a full **CSV/Excel export** of the Client's data, including attachments listed in an index file `[ASSUMPTION: files delivered as a downloadable archive]`.
3. **30 days after the leaving date** (or after the export is delivered, whichever is later `[CONFIRM]`) AutoEd **deletes** all the Client's data from live systems and confirms in writing on request.
4. Records AutoEd must keep by law (our own invoices and accounting records, about 8 years `[CONFIRM]`) are kept as AutoEd's own records and are not Client content.
5. Backups holding the data are overwritten on their normal cycle `[CONFIRM]`.

## 7. Chargebacks and disputes

If a payment is disputed with a bank, we may suspend the product while it is resolved. Please contact us first at `[BILLING EMAIL]`.

## 8. Contact

`[BILLING EMAIL, company name, GSTIN, address]`

## Open points for counsel (this document)

1. Whether a cooling-off refund window is required or advisable for online sale to institutions; applicable consumer or e-commerce rules.
2. Enforceability of "no refund on annual plans" and auto-renewal terms; RBI e-mandate rules.
3. GST credit note mechanics for refunds and treatment of gateway fees.
4. Whether read-only mode followed by deletion at day 30, versus day 30 plus export notice, matches the contract and the Fiduciary's obligations to its own data principals.
5. Treatment of shared master data when only one product lapses.
