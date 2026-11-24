# Parent app (`mobile-parent/`)

Decision 46: two mobile apps. `mobile/` (staff) is untouched; `mobile-parent/` is the second Expo app, same Expo SDK 52 / React Native
0.76.5 / expo-router 4 and TypeScript settings, same backend. It reads and writes through **the Supabase Data API as the signed-in
user** (decision 51) with the anon key; no service key, no OS API. The data calls and the rules are the ones of the web portal
(`packages/shared/src/erp-portal`), see `docs/erp-portal.md`.

## What is in it

Sign-in with Supabase Auth: phone OTP, e-mail OTP, password (decision 36; `app/signin.tsx`, the session is kept in the keychain in
chunks, `src/lib/chunked.ts`). After login the school's name, colours and children are loaded (`loadBoot`: `core.organizations`
branding, `core.students`): the header, buttons and tab tint use the school's colour; a colour that cannot carry text is replaced
(`resolveBranding`). Tabs: Home, Fees, Academics, Messages, More; also Attendance, Homework, Bus, Requests (from Home). Child switcher
in the header. Fees view (paying opens the school's web portal, no payment code in the app), attendance, report cards (QR check link opens
the browser) and published marks, homework, **live bus** (polled every 10 s; "Open in maps"), circulars with acknowledge and two-way
messages, leave requests, language en/hi/te with the review note, **push registration stub** (`src/push.ts`: permission + Expo token,
nothing is stored because ERP has no device-token table yet), **offline cache** of the last data per user and child (`src/lib/cache.ts`,
`useLoad`: saved copy shown at once, "No connection. Showing what was saved ...", removed at sign out).

Strings: the same catalogue as the web portal, one file for both apps: `packages/shared/src/erp-portal/strings.ts` (en filled; hi/te
best effort, `NEEDS_NATIVE_REVIEW`). Call the lookup `L(...)`, never `t(...)`, or the OS i18n lint will read it as an OS key.

## Run, test

```bash
pnpm install
pnpm --filter @autoed/mobile-parent typecheck   # also part of `pnpm typecheck`
pnpm --filter @autoed/mobile-parent test        # pure logic: chunked session storage, screen cache
EXPO_PUBLIC_SUPABASE_URL=... EXPO_PUBLIC_SUPABASE_ANON_KEY=... EXPO_PUBLIC_WEB_BASE=https://app.autoed.in pnpm --filter @autoed/mobile-parent start
```
The shared rules (fees, attendance, branding, cache envelope, sign-in identifiers, strings) are tested in `packages/shared/test/erp-portal*.test.ts`.
No device build was run (not asked); the screens were typechecked, not rendered.

## Before the first device build

* Add `react-native-url-polyfill` (supabase-js needs a full `URL` on React Native). It is not in the offline package store here, so `src/supabase.ts`
  loads it with a guarded `require`; add it to `package.json` and keep the import first.
* Set `extra.eas.projectId`, FCM/APNs credentials and `bundleIdentifier` / `package` (`in.autoed.parent` is a placeholder); app icons and splash.
* Per-school branding is runtime (colours, name). Separate store listings per school come later (decision 46).
* Decide the device-token table for push, then call it from `registerPushStub`.
* Not in the app yet: payment checkout, PTM booking, early pickup, forms, certificates, canteen/library (all on the web portal).
