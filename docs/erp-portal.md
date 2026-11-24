# ERP portals: parent, student, driver, gate (web)

Decision 30: the portals belong to the ERP product. They are screens of `apps/web` that talk to Postgres **only through the Supabase Data
API as the signed-in user** (decision 51): the browser holds the anon key and the user's own token, row-level security is the barrier,
and there is no service key anywhere in a client. Source: the original ERP's `parent/*`, `student/*`, `driver/*` routes.

## Where things are

| Path | What |
|---|---|
| `apps/web/app/erp/(portal)/**` | the screens. URLs: `/erp/signin`, `/erp/parent/*`, `/erp/student/*`, `/erp/driver`, `/erp/gate`, `/erp/verify/<code>` (public) |
| `apps/web/components/erp-portal/**` | UI kit (48 px targets, 16 px inputs, visible focus, skip link), shell and bottom navigation, QR, route map, PWA bits |
| `apps/web/lib/erp-portal/**` | client, session (school, branding, children, language, offline), `useLoad` (offline copy), server-only DB helper |
| `packages/shared/src/erp-portal/**` | **shared with the Expo app**: pure rules (`logic.ts`), the Data API calls (`data.ts`), strings (`strings.ts`), QR encoder (`qr.ts`); import `@autoed/shared/erp-portal` |
| `apps/web/app/api/erp-portal/{pay/[order],verify}` | the two server routes (below) |
| `supabase/migrations/20261118200001_erp_portal_functions.sql`, `..200002_erp_portal_consent.sql` | new functions (below) |

I kept to `(portal)`, `lib/erp-portal`, `components/erp-portal`: the staff area `apps/web/app/erp/(staff)` and the nav shell are not touched. If the
staff stream adds `apps/web/app/erp/layout.tsx`, it must not wrap `(portal)` in the staff shell (the portal has its own).

## Screens

Parent: home (attendance today, fees due, bus, unread, next steps, homework, timetable), child switcher, attendance (month calendar),
academics (report cards, published marks, school notes), report card (detail, **QR + verify link**, print), fees (instalments, receipts,
wallet, **pay selected fees -> `erp.create_payment_order`** -> mock checkout), homework (with submission), calendar and events (register,
consent), bus (live map, ETA, today's boarding), messages (circulars with acknowledge; **two-way conversations**), requests (leave,
certificate, concern, history, issued documents), forms and surveys, PTM (**book a slot**, appointments), pickup (early pickup request,
**OTP**), more (language, large text, message choices, notifications, install, sign out). Student: my day, homework, results, **online and
diagnostic tests with tab-switch logging**. Driver: routes, start trip, **GPS posting** (`erp.driver_position`, at most every 10 s, screen
wake lock), boarding, running late, **SOS**, end trip. Gate: approved pickups and `erp.verify_gate_pass` (5 tries per pass).

Sign-in (decision 36): phone OTP, e-mail OTP or password with Supabase Auth; every failure says "That did not work".
Language en/hi/te (saved on the device, default from the phone), "larger text", installable PWA (`/erp/portal.webmanifest`, icons in
`public/erp-portal`, service worker `/erp/portal-sw.js`, production only). The school's name and colours come from
`core.organizations` (`name`, `branding.primary/accent/tagline`) after login and are applied as CSS variables; a colour that cannot carry
text at 4.5:1 falls back to the default (decision 46). The logo column is read but not yet drawn (a monogram is shown): it needs a signed
Storage URL.

## What the portal reads and writes (all RLS)

Reads: `core.students`, `org_users`, `organizations`, `guardians`, `student_attendance_marks`, `class_posts`, `calendar_events`, `events`,
`timetable_*`, `periods`, `subjects`, `notifications`, `tickets`, `student_leave_requests`; `erp.fee_demands`, `fee_heads`, `receipts`,
`payment_orders`, `student_wallets`, `report_cards`, `growth_records`, `trips`, `stops`, `trip_events`, `trip_positions`, `announcement_recipients`,
`conversations(+_messages)`, `forms`, `form_responses`, `ptm_slots`, `appointments`, `gate_passes`, `pickup_persons`, `issued_documents`,
`online_tests`, `test_attempts`, `post_submissions`. Writes: own `post_submissions`, `conversations`, `conversation_messages`,
`form_responses`, `appointments`, `event_registrations`, `announcement_recipients` (read/ack), `core.student_leave_requests`, `core.tickets`
(certificates and concerns, `source = 'portal'`). Functions: `create_payment_order`, `open_report_card`, `book_ptm_slot`,
`my_gate_pass_otp`, `get_test_questions`, `submit_test`, `driver_*`, `verify_gate_pass`.

