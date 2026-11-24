# AutoEd Privacy Policy

> **DRAFT - needs legal review - not legal advice**
> This is a working draft written by the product team, not by a lawyer. Do not publish, sign or rely on it until counsel has reviewed it. `[ASSUMPTION]` marks something we assumed; `[CONFIRM]` marks a figure, period or legal point we are unsure of. Remove this banner only after written sign-off from counsel.

| | |
|---|---|
| Version | 0.1 (draft) |
| Date | 2026-11-24 |
| Operator | AutoEd, a registered company under Arfan Group Private Limited, India `[CONFIRM exact legal name, CIN, registered address]` |
| Applies to | AutoEd CRM, AutoEd OS, AutoEd ERP, the AutoEd websites (`autoed.in` `[ASSUMPTION: marketing site and apps share this domain]`) and the AutoEd mobile apps |
| Governing law | India. Digital Personal Data Protection Act, 2023 ("DPDP Act") and the DPDP Rules, 2025 ("DPDP Rules") `[CONFIRM current text and commencement dates]` |

## 1. Who we are and which role we play

AutoEd provides software to schools, coaching centres and colleges ("**Clients**"). Our two roles differ, and this policy treats them separately.

1. **AutoEd as Data Processor (most data).** When a Client uses AutoEd to store and handle data about its learners, parents/guardians, staff and enquirers, **the Client decides why and how that data is used. The Client is the Data Fiduciary and AutoEd is its Data Processor.** We process that data only on the Client's documented instructions and under our Data Processing Agreement (`data-processing-agreement.md`). This includes **CRM leads and enquiries, which are the Client's data** (decision #31).
2. **AutoEd as Data Fiduciary (limited data).** For a small set of data that AutoEd itself decides to collect, such as Client account administrators, billing contacts, visitors to AutoEd's own website, and AutoEd's own sales and marketing contacts, AutoEd is the Data Fiduciary. AutoEd's own marketing data, if and when we hold any, is kept in a **separate AutoEd-owned organisation** and never mixed with a Client's data (decision #31).

If you are a student, parent, teacher or enquirer of a school and want to see, correct or delete your data, **contact your school first**. It is the Data Fiduciary and decides on your request; we will help it respond (section 10).

## 2. What data we handle

### 2.1 As Data Processor, on behalf of Clients

Depending on the products and modules a Client switches on `[ASSUMPTION: this list follows the OS, CRM and ERP scope in docs/PLAN-unified-platform.md and may change]`:

| Group | Examples |
|---|---|
| Learners (including children under 18) | Name, date of birth, class/batch/programme, admission number, attendance, marks and report cards, helpdesk/behaviour notes, fee status, photo |
| Parents and guardians | Name, phone, email, relationship to learner, portal login, communication preferences |
| Staff | Name, role, phone, email, attendance, leave, timetable, tasks, payroll data (ERP) |
| Enquirers and leads (CRM) | Name of parent and child, phone, email, source, class applied for, follow-up notes, application status |
| Operational records | Audit logs of who did what, files uploaded, messages sent, AI usage records |
| Financial records (ERP) | Fee demands, receipts, invoices, ledgers |

Much of this is **children's data**. Section 7 sets the extra rules.

### 2.2 As Data Fiduciary, for AutoEd itself

| Group | Examples | Why |
|---|---|---|
| Client administrators and billing contacts | Name, work email, phone, role, school name, GSTIN | To run the account, send invoices, give support |
| Payment data | Razorpay order and payment IDs, amount, status. **We do not store card or UPI credentials; Razorpay handles those.** | To take payment and issue GST invoices |
| Website and app diagnostics | IP address, device type, error reports, page requests | Security, reliability (Sentry, hosting logs) |
| Support requests | What you send us | To answer you |
| Prospects (if we later keep a separate AutoEd marketing org) | Business contact details | Only with a lawful basis and consent where required `[CONFIRM]` |

## 3. Why we use data (purposes) and on what basis

* **As Processor:** only to provide the services the Client has bought, and as the Client instructs.
* **As Fiduciary:** to provide and secure the service, bill for it, support Clients, meet legal obligations (tax, accounting), and, with consent where required, send product updates. Under the DPDP Act the lawful bases are consent and the limited "legitimate uses" in the Act `[CONFIRM which legitimate uses apply to billing, security and legal compliance]`.

We do **not** sell personal data. We do **not** use Client data to train AI models, to advertise, or for our own marketing.

## 4. Where data is stored and who processes it

* The production database and file storage are in **Mumbai, India** (Supabase on AWS ap-south-1) `[ASSUMPTION: confirm when the production project is created]`.
* Web servers run on Vercel, pinned to the Mumbai region (`bom1`) where available `[CONFIRM]`.
* Some service providers may process limited data **outside India** (for example push delivery, error monitoring and AI). The full list, with each provider's role and location, is in the sub-processor table in `data-processing-agreement.md` and summarised in section 6. The DPDP Act allows transfer abroad except to countries the Central Government restricts `[CONFIRM current notified restrictions]`.

## 5. Artificial intelligence

* AutoEd uses Google Gemini on the **paid API tier only** in production, because free-tier prompts may be used by the provider to improve its models.
* **Student and staff personal data is never sent to AI providers.** AI features work on content that does not identify a person (for example a lesson-plan outline, a generic circular draft). Names, contact details, marks and similar are removed or never included. `[ASSUMPTION: this rule is enforced in code and tested; counsel to confirm the wording fits how "personal data" is defined]`
* AI requests are logged (who asked, when, which feature, credits used) but the log does not store personal data of learners or staff. Retention: see `data-retention-schedule.md`.

## 6. Who we share data with (sub-processors)

We use the following service providers. They may handle data only to provide their service to us. The authoritative, current table (with data types and locations) is in `data-processing-agreement.md`.

| Provider | Purpose | Location |
|---|---|---|
| Supabase (on AWS) | Database, authentication, file storage | Mumbai, India |
| Vercel | Hosting of web apps and server functions | Mumbai (`bom1`) for functions `[CONFIRM]`; CDN may be global |
| Google (Gemini API, paid tier) | AI features, no personal data of learners or staff | `[CONFIRM region and data-residency options]` |
| WhatsApp provider | Messages to parents/leads; either the Client's own provider or one run by AutoEd `[CONFIRM provider name]` | `[CONFIRM]` |
| Expo / Firebase (Google) | Push notifications to mobile apps | May be outside India `[CONFIRM]` |
| Sentry | Error and performance monitoring | `[CONFIRM region; choose an EU/US/other data region]` |
| Razorpay | Payments and subscriptions for AutoEd's own billing | India |

We may also disclose data where required by law, a court order, or a government authority, and to our professional advisers under confidentiality.

## 7. Children's data

Many learners and enquirers are under 18. Under the DPDP Act a "child" is a person under 18 `[CONFIRM]`.

* **The school (Data Fiduciary) is responsible for obtaining verifiable parental or guardian consent** where the law requires it, and for the lawful purpose of processing. AutoEd provides tools to record that consent but does not collect it from parents on the school's behalf unless the school instructs and configures us to `[ASSUMPTION]`.
* AutoEd **does not track, profile, or run targeted advertising directed at children**, and does not process children's data in a way likely to cause them harm.
* The DPDP Rules contain exemptions for educational institutions for some of these duties, limited to what is needed for educational activities and safety `[CONFIRM exact scope and whether it extends to a software vendor such as AutoEd]`. AutoEd does not rely on those exemptions for its own purposes.
* The parent/student portal and app (part of the ERP product) show a learner or guardian only their own linked records.

## 8. Security

* Tenant isolation is enforced in the database (Row Level Security); each Client's data is separated from every other Client's data, and products a Client has not bought cannot read that Client's other product data.
* Encryption in transit (TLS) and at rest `[CONFIRM provider defaults]`; role-based access; audit logging of changes and of any AutoEd staff access to a Client's account (time-limited, with a reason, visible to the Client); secrets kept only in provider settings; error monitoring.
* We test isolation before releases.
* No system is perfectly secure. If a personal data breach occurs we follow `breach-response-runbook.md` and tell affected Clients and, where required, the Data Protection Board of India.

## 9. How long we keep data

* **Client data (as Processor):** for as long as the Client's subscription is active, then per the Client agreement: **30 days read-only after a product's payment lapses, then export and deletion; on leaving, CSV/Excel export and deletion 30 days later** (decision #42). Day-by-day detail is in `refund-and-cancellation-policy.md` and `data-retention-schedule.md`.
* **Our own records:** invoices and accounting records are kept as long as tax and company law require, commonly about 8 years `[CONFIRM]`. Other periods are in `data-retention-schedule.md`.

## 10. Your rights

Under the DPDP Act you can, in general, ask for access to a summary of your data, correction, completion and updating, erasure, grievance redress, and nominate another person to exercise your rights if you die or become incapable `[CONFIRM list and conditions]`.

* **Data held by a school:** contact the school. We will help it fulfil the request (`data-subject-rights-procedure.md`).
* **Data AutoEd holds as Fiduciary:** write to the contact in section 12. We aim to respond within `[CONFIRM period, the Rules set a maximum for grievance response]`.
* If unsatisfied, you may complain to the **Data Protection Board of India** after exhausting grievance redress `[CONFIRM]`.
* For a child, the parent or lawful guardian exercises these rights.

## 11. Cookies and similar technologies

The apps use only cookies and local storage needed to keep you signed in and remember settings. We do not use advertising cookies or third-party trackers in the Client apps `[ASSUMPTION; revisit before adding any analytics to autoed.in]`.

## 12. Contact and grievance officer

* Contact: `[PRIVACY EMAIL, e.g. privacy@autoed.in - to be created]`
* Grievance / Data Protection contact: `[NAME, designation, email, postal address]` `[CONFIRM whether a Data Protection Officer or only a grievance contact is required for AutoEd]`
* Company: `[legal name, registered office]`

## 13. Changes

We will post changes here with a new version and date and, for material changes affecting Clients, give notice by email at least `[30 days - CONFIRM]` ahead.

## Open points for counsel (this document)

1. Is AutoEd a "Significant Data Fiduciary" in any role? (Large volumes of children's data may trigger extra duties such as a DPO and audits.) `[CONFIRM]`
2. Wording of AutoEd's two roles, and whether the "legitimate use" bases apply to billing and security.
3. Cross-border transfer disclosures for Gemini, Expo/Firebase, Sentry.
4. Whether this policy should be split into a Client-facing notice and a separate website notice.
