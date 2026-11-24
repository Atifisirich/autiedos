# PLAN-unified-platform.md — AutoEd CRM + OS + ERP in one database, sold separately

Status: **plan only. Nothing in this document has been built.** Written 2026-11-24 for the owner (Atif) and
for whoever continues the build on another Claude account. Read this together with `docs/HANDOFF.md`
(state of AutoEd OS) and the open questions in section 14. No phase starts until the questions it depends
on are answered.

---

## 1. Goal in one paragraph

Run the three AutoEd products — **CRM** (admissions, leads, enquiries, communication), **OS** (school
operations: tasks, attendance, leave, timetable, lesson plans, exams, helpdesk, reports — already built) and
**ERP** (fees, accounts, payroll, inventory, transport etc., scope to be confirmed) — on **one Supabase
Postgres database**, while selling each product **on its own or in any combination**. A client that buys
only CRM must be able to use CRM fully, must never see OS or ERP screens, features or data, and its data
must never mix with another client's data. Adding or removing a product for a client must be a setting,
not a migration or a code change.

## 2. Non-negotiable rules (add to the PRD hard rules)

1. **Tenant isolation is enforced in the database** (Row Level Security), not only in the app. A bug in any
   app must not be able to return another client's rows.
2. **Product isolation is enforced in the database too.** A table that belongs to a product is readable
   only when the client has an active subscription to that product *and* the user has been given access
   to that product.
3. **Three layers, every time:** database (RLS + grants), API (server checks), UI (navigation, routes).
   The UI layer is only for convenience; the database layer is the guarantee.
4. **Every table has `org_id`** (the client / tenant), except a short, reviewed list of global reference
   tables (curriculum maps, presets, product catalogue).
5. **One migration stream** for the whole database, in one repository, applied only by
   `supabase db push` / CI. Nobody edits tables in the Supabase dashboard in production.
6. **Every change to entitlements, roles or data is audited** (`audit.log`), including actions by
   platform staff ("view as" / support access).
7. **Student and staff personal data never goes to an AI provider** (existing PRD rule, kept). AI providers
   are server-side only and on paid tiers that do not train on our data.
8. **Each product's server connects with its own database role** that can only touch its own schema and
   the shared core. The CRM server physically cannot query OS or ERP tables.
9. **No feature ships without an isolation test**: one tenant cannot read another; a client without a
   product cannot read that product's tables; a user without product access cannot either.
10. **Decisions go in `docs/DECISIONS.md`, verification in `docs/BUILD-LOG.md`** (existing rule, kept).

## 3. What exists today (verified 2026-11-24)

| Thing | State |
|---|---|
| Repo `Atifisirich/autiedos` | AutoEd OS monorepo (Next.js web, Expo mobile, `packages/shared`, `packages/server`, Supabase migrations). Branch `claude/gallant-brown-d1cc0z` has everything; **nothing merged to `main`**. |
| OS database design | 6 migrations, 128 tables, **all in the `public` schema**. RLS on every table via `app.apply_rls`. Tenancy is `organizations` → `branches`. Module flags per branch (`module_flags`). Plans and AI credits exist (`plans`, `ai_credit_ledger`). |
| OS verification | `pnpm lint`, `typecheck`, 63 shared tests, 42 server tests (incl. 20 RLS tests), `next build`, browser smoke test (2 users × 3 languages × 47 screens) — all pass on local Postgres 16 + pgvector. |
| OS limitation relevant here | `staff.user_id` is **unique** and `app.my_org_id()` returns **one** org: today a login can belong to only one client. Must change for a shared platform (section 5.3). |
| Repo `Atifisirich/autoedcrm` | **Exists** (last push 2026-11-16). **Not read yet.** The earlier audit (`docs/AUDIT.md`) could not access it. |
| ERP | **No code found** in the repositories this account can see. Scope unknown (question Q4). |
| Supabase | Org **digivate**. Projects: `autoed-crm-mumbai` (Mumbai, **active**, Postgres 17), `autoedcrm` (Seoul, paused), `intake-by-digivate` (Mumbai, paused). On 2026-11-16 `autoed-crm-mumbai` had **no tables** in `public`; **not re-checked since** — it may now hold live CRM data. Plan (free/Pro) not visible to the tools. |
| Vercel | Account `atif60002-9526`, one team, **Hobby plan**. Projects not listed yet. PRD mentions a Vercel project `autoed-crm`. |
| Local dev | Postgres 16 + pgvector on port 54322 in `/tmp/pgdata` (lost when the cloud container is reclaimed). |

