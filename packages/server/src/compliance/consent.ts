/**
 * Consent records and the send gate (messaging-consent.md 2.2 and 2.3). The ledger is core.consents (append-only).
 * These helpers run as the caller's own product role (crm_server, os_server or erp_server) with the signed-in
 * user's claims: they only ever touch the caller's own org (the functions check it).
 */
import { guarded, type ComplianceDb, type ComplianceRole } from './db';
import { ComplianceError, CONSENT_CHANNELS, PERSON_TYPES, type ConsentChannel, type ConsentPurpose, type ConsentStatus, type PersonType } from './types';

export type ConsentRole = Extract<ComplianceRole, 'crm_server' | 'os_server' | 'erp_server' | 'platform_admin_server'>;

export interface RecordConsentInput {
  orgId: string;
  channel: ConsentChannel;
  /** Phone number or email as typed; it is normalised (E.164 for phones, lower case for email). */
  contact: string;
  purpose: ConsentPurpose | 'both';
  status: ConsentStatus;
  /** form id, qr, missed_call, in_person, inbound_message, import ... */
  source: string;
  personType?: PersonType;
  personId?: string;
  /** Consent text version, URL, form snapshot id, ip, user agent. */
  proof?: Record<string, unknown>;
  /** For a child: the guardian who consented. */
  guardianId?: string;
  guardianRelation?: string;
}

function check(i: { channel: string; personType?: string }) {
  if (!CONSENT_CHANNELS.includes(i.channel as ConsentChannel)) throw new ComplianceError('invalid', `unknown channel ${i.channel}`);
  if (i.personType && !PERSON_TYPES.includes(i.personType as PersonType)) throw new ComplianceError('invalid', `unknown person type ${i.personType}`);
}

export async function recordConsent(db: ComplianceDb, role: ConsentRole, actorUserId: string, i: RecordConsentInput): Promise<{ ids: string[]; contact: string }> {
  check(i);
  return guarded(() =>
    db.run(role, { actorUserId }, async (q) => {
      const r = await q.query<{ r: { ids: string[]; contact: string } }>(`select app.compliance_record_consent($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11) as r`, [
        i.orgId, i.channel, i.contact, i.purpose, i.status, i.source, i.personType ?? null, i.personId ?? null, JSON.stringify(i.proof ?? {}), i.guardianId ?? null, i.guardianRelation ?? null,
      ]);
      return r.rows[0]!.r;
    }),
  );
}

/** Opt a contact out of everything on a channel (a STOP). */
export function recordOptOut(db: ComplianceDb, role: ConsentRole, actorUserId: string, i: Omit<RecordConsentInput, 'purpose' | 'status'>) {
  return recordConsent(db, role, actorUserId, { ...i, purpose: 'both', status: 'opted_out' });
}

export async function consentStatus(db: ComplianceDb, role: ConsentRole, actorUserId: string, i: { orgId: string; channel: ConsentChannel; contact: string; purpose: ConsentPurpose }): Promise<ConsentStatus> {
  check(i);
  return guarded(() =>
    db.run(role, { actorUserId }, async (q) => (await q.query<{ s: ConsentStatus }>(`select app.compliance_consent_status($1,$2,$3,$4) as s`, [i.orgId, i.channel, i.contact, i.purpose])).rows[0]!.s),
  );
}

/** The gate the send functions must call: false means do not send. */
export async function maySend(db: ComplianceDb, role: ConsentRole, actorUserId: string, i: { orgId: string; channel: ConsentChannel; contact: string; purpose: ConsentPurpose }): Promise<boolean> {
  check(i);
  return guarded(() =>
    db.run(role, { actorUserId }, async (q) => (await q.query<{ ok: boolean }>(`select app.compliance_may_send($1,$2,$3,$4) as ok`, [i.orgId, i.channel, i.contact, i.purpose])).rows[0]!.ok),
  );
}

/** Full history for one contact (newest first), read under RLS as the caller. */
export async function consentHistory(db: ComplianceDb, role: ConsentRole, actorUserId: string, i: { orgId: string; channel: ConsentChannel; contact: string }) {
  check(i);
  return db.run(role, { actorUserId }, async (q) =>
    (await q.query(
      `select id, person_type, person_id, channel, contact, purpose, status, source, proof, recorded_by, recorded_at
         from core.consents where org_id = $1 and channel = $2 and contact = app.compliance_normalise_contact($2, $3)
        order by recorded_at desc, id desc`,
      [i.orgId, i.channel, i.contact],
    )).rows,
  );
}
