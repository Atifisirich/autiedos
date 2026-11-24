# ADR 005 — Isolation harness on an empty platform

Status: accepted (Phase 2 foundation). Date: 2026-11-24.
Implements plan §8 and rule 9.

## Decision

* The harness lives in `packages/server/test-platform` with its own config
  (`packages/server/vitest.platform.config.ts`, script `test:platform`). Its global setup runs
  `node scripts/db.mjs reset --platform-only`, i.e. only `*_platform_*.sql` migrations: an empty platform with
  no legacy OS tables. It uses `PLATFORM_DATABASE_URL`, else `DATABASE_URL`.
* It talks to Postgres directly (no app code) as the real roles: `set local role <role>` plus
  `request.jwt.claims`, and real logins (`crm_server`, `job_runner` …) where grants are the point.
* Tests are generated from the catalogue: every table with `org_id` in `core`, `crm`, `os`, `erp`, `audit`,
  `billing` is checked, and the fixture must have rows for both orgs in each, so a new table without fixture rows,
  RLS, a policy, the product check, `org_id` or the audit trigger fails CI.
* Product schemas hold one placeholder table each (`crm|os|erp.harness_probe`, module `harness`) until real
  product tables arrive; then the probes are dropped.

## Coverage

| Plan test | Status |
|---|---|
| T1 org A vs org B, every table, every schema | done (authenticated and each server role; select, update, delete, insert) |
| T2 CRM-only org on os/erp | done (rows planted for it stay invisible; inserts and job enqueue refused) |
| T3 user granted only OS | done (+ revoked grant, role scope own/branch/org, CRM admin cannot grant OS) |
| T4 suspended | done (suspended/cancelled/dates/closed org off; trial/past_due on; per-branch switch; next request) |
| T5 crm_server on os.* | done (real login; all role × schema pairs; `set role` refused) |
| T6 anon | done (no schema usage, no table or function privilege, every query refused) |
| T7 catalogue | done (RLS, ≥1 policy, private has none, org_id except reviewed list, product check in every product policy, audit trigger, `search_path` on security definer, no PUBLIC execute, grant matrix, role memberships) |
| T8 storage | policy level only on `storage.objects` (local shim); the Supabase Storage API is not exercised |
| T9 view-as | done (needs open session, reason and duration enforced, read-only, expiry, audit events, session id on writes) |
| T10 org switch | replaced (decision 37): second org link rejected, cross-org grant rejected |
| T11 jobs | done (`private.claim_jobs` skips and logs; queue unreadable by users and product roles) |
| T12 Supabase advisor | not done: needs a Supabase project; nothing in the cloud is touched in this phase |
