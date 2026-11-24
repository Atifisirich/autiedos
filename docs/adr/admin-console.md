# ADR: Platform admin console (AutoEd staff manage clients)

Status: built and tested on local Postgres only; nothing deployed, no Supabase or Vercel call made. Date: 2026-11-24.
Implements plan phase 4 (`docs/PLAN-unified-platform.md` 4.2, 4.4, 11). Decisions used: #34 (entitlements per org and
optional per branch), #37 (one person, one client; staff reach a client only through "view as"), #42 (30 days read-only),
#45 (whole products only), #54 (AutoEd staff are platform admins and use view-as), #32/#33 (Razorpay + GST, no live call).

## Where things are

| Part | Path |
|---|---|
| Database functions (migration, **new file**) | `supabase/migrations/20261125000001_platform_admin_console.sql` |
| Server: services + route table `dispatchAdmin(req)` | `packages/server/src/platform-admin/**` (export `@autoed/server/platform-admin`) |
| Web: pages | `apps/web/app/admin/**` (clients, new client, client detail with six tabs, audit, plans, support, login) |
| Web: API catch-all | `apps/web/app/api/admin/[...path]/route.ts` (cookie `admin_session`) |
| i18n | `packages/shared/src/i18n/source/admin.txt` (keys `console.*`; Hindi and Telugu **need native review**) |
| Tests | `packages/server/test-platform/admin-*.test.ts` (run by `pnpm test:platform`) |

## How access works

* The console connects **only** as login role `platform_admin_server` (`ADMIN_DATABASE_URL`; there is no fallback to
  `DATABASE_URL`, and it is never `service_role`). Each request checks `current_user` and `session_user`; any other
  role fails the request with `admin_db_wrong_role`.
* A request is one transaction with the admin's JWT claims. `app.is_platform_admin()` is asked of the database first;
  a client user, a signed-in user with no client, a deactivated admin and anonymous callers are all refused on **every**
  route (test `admin-security`). Removing admin rights applies on the next request: the console session
  (`autoed-admin` JWT, 8 hours, cookie) proves identity only.
* Writes carry the header `x-admin-client: 1` (a second guard next to SameSite=Lax).
* Sign-in: Supabase token -> console session (`POST /auth/session`), or e-mail only when `AUTH_PROVIDER=dev` outside production.

## Why a migration, and why functions instead of policies

Harness test T9 requires that a platform admin without a support session sees **no** client master data
(`core.branches`, `core.org_users`, product tables). The console still has to create a client's first branch and admin,
list users, lock accounts and grant product access. Adding policies would break T9, so each of those is a narrow
`security definer` function (`app.admin_*`, `search_path = ''`, `app.is_platform_admin()` checked first, execute granted
to `platform_admin_server` and `service_role` only, revoked from PUBLIC). They write through tables that carry the audit
triggers, so every row change is in `audit.log` with the admin as actor. Tests prove: the other roles cannot execute them,
a client admin cannot run them even on the right role, and the console role still sees zero branches/users/product rows
directly (T9 stays true).

Direct console access (already granted by the foundation): organisations, subscriptions, per-branch switches, billing
tables, support sessions, `audit.*`, `core.login_events`, `core.user_security` (read).

## Features and how each is audited

Every mutating route does its row changes (audit trigger) **and** one named `admin.*` event through `app.admin_log_event`
(`admin.client.create`, `.suspend`, `admin.subscription.transition...`, `admin.user.lock`, `admin.view_as.start`, ...). The
test helper asserts this for every write it drives, and a final test fails if any write route of the route table was not
driven.

* **Clients list with health/status**: health is computed (`health.ts`) from subscriptions, locked users, invites not
  accepted, last sign-in; the reasons are shown beside the badge. Thresholds (trial ends within 7 days, no sign-in for
  30 days, 14 days for a new client) are product defaults, not owner decisions.
* **Create client in one step**: organisation + first branch + subscription per product (+ built-in `admin` role per
  product) + optional billing profile + first admin (auth invite, organisation link, admin role in every bought product)
  in one transaction. If the database part fails after the auth user was created by this call, the user is removed
  again; an existing login is never removed.
* **Suspend / reactivate a client**: `core.organizations.status` `closed` / `active`. `app.current_org_id()` and
  `app.org_has_product()` require an active organisation, so every product is off on the next request.
