# ADR 003 — Identity: one person, one client; login security; support "view as"

Status: accepted (Phase 2 foundation). Date: 2026-11-24.
Implements decisions 30, 36, 37 (which override plan §4.4 / §5.3: no memberships switcher).

## Decision

* `core.org_users (org_id, user_id, kind, status, home_branch_id)` with **`unique (user_id)`**
  (`org_users_one_org_per_user`): an auth user belongs to exactly one client org. `kind` is
  `staff | guardian | parent | student`. There is no org switcher and no `app.my_org_ids()`.
* `app.current_org_id()` returns that single org (active link, active org), or the org of the caller's open
  support session. `app.my_org_id()` is the public alias. Platform policies call `app.current_org_id()` because
  the legacy OS migrations redefine `app.my_org_id()` (see platform-foundation.md, "name clashes").
* Composite foreign keys `(org_id, user_id) → core.org_users` on `user_product_access`, `user_branch_access`,
  `learner_links` make a grant in another org impossible at the schema level (harness T10 replacement).
* Guardians/parents/students (decision 30): `core.learner_links (user_id, learner_id, relation)` and
  `app.my_learner_ids()`. `learner_id` gets its foreign key when the learner table moves to `core`. Portal policies
  come with the ERP; `app.can()` never grants role permissions to non-staff users.
* Login security (decision 36): `core.user_security` (password set/changed, must-change, failed attempts,
  `locked_until`, MFA required/enrolled) and `core.login_events`. Written only by
  `app.record_login_event(...)` (five failed password attempts → 15-minute lock; success resets) and read with
  `app.login_allowed(user)`. Executable by server roles, **not** by `authenticated` (a user could otherwise reset
  their own counter). Supabase Auth stays the credential store; these tables hold what it does not.
* Support access: `core.platform_admins` (AutoEd staff, in no org) and `core.support_sessions` (org, admin,
  reason ≥ 10 chars, `read_only` default true, at most 4 hours, one open per admin). Opened and closed only by
  `app.start_support_session(org, reason, minutes, read_only)` / `app.end_support_session()`, which write
  `support_session.start/end` events to `audit.log`. While open: the admin's `current_org_id()` is that org,
  `user_has_product` is true for the org's products, `can()` allows only `view` unless the session is
  read-write; every row change made in the session carries `support_session_id` in `audit.log`. Client admins
  with `audit.view` see their org's support sessions. Without a session, a platform admin sees no client product
  or master data (only organizations, subscriptions, billing and audit for the console).

## Consequences

One phone or email cannot be a parent in two client organisations (decision 37). A platform admin account must
not also be an org user; nothing enforces this yet beyond `current_org_id()` preferring the org link.
