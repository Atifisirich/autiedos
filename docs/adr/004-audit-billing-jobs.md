# ADR 004 — Audit, billing shapes, jobs and rate limits

Status: accepted (Phase 2 foundation). Date: 2026-11-24.
Implements plan rule 6, §4.10, decision 32 (Razorpay + GST).

## Audit

* `audit.log` (row changes and named events, `support_session_id`, no FK on `org_id` so history survives an org
  deletion) and `audit.config_history` (configuration and entitlement changes).
* Triggers `app.platform_audit_row()` and `app.platform_config_history_row()` (security definer) are attached by
  `app.enable_audit(schema, table, config)`, which `app.apply_rls` calls. Config history is on organizations,
  subscriptions, org_branch_products, org_users, user_branch_access, learner_links, roles, role_permissions,
  user_product_access and every `product_config` table. `core.login_events` is itself a log and has no trigger.
* Read: platform admins, and org members with `audit.view`. No write grant to anyone but triggers/functions.

## Billing (shapes only; integration built late)

`billing.plans` (global price list, paise, SAC code, GST rate, `razorpay_plan_id`), `billing.accounts` (legal name,
GSTIN with format check, state code = place of supply, `razorpay_customer_id`), `billing.razorpay_subscriptions`,
`billing.invoices` (sequential number per financial year, supplier/customer GSTIN, place of supply,
taxable/CGST/SGST/IGST in paise; checks: total = sum, intra-state → no IGST, inter-state → no CGST/SGST),
`billing.invoice_lines`, `billing.payments` (Razorpay order/payment ids), `billing.usage` (metered AI credits,
WhatsApp etc. per product). Written by `platform_admin_server` (policy: platform admin); client admins with
`billing.view` read their own org. Razorpay webhooks land in `private.webhook_events` (unique provider + event id).

## Jobs and rate limits

* `private.jobs` carries `org_id` and `product_key`. `private.claim_jobs(product, worker, limit)` first marks due
  jobs of orgs without an active subscription to that product as `skipped` (with `skip_reason`) and writes a
  `job.skipped` event to `audit.log`, then claims the rest with `for update skip locked`.
  `private.finish_job(id, ok, error)` retries with exponential backoff up to `max_attempts`.
  `app.enqueue_job(product, kind, payload, run_at)` enqueues for the caller's org and refuses a product the user
  does not have.
* `private.rate_limits` + `app.rate_limit_hit(key, limit, window_seconds, org)` (fixed window).
* `private` tables have RLS on and no policies; only these security definer functions touch them. `job_runner`
  may execute them; nobody else is granted the tables.
