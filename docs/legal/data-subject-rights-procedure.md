# Data Subject Rights Procedure

> **DRAFT - needs legal review - not legal advice**
> This is a working draft written by the product team, not by a lawyer. Do not rely on it until counsel has reviewed it. `[ASSUMPTION]` marks something we assumed; `[CONFIRM]` marks a figure, period or legal point we are unsure of.

| | |
|---|---|
| Version | 0.1 (draft) |
| Date | 2026-11-24 |
| Covers | Requests by a person (a "data principal", or a parent/guardian for a child) about their personal data, and requests by an organisation (Client) for its whole dataset |
| Legal frame | DPDP Act 2023 and DPDP Rules 2025 `[CONFIRM current text, rights list and response periods]` |
| Build status | **Tools described in section 5 are planned (plan Phase 6) and not built.** Until they exist, requests are handled manually by AutoEd engineers using approved scripts and logged. |

## 1. Who does what

| Situation | Who decides | Who acts |
|---|---|---|
| Person asks about data a **school/Client holds** (students, parents, staff, CRM leads) | **The Client** (Data Fiduciary) | Client administrator uses the product tools; AutoEd helps and runs back-end steps only on the Client's written instruction |
| Person asks AutoEd directly about Client data | The Client | AutoEd forwards to the Client within `[3 business days - CONFIRM]` and tells the person who to contact. AutoEd does not decide or respond on the merits. |
| Person asks about data **AutoEd holds as Fiduciary** (Client administrators, billing contacts, website visitors, AutoEd marketing org) | AutoEd | AutoEd privacy contact `[PRIVACY EMAIL]` |
| **Organisation (Client)** asks for export or deletion of everything | The Client's authorised administrator | AutoEd, per section 4 |
| **Child's** request | The parent/guardian exercises the right for a child | Same as above after verifying the guardian link |

## 2. The rights (summary) `[CONFIRM against the Act]`

| Right | What it means in AutoEd |
|---|---|
| **Access** | Summary of personal data processed, the processing activities, identities of other fiduciaries and processors it was shared with |
| **Correction, completion, updating** | Fix inaccurate or incomplete data |
| **Erasure** | Delete data that is no longer needed or where consent is withdrawn, unless law requires keeping it |
| **Export** (portability-style copy) | A readable copy (CSV/Excel/PDF). The DPDP Act has no GDPR-style portability right `[CONFIRM]`, but export is needed for access and for contract exit |
| **Grievance redressal** | Complain to the Fiduciary first; then to the Data Protection Board |
| **Nomination** | Name a person to exercise rights on death or incapacity |
| **Withdraw consent** | As easy as giving it; stops further processing based on consent |

## 3. Procedure for a request about one person

