# Web shell: mounting the product switcher (for the CRM and ERP UI streams)

Decision 35: one web app, three products. The shell lives in `apps/web/components/shell/**` and
`apps/web/app/(shell)/**`; ADR: `docs/adr/shell-and-login.md`.

## What exists

| Route / component | What it does |
|---|---|
| `/login` | One sign-in for CRM, ERP and OS: code (SMS / e-mail), password, "forgot password"; demo e-mail sign-in when `NEXT_PUBLIC_AUTH_PROVIDER=dev`. Honours `?next=/crm/...`. |
| `/` | Landing after sign-in: school branding + only the products the school bought AND the person was given. |
| `/go/<product>` | Opens the product when the person has it, else "not part of your plan". Use it for links from mail or the mobile app. |
| `/account/password` | Set / change password; forced while `must_change_password` is set. |
| `GET /api/os/session` | The platform session (`PlatformSession` in `@autoed/shared`): user, org (+ `branding`), products with `home` and modules, `must_change_password`. Answers for any signed-in person, with or without the OS. |
| `<ProductSwitcher current="crm" />` | Header control listing the person's products; links to each product home and to `/`. |
| `<ProductGate product="crm">` | Signed out -> `/login?next=...`; must change password -> `/account/password`; no product -> "not part of your plan"; else renders children. |
| `<SchoolBrand session={...} />`, `brandColor(branding)` | School name / initials in `branding.primary_color` (or `branding.color`). |
| `usePlatformSession()`, `useShellLang()`, `signOut()` | The session (fetched once per page and shared), the `os_lang` language choice, sign-out everywhere. |

Everything is exported from `@/components/shell` (the old OS header moved to `components/os-shell.tsx` so that
path resolves to the shell).

## Mounting it in a product layout

```tsx
// apps/web/app/crm/layout.tsx  (same for apps/web/app/erp/(staff)/layout.tsx with product="erp")
import type { ReactNode } from 'react';
import { ProductGate } from '@/components/shell';
import { CrmRoot } from '@/components/crm/root'; // your own provider + chrome

export const dynamic = 'force-dynamic';

export default function CrmLayout({ children }: { children: ReactNode }) {
  return (
    <ProductGate product="crm">
      <CrmRoot>{children}</CrmRoot>
    </ProductGate>
  );
}
```

and in your header (a client component):

```tsx
import { ProductSwitcher } from '@/components/shell';
// ...
<header className="flex items-center gap-2 ...">
  <ProductSwitcher current="crm" lang={lang} />  {/* lang optional: defaults to the saved os_lang choice */}
  ...
</header>
```

Rules:

* Product homes are fixed in `PRODUCT_HOME` (`@autoed/shared`): `/os`, `/crm`, `/erp`. The ERP staff screens must
  answer at `/erp` (the portal keeps `/erp/parent`, `/erp/student`, `/erp/driver`, `/erp/gate`, `/erp/signin`).
  If a home has to change, change `PRODUCT_HOME` only.
* Sign-out: call `signOut()` from `@/components/shell` (ends the shared session and returns to `/login`). Do not
  build a separate CRM or ERP staff login: the session cookie `os_session` (HS256, issuer `autoed-os`, `sub` = auth
  user id, claims `sid`, `org`, `products`, `mcp`) is the one platform session; `packages/crm-server/src/auth.ts`
  already verifies it.
* Your server must still check the product itself (layer 2) - the gate is only the UI layer. A product server
  should also refuse while the token's `mcp` claim (or `core.user_security.must_change_password`) is set, answering
  `403 password_change_required`; the OS dispatcher does this already.
* Strings: the shell's keys are `shell.*` (en/hi/te). The product names come from `shell.product.<key>.name`.
* The ERP parent/student portal (`app/erp/(portal)`) keeps its own sign-in and is not gated by this shell.