## 4. Target architecture

### 4.1 One Supabase project, several schemas

New project **`autoed-platform`** in **Mumbai (ap-south-1)**, Supabase Pro. (Recommendation; see Q1 for
reusing `autoed-crm-mumbai` instead.)

| Schema | Holds | Who may touch it |
|---|---|---|
| `core` | Tenants (organizations, branches), identity (memberships, user product access), product catalogue, subscriptions, shared master data (people/staff, students, guardians, classes, sections, academic years), files index | All three product servers (read; writes only through `core` functions for entitlement tables) |
| `crm` | Leads, enquiries, campaigns, follow-ups, admissions pipeline, CRM messaging, CRM settings | CRM server only |
| `os` | Everything AutoEd OS has today except what moves to `core` (tasks, attendance, leave, timetable, lesson plans, exams, helpdesk, circulars, reports …) | OS server only |
| `erp` | Fees, invoices, receipts, accounts, payroll, inventory, transport … (scope Q4) | ERP server only |
| `audit` | `audit.log`, `audit.config_history`, support-access log | Insert by triggers; read by platform admins and client admins (own org) |
| `billing` | Platform plans, invoices to clients, payments, usage (AI credits, WhatsApp messages) | Platform admin server; read-only views for client admins |
| `app` | Security helper functions (`app.my_org_ids()`, `app.has_product()`, `app.can()` …). No tables. | Executed by policies |
| `private` | Secrets-adjacent internals, job queue, rate limits. **Never exposed through the Data API.** | Service role / job runner |

Postgres extensions (`pgcrypto`, `vector`, `pg_trgm`, `citext`) live in the `extensions` schema
(Supabase default), shared by all.

### 4.2 How a product is switched on for a client (entitlements)

```
core.products            (key: 'crm' | 'os' | 'erp', name, active)
core.product_modules     (product_key, module_key)   -- e.g. 'os' owns 'tasks','leave',…; 'crm' owns 'leads',…
core.subscriptions       (org_id, product_key, status: trial|active|past_due|suspended|cancelled,
                          starts_on, ends_on, seats, plan_key, notes)
core.org_branch_products (org_id, branch_id, product_key, enabled)   -- optional per-branch on/off
core.user_product_access (org_id, user_id, product_key, role_key, granted_by, granted_at, revoked_at)
os.module_flags          (existing, per branch, per module — now only for modules inside a product)
```

Rules:

* `app.org_has_product(org_id, 'crm')` = an active/trial/past_due-in-grace subscription row exists.
  `suspended` and `cancelled` return false.
* `app.user_has_product(org_id, 'crm')` = `org_has_product` **and** the signed-in user has an
  un-revoked `user_product_access` row for that org and product.
* A module check (`os.module_flags`) only applies after the product check passes.
* Changing a subscription takes effect on the next request (functions are `stable`, no long caching).
* What happens to data when a product is cancelled: **kept read-only for a grace period, then exported
  and deleted** on request or after the retention period (Q19, Q20).

### 4.3 How isolation is enforced — the three layers

**Layer 1 — database (the guarantee)**

Every product table gets a policy of this shape (generated by an extended `app.apply_rls`):

```sql
-- example for crm.leads
create policy sel on crm.leads for select to authenticated using (
  app.user_has_product(org_id, 'crm')            -- tenant + product + user access in one check
  and app.can('leads', 'view', org_id, branch_id, owner_id, null, null)   -- existing role/scope logic
);
```

* `core` master-data tables (students, staff, classes …) are readable when the user has **any** product
  for that org, and writable only through the product that owns that field set (section 4.5).
* Grants: product schemas are **not** granted to `anon`. Only `authenticated` (through RLS) and the
  product's own server role.
* **Data API (PostgREST) exposure:** expose only what a client app must call directly (today: nothing
  except Supabase Auth). All three products talk to the database through their own server API, as the OS
  already does. RLS still applies because the server runs each request as the signed-in user
  (`run(ctx, …)` sets `request.jwt.claims` and `role authenticated`).

**Layer 2 — product servers**

