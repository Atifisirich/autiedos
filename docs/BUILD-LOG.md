# BUILD-LOG.md

Newest first. "Verified" means a command was run and its result seen.

## Unified platform build — CRM + OS + ERP on one database (2026-11-24/25)

Built by parallel agents, merged into `claude/confident-ritchie-qs7c7g`, every merge re-verified by the integrating session.
Design and decisions: `docs/PLAN-unified-platform.md`, `docs/DECISIONS.md` #27-55, `docs/MAP-TABLES.md`, `docs/adr/*`.

**Built:** platform foundation (schemas core/os/crm/erp/audit/billing/app/private, per-product DB roles, entitlements,
RLS generator, isolation harness T1-T12); 67 core master-data tables; OS moved onto `os` (62 tables); CRM back end (33 `crm`
tables, `core.admit_student`, data migration script) and CRM screens at /crm; ERP schema (127 `erp` tables) and ERP staff
screens at /erp; parent/student/driver portals and the separate parent app `mobile-parent/`; platform admin console at
/admin; compliance tooling (export/erasure/retention/consent, registry covering all products); Razorpay + GST billing code;
Gemini-only AI adapter; one web app with product switcher; staff login by password + phone/email OTP with lockout; CI for all of it.

**Verified (final combined tree, local Postgres 16):** `pnpm lint` OK; server/shared/crm-server eslint clean; `pnpm typecheck`
0 errors; shared 167 tests; server 107; isolation/platform harness 271 passed, 9 skipped (8 PostgREST Data-API tests are
opt-in via POSTGREST_BIN - they passed when run by the agents, 1 needs a Supabase project); CRM 117 passed, 5 skipped
(need SOURCE_DATABASE_URL); mobile-parent 5; ERP/core generators produce no diff; `next build` OK.
Browser e2e scripts (OS smoke, CRM e2e, ERP smoke, portal isolation/flows, shell) passed when run by their agents; they were
not all re-run after the final integration (route rename of the ERP staff driver/gate pages).

**Not verified / not done:** nothing deployed; no real Supabase, Gemini, Razorpay, WhatsApp, Expo push or Sentry call; Gemini
model IDs are placeholders; mobile apps never run on a device; `@autoed/web` eslint now runs but reports 25 existing style
issues (CI skips it); Hindi/Telugu for CRM/ERP screens not done (decision 55) and all hi/te text needs native review; legal
documents and retention periods are drafts needing a lawyer; decision 42's 30-day read-only state is not enforced by the DB.

## Phase 9 groundwork — web UI, i18n, mobile, docs (this session)

**Built**
* Web app (`apps/web`, Next.js 15): 47 screens under `/os` covering every module in the PRD — My Day, tasks
  (list/board/calendar/team, day close, plan my week), checklists, staff attendance (check-in, regularisation,
  biometric import), student attendance, leave (live preview), approvals (+ form builder), timetable
  (drag-and-drop with clash check, versions, publish), substitution, duty roster, lesson planner (generator,
  editor with per-section AI actions and companions, plan bank, annual plan, library, curriculum maps), coverage,
  class log, exams (date sheet, invigilation, seating, blueprints, papers with review and watermarked export),
  observation and appraisal, helpdesk, circulars, calendar, meetings, events, incidents, compliance, reports
  (dashboards, catalogue, builder, plain-language questions, digest), AI credits, settings, setup wizard and the
  generic configuration editor, and the AutoEd console (schools, credits, support, plans, view-as).
* i18n: 1,882 keys × English/Hindi/Telugu from one source (`packages/shared/src/i18n/source/*.txt` →
  `scripts/build-i18n.mjs`). `scripts/check-i18n.mjs` (`pnpm lint`) enforces key parity, placeholder parity, that
  every dynamic key family is complete, and no literal text in JSX.
* Mobile (`mobile`, Expo 52 / expo-router): login (OTP or dev), My Day with geofenced check-in, tasks, student
  attendance, inbox, settings; offline outbox replayed through `/sync`; push registration.
* Docs: AUDIT, DECISIONS, README, `.env.example`.

**Verified**
* `packages/shared`: 63 unit tests pass. `packages/server`: 42 tests pass (20 RLS tests; 22 flow/acceptance tests
  including the 8 PRD flows and the help bot answering all 117 knowledge-base titles in en/hi/te).
