# Messaging Consent: WhatsApp and SMS

> **DRAFT - needs legal review - not legal advice**
> This is a working draft written by the product team, not by a lawyer. Do not rely on it until counsel has reviewed it. `[ASSUMPTION]` marks something we assumed; `[CONFIRM]` marks a figure, period or legal point we are unsure of.

| | |
|---|---|
| Version | 0.1 (draft) |
| Date | 2026-11-24 |
| Scope | WhatsApp messages (the Client's own provider, or a provider run by AutoEd; decision #41), SMS if later enabled, push and email where relevant |
| Roles | The **Client** decides whom to message and is responsible for having consent (Data Fiduciary). AutoEd provides the sending tool and consent records as Data Processor. If `provider_owner = autoed`, AutoEd also runs the sending account and must meet the provider's policies for it `[CONFIRM contractual allocation]`. |

## 1. Principles

1. **No marketing or promotional message without opt-in.** This applies to CRM follow-ups, admission campaigns and fee/event promotions.
2. **Service messages** (attendance alert, fee due notice, exam result, circular) need a lawful basis and a clear relationship, but the school should still capture opt-in at admission and honour opt-out `[CONFIRM whether DPDP consent or "legitimate use" is the right basis for school service messages]`.
3. **Easy opt-out.** Every promotional message offers a way to stop (reply STOP, or button), and the stop is honoured immediately and recorded.
4. **Children:** messages about a child go to the parent/guardian, never to the child's own number unless the school decides and the guardian consents `[CONFIRM]`. No targeted advertising or profiling of children.
5. **Record everything:** consent, its source and text, withdrawal, and message templates used.

## 2. WhatsApp

### 2.1 Opt-in
* WhatsApp Business Platform policy requires that a business obtains opt-in from a person before messaging them, and that the person knows they will receive messages from that business on WhatsApp `[CONFIRM current Meta Business Messaging and WhatsApp Business policies]`.
* Acceptable opt-in capture examples `[ASSUMPTION]`: ticked checkbox on the admission/enquiry form with clear wording ("I agree to receive updates about admission and my child's school on WhatsApp"), a missed-call or click-to-WhatsApp flow, an in-person form signed by the parent, the parent's first message to the school (which also opens a 24-hour service window).
* **Not acceptable:** buying or scraping lists; assuming consent because a number was in a phone book; pre-ticked boxes; using a lead's number for something other than what they were told.

### 2.2 Opt-in record (what the product stores per contact and channel)
| Field | Notes |
|---|---|
| Person / lead ID and org | The Client's record |
| Phone number (normalised) | |
| Channel | `whatsapp` / `sms` / `push` / `email` |
| Purpose class | `service` / `promotional` / `both` |
| Status | `opted_in` / `opted_out` / `unknown` |
| Timestamp (UTC) and time zone shown | |
| Source | form id, QR, missed call, in person, inbound message, import |
| Proof | consent text version and URL; form snapshot; who recorded it (user ID); IP/user-agent for web forms `[ASSUMPTION]` |
| For children: guardian ID and relationship | Link to the guardian who consented |
| Withdrawal | timestamp, source (reply STOP, school staff, request), and who recorded it |
| History | Append-only; never overwritten |

### 2.3 Sending rules (to enforce in the product)
* The send function **blocks** promotional sends to anyone not `opted_in` for `promotional` or `both`, and any send to `opted_out`.
* Outside the 24-hour customer-service window, only **pre-approved templates** may be sent; each template has a category (utility, marketing, authentication) and is registered with the provider `[CONFIRM]`.
* Bulk imports of contacts require the importer to confirm they hold consent, and import consent status as `unknown` (not opted in) unless a proof column is provided.
* Inbound **STOP / unsubscribe / "no"** keywords (English, Hindi and other supported languages) set `opted_out` automatically and send one confirmation `[ASSUMPTION]`.
* Rate limits and quality: protect the sending number's quality rating; stop broadcasts if block/report rates rise `[CONFIRM provider thresholds]`.
* Message content is not sent to AI providers.

### 2.4 Provider ownership
* **`provider_owner = client`:** the Client holds the WhatsApp Business account and is bound by Meta's terms; AutoEd only calls the API with the Client's credentials (stored as secrets).
* **`provider_owner = autoed`:** AutoEd (or its chosen provider) runs a shared or per-Client sender. Each Client's sender name, templates and opt-in lists must stay separate so one Client's complaints cannot damage another's number `[ASSUMPTION; confirm provider capability]`.

## 3. SMS (only if SMS is enabled; not in scope today `[ASSUMPTION]`)

Indian telecom rules (TRAI's Telecom Commercial Communications Customer Preference Regulations, 2018, and DLT platform requirements) apply `[CONFIRM current regulations and any 2024-25 amendments]`:

* **DLT registration:** the sender (the school, as "principal entity", or AutoEd on its behalf) registers on a telecom operator's DLT portal, with a business entity, PAN/GST and authorisation `[CONFIRM requirements]`.
* **Headers (sender IDs):** register a 6-character header per purpose, one per Client; do not share a header across Clients.
* **Templates:** every SMS body must match a registered template with variables; unregistered content is blocked by operators.
* **Consent:** record consent and register it on the DLT consent system where required `[CONFIRM current consent-management rules]`.
* **Categories:** transactional, service (implicit/explicit), promotional; promotional SMS may be sent only to numbers not on the DND register or with explicit consent, and only in permitted time windows (traditionally 9 am to 9 pm) `[CONFIRM]`.
* **Chosen SMS gateway** must be a registered telemarketer/aggregator `[CONFIRM provider]`.
* Add the SMS provider to the sub-processor table in `data-processing-agreement.md` before launch.

## 4. Push notifications and email
* Push (Expo/Firebase): permission is requested by the device OS; in-app switches let the user turn categories off; notification text avoids sensitive details `[ASSUMPTION]`.
* Email: transactional emails need no opt-in; promotional emails need consent and an unsubscribe link `[CONFIRM IT Act/DPDP basis]`.

## 5. Who is responsible for what

| Task | Client | AutoEd |
|---|---|---|
| Obtain and word the consent, collect parental consent for children | Yes | Provides form templates and a consent-text library `[ASSUMPTION]` |
| Record consent and honour opt-out | Uses the tools and respects them | Provides the consent store and blocks disallowed sends |
| Template approval with the provider | Yes (own provider) | Helps; owns it if `provider_owner = autoed` |
| DLT registration (SMS) | Principal entity | Assists |
| Responding to complaints | Primary | Supports |
| Keeping proof | Primary | Stores it in the Client's org per the retention schedule |

## 6. Complaints and misuse
If a recipient complains, the Client suspends sending to that person at once. Repeated misuse by a Client can lead to suspension of messaging features under the Terms of Service.

## 7. Retention
Consent and opt-out records are kept for the relationship plus `[3 years - CONFIRM]` as proof (`data-retention-schedule.md`); message content for `[12 months - CONFIRM]`.

## Open points for counsel (this document)

1. The correct lawful basis (consent versus legitimate use) for school service messages to parents.
2. Allocation of responsibility if AutoEd runs the WhatsApp sender for a Client.
3. TRAI/DLT obligations if AutoEd ever sends SMS as an aggregator on behalf of schools.
4. Messaging minors directly, and use of children's numbers.
5. Current consent-management and DND time-window rules.