* **Subscriptions** (add, change plan/seats/end date, per-product transitions): the state machine of
  `packages/shared/src/billing/subscription.ts`. `core.subscriptions` has only status, plan, dates and seats, so the full
  `SubscriptionState` is rebuilt from the row (trial end = `ends_on`; past-due-since from `audit.config_history`;
  suspended / cancelled stamped by `ends_on`, set to the last day of access). Console events: activate (payment
  succeeded), mark past due, suspend (halted), cancel, tick. A refused transition is HTTP 409 `transition_not_allowed`
  with the machine's reason (for example `terminal`). `cancelled` is terminal in the machine; a separate **restart**
  action (cancelled only) starts the product again as a fresh trial or active period.
  `POST /billing/tick` applies time rules to all live subscriptions (what the nightly job will do).
* **Per-branch product on/off**: `core.org_branch_products`.
* **User product access**: grant / change role / revoke per product; refused for a product the client has not bought.
* **Users**: list, invite, lock / unlock (`core.user_security.locked_until`, read by `app.login_allowed`), force password
  change flag (`must_change_password`), activate / disable. Lock, unlock, force reset and status changes require a reason.
* **View-as**: `app.start_support_session` (reason >= 10 characters, 1-240 minutes, read-only by default, one open session
  per admin, start/end events). The console returns banner data (`GET /view-as/current`, `currentViewAs()` for product
  apps) and lists sessions; `clientSupportSessions()` is for product servers to show a client admin the support log of their
  own organisation (RLS decides who sees rows; the staff member's name is not exposed).
* **Billing and usage**: plans (list, upsert), billing profile (GSTIN state must match state code), entitlements by the
  billing rules (full / read-only for 30 days / none, shown beside the database gate), usage per month and metric,
  invoices, payments, Razorpay mode (never a key). **Draft invoices only**, using `computeInvoice`, `financialYearOfDate`,
  `formatInvoiceNumber`: CGST+SGST or IGST by supplier state vs place of supply, numbers `AE/26-27/000001` allocated under
  an advisory lock per financial year; a voided draft keeps its number. No Razorpay call is made anywhere.
* **Audit viewer**: `audit.log` and `audit.config_history`, filters by client, actor, action prefix, table, row, dates, free
  text; keyset paging.
* **Entitlement preview** ("what can this user see"): `app.admin_entitlement_preview` gives the facts the policies use
  (`org_has_product`, `branch_has_product`, role permissions, visible branches); the service turns them into modules with
  widest view scope, branches on/off, reasons a product is off, and billing access.

## Configuration

| Variable | Purpose |
|---|---|
| `ADMIN_DATABASE_URL` | Connection as `platform_admin_server` (required) |
| `AUTH_JWT_SECRET` | Signs the console session (required in production) |
| `SUPABASE_URL`, `SUPABASE_JWT_SECRET` | Verify Supabase tokens at sign-in |
| `SUPABASE_AUTH_ADMIN_KEY` | Auth admin API key used to invite users (`/auth/v1/invite`), **never run against a real project from this build** |
| `AUTOED_SUPPLIER_STATE_CODE`, `AUTOED_SUPPLIER_GSTIN` | AutoEd's own GST identity; invoices are refused without the state code |
| `ADMIN_DEFAULT_TRIAL_DAYS` (14), `ADMIN_VIEW_AS_MINUTES` (60) | Defaults, not owner decisions |
| `ADMIN_DEV_AUTH_DATABASE_URL` | Dev only (`AUTH_PROVIDER=dev`, not production): inserts invited users into the local `auth.users` shim |

## Not done / open

* **Wallet balances (AI credits, messaging)**: no wallet tables exist yet; the billing tab shows `billing.usage` and says so.
* **Cancel at period end** is not offered: `core.subscriptions` cannot store it.
* **Invoice issue, PDF, payment links, Razorpay webhooks, credit notes** belong to the billing integration stream.
* **Admin MFA**, IP allow-listing and session revocation lists for console sessions are not built (the admin check per request
  covers removal of an admin).
* The invite adapter for Supabase is written from the public API shape and untested; a platform admin account is created out
  of band (`insert into core.platform_admins`). `platform_admin_server` needs a password set per environment (ADR 001).
* **Client-side read-only (decision 42)** is not enforced by the database (`cancelled` / `suspended` remove access at once,
  see `platform-foundation.md`); the console shows the 30-day window from the shared entitlement rules beside the gate.
* Decision 54 says staff "belong to the AutoEd org"; ADR 003 and the foundation keep `core.platform_admins` outside any org.
  The console follows the foundation (no org link needed). Revisit if the AutoEd org is created.
* Hindi and Telugu strings are a best-effort first translation and need native review.
* The web pages were checked in headless Chrome at 1100 px and 390 px (no page-wide horizontal scroll, labels, keyboard tabs,
  live regions) but not with a screen reader or an accessibility audit tool.