* Each product server (CRM, OS, ERP) connects through the Supabase pooler as its **own login role**:
  `crm_server`, `os_server`, `erp_server`. Each role is granted `USAGE` on `core` + its own schema only.
  Even with a bug or SQL injection, the CRM server cannot read `os.*` or `erp.*` (the grant is missing,
  not just the policy).
* Each request: verify session token → load `org_id`, user, products → reject with 403 if the product is
  not in the session (`needProduct('crm')`, next to the existing `need()` / `needModule()`).
* Jobs and cron handlers loop only over orgs that have the product.
* `service_role` (bypasses RLS) is used only by the platform admin server and migrations, never by
  product request handlers. Every use is logged.

**Layer 3 — UI**

* Each app reads `/me` → products and modules → builds navigation. Routes for products the user lacks
  return a "not part of your plan" page, not a crash.
* If a single shell is chosen (Q8), a product switcher shows only purchased products.

### 4.4 Identity and logins

* One Supabase Auth (`auth.users`) for all products. A person signs in once (OTP on phone/email).
* `core.memberships (user_id, org_id, staff_id, status)` replaces the "one user = one staff row" rule, so
  one login can belong to several clients (e.g. a consultant, a group chairman, your own support staff).
* Session token carries the **active org** (switchable) and the list of products for that org.
  `app.my_org_id()` stays (active org); `app.my_org_ids()` is added for cross-org platform views.
* Product access is per user per org (`core.user_product_access`). A school can buy OS and ERP but give the
  accountant only ERP.
* Platform staff access to a client ("view as") stays as the OS has it: time-limited, reason required,
  banner shown, every action audited, client admin can see the support-access log.

### 4.5 Shared master data — who owns what

The point of one database is that a school entered once is the same school in all products.

