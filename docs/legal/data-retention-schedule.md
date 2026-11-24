# AutoEd Data Retention Schedule

> **DRAFT - needs legal review - not legal advice**
> This is a working draft written by the product team, not by a lawyer. Every period below is a default proposal. Nothing may be auto-deleted in production until counsel has confirmed it. `[ASSUMPTION]` marks something we assumed; `[CONFIRM]` marks a figure, period or legal point we are unsure of; `[LAWYER TO CONFIRM]` marks a retention period that must be set with counsel.

| | |
|---|---|
| Version | 0.1 (draft) |
| Date | 2026-11-24 |
| Purpose | Default retention per data type, enforced by a scheduled purge job (plan section 9, Phase 6) |
| Fixed by owner | Non-payment of a product: 30 days read-only, then export and deletion; on leaving: CSV/Excel export and deletion 30 days later (decision #42) |

## 1. Principles

1. **The Client (Data Fiduciary) decides retention of its data.** These are AutoEd's defaults and the maximum AutoEd will keep Client data after the contract ends. A Client may configure shorter periods per data type `[ASSUMPTION: setting per org in Phase 6]`.
2. The DPDP Act requires erasure when the purpose is served or consent is withdrawn, unless law requires retention `[CONFIRM section 8(7) and the Rules' retention provisions]`.
3. Keep only what is needed. A **legal hold** (court order, investigation, breach) suspends purge for the affected data.
4. The purge job writes an audit entry (what class, which org, how many rows, when) without storing the deleted personal data.
5. Backups age out on the platform cycle `[CONFIRM: plan backups 7 days; confirm]`; we do not restore purged data to live systems except for disaster recovery, and then re-run the purge.
6. The DPDP Rules may require a minimum retention of certain logs and traffic data (commonly understood as one year) `[CONFIRM]`; the log periods below respect that.

## 2. Schedule

Trigger = when the clock starts.

### 2.1 Client data (AutoEd as Data Processor)

| Data type | Default retention | Trigger | After the period | Marker |
|---|---|---|---|---|
| **CRM leads and enquiries not admitted** | 24 months after the last activity | Last follow-up or status change | Delete or anonymise (keep counts for reports) | `[LAWYER TO CONFIRM; consider 12 to 36 months]`; the school's data, school may set shorter |
| **CRM leads that became students** | Becomes a student record (below); lead history kept with it | Admission confirmed (decision #38) | As student | `[LAWYER TO CONFIRM]` |
| **Consent and opt-out records** (WhatsApp, SMS, parental consent) | Life of the relationship plus 3 years, because they are proof of lawful processing | Consent withdrawn or relationship ended | Delete | `[LAWYER TO CONFIRM]` |
| **Active students / parents / staff data** | While enrolled or employed | | | |
| **Students after leaving** (core profile, attendance, results, report cards, certificates data) | Core academic record `[ASSUMPTION: school may need for transfer certificates, verification; propose 7 years]`; other student data (helpdesk, notes, photos) 1 year | Date of leaving | Delete or anonymise | `[LAWYER TO CONFIRM; check education and board record rules, school may be required to keep records longer]` |
| **Parents / guardians after learner leaves** | Same as the learner's record | Date learner leaves | Delete | `[LAWYER TO CONFIRM]` |
| **Staff after leaving** (HR and payroll data) | Payroll and statutory records per law (see financial records); other profile data 3 years `[ASSUMPTION]` | Date of leaving | Delete or anonymise | `[LAWYER TO CONFIRM; PF/ESI/TDS and labour law periods]` |
| **Operational records** (tasks, leave, timetable, lesson plans, circulars, helpdesk) | Current plus 3 academic years `[ASSUMPTION]` | End of the academic year | Delete or archive on request | `[LAWYER TO CONFIRM]` |
| **Uploaded files** (documents, photos, attachments) | Same as the record they belong to | | Delete from storage with the record | |
| **Messages (WhatsApp / push / SMS content and delivery logs)** | 12 months `[ASSUMPTION]` | Send date | Delete content; keep minimal delivery metadata 12 more months for dispute handling | `[LAWYER TO CONFIRM]` |
| **Financial records the Client keeps in ERP** (fee demands, receipts, invoices, ledgers, payroll) | **About 8 years** `[CONFIRM: Companies Act books of account; GST records; income tax; the school's own legal regime]` | End of the financial year | Delete or archive | `[LAWYER TO CONFIRM]` |

### 2.2 Logs

| Data type | Default retention | Trigger | Marker |
|---|---|---|---|
| **Audit log** (`audit.log`: who changed what, role and entitlement changes, support "view as" access) | **3 years** online, then delete `[ASSUMPTION]`; at least 1 year in all cases | Event date | `[LAWYER TO CONFIRM]` (balance: security evidence and Rules' minimum versus minimisation). Audit entries should store identifiers and field names rather than the personal data itself |
| **Login events** (`core.login_events`, security data) | 12 months | Event date | `[LAWYER TO CONFIRM]` |
| **AI logs** (AI request log: Client, user, feature, credits; no learner/staff personal data) | 12 months for usage detail; monthly credit totals kept with billing records | Event date | `[LAWYER TO CONFIRM]` |
| **Application and error logs** (Vercel, Supabase, Sentry) | Provider defaults, not more than 90 days `[ASSUMPTION; confirm provider settings]` | Event date | `[CONFIRM]` |
| **Support session records** | Same as the audit log | | |
| **Breach incident records** | 5 years `[ASSUMPTION]` | Incident closed | `[LAWYER TO CONFIRM]` |

### 2.3 AutoEd's own data (AutoEd as Data Fiduciary)

| Data type | Default retention | Trigger | Marker |
|---|---|---|---|
| **Invoices, payment records, GST records, credit notes** | **About 8 years** `[CONFIRM: GST Act records at least 72 months from due date of annual return; Companies Act 8 years]` | End of financial year | `[LAWYER TO CONFIRM]` |
| **Client contracts and DPAs** | Term plus 8 years `[ASSUMPTION; limitation periods]` | Contract end | `[LAWYER TO CONFIRM]` |
| **Client administrator and billing contacts** | While the account is active, then 2 years (for disputes) | Contract end | `[LAWYER TO CONFIRM]` |
| **Support tickets and correspondence** | 3 years `[ASSUMPTION]` | Ticket closed | `[LAWYER TO CONFIRM]` |
| **AutoEd marketing prospects** (separate AutoEd-owned org) | Until opt-out, or 24 months after last interaction | Last interaction | `[LAWYER TO CONFIRM]`; keep opt-out suppression list indefinitely |
| **Website visitor logs and analytics** | 12 months | Visit | `[CONFIRM]` |

### 2.4 Contract-end events (fixed by owner)

| Event | Timeline |
|---|---|
| Non-payment of a product | Day 0 read-only; day 0 to 30 read-only; export prepared; then deletion of that product's data (see refund policy for notice) |
| Client leaves | CSV/Excel export delivered; **deletion 30 days later** |
| Trial not converted | Read-only 30 days, then deletion `[ASSUMPTION]` |
| Right-to-erasure request for a person | Within `[30 days - CONFIRM]` of the Client's instruction, subject to legal-hold and retention duties (`data-subject-rights-procedure.md`) |

## 3. How the purge job should work (for the build)

* Daily scheduled job, per org, per data class, reading the rules above plus per-org overrides.
* Dry-run mode first; counts logged; deletion in batches; audited.
* Honours legal hold and `suspended` states.
* Deletes dependent files in storage and search/embedding rows `[ASSUMPTION: the vector tables also hold derived data and must be purged]`.
* Anonymisation (not deletion) where aggregates must survive: replace personal fields with null/hash, keep counts.

## Open points for counsel (this document)

1. Student records: how long a school (and thus AutoEd as Processor) should keep records after a learner leaves, given education-board, transfer-certificate and limitation rules.
2. Minimum log retention under the DPDP Rules and CERT-In directions versus the audit/login/AI log periods above.
3. Financial-record period (8 years) and who is the owner of the records (Client's ERP data versus AutoEd's invoices).
4. Whether CRM leads of minors need a shorter period.
5. Whether anonymised data still counts as personal data for these purposes.
