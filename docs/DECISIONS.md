# DECISIONS.md — choices made where the PRD was ambiguous or silent

Each entry: what was decided, why, and how to change it. Anything that is school-specific is data
(configuration tables), so most of these are defaults, not hard rules.

## Architecture

1. **One API for web and mobile.** `packages/server/src/api/index.ts` is a framework-free dispatcher
   (`dispatch(req)`); the Next route `apps/web/app/api/os/[...path]/route.ts` is a thin wrapper. The
   mobile app calls the same routes. Validation uses zod schemas in `packages/shared`.
2. **Own session token on top of Supabase Auth.** Sign-in uses Supabase (OTP by email or phone). The
   access token is exchanged once at `POST /auth/session` for an HS256 session token (`AUTH_JWT_SECRET`)
   so sessions can be listed and revoked per device (`device_tokens`, `session:<sid>`), which the PRD asks
   for ("sign out a device"). Row-level security still runs as the user: the API sets
   `request.jwt.claims` and `set local role authenticated` for each request.
3. **Dev login.** `AUTH_PROVIDER=dev` allows email-only sign-in for demos and tests. It is refused unless
   that variable is set, and `.env.example` leaves it unset.
4. **Jobs without a queue service.** Reminders, escalations, recurring tasks, digests and generation
   run from a `jobs` table driven by `/api/cron/tick` (Vercel cron every minute, `CRON_SECRET`). Chosen so no extra
   infrastructure is needed; a long timetable generation is a job that the UI polls.
5. **Local development database.** Plain Postgres 16 with pgvector plus `supabase/local/shim.sql`
   (emulates the `auth` schema, roles and storage). The same migrations apply unchanged to Supabase.

## Data and security

6. **RLS on every table** via `app.apply_rls(table, kind)` with five kinds: `config`, `entity`, `child`,
   `member`, `global`. Permissions resolve through `app.has_permission(user, module, action, target)` with scopes
   own / team / department / wing / branch / group. `FORCE ROW LEVEL SECURITY` is not used: the API's
   privileged helper (`sys`) runs checked side effects (notifications, audit-sensitive writes) as the table owner,
   and every call to it follows an explicit permission check in the service.
7. **Audit trigger on all tables** (`app.audit_row`) writes `audit_log`; configuration tables also write
   `config_history`. `audit_log.org_id` has no foreign key so history survives deleting an organisation.
8. **Question papers are never exposed by list endpoints** (only the setter and reviewers can open one); every
   view and download is written to `paper_access_log` with a watermark of name and time.
9. **Student personal data never goes to AI.** `packages/shared/src/rules/privacy.ts` blocks prompts that contain
   names or phone numbers from the roster; plans use class profiles (size, ability mix), not individuals.
10. **Selfies** are optional, kept for `attendance_rules.selfie_retention_days` (default 90) and then deleted by the
    daily `selfie_purge` job; only the owner and attendance managers can read them.

## Product defaults (all editable in Setup → Settings lists)

11. **Assignment rule default** (who can assign work to whom): by seniority from `positions.rank`; explicit
    `assignment_rules` override it. "Request" means the receiver must accept.
12. **Escalation** defaults (column defaults of `escalation_rules`): reminder 120 min before due, owner at due time,
    assigner after 240 working minutes, the assigner's manager after 1 working day. Working time uses the branch calendar (working days, bells, holidays).
13. **Leave "sandwich" rule** off by default; Sunday and holidays do not count as leave days unless the type says so.
14. **Late / half day** thresholds come from `attendance_rules` per position (grace 10 min, half day after 120 min).
15. **Student attendance** is "all present, tap exceptions"; edits after the branch's edit window need approval.
16. **Daily lesson plan review chain:** HOD then academic coordinator (`plan_submission_rules.review_steps`).
    Coordinator's view/approve scope on plans is `branch`.
17. **AI plans must be confirmed by the teacher** ("I have read and checked this plan") before submitting.
18. **AI credit costs** are rows in `ai_action_costs` (platform level). Failures (provider down, invalid output
    after 3 attempts, privacy block) cost nothing. Fair-use daily limits per feature are separate from monthly credits.
19. **Models:** strong = `claude-opus-5-5`, fast = `claude-haiku-5-5`, stored in `platform_settings`, not in code.
20. **Curriculum maps** shipped: CBSE Classes 9–10 Science and Mathematics, CBSE Class 8 Hindi, Cambridge Lower
    Secondary Stage 8 Science, IGCSE Mathematics. Schools clone a map to edit it; the master map is updated by
    AutoEd (`/admin/curriculum`). Other classes and subjects need content authored by a subject expert.
21. **Help bot** answers only from the knowledge base (39 articles × en/hi/te) using local embeddings with a
    word-overlap gate; if nothing matches it offers "ask AutoEd support" rather than guessing.
22. **Local embeddings** (256-d hashed vectors) are used instead of an external embedding API so the help bot and
    document search work with no key and no student data leaves the system. Swap `embed()` for a model embedding later.
23. **Offline (mobile):** task actions, staff check-in, student attendance, class logs and checklist answers queue in an
    outbox and replay through `POST /sync` with a client id (server de-duplicates). Everything else needs a connection.
24. **Languages:** English, Hindi, Telugu. Every UI string is a key in one source file per area
    (`packages/shared/src/i18n/source/*.txt`) that builds the three JSON catalogues; `scripts/check-i18n.mjs` fails on
    missing keys, mismatched placeholders and literal text in JSX.
25. **Dates and time** are stored in UTC and shown in the branch time zone (default Asia/Kolkata).
26. **Seed data** is dated "today" at run time (`SEED_TODAY` overrides) so the demo always has current tasks.