1. **Receive.** Through the school's request channel or the in-app form. Record in the request register: ID, date received, requester, subject person, right invoked, channel.
2. **Verify identity.** Confirm that the requester is the data principal, or the parent/guardian linked in `core` (guardian-to-student link, decision #30). Use a one-time code to the registered phone/email, or the school's records. For a former student, the school decides on evidence. Do not disclose data until verified. For parents in portal-using schools, the guardian link already exists.
3. **Classify.** Is it access, correction, erasure, export, withdrawal, grievance? Any legal hold, retention duty or dispute?
4. **Find the data.** Run the per-person search across schemas for that `org_id`: `core` (people, students, guardians, staff), `crm` (leads/enquiries linked by phone/email/ID), `os`, `erp`, `billing` (only the Client's own users), files, messages, `audit` references and AI logs. Match across products because a person may appear in several.
5. **Decide** (Client). Grant, partly grant, or refuse with reasons (for example financial records that must be kept, or a legal hold). `[CONFIRM permitted refusal grounds.]`
6. **Act.**
   * *Access / export:* generate the per-person export (section 5.1) and deliver by a secure link to the verified requester.
   * *Correction:* the Client corrects in the product; the audit log records old and new value. Propagate to linked records.
   * *Erasure:* run the per-person erase (section 5.2): delete, or anonymise where records must stay (e.g., a receipt line item keeps amount but not name `[CONFIRM]`). Remove files, message content, and derived data (embeddings). Backups age out. Record what was kept and why.
   * *Withdraw consent:* update the consent record; stop the relevant processing (for example mark WhatsApp opt-out, `messaging-consent.md`).
7. **Respond** within `[CONFIRM period; use 30 days as a working default]`. Record the date and outcome.
8. **Close and log.** Store the request record `[retention: 3 years - CONFIRM]` without keeping the exported data.

**Timing:** the Rules prescribe periods for grievance response `[CONFIRM, commonly understood as a maximum of 90 days]`; our working target is shorter.

## 4. Procedure for an organisation (Client)

### 4.1 Full export (any time, and mandatory on exit)

1. The Client's administrator requests it in the Setup area or in writing to `[SUPPORT EMAIL]`. Authority check: signatory or registered administrator `[ASSUMPTION; two-person verification for deletion]`.
2. AutoEd runs the **org export** (section 5.3): all tables for that `org_id` by product, as CSV/Excel plus an index of attached files, delivered through a time-limited link.
3. Export is audited (who, when, which products).

### 4.2 Deletion of a product (non-payment) or of the whole org (leaving)

1. Trigger: day 30 of read-only for a product, or 30 days after the leaving date (`refund-and-cancellation-policy.md`).
2. Confirm the export has been delivered and acknowledged, or that notice was given `[7 days - CONFIRM]` before deletion.
3. Check legal hold.
4. Run the **org deletion** (section 5.4), product by product. Shared `core` data is deleted only if no active product still needs it.
5. Issue a written deletion certificate on request listing classes deleted, date, and the legal records kept.
6. Backups age out `[CONFIRM max period]`.

### 4.3 Requests by a Client for its people in bulk
For example "delete all leads older than 24 months": use the retention tools (`data-retention-schedule.md`), not ad hoc SQL.

## 5. How the product tools will support this (to build in Phase 6)

All tools are server-side, run as the signed-in admin, respect RLS, and write to `audit.log`.

### 5.1 Per-person export
* Input: org, person (student / guardian / staff / lead), identity found by ID or phone/email.
* Output: ZIP with CSV/Excel per table, a human-readable PDF summary, and a file index. Excludes other people's data (for example siblings' records or other staff's notes about the subject must be redacted `[ASSUMPTION; counsel to advise]`).
* Shows which products hold the person's data.

### 5.2 Per-person erase (and anonymise)
* Dry-run first: list of tables and row counts that will be deleted or anonymised, and rows retained with the reason.
* Cascades through product schemas, storage files, messages, AI-derived data; leaves a tombstone record (request ID, class, date) with no personal data.
* Two-step confirmation by an authorised administrator.
* For leads that never became students, delete the lead; for admitted students, the student profile in `core` is deleted only if retention rules allow.

### 5.3 Per-organisation export
* Per product and for the whole org; CSV/Excel plus file archive; checksum and row-count manifest so the Client can verify completeness.

### 5.4 Per-organisation deletion
* Product-level and org-level; requires the owner/platform admin plus Client authorisation; legal-hold check; dry-run; writes a deletion certificate record.

### 5.5 Supporting records
* **Request register** (who, what, when, outcome).
* **Consent records** (parental consent status, WhatsApp opt-in/out) searchable per person.
* **Access log** for support "view as" sessions visible to the Client.
* **Data map:** a maintained list of every table holding personal data, by product, with its retention class, so search, export and erase stay complete when new tables are added `[ASSUMPTION: a CI test fails if a new table with person data is not registered in the data map]`.

## 6. Special cases

* **Child data subject:** verify the parent/guardian relationship; the child may not be able to exercise rights alone `[CONFIRM]`. Do not delete data a school must keep by law.
* **Shared phone numbers:** one phone can be a parent of several children within a Client; a request by phone number must be verified and scoped to the right person.
* **Parent in two Clients:** not possible under decision #37 (one person, one Client); two separate requests to two Clients are handled by each.
* **Data in AI providers:** none by design (no personal data sent), so nothing to delete there.
* **Data in backups:** cannot be selectively deleted; ages out. Disclose this to requesters.
* **Legal hold or open dispute:** pause erasure; tell the requester the reason where lawful.
* **Vexatious or manifestly unfounded requests:** `[CONFIRM whether refusal is allowed]`.

## 7. Request register fields

ID, received date, channel, requester, relationship, subject, org, right, identity-verified (date, by whom), systems searched, decision (grant/partial/refuse) and reason, actions taken, response date, closed date, link to audit entries.

## Open points for counsel (this document)

1. The exact rights list, response deadlines and refusal grounds in the current Act and Rules.
2. Whether AutoEd, as Processor, may refuse to act without the Client's instruction in all cases, and how to handle a data principal who writes to AutoEd directly.
3. Identity-verification standard, especially for parents and former students.
4. Erasure versus legal retention duties (for example school records, financial records) and acceptable anonymisation.
5. Redaction of third-party data in access exports.