| Data | Lives in | Written by | Notes |
|---|---|---|---|
| Organization, branches, branding, time zone | `core` | Setup (any product's setup wizard, same code) | |
| Staff (people who log in or are rostered) | `core.staff` | OS / ERP HR screens; CRM for counsellors | ERP payroll fields live in `erp.staff_payroll` (1:1), not in core |
| Students | `core.students` | CRM creates on **admission confirmed**; OS/ERP edit their own fields | CRM leads/enquiries are **not** students; they live in `crm` until converted |
| Guardians / parents contacts | `core.guardians` | CRM / ERP | Personal data — strict policies (section 9) |
| Classes, sections, academic years, subjects | `core` | OS setup (or ERP if OS not bought) | |
| Fee structures, invoices | `erp` | ERP | |
| Timetable, tasks, attendance … | `os` | OS | |

Rule: if only one product needs it, it lives in that product's schema. It moves to `core` only when two
products need the same row. Each move is a decision in `DECISIONS.md`.

**CRM-only client:** has `core.organizations`, `core.branches`, `core.staff` (counsellors),
`core.students` (only when admissions convert), and `crm.*`. No `os` or `erp` rows ever exist for it.

### 4.6 Applications and deployment

Recommended (Q8 decides): **one monorepo, three web apps, shared packages, one database.**

```
apps/os-web     (today's apps/web)        → os.autoed.<domain>
apps/crm-web    (port of autoedcrm)       → crm.autoed.<domain>
apps/erp-web    (new)                     → erp.autoed.<domain>
apps/admin-web  (platform console)        → admin.autoed.<domain>
mobile          (one Expo app, product tabs shown by entitlement) or one app per product (Q9)
packages/shared (zod schemas, i18n, presets, product/module catalogue)
packages/server (core services: auth, tenancy, entitlements, audit, files, AI, notify)
packages/crm-server, packages/os-server, packages/erp-server
supabase/migrations (single stream, file names prefixed by schema)
```

* One Vercel project per web app (separate env vars, separate DB role credentials, separate cron).
* Single sign-on across subdomains via one auth cookie on the parent domain.
* One mobile app with all three products is simpler to publish and maintain; tabs are hidden by
  entitlement. Separate store listings per product are possible later.

### 4.7 Files (Supabase Storage)

* One bucket per product (`crm-files`, `os-files`, `erp-files`) plus `core-files` (logos, student photos).
* Object path always starts with `{org_id}/…`. Storage policies check `app.user_has_product(org_id, …)`.
* Signed URLs only, short expiry, type and size limits (from the OS security backlog).

### 4.8 AI (Gemini or Anthropic)

* One AI adapter in `packages/server` with providers: `anthropic` (exists), `gemini` (to build),
  `mock` (exists). Provider and model per action are rows in `platform_settings`.
* Every call logged in `core.ai_generations` with `product_key` and charged to `billing.ai_credit_ledger`.
* Credits: one wallet per org shared across products, or per product (Q15).
* Gemini must be used on the **paid API tier** (free-tier prompts may be used to improve Google's models —
  not acceptable for school data). Check Google's data-processing terms and region before go-live.

### 4.9 Messaging (WhatsApp, SMS, email, push)

* One channel layer in core (`notify`), one set of provider credentials per org, templates tagged by
  product. CRM's existing messaging (once read) becomes this layer, or this layer wraps it.
* Opt-in and opt-out stored per contact per channel (legal requirement, section 9).

### 4.10 Background jobs

* One `private.jobs` table, one cron tick per app (or one shared tick) — Vercel Pro allows per-minute cron.
* Every job row carries `org_id` and `product_key`; the handler re-checks `org_has_product` before running.

## 5. Changes needed to the existing OS

### 5.1 Move tables out of `public`
* Rename schema targets in the 6 migrations — **or** (safer, keeps history) write new migrations that
  `alter table … set schema core|os`. Because nothing is deployed yet, rewriting the 6 migrations into the
  new layout is acceptable and cleaner. Decision: rewrite (record in DECISIONS.md).
* Update every SQL string in `packages/server` (≈220 routes) to schema-qualified names, or set
  `search_path = os, core, extensions` per role and keep unqualified names. Recommendation: **schema-
  qualify** core tables, rely on `search_path` only for the product's own schema.
* Update `supabase/local/shim.sql`, `scripts/db.mjs`, seed, tests.

### 5.2 Add the product layer
* New tables from 4.2; seed `products` and `product_modules` from `packages/shared/src/modules.ts`.
* Extend `app.apply_rls(table, kind, module)` → `app.apply_rls(schema, table, kind, product, module)` and
  add the product check to every generated policy.
* Add `needProduct()` to the server and product info to `/me`; hide nav accordingly.

### 5.3 Multi-org logins
* Drop `unique (staff.user_id)`; add `core.memberships`; session token gets `org_id` (active) and an org
  switcher endpoint. Update `app.my_org_id()` to read the active org from the claims and verify membership.

### 5.4 Tests to add
* Isolation matrix (section 8) for every table in every schema — generated from the catalogue, so a new
  table without a policy fails CI.

## 6. CRM integration (depends on reading `Atifisirich/autoedcrm`)

1. Read the CRM repo and, read-only, the CRM database schema (`autoed-crm-mumbai`). Produce
   `docs/AUDIT-CRM.md`: tables, row counts, auth method, external integrations, Vercel config.
2. Map each CRM table to `core` or `crm` (table-by-table decision list).
3. Port the CRM server to the shared packages (auth, tenancy, entitlements, audit) and its own DB role.
4. Data migration script (idempotent, re-runnable): export from `autoed-crm-mumbai` → transform → load
   into `autoed-platform`. Dry run on a copy; row-count and checksum report per table.
5. Cutover (section 10). Old project kept read-only for 30 days as rollback, then paused, then deleted after
   a final backup (Q2).

## 7. ERP (new build, scope from Q4)

Planned in the same way as the OS was: a short ERP PRD first (modules, roles, reports, Indian
requirements: GST invoices, fee receipts, TDS/PF/ESI for payroll if in scope, Tally export), then schema in
`erp`, then server, then UI. Reuse `core` for school, staff, students; ERP-specific fields in `erp`.
Do not start ERP code before the ERP PRD is approved.

## 8. Isolation and security test plan (must pass before any client data goes in)

Automated (Vitest against a real Postgres, run in CI on every push):

| # | Test | Expected |
|---|---|---|
| T1 | User in org A selects every table | Zero rows from org B, in every schema |
| T2 | Org with only CRM: its admin selects every `os.*` and `erp.*` table | Zero rows; inserts rejected |
| T3 | Org with CRM+OS, user granted only OS | `crm.*` returns zero rows |
| T4 | Subscription set to `suspended` | All product reads fail on the next request |
| T5 | `crm_server` role runs `select * from os.tasks` | Permission denied (grant missing) |
| T6 | `anon` role on every schema | Nothing readable except explicitly public reference data |
| T7 | Every table in `crm`, `os`, `erp`, `core` has RLS enabled and ≥1 policy | Catalogue check; fails CI if not |
| T8 | Storage: org A requests org B object path / product bucket without product | Denied |
| T9 | Support "view as" | Works only with an open support session; audited |
| T10 | Cross-org user switches org | Sees only the active org's data |
| T11 | Job runner for an org without the product | Job skipped and logged |
| T12 | Supabase security advisor (`get_advisors security`) | No errors |

Manual before go-live: the `security-review` skill on the full diff; a penetration-style pass on the APIs
(IDOR on every `:id` route); review of every `security definer` function (`search_path` set, no dynamic
SQL from input).

## 9. Legal and compliance (India) — needs a lawyer; this is not legal advice

* **Digital Personal Data Protection Act 2023 and DPDP Rules 2025.** Schools are the *data fiduciaries*;
  AutoEd is a *data processor* for school data and a *fiduciary* for its own client-contact data (CRM
  leads may be AutoEd's own marketing data or the school's — clarify per client, Q22).
* **Children's data:** processing data of under-18s needs verifiable parental consent (obtained by the
  school); no tracking, profiling or targeted advertising of children. Our AI rule (no student PII to AI)
  supports this. Admissions CRM leads are often minors' data — same rules.
