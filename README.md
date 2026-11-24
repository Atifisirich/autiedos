# AutoEd OS

The staff-only school operating system from the AutoEd PRD (`docs/PRD-autoed-os.md`): tasks, attendance, leave,
approvals, timetable and substitution, lesson planning with AI, exams, observation, helpdesk, circulars, reports
and more, for CBSE and Cambridge schools, in English, Hindi and Telugu.

```
apps/web          Next.js 15 app (all routes under /os) and the /api/os endpoint
mobile            Expo app (My Day, tasks, student attendance, inbox) with offline outbox
packages/shared   zod schemas, rules engines, presets, timetable generator, i18n catalogues (web + mobile)
packages/server   API router, services, AI/messaging/push adapters, scheduler, seed, tests
supabase          migrations (the only way the schema changes; OS stream = `*_os_*`, on the shared platform), local shim
kb                help-bot articles in en / hi / te
docs              PRD, AUDIT, DECISIONS, BUILD-LOG
scripts           db.mjs, build-i18n.mjs, check-i18n.mjs, kb-source.py
```

## Run it locally

Needs Node 22, pnpm, and Postgres 16 with the `pgvector` extension listening on `localhost:54322`
(or set `DATABASE_URL`). The OS server connects as the `os_server` role (same URL with the user swapped, or
`OS_DATABASE_URL`); role passwords come from `OS_SERVER_DB_PASSWORD` / `JOB_RUNNER_DB_PASSWORD` /
`PLATFORM_ADMIN_DB_PASSWORD` (set by `pnpm db:reset` locally), never from migrations. See `docs/adr/os-move.md`.

```bash
pnpm install
pnpm db:reset          # applies migrations and seeds "Demo International School"
cp .env.example apps/web/.env.local   # then set AUTH_PROVIDER=dev and NEXT_PUBLIC_AUTH_PROVIDER=dev
pnpm dev               # http://localhost:3000
```

Demo logins (email only, dev mode): `principal@demo.school`, `vp@demo.school`, `coordinator@demo.school`,
`admin@demo.school`, `chairman@demo.school`, `director@demo.school`, teacher `deepa.teacher9@demo.school`,
HOD `priya.hod6@demo.school`, Kondapur principal `principal.kond@demo.school`; platform console `admin@autoed.dev`.

Without `GEMINI_API_KEY`, AI features use a deterministic mock so everything works offline. Production requires
`GEMINI_API_KEY` and `GEMINI_TIER=paid` (see `docs/adr/ai-gemini.md`).

## Checks

```bash
pnpm lint                              # builds the catalogues and runs the i18n check
pnpm --filter @autoed/shared test      # rules engines
pnpm --filter @autoed/server test      # RLS tests (one per table group) and the 8 PRD flows; resets the DB
pnpm typecheck
pnpm --filter @autoed/web build
BASE_URL=http://localhost:3000 node apps/web/e2e/smoke.mjs   # opens every screen as two roles in en/hi/te (needs Playwright)
```

## Rules the code follows

Migrations only · RLS on every table · no hard-coded school structure (it is all configuration data) · every string is
an i18n key · AI runs only on the server and is recorded in `ai_generations` and `ai_credit_ledger` · no student names,
phones or staff personal data are sent to AI · every state change is audited · one shared API for web and mobile.
Choices made where the PRD was silent are in `docs/DECISIONS.md`.

## Deploy

Vercel (web, with the cron in `apps/web/vercel.json`) + Supabase (Mumbai). Set the variables in `.env.example`,
apply migrations with `supabase db push`, leave `AUTH_PROVIDER` unset. Mobile: EAS build once the Expo, Firebase and store
accounts exist (see `docs/BUILD-LOG.md`).
