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

## Unified platform (CRM + OS + ERP) — owner answers, 2026-11-24

Source: owner replies to PLAN-unified-platform.md §14. "Open" means the owner has not decided yet.

27. **CRM data in `autoed-crm-mumbai` is demo only.** "Greenfield Schools" is a demo name (Q2). No client data has to be migrated yet.
28. **Clients are schools, coaching centres and colleges** (Q5). `core` must not assume school-only terms: use generic "learner / class / batch / programme" naming where the OS uses school terms, and keep school fields optional.
29. **ERP code exists in another repository** the owner will connect (Q4). ERP scope is taken from that repo, not designed from scratch. Phase 1 (discovery) stays open until it has been read.
30. **Parent and student portal is part of the ERP product** (Q17). OS stays staff-only. `core` gets guardian-to-student links and parent/student memberships now; portal screens are built with the ERP.
31. **CRM leads are the school's data** (Q22). AutoEd's own marketing data may come later and must live in a separate AutoEd-owned org, not mixed into a client's rows. AutoEd is a registered company under Arfan Group Private Limited. No lawyer yet: DPA, privacy policy and terms stay as drafts marked "needs legal review".
32. **Billing: Razorpay with GST, not manual** (Q24). First paying client, date and product: unknown (Q25). `billing` schema is designed for Razorpay subscriptions and GST invoices, built late.
33. **Free tiers only; no paid plan or priced resource without the owner's written yes** (Q1/Q18). Point-in-time recovery later (Q18).
34. **Clients can have different products per branch** (Q7).
35. **One web app with a product switcher (CRM / ERP / OS), not three apps** (Q8, overrides plan §4.6). Isolation is still enforced in the database (three DB roles, per-product RLS); one deployment may hold three connection pools, one per role.
36. **Logins: phone OTP, email OTP and password** (Q11). Password is added alongside OTP. `core.user_security` (password set/changed, must-change flag, failed attempts, lockout, 2FA requirement) and `core.login_events` store what Supabase Auth does not.
37. **Logins can belong to several clients** (Q12) — confirm wording below; plan §5.3 `core.memberships` stays.
38. **CRM leads become `core.students` only when admission is confirmed** (Q13). The CRM's current "student row per enquiry" must be mapped to a CRM-owned child record.
39. **Staff source of truth is OS, ERP HR/payroll adds to it** (Q14).
40. **AI: Gemini only. Anthropic is removed** (Q15). One credit wallet per client shared across products. Gemini must be on the paid API tier in production (free-tier prompts can train Google models); development uses the mock adapter.
41. **WhatsApp: client brings its own provider, or uses one run by AutoEd** (Q16). Per-org provider config with a `provider_owner` of `client` or `autoed`.
42. **When a client stops paying for a product: 30 days read-only, then export and delete** (Q19). **On leaving: CSV/Excel export, deleted 30 days later** (Q20).
43. **Domain: `autoed.in`** is owned (Q10).

Open: Q3 (which "autoedcrm"), Q6 (single modules), Q9 (mobile app structure), Q12 (wording), Q23 (who else gets admin access).