* **Contracts:** a client agreement + **Data Processing Agreement** per client, listing sub-processors
  (Supabase/AWS Mumbai, Vercel, Google Gemini or Anthropic, WhatsApp provider, Expo/Firebase, Sentry) and
  where each processes data.
* **Data location:** database and storage in Mumbai. Vercel functions should be pinned to the Mumbai
  region (`bom1`). AI and push providers may process outside India — disclose in the DPA.
* **Breach notification:** process to notify affected clients and the Data Protection Board within the
  time the Rules require; keep an incident runbook.
* **Rights requests:** export and delete per person and per org. Build tools for both (Phase 6).
* **Retention:** default retention per data type (leads, students after leaving, audit logs, AI logs) set
  with the lawyer; enforce with a scheduled purge job.
* **Messaging consent:** WhatsApp opt-in records; TRAI rules for promotional SMS (DLT registration) if SMS
  is used.
* **Financial records (ERP):** GST invoice rules and statutory retention (commonly 8 years for books of
  account) if ERP issues invoices or keeps accounts.
* **Your own terms:** privacy policy, terms of service, refund policy for subscriptions.

## 10. Phased delivery plan

Each phase: work on a branch, all checks green, BUILD-LOG updated, owner sign-off before the next phase.

| Phase | Work | Done when | Needs from owner |
|---|---|---|---|
| **0. Decisions & accounts** | Answer section 14. Upgrade Supabase org to Pro, Vercel to Pro. Buy/choose domain. | Answers recorded in DECISIONS.md | Q1–Q25, payments |
| **1. Discovery** | Read `autoedcrm` repo; read-only schema + row counts of `autoed-crm-mumbai`; list Vercel projects; write `AUDIT-CRM.md`; draft ERP scope doc | Audit and ERP scope reviewed | Read-only access approval |
| **2. Platform core design** | ADRs for schemas, entitlements, identity; write `core`, `app`, `audit`, `billing` migrations; DB roles; isolation test harness (T1–T12) running on an empty platform | Harness green locally and in CI | — |
| **3. Move OS onto the platform** | Section 5. All existing tests + new isolation tests + browser smoke green | `pnpm` checks + smoke + T1–T12 pass | — |
| **4. Platform admin console** | Clients, subscriptions, product on/off per org and branch, user product access, support sessions, usage, audit viewer | Can create a CRM-only client and an OS+ERP client from the UI; T2/T3 pass on them | — |
| **5. CRM onto the platform** | Section 6 steps 1–4 on staging | CRM works for a CRM-only test client; data migration dry run report matches row counts | CRM walkthrough with owner |
| **6. Compliance tooling** | Export/delete per person and per org; retention purge job; consent records; support-access log visible to clients | Tested on demo data | Lawyer's retention periods |
| **7. Staging deploy** | Staging Supabase project (or Supabase branch) + Vercel previews; Gemini adapter; Sentry; per-minute cron; storage | E2E flows pass on staging URLs | Gemini key, Sentry DSN |
| **8. Production + CRM cutover** | Create `autoed-platform`; push migrations; deploy apps; freeze CRM writes; final migration; verify counts; switch DNS; monitor | Owner signs off checklist; rollback window opens | Cutover date, downtime approval |
| **9. ERP** | ERP PRD → schema → server → UI, on the platform | ERP acceptance tests pass | ERP scope sign-off, sample data |
| **10. Operate** | Backups restore drill, monitoring, on-call runbook, cost review | Restore drill done | — |

