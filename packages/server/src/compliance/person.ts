/**
 * Per-person tools (data-subject-rights-procedure.md 5.1 and 5.2): export everything held about one staff member,
 * student, guardian or lead, and erase or anonymise it. Driven by core.pii_registry, so a registered table is
 * covered automatically. Runs as platform_admin_server with the signed-in admin's claims; the SQL functions
 * authorise the actor (platform admin, or an org member with compliance.export / compliance.erase).
 */
import { guarded, type ComplianceDb } from './db';
import { createZip, sha256, toCsv } from './files';
import { ComplianceError, PERSON_TYPES, type Blocker, type ErasurePlan, type PersonType } from './types';

export interface PersonRef {
  orgId: string;
  personType: PersonType;
  personId: string;
  /** Phone numbers and emails the person is known by, so rows keyed by contact (leads, consents) are found. */
  identifiers?: string[];
}

export interface PersonExportData {
  request_id: string;
  org_id: string;
  person_type: PersonType;
  person_id: string;
  generated_at: string;
  tables: { schema: string; table: string; key_column: string; person_type: PersonType; rows: Record<string, unknown>[] }[];
  skipped: { schema: string; table: string; reason: string }[];
}

export interface PersonExportFile {
  data: PersonExportData;
  zip: Buffer;
  filename: string;
  sha256: string;
}

function assertPerson(p: PersonRef) {
  if (!PERSON_TYPES.includes(p.personType)) throw new ComplianceError('invalid', `unknown person type ${String(p.personType)}`);
}

/** Lower-cased trimmed values plus the E.164 form of anything that looks like a phone number. */
export function expandIdentifiers(ids: string[] = []): string[] {
  const out = new Set<string>();
  for (const raw of ids) {
    const v = raw.trim();
    if (!v) continue;
    out.add(v.toLowerCase());
    if (!v.includes('@')) {
      const d = v.replace(/[^0-9+]/g, '');
      const digits = d.replace(/[^0-9]/g, '');
      if (digits.length === 10) out.add('+91' + digits);
      else if (digits.length === 12 && digits.startsWith('91')) out.add('+' + digits);
      else if (digits.length >= 8) out.add(d.startsWith('+') ? d : '+' + digits);
    }
  }
  return [...out];
}

const safeName = (s: string) => s.replace(/[^a-zA-Z0-9._-]/g, '_');

/** The export bundle: data.json, one CSV per table that holds rows, a summary and a manifest with sha256 of each file. */
export function buildPersonZip(data: PersonExportData, at = new Date()): Buffer {
  const files: { name: string; data: Buffer }[] = [];
  const json = Buffer.from(JSON.stringify(data, null, 2), 'utf8');
  files.push({ name: 'data.json', data: json });
  const summary: string[] = [
    `Personal data export: ${data.person_type} ${data.person_id}`,
    `Organisation: ${data.org_id}`,
    `Generated: ${data.generated_at}`,
    '',
    'Tables holding data about this person:',
  ];
  for (const t of data.tables) {
    summary.push(`  ${t.schema}.${t.table}: ${t.rows.length} row(s)`);
    if (t.rows.length === 0) continue;
    const columns = [...new Set(t.rows.flatMap((r) => Object.keys(r)))];
    files.push({ name: `csv/${safeName(t.schema)}.${safeName(t.table)}.${safeName(t.key_column)}.csv`, data: toCsv(columns, t.rows) });
  }
  if (data.skipped.length) {
    summary.push('', 'Not searched:');
    for (const s of data.skipped) summary.push(`  ${s.schema}.${s.table}: ${s.reason}`);
  }
  files.push({ name: 'summary.txt', data: Buffer.from(summary.join('\n') + '\n', 'utf8') });
  const manifest = {
    request_id: data.request_id,
    generated_at: data.generated_at,
    files: files.map((f) => ({ path: f.name, bytes: f.data.length, sha256: sha256(f.data) })),
    tables: data.tables.map((t) => ({ schema: t.schema, table: t.table, rows: t.rows.length })),
  };
  files.push({ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') });
  return createZip(files, at);
}

export async function exportPerson(db: ComplianceDb, actorUserId: string, p: PersonRef): Promise<PersonExportFile> {
  assertPerson(p);
  const data = await guarded(() =>
    db.run('platform_admin_server', { actorUserId, statementTimeoutMs: 120_000 }, async (q) => {
      const r = await q.query<{ r: PersonExportData }>(`select app.compliance_person_export($1, $2, $3, $4) as r`, [p.orgId, p.personType, p.personId, expandIdentifiers(p.identifiers)]);
      return r.rows[0]!.r;
    }),
  );
  const zip = buildPersonZip(data);
  return { data, zip, filename: `person-export-${safeName(p.personType)}-${safeName(p.personId)}.zip`, sha256: sha256(zip) };
}

export interface ErasurePlanResult {
  requestId: string;
  eligible: boolean;
  status: string;
  /** Present only when eligible; shown once, never stored in clear. */
  confirmationToken?: string;
  tokenExpiresAt?: string;
  identityVerified: boolean;
  plan?: ErasurePlan;
  blockers: Blocker[];
}

/** Step 1: a dry run. Lists what would be deleted, anonymised or retained (and why). Nothing changes. */
export async function planPersonErasure(db: ComplianceDb, actorUserId: string, p: PersonRef, input: { reason: string; identityVerified?: boolean }): Promise<ErasurePlanResult> {
  assertPerson(p);
  const r = await guarded(() =>
    db.run('platform_admin_server', { actorUserId }, async (q) => {
      const res = await q.query<{ r: Record<string, unknown> }>(`select app.compliance_person_erasure_plan($1, $2, $3, $4, $5, $6) as r`, [
        p.orgId,
        p.personType,
        p.personId,
        expandIdentifiers(p.identifiers),
        input.reason,
        input.identityVerified ?? false,
      ]);
      return res.rows[0]!.r;
    }),
  );
  return {
    requestId: r.request_id as string,
    eligible: Boolean(r.eligible),
    status: r.status as string,
    confirmationToken: r.confirmation_token as string | undefined,
    tokenExpiresAt: r.token_expires_at as string | undefined,
    identityVerified: Boolean(r.identity_verified),
    plan: r.plan as ErasurePlan | undefined,
    blockers: (r.blockers as Blocker[] | undefined) ?? [],
  };
}

export interface ErasureResult {
  requestId: string;
  result: ErasurePlan;
  /** Work the database cannot do: deleting the Supabase Auth user. The server must perform and record it. */
  externalActions: ErasurePlan['external_actions'];
}

/** Step 2: needs the request id and the token returned by step 1. Refusals (identity, legal hold) throw ComplianceError('refused'). */
export async function executePersonErasure(db: ComplianceDb, actorUserId: string, requestId: string, token: string): Promise<ErasureResult> {
  const r = await guarded(() =>
    db.run('platform_admin_server', { actorUserId, statementTimeoutMs: 120_000 }, async (q) => {
      const res = await q.query<{ r: Record<string, unknown> }>(`select app.compliance_person_erasure_execute($1, $2) as r`, [requestId, token]);
      return res.rows[0]!.r;
    }),
  );
  if (!r.ok) throw new ComplianceError('refused', 'erasure refused', (r.blockers as Blocker[]) ?? []);
  const result = r.result as ErasurePlan;
  return { requestId: r.request_id as string, result, externalActions: result.external_actions };
}