Core inserts need `org_id` sent explicitly (core tables have no default); the client gets it from `core.organizations`.

## New database functions (migrations `20261118200001`, `20261118200002`)

* `erp.portal_directory(student)`: class teacher, subject teachers, PTM staff, bus, driver, attendant names. `core.staff` is closed to families.
* `erp.portal_results(student)`: published marks with assessment, subject, term and maximum. A family could read its `assessment_results` rows
  but not the `assessments` behind them.
* `erp.request_gate_pass(...)`: the pass and its `core.approval_requests` row (linked_type `gate_pass`, class teacher as approver) in one
  step; `erp.apply_approval` then issues the OTP. No ERP approval types were seeded, so the function creates the `gate_pass` type on demand.
* `erp.portal_consents()` / `erp.portal_set_consent(channel, purpose, status)`: a guardian's own WhatsApp/SMS/e-mail choices on the consent
  ledger (`app.compliance_record_consent`; the `app` schema is not on the Data API).

All are `security definer`, pinned `search_path`, check the caller inside, not executable by anon. Tests: `packages/server/test-platform/erp-portal.test.ts`.

## Server routes (the only server code)

* `POST /api/erp-portal/pay/<order>`: **mock payment provider**. The browser sends its token; the route reads the order through the Data
  API with that token (RLS: only the family sees it), then calls `erp.settle_payment_order` / `erp.fail_payment_order` as the `erp_server` role.
  No gateway call. Mock settlement posts a real receipt, so it is on only when `ERP_PAYMENTS_PROVIDER=mock` (the default outside
  production); otherwise 501. With Razorpay the same order is paid in the gateway checkout and settled by webhook.
* `GET /api/erp-portal/verify?code=`: public door to `erp.verify_document` (server-only grant), rate limited per address, returns only what
  the function returns. The QR link opens `/erp/verify/<code>`.
* Environment: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `ERP_SERVER_DATABASE_URL` (login as `erp_server`),
  `ERP_PAYMENTS_PROVIDER`. `NEXT_PUBLIC_PORTAL_DEV_AUTH=1` only shows a hint on the local sign-in page.

## Offline

Each screen keeps its last good answer in `localStorage` per user and child and shows it with "No connection. Showing what was saved ...".
Sign out removes the user's saved screens (shared phones). The pickup code, test questions and payment state are never saved.
The service worker caches visited portal pages and Next static assets; Data API calls always go to the network.

## Verification (local, own database `portal`)

```bash
export DATABASE_URL=postgres://postgres@localhost:54322/portal
pnpm db:reset:platform
node apps/web/e2e/portal-all.mjs            # world + PostgREST v12.2.3 + dev auth shim + next start, then the four scripts
```
`apps/web/e2e/portal-stack.mjs` is the **dev-only JWT shim** (signs sessions with the PostgREST secret, plays `/auth/v1/otp|verify|token`);
nothing of it exists in the app. Scripts: `portal-isolation.mjs` (72 checks: a parent sees only the own child's fees, receipts, report
cards, attendance, messages and bus, never another family's or school's, over the API and for every response in the browser; student sees
only self; functions refuse other children; anon and forged tokens get nothing), `portal-parent.mjs` (sign-in, payment order + mock
settlement + receipt, PTM booking, pickup, QR verify, messages, leave, Hindi, offline), `portal-student.mjs` (test with 2 logged tab
switches, scored in the database), `portal-driver.mjs` (GPS, boarding, delay, SOS, then the parent sees the bus live). All fail on page
errors, console errors and 5xx. 390 px screenshots go to `apps/web/e2e/portal-shots/` (git-ignored).

## Not done / known gaps

* Library, store orders, canteen wallet top-up, hostel, gallery and the parent "data request" are not in the portal screens.
* Certificate and concern requests are helpdesk tickets; the staff stream must show `source = 'portal'` tickets and approve leave
  (`core.student_leave_requests`, no approval row is created for leave) and the attendance mark that should follow.
* `erp.module_flags` is not checked by the portal (platform hook missing, see `erp-port.md`).
* Online payment with a real gateway; the mock page is the only checkout.
* Push notifications (no device-token table in ERP); logo image; Hindi/Telugu need native review (`NEEDS_NATIVE_REVIEW`).
* Staff language is OS-only; the portal's strings are in `packages/shared/src/erp-portal/strings.ts`.
