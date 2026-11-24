# AutoEd Data Processing Agreement (DPA)

> **DRAFT - needs legal review - not legal advice**
> This is a working draft written by the product team, not by a lawyer. Do not sign or rely on it until counsel has reviewed it. `[ASSUMPTION]` marks something we assumed; `[CONFIRM]` marks a figure, period or legal point we are unsure of.

> **Note on the law - read before using.** This DPA is written around India's **Digital Personal Data Protection Act, 2023** ("DPDP Act") and the **Digital Personal Data Protection Rules, 2025** ("DPDP Rules"). The drafters worked from memory of the framework, not from the current official text. **Every clause that cites a section, rule number, time limit or exemption must be checked against the current text of the Act and the Rules, and against any later amendment, notification or phased commencement date, before this DPA is used.** In particular check: the breach-notification timelines; the children's data rules and any exemption for educational institutions; the obligations that apply to a Data Processor (the Act places the main duties on the Data Fiduciary, so most processor duties here are contractual); cross-border transfer restrictions; and retention of logs. `[CONFIRM ALL]`

| | |
|---|---|
| Version | 0.1 (draft) |
| Date | 2026-11-24 |
| Parties | **Client** (Data Fiduciary) and **AutoEd**, a registered company under Arfan Group Private Limited `[CONFIRM legal name]` (Data Processor) |
| Forms part of | Client Agreement (Annexure A) |
| Basis | AutoEd is the Data Processor for school data (decision #48); CRM leads are the Client's data (decision #31) |

## 1. Definitions

Terms such as *personal data*, *data principal*, *Data Fiduciary*, *Data Processor*, *processing*, *personal data breach*, *child* and *Board* have the meaning in the DPDP Act `[CONFIRM]`. "**Client Personal Data**" means personal data processed by AutoEd on behalf of the Client through the Services, including data about learners (including children), parents/guardians, staff and CRM leads and enquirers. "**Sub-processor**" means a third party AutoEd engages to process Client Personal Data.

## 2. Roles and scope

1. The Client is the Data Fiduciary and determines the purposes and means. AutoEd is the Data Processor and processes only on the Client's behalf.
2. Subject matter: providing the CRM, OS and ERP products the Client has bought. Duration: the subscription term plus the deletion periods in section 12. Nature and purpose, categories of data and data principals: Annexure 1.
3. The Client's instructions are this DPA, the Client Agreement and the Client's configuration and use of the Services. AutoEd tells the Client if it believes an instruction breaches the law.
4. If AutoEd determines purposes of its own for any data (for example its own marketing), it does so as a separate Data Fiduciary, in a separate AutoEd-owned organisation, and never with Client data.

## 3. Processor duties

AutoEd will:

1. process Client Personal Data only for the purposes above and on the Client's instructions;
2. keep it confidential and ensure everyone authorised to process it is bound by confidentiality;
3. implement the **security safeguards** in section 6, reasonable for the nature of the data `[CONFIRM against the safeguards the DPDP Rules require, e.g. encryption/obfuscation, access control, logging, backups, monitoring]`;
4. assist the Client to respond to requests from data principals (access, correction, erasure, grievance, nomination) using the tools in `data-subject-rights-procedure.md`;
5. notify the Client of a personal data breach per section 8;
6. engage Sub-processors only per section 7;
7. delete or return Client Personal Data per section 12;
8. give the Client information reasonably needed to show compliance and allow audit per section 11;
9. keep records of processing activities, access by AutoEd staff ("view as" sessions) and Sub-processors;
10. not **sell, rent or share** Client Personal Data, nor use it for AutoEd's own purposes, advertising or to train AI models.

## 4. Children's data

1. Many data principals are children (under 18) `[CONFIRM definition]`. The **Client, as Data Fiduciary, is responsible for obtaining verifiable consent of the parent or lawful guardian** where required, for verifying the identity and age of the parent/guardian as the Rules require, and for any lawful exemption it relies on `[CONFIRM exemptions for educational institutions and whether they extend to AutoEd as Processor]`.
2. AutoEd provides features to record consent and its status (`messaging-consent.md`, `data-subject-rights-procedure.md`) but does not itself verify parents.
3. AutoEd will **not** carry out **tracking, behavioural monitoring, profiling or targeted advertising directed at children**, and will not enable it in the Services. The Client will not instruct otherwise. Operational features that the Client needs for educational activities or safety (for example attendance) are the Client's instruction and responsibility `[CONFIRM line between permitted educational monitoring and prohibited tracking]`.
4. The Services do not use children's data to train AI or to personalise advertising.

## 5. Artificial intelligence

1. **Student and staff personal data is never sent to AI providers.** Features that call an AI provider send only content that does not identify a person, and the application layer removes or excludes identifying fields before any call. AutoEd tests this rule.
2. AutoEd uses **Google Gemini on the paid API tier only** in production; free-tier use is blocked by configuration `[ASSUMPTION: startup check refuses a non-paid setting in production]`. Development uses a mock adapter.
3. AI usage logs record the event (Client, user, feature, time, credits), not the personal data of learners or staff.

## 6. Security measures

| Area | Measure |
|---|---|
| Isolation | Row Level Security on every table; per-Client (`org_id`) isolation in the database; per-product access; isolation tests before release |
| Access | Role-based access, unique logins (phone OTP, email OTP, password), lockout after failed attempts `[CONFIRM]`, optional 2FA; least-privilege database roles per product |
| Support access | Time-limited "view as" sessions with stated reason, logged and visible to the Client |
| Encryption | TLS in transit; encryption at rest by the database platform `[CONFIRM]` |
| Audit | Changes to entitlements, roles and data are logged |
| Secrets | Held only in platform settings; rotated on staff change |
| Backups | Daily platform backups `[CONFIRM retention, restore test cadence]` |
| Monitoring | Error monitoring; platform security advisors after migrations |
| Location | Database and storage in Mumbai, India |
| Staff | Confidentiality obligations; access limited to what the role needs `[ASSUMPTION: staff training and onboarding checklist to be written]` |

`[ASSUMPTION: the platform is not yet in production; these measures are the design commitments in docs/PLAN-unified-platform.md and must be verified (BUILD-LOG) before this DPA is signed by any real Client.]`

## 7. Sub-processors

1. The Client gives **general authorisation** for the Sub-processors in the table below. AutoEd will give at least `[30 days - CONFIRM]` notice (email and in-app) before adding or replacing one that handles Client Personal Data. The Client may object on reasonable data-protection grounds within `[15 days - CONFIRM]`; if not resolved, the Client may terminate the affected product without penalty and receive a pro-rata refund.
2. AutoEd binds each Sub-processor by written terms no less protective in substance than this DPA and remains responsible for it.

| Sub-processor | What it does | Client data it may see | Where it processes | Notes |
|---|---|---|---|---|
| **Supabase** (hosting on **AWS**) | Postgres database, authentication, file storage | All Client Personal Data stored in the Services | **Mumbai, India (AWS ap-south-1)** `[CONFIRM production project region]` | Supabase company is US-based; support/admin access from outside India is possible `[CONFIRM]` |
| **Vercel** | Hosts the web apps and server functions | Request data passing through functions; no persistent storage of Client data intended | Functions pinned to **Mumbai (`bom1`)** `[CONFIRM]`; CDN/edge and logs may be outside India `[CONFIRM]` | Free/Hobby plan has no DPA - see open points |
| **Google (Gemini API, paid tier)** | AI features | **No student or staff personal data.** Non-identifying prompt content only | `[CONFIRM region; Google may process outside India]` | Paid tier does not train on prompts `[CONFIRM current terms]` |
| **WhatsApp provider** | Sends and receives WhatsApp messages | Recipient phone number, message content, delivery status | **Client's own provider** (Client is responsible for it) **or AutoEd-run provider** `[CONFIRM provider name, e.g. a Business Solution Provider, and location]` | `provider_owner` is `client` or `autoed` (decision #41). WhatsApp/Meta processes messages under its own terms |
| **Expo / Firebase (Google)** | Push notifications to mobile apps | Device push token, notification title/body | Outside India possible `[CONFIRM]` | Notification text should not contain sensitive learner data `[ASSUMPTION: enforce in code]` |
| **Sentry** | Error and performance monitoring | Error traces, IP, user ID; personal data scrubbed `[ASSUMPTION: scrubbing configured]` | `[CONFIRM region chosen; EU/US region would be outside India]` | No learner content intended in traces |
| **Razorpay** | Payment gateway for AutoEd's own subscription billing | Client billing contact, payment identifiers; **no learner data** | India | Razorpay is largely an independent fiduciary for payment data `[CONFIRM]`. Fee collection from parents (ERP) is a separate feature and a separate review `[ASSUMPTION]` |

`[ASSUMPTION: SMS gateway, email delivery provider and any analytics provider are not yet chosen; if added, update this table first.]`

## 8. Personal data breach

1. AutoEd will notify the Client **without undue delay and in any event within `[TIMELINE TO BE CONFIRMED BY COUNSEL - placeholder: 24 hours]`** after becoming aware of a breach affecting Client Personal Data `[CONFIRM against the Rules: the Fiduciary must notify the Board without delay and give a detailed report within a prescribed period (commonly understood as 72 hours); set the processor's window shorter so the Client can meet its own]`.
2. The notice includes, as far as known: nature and time of the breach, categories and approximate number of data principals and records, likely consequences, measures taken, and a contact. AutoEd supplies further details as they become known.
3. AutoEd will cooperate with the Client's investigation, mitigation and notifications to affected data principals and the Data Protection Board of India. **The Client, as Data Fiduciary, decides on and makes those notifications**; AutoEd can prepare drafts (`breach-response-runbook.md`).
4. AutoEd keeps a record of breaches and the response `[CONFIRM retention]`.

## 9. International transfers

Client Personal Data is stored in India. Some Sub-processors (Section 7) may process limited data outside India. AutoEd will not transfer it to a country or territory the Central Government has restricted by notification `[CONFIRM current list]`, and will tell the Client of any change in processing location.

## 10. Data subject requests

AutoEd forwards to the Client, within `[3 business days - CONFIRM]`, any request it receives from a data principal about Client Personal Data and does not respond itself except as the Client instructs. See `data-subject-rights-procedure.md`.

## 11. Audit and information

AutoEd will provide up-to-date information on its measures and, once a year and on `[30 days']` notice, answer a reasonable security questionnaire. A deeper audit may be done at the Client's cost, under confidentiality and during business hours, where the Board or a regulator requires it or after a breach `[CONFIRM]`.

## 12. Return and deletion

1. **Non-payment of a product:** read-only for **30 days**, then export and deletion of that product's data.
2. **On leaving:** CSV/Excel export and **deletion 30 days after** (decision #42).
3. At any time the Client may export its data using the tools in the Services.
4. Deletion removes data from live systems; backups age out on their normal cycle `[CONFIRM max]`. AutoEd confirms deletion in writing on request.
5. AutoEd retains only what law requires it to keep **as its own records** (for example invoices and tax records) and, if the Rules require, certain logs and traffic data for a minimum period `[CONFIRM period under the Rules; commonly one year for logs]`.

## 13. Liability

As set in the Client Agreement. `[CONFIRM: super-cap for breach of this DPA; allocation of statutory penalties.]`

## 14. Term, order of precedence, law

This DPA lasts while AutoEd processes Client Personal Data. In a conflict on personal data, this DPA prevails. Indian law applies; forum as in the Client Agreement.

---

## Annexure 1: Description of processing

| Item | Description |
|---|---|
| Purpose | Admissions and enquiry management (CRM), school operations (OS), fees, accounts and parent/student portal (ERP) `[ASSUMPTION per plan]` |
| Data principals | Learners (including children), parents/guardians, staff, enquirers/leads, Client administrators |
| Categories | Identity and contact details; class/programme and attendance; assessment and report data; fee and payment status; staff HR data; messages; uploaded files; logs |
| Sensitive data | Health or special-needs notes, caste/category, if the Client chooses to record them `[ASSUMPTION; DPDP Act has no "sensitive" class but counsel to advise on risk]` |
| Frequency | Continuous during the term |
| Retention | Per `data-retention-schedule.md` |

## Open points for counsel (this document)

1. Exact processor obligations and the breach timeline: confirm AutoEd's window (placeholder 24 hours) against the Board-notification clock.
2. Educational-institution exemptions for children's data and whether AutoEd as Processor benefits.
3. Vercel Hobby plan terms and DPA availability (upgrade to a plan with a DPA before a paying client, owner decision #33 requires written approval for spend).
4. Gemini: data-residency options, paid-tier terms, whether non-identifying content is truly outside "personal data".
5. Whether Supabase/AWS/Vercel/Sentry standard DPAs are adequate or need review.
6. Whether Razorpay is a Sub-processor or independent Fiduciary.
7. Security-measure list versus the Rules' prescribed safeguards.