* `apps/web`: `tsc --noEmit` clean; `next build` succeeds for all routes.
* `apps/web/e2e/smoke.mjs` (Playwright, real Chromium, production build, seeded demo school): signed in as the
  principal and a teacher and opened all 47 screens in English, Hindi and Telugu — no page errors, no console
  errors, no HTTP 5xx, no untranslated keys. Run: `BASE_URL=http://localhost:3000 node apps/web/e2e/smoke.mjs`.
* `mobile`: `tsc --noEmit` clean.
* `pnpm lint` (i18n check) passes.

**Bugs the smoke test found and fixed**
* A lookup query selected a column that does not exist (broke every form's dropdowns).
* Helpdesk list query had an unused SQL parameter (500 for the "mine" view).
* Setup page effect returned a non-function (React crash).
* Server/client language mismatch caused hydration errors in Hindi and Telugu.
* A date hard-coded in one flow test; now relative to today.

**Not verified (be aware)**
* The mobile app has been type-checked but **never run on a device or emulator**.
* No real Anthropic, WhatsApp, Expo push or Supabase Auth call has been made; these run against mock adapters
  (see below). The AI adapter code follows the current SDK but has not been exercised against the live API.
* Hindi and Telugu text was written by the build, not reviewed by a native speaker.
* Screens were checked for errors and untranslated keys, not for visual polish at every width; only one screenshot was reviewed.
* Playwright smoke covers "every screen opens", not full click-through of the 8 flows in the browser. The 8 flows are
  tested end to end at the API level (`packages/server/test/flows.test.ts`).

## Earlier phases (previous sessions)

* **Phase 0 — foundations.** Migrations (128 tables), RLS on every table with a test per table, audit and config-history
  triggers, permission function, module flags, presets (roles, leave types, categories, rubrics, templates), time/rules
  libraries, local Postgres shim, seed for "Demo International School".
* **Phases 1–8 — server.** Services and API for tasks, checklists, attendance, leave, approvals, timetable generator and
  substitution, lesson planner with AI adapter (mock + Anthropic), curriculum, exams and papers, observation and appraisal,
  helpdesk, circulars, calendar, meetings, events, duty, incidents, compliance, reports, help bot, setup, platform admin,
  scheduler. Unit tests for the rules engines (can-assign, escalation, leave balance, substitute ranking, clash detection,
  credit cost, and more).

## Session: handoff verification and first fixes

Verified on a fresh Postgres 16 + pgvector (port 54322): `pnpm db:reset`, `pnpm lint`, `pnpm typecheck`, shared tests (63),
server tests (42, includes 20 RLS), `next build`, and the browser smoke test (2 users x 3 languages x 47 screens). All passed.

Found and fixed:
- `/os/coverage` was linked from the nav and notifications and listed in the smoke test, but the page file did not exist. Added
  `apps/web/app/os/coverage/page.tsx` (coverage table, projected finish, AI recovery plan dialog) using existing i18n keys.
- The smoke test never settled where Google Fonts is unreachable (`networkidle`). It now aborts font requests.
- Added `.github/workflows/ci.yml` (lint, typecheck, shared + server tests against a pgvector service, web build). Not yet run on GitHub.

Reminder: run `pnpm i18n:build` before `pnpm db:reset`, or seeded notifications show raw keys.

## Blocked on Atif (built against mock adapters)

| Needed | Used instead | Where to plug in |
|---|---|---|
| Anthropic API key | Deterministic mock AI provider | `ANTHROPIC_API_KEY` |
| WhatsApp provider and approved templates | Mock adapter, messages recorded | `WHATSAPP_API_URL`, `WHATSAPP_API_TOKEN` |
| Expo / Firebase / APNs accounts | Mock push; registration code is ready | `PUSH_PROVIDER=expo`, `EXPO_ACCESS_TOKEN`, `extra.eas.projectId` in `mobile/app.json` |
| Google Play / Apple Developer accounts | — | store submission |
| Sentry project | — | `SENTRY_DSN` (not wired yet) |
| CRM repository access | Standalone implementations | see `docs/AUDIT.md` |
| Subject expert review of curriculum maps | Maps shipped for CBSE 9–10 Science/Maths, CBSE 8 Hindi, Cambridge Lower Secondary 8 Science, IGCSE Maths | `/os/lesson-plans/library` |
| Native-speaker review of Hindi and Telugu | Build-written text | `packages/shared/src/i18n/source/*.txt` |