Rough effort (one engineer working with Claude, after answers): phases 1–4 ≈ 2–3 weeks; phase 5 depends on
CRM size; phases 6–8 ≈ 2 weeks; ERP is a product of its own (weeks to months by scope).

### Rollback per risky step
* **Schema move of OS (phase 3):** not deployed yet, so rollback = previous branch.
* **CRM cutover (phase 8):** old project stays untouched and read-only; DNS points back; data written to
  the new platform during the window is exported by the migration script in reverse (keep the window short).
* **Every production migration:** tested on a Supabase branch with production-like data first; backup taken
  right before `db push`.

## 11. Operations

* **Backups:** Pro gives daily backups (7 days). Consider Point-in-Time Recovery add-on before many clients
  (Q18). Restoring one client = restore to a separate project and copy that org's rows back (script to
  write in phase 6).
* **Noisy neighbours:** `statement_timeout` per server role (e.g. 15 s for request roles, longer for job
  role); heavy reports on a read replica when needed; indexes start with `org_id`.
* **Monitoring:** Sentry (web, mobile, servers), Supabase advisors after every migration, query
  performance report monthly, alert on failed cron ticks.
* **Environments:** local (Postgres + shim) → staging (separate Supabase project) → production.
* **Secrets:** only in Vercel/Supabase env settings; per-product DB role passwords; rotate on staff change.

## 12. Cost (list prices as remembered — verify on the pricing pages)

| Item | Monthly |
|---|---|
| Supabase Pro (org) incl. one Micro compute | ~$25 |
| Each extra active project (e.g. staging, or the old CRM during cutover) | ~$10 each (Micro) |
| Vercel Pro, per seat | ~$20 |
| PITR add-on (optional) | ~$100 |
| Gemini, WhatsApp, Sentry, domains | usage / provider |

With one platform project + one staging project + one Vercel seat: **~$65/month** before usage. After
cutover the old `autoed-crm-mumbai` can be paused (stops its compute charge).

## 13. Risk register

| Risk | Impact | Mitigation |
|---|---|---|
| Policy mistake leaks data across clients or products | Severe (legal, trust) | DB-level product check, per-product roles, T1–T12 in CI, security review, advisors |
| CRM is live; migration loses or corrupts data | Severe | Dry runs, checksums, write freeze, keep old project 30 days |
| Unknown CRM design conflicts with OS core tables | Delays | Discovery phase before design is final |
| One heavy query slows all products | Medium | Timeouts, indexes, replica later |
| One bad migration takes all products down | High | Branch testing, backup before push, small migrations, off-hours |
| Children's data handled outside DPDP rules | Severe | Lawyer review, DPA, consent, AI PII ban |
| Single account owns everything (Supabase/Vercel/GitHub) | Medium | Second owner/admin on each, 2FA, documented access |
| Gemini free tier used by mistake | High | Config check at startup refuses non-paid key setting in production |

## 14. Questions for the owner (please answer all; number your answers)

**Products and selling**
1. Use a **new** Supabase project `autoed-platform` (recommended) or turn the existing `autoed-crm-mumbai`
   into the platform?
2. Does `autoed-crm-mumbai` hold **live client data** today? Roughly how many clients, users, rows? Can
   CRM be read-only for 1–2 hours during cutover?
3. Is `Atifisirich/autoedcrm` the real, current CRM code? Is anything else (another repo, no-code tool,
   spreadsheet) part of the CRM?
4. What is the **ERP**? Which modules (fees, accounts, payroll, inventory, transport, library, hostel,
   admissions)? Does any ERP code or product exist somewhere else?
