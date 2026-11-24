# Personal Data Breach Response Runbook

> **DRAFT - needs legal review - not legal advice**
> This is a working draft written by the product team, not by a lawyer. Do not rely on it as the legal basis for any notification until counsel has reviewed it. `[ASSUMPTION]` marks something we assumed; `[CONFIRM]` marks a figure, period or legal point we are unsure of.

| | |
|---|---|
| Version | 0.1 (draft) |
| Date | 2026-11-24 |
| Applies to | Any suspected or confirmed breach of personal data in AutoEd CRM, OS, ERP, the apps, or AutoEd's own systems |
| Legal frame | DPDP Act 2023 and DPDP Rules 2025 `[CONFIRM current text]`. The Client is the Data Fiduciary for school data and is the party that notifies the Data Protection Board and data principals. AutoEd, as Processor, must tell the Client fast and help. For AutoEd's own data (billing contacts, etc.) AutoEd is the Fiduciary and notifies. |

**Clock (placeholders, counsel to confirm):** AutoEd to Client within **[24 hours - CONFIRM]** of becoming aware. Client to Board "without delay" and detailed report within **[72 hours - CONFIRM]**. Client to affected data principals "without delay" `[CONFIRM]`. Start the clock at **awareness**, not at confirmation of the full facts. Notify early and update later.

## 1. What counts as a breach

Any unauthorised processing, or accidental disclosure, acquisition, sharing, use, alteration, destruction or loss of access to personal data that compromises its confidentiality, integrity or availability `[CONFIRM definition]`. Examples:

* a policy mistake lets one Client (or a user without the product) read another's rows;
* leaked service-role key, database password or user credentials;
* a staff laptop or account compromised; a "view as" session misused;
* data exported or sent to the wrong recipient; a wrong WhatsApp broadcast;
* a Sub-processor tells us of its own breach;
* student or staff personal data found in an AI request or an error trace;
* ransomware, deletion or loss of data without a usable backup.

If in doubt, treat it as a breach and start section 3.

## 2. Roles

| Role | Who `[ASSUMPTION: owner is the only admin today, decision #47; fill names when a second person exists]` | Duties |
|---|---|---|
| **Incident Commander (IC)** | Owner (Atif) / backup `[NAME]` | Runs the incident, decides severity, signs off notifications |
| **Technical Lead** | Engineer on call `[NAME]` (or Claude session working with the owner) | Contain, investigate, fix, preserve evidence |
| **Legal / Compliance contact** | `[LAWYER NAME, phone]` (none engaged yet) | Advises on notification duty and wording |
| **Client Liaison** | `[NAME]` | Talks to affected Clients |
| **Scribe** | Anyone assigned | Keeps the timeline log in real time |

## 3. Steps

### Step 0 - Detect and report (any time)
Anyone who suspects a breach (staff, Client, Sentry alert, Supabase advisor, a user report) emails `[SECURITY EMAIL]` and messages the IC. Do not investigate alone or delete anything.

### Step 1 - Open the incident record (within 1 hour)
Create an incident file `docs/legal/incidents/YYYY-MM-DD-short-name.md` `[ASSUMPTION: keep privately, not in the public repo; counsel to advise on privilege]`. Record: who reported, when AutoEd became aware (this starts the clock), what is known, first severity guess (section 4).

### Step 2 - Contain (immediately)
Stop the bleeding before understanding everything. Typical actions:
* revoke or rotate exposed keys, passwords and tokens (Supabase service role, per-product DB role passwords, Vercel env vars, Razorpay, WhatsApp, Gemini);
* disable the affected user, "view as" session or integration;
* switch the affected product off for the affected org (subscription `suspended`), or take the app to maintenance mode;
* fix or disable the faulty policy/function via a migration (never edit production by hand `[per plan rule 5]`);
* if a Sub-processor is the source, follow their instructions and revoke our access.

### Step 3 - Preserve evidence
Export relevant `audit.log` rows, `core.login_events`, Supabase logs, Vercel runtime logs and Sentry events for the window. Snapshot configuration. Do not overwrite or purge; suspend the retention purge job for the affected data `[ASSUMPTION: purge job has a legal-hold switch]`.

### Step 4 - Assess scope
Answer, with evidence:
* Which Clients (`org_id`s), products, tables and which data principals? How many records? Any **children**? Any financial or ID data?
* What data fields? Was data read, copied, changed or destroyed?
* From when to when? Is it still happening?
* Was it encrypted or otherwise unreadable to the recipient?
* Who had access (external, another Client, internal)?
Use the audit log to find actual access, not only possible access.

### Step 5 - Decide on notification (IC with counsel, target within 12 hours of awareness)
* Personal data of any Client affected -> **notify those Clients** (Step 6), always.
* AutoEd's own data affected -> AutoEd notifies the Board and affected people as Fiduciary (Step 8).
* If it is a confirmed **no personal data** event (for example a service outage), record the reasoning and close.
Record the decision and who made it.

### Step 6 - Notify affected Clients (within [24 hours - CONFIRM])
Send Template A below to the Client's registered data contact and administrator, by email and phone/WhatsApp as a courtesy. Send a first notice even with partial facts. Promise updates every `[24 hours]` until contained.

