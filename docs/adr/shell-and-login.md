# ADR: One web shell with a product switcher, and one staff sign-in

Status: accepted (built on local Postgres; nothing deployed). Owner decisions 35, 36, 37 in `docs/DECISIONS.md`.

## Context

* Decision 35: one web app with a product switcher (CRM / ERP / OS), not three apps; isolation stays in the
  database (per-product roles and RLS).
* Decision 36: staff sign in with phone OTP, e-mail OTP **and** password. `core.user_security` and
  `core.login_events` (foundation) hold what Supabase Auth does not: password set/changed, must-change, failed
  attempts, lockout. The foundation already had `app.record_login_event` (5 wrong passwords -> 15 minute lock),
  `app.login_allowed` and `app.rate_limit_hit` (fixed window in `private.rate_limits`), but nothing called them.
* Decision 37: one person belongs to exactly one client, so the session needs no org picker.
* Before this change: the OS login page did OTP in the browser against Supabase and exchanged the token at
  `POST /api/os/auth/session`; the session token carried `org` + `products` but the response did not; a person
  with no product still got a session; rate limiting was an in-memory token bucket; `/` redirected to `/os`.

## Decision

### Sign-in goes through the server

All three methods are checked **server-side** (`packages/server/src/login/`), so every attempt passes the same
rate limits, lockout and log, whatever the client:

| Route (`/api/os/...`, product-neutral) | What |
|---|---|
| `POST /auth/password` `{identifier, password}` | e-mail or phone + password |
| `POST /auth/otp/start` `{identifier}` / `POST /auth/otp/verify` `{identifier, code, purpose}` | SMS or e-mail code; `purpose: 'reset'` = forgot password |
| `POST /auth/session` `{accessToken, method?}` | exchange of a Supabase token the client got itself (mobile, portal); now refuses locked users and users without a product |
| `POST /auth/password/change` `{current_password?, new_password}` | set / change; returns a new session, ends the old one |
| `POST /auth/dev-login` `{email}` | `AUTH_PROVIDER=dev` only, unchanged e-mail-only demo login (now rate limited in the DB and logged) |
| `GET /session` | the platform session for the shell (any signed-in person, OS or not) |
| `POST /auth/logout` | ends the session, logs `logout` |

Who checks the secret is an `AuthProvider` (`login/provider.ts`):

* **supabase** (default): GoTrue's HTTP API from the server - `/otp` (`create_user: false`), `/verify`,
  `/token?grant_type=password`, and `PUT /admin/users/{id}` with the service-role key to set a password.
  Env: `SUPABASE_URL`, `SUPABASE_ANON_KEY` (or the `NEXT_PUBLIC_` names), `SUPABASE_SERVICE_ROLE_KEY`.
  Exercised only against a mocked `fetch` here (no cloud calls were allowed).
* **dev** (`AUTH_PROVIDER=dev`, refused when `VERCEL_ENV=production`): OTP code = `DEV_OTP_CODE` (default
  `123456`), passwords as scrypt hashes in `auth.dev_passwords`, which exists only in `supabase/local/shim.sql`.
  The migration grants the product roles access to it only if the shim created it, so on Supabase it is a no-op.

Flow of one attempt: DB rate limit per IP (`login:ip:<ip>`, 30/min) and per identifier (`login:id:<id>`, 10 per
15 min; OTP sends `otp:send:<id>`, 5 per 15 min) -> `app.login_lookup(identifier)` -> `app.login_allowed` (a locked
account is refused for **every** method, 423 `account_locked`) -> provider check -> `app.record_login_event`
(failures of the password count toward the lock; OTP failures are logged but not counted) -> member not
disabled -> `issueSession`. Refusals after the secret was checked (locked, disabled, no product) and sign-outs are
logged with the new `app.record_login_note`, which does not touch the counter. Limits are env-tunable
(`LOGIN_IP_PER_MINUTE`, `LOGIN_ID_PER_15_MIN`, `OTP_SEND_PER_15_MIN`, `PASSWORD_CHANGE_PER_15_MIN`).

Unknown identifiers get the same answer as a wrong secret (`invalid_credentials` / `invalid_code`, and OTP start
always says "if this is registered, a code was sent"); the dev provider spends the same scrypt work for them.
Known trade-off: `423 account_locked` tells an attacker that the identifier exists - accepted so that staff
understand why they cannot sign in.

### The session token carries org + products; no product, no session

`issueSession` (`packages/server/src/auth.ts`) returns `{token, expires_at, org, products, must_change_password,
is_platform_admin}` and signs `sid`, `org`, `products`, `mcp` (must change) and, for a reset sign-in, `pwr` (time).
A person whose org gives them no product is refused with `403 no_product` (platform admins excepted, they have
no org). Claims are a hint for clients; the OS dispatcher re-reads products per request, and `verifySession` now
also reads `core.user_security.must_change_password` per request.

