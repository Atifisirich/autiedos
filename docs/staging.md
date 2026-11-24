# Staging (hosted preview) - free tiers only

A staging copy of the platform runs on the owner's existing Supabase project `autoed-crm-mumbai` (ref `cixiopoeudhyxbmsgyyl`,
ap-south-1, free plan) and the owner's Vercel Hobby team (project `autoed-platform-staging`, preview deployments of the branch
`claude/confident-ritchie-qs7c7g`; nothing is promoted to production and no domain is attached). The old CRM demo schema
`autoed` in the same database (used by the Vercel project `autoed-crm`) is not touched.

## Database

* Schema: every file of `supabase/migrations` applied in filename order with the Supabase MCP `apply_migration` (one migration per
  file, same name without `.sql`). Each call fetched the file from GitHub at a pinned commit through the `http` extension and checked
  its sha256 before running it, so the applied SQL is byte-identical to the repository. No file needed a change for real Supabase.
  `supabase/local/shim.sql` is local only and was not applied.
* Login roles `os_server`, `crm_server`, `erp_server`, `platform_admin_server`, `job_runner` have random passwords, set out of band
  (never in a migration or in git); they live only in the Vercel environment variables.
* Data API: the schemas `core`, `erp` and `audit` are exposed to PostgREST (`alter role authenticator set pgrst.db_schemas = 'public,
  graphql_public, core, erp, audit'`). **Also add them in the dashboard** (Project Settings -> Data API -> Exposed schemas), otherwise a
  later change saved there can drop them again.
* Demo data: `supabase/staging/*.sql`, made by `scripts/export-staging-data.mjs` from a local database built with

  ```bash
  export DATABASE_URL=postgres://postgres@localhost:54322/staging
  pnpm i18n:build && pnpm db:reset                                       # OS demo school (@demo.school)
  ERP_DEMO_DOMAIN=erp.demo.school node scripts/seed-erp-demo.mjs && node scripts/seed-erp-demo-extras.mjs   # ERP demo school
  (cd apps/web && CRM_DATABASE_URL=postgres://crm_server@localhost:54322/staging npx tsx e2e/crm-seed.mts)  # CRM demo school (@demo.test)
  node scripts/export-staging-data.mjs
  ```

  `00-auth.sql` holds the demo logins (auth.users + auth.identities, no passwords), `01-truncate.sql` empties core/os/crm/erp/billing,
  `02..NN-data.sql` are data-only inserts (under 1 MB each, `session_replication_role = replica`), `counts.json` the expected row counts.
  `audit` and `private` are not copied. Loading them again resets the staging data. The demo logins share one demo password set
  directly in `auth.users` (bcrypt), so Supabase Auth password sign-in works; it is not in git.

## Vercel

* Root directory `apps/web`, framework Next.js, Node 22, pnpm workspace install from the repository root, functions in `bom1`.
* Vercel treats this branch as the project's production branch, so a push creates a *production* build. The project's
  "Ignored Build Step" skips every production build (`VERCEL_ENV=production` -> exit 0); previews are created with the Vercel
  MCP `create_deployment` (git source = this branch, no target) and are reachable at the branch alias
  `autoed-platform-staging-git-cla-2fab22-atif60002-9526s-projects.vercel.app`. Production has no environment variables.
* Environment (Preview only): one connection string per role through the Supavisor **transaction** pooler
  (`postgres://<role>.cixiopoeudhyxbmsgyyl:<password>@aws-1-ap-south-1.pooler.supabase.com:6543/postgres`, `DATABASE_SSL=true`):
  `OS_DATABASE_URL`, `CRM_DATABASE_URL`, `ERP_SERVER_DATABASE_URL`, `ADMIN_DATABASE_URL` / `PLATFORM_ADMIN_DATABASE_URL`,
  `JOB_DATABASE_URL`; `DATABASE_URL` points at `os_server` too (no owner connection exists on staging). Plus
  `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` (the project's publishable key), random
  `AUTH_JWT_SECRET`, `CRON_SECRET`, `APP_SECRET`, `STORAGE_SIGNING_SECRET`; `AUTH_PROVIDER=dev` / `NEXT_PUBLIC_AUTH_PROVIDER=dev`
  (allowed only because every preview is behind Vercel Authentication); `ERP_PAYMENTS_PROVIDER=mock`, `DEMO_PAYMENTS=1`;
  no `GEMINI_API_KEY` (mock AI), no messaging or push keys (mock).
* **Cron: Hobby allows only daily cron jobs**, so `apps/web/vercel.json` runs `/api/cron/tick` once a day (`17 3 * * *`). The job
  queue, reminders and scheduled sweeps that expect a per-minute tick need the Pro plan (or an external scheduler calling
  `/api/cron/tick` with `CRON_SECRET`). Vercel runs crons on production deployments only, so previews never run them.

## Signing in

* OS (and the product switcher): `/login`, demo e-mail sign-in, e.g. `principal@demo.school`, `admin@demo.school`.
* ERP staff: `/erp/login` with an `@erp.demo.school` login and the demo password (Supabase Auth). The ERP's dev sign-in is off
  whenever `NODE_ENV=production`, which is always the case on Vercel.
* ERP families: `/erp/signin` (password) with the ERP parent login.
* CRM: `@demo.test` logins (Greenfield Demo School) through `/login` (they are staff, so the demo e-mail sign-in accepts them).
  The CRM's own `/crm/login` e-mail-only sign-in refuses on real Supabase by design.
* Platform console: `/admin` needs Supabase Auth (its dev login is off in production).

## Known gaps on hosted Supabase

* `os.ensure_staff_login` and `crm.dev_create_login` insert into `auth.users` without an id; on Supabase `auth.users.id` has no default,
  so creating a new login from the OS staff screen fails there. Invites must go through the Supabase Auth admin API.