### Step 7 - Support the Client's own notifications
The Client decides whether and what to tell the Board and data principals. AutoEd helps by giving the Client: Template B (draft Board intimation content), Template C (draft notice to data principals/parents), the affected-person list in a safe export, and the facts. `[CONFIRM the current Board reporting channel and format under the Rules.]`

### Step 8 - AutoEd as Fiduciary (own data breach)
IC with counsel notifies the Board and the affected individuals using Templates B and C, adapted.

### Step 9 - Eradicate and recover
Deploy the permanent fix via the normal migration path with an isolation test that would have caught the issue (add to the T1-T12 harness). Restore data from backup if needed (restore to a separate project and copy back that org's rows). Re-enable service. Rotate any credentials that could have been seen.

### Step 10 - Review (within 14 days after close)
Write a post-incident review: timeline, root cause, what worked, what failed, actions with owners and dates. Update this runbook, the DPA security measures, and the risk register. Keep the record for `[CONFIRM period]`.

## 4. Severity guide

| Level | Meaning | Examples | Response |
|---|---|---|---|
| **SEV1** | Confirmed access by an unauthorised party to personal data, or cross-Client leak, or children's data exposed | RLS bug returned another Client's students; leaked service key used | All hands, Clients notified in hours |
| **SEV2** | Likely exposure not yet confirmed, or limited internal misuse | Key exposed in a public repo for a short time, no sign of use | Contain, assess, notify if any evidence |
| **SEV3** | Near miss, no personal data at risk | Alert from advisor on an unused table | Fix and log |

## 5. Templates

### Template A - AutoEd to Client (first notice)

> **Subject:** Important: personal data incident affecting [Client name] - [incident ID]
>
> Dear [name],
>
> We are writing as your Data Processor under our Data Processing Agreement. On [date, time IST], we became aware of an incident that may involve personal data held for [Client name] in AutoEd [CRM / OS / ERP].
>
> **What we know so far:** [short factual description]. **When:** [from - to, or "ongoing/unknown"]. **Data involved:** [categories, e.g. names, phone numbers of parents of about N learners; includes data of children: yes/no]. **People affected:** approximately [N], [which branches].
>
> **What we have done:** [containment actions]. **What we recommend you do now:** [e.g. do not click links in unusual messages; reset passwords; hold off on bulk messaging].
>
> As the Data Fiduciary you decide on notifying the Data Protection Board of India and the affected individuals. We will support you with a draft intimation, the affected list and a full report. We will send an update by [time]. Our contact for this incident: [name, phone, email].
>
> [Name], AutoEd

### Template B - Draft intimation to the Data Protection Board of India (content for the Fiduciary to submit) `[CONFIRM required fields and channel under the Rules]`

1. Fiduciary name, contact, registration details.
2. Nature, extent, timing and location of the breach.
3. Likely impact on data principals.
4. Categories and approximate number of data principals and records.
5. Whether children's data is involved.
6. Measures taken or proposed to mitigate risk and prevent recurrence.
7. Findings on the cause and the person(s) responsible, if known.
8. Steps taken to protect interests of affected data principals.
9. Contact for the Board.
10. Date and time of awareness; date and time of this intimation. `[If the detailed report is a second step within the prescribed period, use this list for the detailed report and a shorter version for the first intimation.]`

### Template C - Draft notice to affected data principals or parents/guardians

> **Subject:** Notice about your [child's] personal data held by [School name]
>
> Dear [parent / guardian / name],
>
> We are writing to inform you of an incident involving personal data held by [School name]. On [date] we learned that [plain-language description]. The data involved: [list, e.g. name, class, phone number]. [It does / does not include financial or identity documents.]
>
> What this could mean for you: [e.g. you may receive unwanted calls or messages]. What we have done: [measures]. What you can do: [practical advice]. For questions contact [name, phone, email]. You may also complain to the Data Protection Board of India `[CONFIRM wording]`.
>
> [Name, designation], [School name]

### Template D - Update to Client (every [24 hours])

> **Subject:** Update [n] - incident [ID]
> Status: [contained / under investigation / resolved]. New facts: [...]. Changes to affected numbers: [...]. Next update by: [time].

### Template E - Closing note to Client

> Root cause, fix, timeline, data affected (final), actions to prevent recurrence, attached post-incident review summary, confirmation of notifications made by AutoEd.

## 6. Contact sheet (fill in before first Client goes live)

| Who | Contact |
|---|---|
| Incident Commander | `[ ]` |
| Backup | `[ ]` |
| Lawyer | `[ ]` |
| Supabase support, Vercel support, Razorpay, WhatsApp provider | `[ ]` |
| Cyber insurer (if any) | `[ ]` |
| CERT-In (reporting of cyber incidents) | `[CONFIRM whether AutoEd must report separately within 6 hours under the CERT-In directions of 2022]` |

## 7. Testing this runbook

Run a table-top exercise before the first paying Client and after every change in provider or staff: simulate "RLS bug returned another school's students" and time Steps 1 to 6.

## Open points for counsel (this document)

1. The processor-to-fiduciary window and the Board clock (placeholders 24 h and 72 h).
2. Whether CERT-In reporting also applies, and the interaction with DPDP reporting.
3. Board reporting channel and format; content required in the first intimation versus the detailed report.
4. Whether AutoEd should notify data principals directly on a Client's behalf (by contract) or leave it to the Client.
5. Privilege and record-keeping for incident files.