5. Who are the clients: only schools, or also coaching centres, colleges, non-education businesses (would
   change the `core` model)?
6. Can a client buy **single modules** inside a product (e.g. only OS helpdesk), or only whole products?
7. Should each **branch** of a group be able to have different products?

**Apps and logins**
8. One web app with a product switcher, or **separate web apps per product** on subdomains (recommended)?
9. One mobile app for all products (recommended), or one app per product?
10. Domain to use (e.g. `autoed.in`)? Do you own it?
11. Login methods: phone OTP, email OTP, Google sign-in, password? Same for all products?
12. Can one person belong to several clients (consultants, group owners, your support staff)?

**Data rules**
13. Should CRM leads, once admitted, become `core.students` automatically?
14. Who is the source of truth for staff: OS, ERP (HR/payroll), or whichever the client bought first?
15. AI credits: one wallet per client shared by all products, or per product? Which AI provider by default
    (Gemini, as you said)?
16. WhatsApp: one provider account for all clients (yours) or each client brings its own?
17. Should parents/students ever log in (portal), now or later? (Changes privacy scope a lot.)

**Safety, legal, operations**
18. Buy Point-in-Time Recovery (~$100/month) now or later?
19. When a client stops paying for a product: how many days read-only, then what?
20. When a client leaves entirely: export format (Excel/CSV/JSON) and how soon to delete?
21. Do you have a lawyer for the DPA, privacy policy and terms? Is AutoEd a registered company (name for
    contracts and invoices)?
22. In CRM, are leads the **school's** data or **AutoEd's** marketing data?
23. Who else should have admin access to Supabase, Vercel and GitHub (backup owner)?
24. How will you bill clients: manual invoices, Razorpay subscriptions, or another gateway? GST registered?
25. Target date for the first paying client on the unified platform, and which product will it use?

## 15. Handoff for the next account / session

**Repository:** `github.com/Atifisirich/autiedos`, branch `claude/gallant-brown-d1cc0z` (contains the
whole OS build, this plan, CI workflow, the `/os/coverage` page). Nothing merged to `main`.

**Read in this order:** this file → `docs/HANDOFF.md` → `docs/DECISIONS.md` → `docs/BUILD-LOG.md` →
`docs/PRD-autoed-os.md` → `docs/AUDIT.md`.

**Set up and verify the existing OS first** (from `docs/HANDOFF.md` §4C):

```bash
apt-get install -y postgresql-16-pgvector        # if the vector extension is missing
mkdir -p /tmp/pgdata && chown postgres /tmp/pgdata
su postgres -c "/usr/lib/postgresql/16/bin/initdb -D /tmp/pgdata -A trust -U postgres"
su postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D /tmp/pgdata -o '-p 54322 -k /tmp' -l /tmp/pg.log start"
pnpm install
pnpm i18n:build && pnpm db:reset                  # i18n BEFORE reset, or inbox shows raw keys
pnpm lint && pnpm typecheck
pnpm --filter @autoed/shared test                 # 63
pnpm --filter @autoed/server test                 # 42
pnpm --filter @autoed/web build
# then: next start with AUTH_PROVIDER=dev NEXT_PUBLIC_AUTH_PROVIDER=dev AUTH_JWT_SECRET=<any>
# and BASE_URL=http://localhost:3000 node apps/web/e2e/smoke.mjs
```

**Connected accounts seen on 2026-11-24** (check again — the new account may see different ones):
Supabase org `digivate`; Vercel account `atif60002-9526` (Hobby). GitHub repos include
`Atifisirich/autoedcrm` (CRM, unread).

**Do not:** write to `autoed-crm-mumbai` or the CRM repo before Phase 1 is approved; create paid
resources without the owner confirming cost; send real student/staff data to AI; skip isolation tests.

**Suggested first prompt for the next session:**

> Read docs/PLAN-unified-platform.md, then docs/HANDOFF.md, DECISIONS.md and BUILD-LOG.md in
> Atifisirich/autiedos (branch claude/gallant-brown-d1cc0z). Set up the local database and confirm the
> verification commands pass. My answers to the questions in section 14 are: <answers>. Record them in
> DECISIONS.md, then start Phase 1 (discovery) — read-only only — and stop for my review before Phase 2.
> Do not claim anything is verified unless you ran it and saw it pass.
