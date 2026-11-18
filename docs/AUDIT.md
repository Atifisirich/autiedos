# AUDIT.md — what already existed (PRD rule 1)

The PRD asks the build to audit the existing AutoEd CRM/ERP app and reuse what it already has for
organisations, staff and classes. This records what could actually be checked.

## What was checked

| Item | Result |
|---|---|
| Supabase project `autoed-crm-mumbai` (ap-south-1), `public` schema | **No tables** (confirmed through the Supabase connector at the start of the build). Nothing to reuse or conflict with. |
| CRM source repository | **Not accessible** from the build session. The only repository the session could read and write was `atifisirich/autiedos`, which was empty apart from the PRD. |
| Vercel project `autoed-crm` | Known from the PRD (Next.js, Node 22). Not inspected for code. |

## What this means

* Because the database had no tables, the OS schema is created from scratch by migrations
  (`supabase/migrations/2026111600000x_*.sql`). There is no table name collision with the CRM.
* Because the CRM repo could not be read, **no CRM table, component or adapter was reused**. Every
  place the PRD says "reuse the CRM's …" has a standalone implementation instead, behind an adapter so
  it can be swapped:
  * UI kit — a small kit in `apps/web/components/ui.tsx` (Tailwind). Replace with the CRM kit when merged.
  * WhatsApp — `WhatsAppAdapter` in `packages/server/src/adapters/channels.ts` (mock by default; HTTP provider
    when `WHATSAPP_API_URL` and `WHATSAPP_API_TOKEN` are set).
  * Organisations, staff, classes — OS-owned tables (`organizations`, `branches`, `staff`, `classes`,
    `sections`, `students`). If the CRM later owns these, map them with views or a one-time import.

## To do when the CRM repo is available (needs Atif)

1. Compare the CRM's organisation, staff, class and student tables with the OS ones and decide, table by
   table, whether the OS tables become views over the CRM tables or the CRM reads the OS tables.
2. Point `WhatsAppAdapter` at the CRM's messaging function and submit the OS templates for approval
   (`NOTIFICATION_EVENTS[].whatsappTemplate` in `packages/shared/src/presets/catalogs.ts` lists them).
3. Swap the UI kit if the CRM's differs.

Everything else (RLS, audit, module flags, i18n, AI recording) is self-contained and unaffected.
