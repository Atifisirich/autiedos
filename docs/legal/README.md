# docs/legal - draft legal and compliance documents

> **DRAFT - needs legal review - not legal advice**
> Every file in this folder was written by the product team (with Claude) from `docs/PLAN-unified-platform.md` section 9 and `docs/DECISIONS.md` #27-53. No lawyer is engaged yet. Nothing here may be published, signed, sent to a client, or relied on until counsel has reviewed it. Markers: `[ASSUMPTION]` = we assumed it; `[CONFIRM]` = a figure, period or legal point we are unsure of; `[LAWYER TO CONFIRM]` = a retention period to be set with counsel.

Written 2026-11-24. Facts these drafts rest on: AutoEd is a registered company under Arfan Group Private Limited, India (#31); AutoEd is the **data processor** for school data and the client is the data fiduciary (#48); CRM leads are the school's data and AutoEd's own marketing data would live in a separate AutoEd-owned org (#31); billing via Razorpay with GST (#32); 30 days read-only after non-payment of a product, then export and deletion; on leaving, CSV/Excel export and deletion 30 days later (#42); Gemini only, paid tier, no student/staff personal data to AI (#40); data in Mumbai; WhatsApp provider is the client's own or AutoEd's (#41).

## Documents

| File | What it is | Audience |
|---|---|---|
| `privacy-policy.md` | Privacy policy covering both roles: processor for school data, fiduciary for AutoEd's own data | Public (after review) |
| `terms-of-service.md` | Terms for all users of AutoEd CRM, OS, ERP and apps | Public / clients |
| `refund-and-cancellation-policy.md` | Billing via Razorpay with GST, refunds, 30-day read-only then deletion, leaving process | Clients |
| `client-agreement.md` | Master subscription agreement with order form, one per client | Clients (signed) |
| `data-processing-agreement.md` | DPDP-based processor terms, sub-processor table, breach clause placeholder; annexure to the client agreement | Clients (signed) |
| `breach-response-runbook.md` | Internal steps, roles, severity, notification templates for clients and the Data Protection Board | Internal |
| `data-retention-schedule.md` | Default retention per data type with `[LAWYER TO CONFIRM]` markers; spec for the purge job | Internal / clients |
| `data-subject-rights-procedure.md` | Access, correction, erasure, export per person and per organisation; tool requirements | Internal / clients |
| `messaging-consent.md` | WhatsApp opt-in/out records, TRAI/DLT notes if SMS is used | Internal / clients |

## Open questions for counsel

1. **DPDP Rules 2025 text and dates.** Confirm the current text and phased commencement dates; every section/rule reference was written from memory.
2. **Processor obligations and breach clock.** What the Act and Rules require of a Data Processor (versus the fiduciary); the AutoEd-to-client window (placeholder 24 hours) against the Board clock (placeholder 72 hours for the detailed report); whether CERT-In's 6-hour reporting also applies.
3. **Children's data.** Verifiable parental consent mechanics; whether the Rules' exemption for educational institutions covers a software vendor; the line between permitted educational monitoring (attendance) and prohibited tracking/profiling.
4. **Significant Data Fiduciary risk.** Does the volume of children's data make AutoEd or large clients an SDF (DPO, audits, impact assessments)?
5. **Cross-border transfers.** Gemini, Expo/Firebase, Sentry, and Supabase/Vercel support access from outside India; any restricted-country notifications.
6. **Retention periods.** Student records after leaving, CRM leads (esp. minors), audit/login/AI log periods, minimum log retention, financial records (~8 years) and who owns them (client's ERP data versus AutoEd's invoices).
7. **Contract allocation.** Liability cap and super-cap for DPA breach, penalty allocation, indemnities, unilateral change of terms, e-acceptance, stamp duty, dispute forum, contracting entity (AutoEd versus Arfan Group Private Limited).
8. **Billing and refunds.** Cooling-off window, enforceability of no-refund annual plans and auto-renewal (RBI e-mandate), GST credit notes, treatment of unused AI credits.
9. **Deletion mechanics.** Whether day-30 read-only then deletion is acceptable without further notice; handling shared master data when only one product lapses; backups ageing out.
10. **Messaging.** Lawful basis for school service messages; responsibility if AutoEd runs the WhatsApp sender; DLT obligations if SMS is ever used.
11. **Provider contracts.** Whether Vercel Hobby, Supabase and Sentry standard terms provide an adequate DPA; Razorpay as sub-processor or independent fiduciary.
12. **Aggregated/de-identified data.** May AutoEd use it, and does anonymisation take it outside the Act?

## What the owner must decide

1. **Engage a lawyer** (who, when, budget). Spend needs a written yes under decision #33.
2. **Legal identity:** exact contracting entity (AutoEd versus Arfan Group Private Limited), CIN, registered address, GSTIN, SAC code, signatory.
3. **Contacts:** privacy, security, billing, support emails on `autoed.in`; grievance contact (and a DPO if counsel says so); incident commander and a backup (decision #47 says the owner is the only admin today).
4. **Commercial terms:** billing cycles (monthly/annual), free trial or not, cooling-off refund window, late-payment interest, notice periods, liability cap, SLA or none, support hours.
5. **Retention defaults** counsel should start from (section 2 of `data-retention-schedule.md`) and whether clients may set shorter periods.
6. **WhatsApp:** provider name for the AutoEd-run option; whether SMS is in scope at all.
7. **Provider tiers:** moving off free/Hobby plans where DPAs require it (Vercel, Supabase, Sentry), Sentry data region, Gemini region.
8. **Dispute forum:** courts or arbitration, and city.
9. **Whether parents pay fees through the ERP portal** (adds Razorpay as a processor of parent payment data; needs its own review).
10. **Publication plan:** where policies will live (`autoed.in/privacy` etc.), and how acceptance is recorded in the product.

## Things the build must match (so the documents stay true)

* Isolation tests pass before any client data goes in (plan section 8); the DPA security table depends on it.
* Startup check refuses a non-paid Gemini setting in production; AI request path strips personal data.
* Per-person and per-org export and erase tools, retention purge job with legal hold, consent records, support-access log visible to clients (plan Phase 6).
* Sub-processor table updated before any new provider (SMS, email, analytics) is added.
* Vercel functions in `bom1`; production database in Mumbai.