### Passwords

* Policy (`checkPassword` in `@autoed/shared`, used by the server and live in the form): length >=
  `PASSWORD_MIN_LENGTH` (default 10, never below 8), <= 128; not containing the e-mail local part or the phone;
  not one repeated character or a straight sequence; not a short list of well-known passwords. No composition
  rules (NIST 800-63B). Optional breached-password check against the Pwned Passwords range API (k-anonymity,
  5 hex chars leave) with `PASSWORD_BREACH_CHECK=on`; **off by default**, and it fails open.
* Changing needs the current password unless none is set yet, an admin set `must_change_password`, or the
  session is a "forgot password" OTP sign-in younger than 15 minutes (`pwr`). A wrong current password counts
  toward the lockout. Success calls `app.record_password_set` (sets password timestamps, clears must-change,
  counter and lock), ends the old session and issues a new one.
* **must_change_password enforcement**: while set, the OS dispatcher answers every non-public route with
  `403 password_change_required` (only `/session`, `/auth/*` answer); the web client sends the person to
  `/account/password`. Admins set the flag with `app.admin_set_must_change_password` (admin console).

### Web shell

* `apps/web/app/(shell)/`: `/` landing (school branding + only purchased **and** granted products, from
  `GET /session`), `/go/<product>` (open or "not part of your plan"), `/account/password`. `/login` is the
  unified form (code / password / forgot; "Demo" tab when `NEXT_PUBLIC_AUTH_PROVIDER=dev`) and lands on `/` (or
  `?next=`). The old `app/page.tsx` redirect to `/os` is gone.
* `apps/web/components/shell/`: `ProductSwitcher`, `ProductGate`, `NotInPlan`, `SchoolBrand`,
  `usePlatformSession` (one `/session` fetch per page, shared). The OS header (moved from `components/shell.tsx`
  to `components/os-shell.tsx` so `@/components/shell` is the shell) mounts the switcher, and `app/os/layout.tsx`
  is wrapped in `ProductGate product="os"`, so ERP- or CRM-only staff see "not part of your plan" instead of the OS
  failing on `/me`. How CRM/ERP mount it: `docs/shell.md`.
* Branding: `core.organizations.branding` (`app_name`, `primary_color`, or the older `color`) and the name; the
  logo file is private storage, so the mark is the school's initials in its colour until a signed URL is added.
* Product homes: `PRODUCT_HOME` in `@autoed/shared` (`/os`, `/crm`, `/erp`). Product links do not prefetch.
* All strings are `shell.*` keys in en/hi/te (`packages/shared/src/i18n/source/07-shell.txt`; Hindi and Telugu
  need a native speaker's review).

### Database (`20261126000001_platform_shell_login.sql`, also applied by `--platform-only`)

`app.login_lookup(text)`, `app.login_identity(uuid)`, `app.record_password_set(uuid, boolean)`,
`app.record_login_note(...)`: security definer, `search_path = ''`, executable only by the server roles and
`service_role` (not `authenticated`, not `job_runner`, not PUBLIC/anon).

## Consequences

* The web no longer talks to Supabase Auth from the browser for staff sign-in. `POST /auth/session` stays for the
  mobile apps and the ERP portal; a password check done directly against GoTrue by such a client bypasses the
  platform's lockout counter (GoTrue has its own rate limits). Moving those clients to `/auth/password` closes it.
* The CRM server verifies the same token but does not yet refuse while `mcp` is set; the CRM/ERP UI streams are
  told to (docs/shell.md).
* `/erp` (ERP staff home) does not exist in this branch; the switcher links to it and the e2e notes the 404.
* Rate limits now live in `private.rate_limits` (shared by instances); rows are never pruned - a job should delete
  windows older than a day.
* Not built: 2FA (`mfa_required` / `mfa_enrolled_at` columns unused), admin "set a temporary password for a user"
  (the admin console can only force a change), e-mail magic-link password reset, logo signed URL.

## Tests

* `packages/server/test/shell-login.test.ts` (17): token carries org + products; `/session` (branding, modules);
  OS + ERP user gets two products; no product / revoked grant -> 403 `no_product`, logged, no counter change;
  lockout after 5 wrong passwords (423, OTP refused too, unlock restores); unknown identifier; phone identifier;
  must-change blocks product routes until a valid new password, old session ended; current password required and
  counted; forgot-password via OTP; DB rate limits per identifier, per IP and for OTP sends; Supabase token
  exchange; Supabase provider endpoints (mocked fetch); breached-password check off by default / k-anonymity.
* `apps/web/e2e/shell.mjs` (Playwright, production build, dev auth): OS-only user sees only OS and "not part of
  your plan" for ERP/CRM; OS + ERP user sees two options and the switcher opens ERP; set password, wrong password,
  password sign-in, must-change redirect; no page or console errors, no 5xx, no untranslated keys (en/hi/te).
