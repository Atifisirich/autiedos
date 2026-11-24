/**
 * Consent records and the send gate (messaging-consent.md 2.2, 2.3): an append-only ledger per contact, channel
 * and purpose; promotional needs opt-in; opt-out blocks everything; one org never sees or changes another's.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { consentHistory, consentStatus, maySend, recordConsent, recordOptOut } from '../src/compliance/consent';
import { ComplianceError } from '../src/compliance/types';
import { createWorld, type World } from './compliance-support';

let w: World;
let nobody: string;
beforeAll(async () => {
  w = await createWorld();
  nobody = randomUUID();
  await w.q(`insert into auth.users (id, email) values ($1, 'nobody@x.test')`, [nobody]);
}, 300000);
afterAll(async () => {
  await w?.close();
});

const rejects = async (p: Promise<unknown>, code: string) => {
  const e = await p.then(() => null, (x: unknown) => x);
  expect(e, `expected ${code}`).toBeInstanceOf(ComplianceError);
  expect((e as ComplianceError).code).toBe(code);
};

describe('consent ledger', () => {
  it('normalises the contact and expands "both" into a service and a promotional row', async () => {
    const r = await recordConsent(w.db, 'crm_server', w.u.aAdmin!, {
      orgId: w.A.id, channel: 'whatsapp', contact: ' 98765 43210 ', purpose: 'both', status: 'opted_in', source: 'admission_form_v3',
      personType: 'guardian', personId: w.p.guardian, proof: { text_version: 'v3', ip: '203.0.113.5' }, guardianId: w.p.guardian, guardianRelation: 'mother',
    });
    expect(r.contact).toBe('+919876543210');
    expect(r.ids).toHaveLength(2);
    const rows = await w.q(`select purpose, status, contact, recorded_by, proof from core.consent_events where org_id = $1 and contact = '+919876543210' order by purpose`, [w.A.id]);
    expect(rows.map((x) => x.purpose)).toEqual(['promotional', 'service']);
    expect(rows.every((x) => x.status === 'opted_in' && x.recorded_by === w.u.aAdmin)).toBe(true);
    expect((rows[0]!.proof as { text_version: string }).text_version).toBe('v3');
  });

  it('lower-cases email and keeps one ledger across spellings of a phone number', async () => {
    const r = await recordConsent(w.db, 'os_server', w.u.aAdmin!, { orgId: w.A.id, channel: 'email', contact: '  Parent@Example.TEST ', purpose: 'promotional', status: 'opted_in', source: 'web_form' });
    expect(r.contact).toBe('parent@example.test');
    for (const spelling of ['+91 98765-43210', '09876543210', '919876543210', '9876543210']) {
      expect(await consentStatus(w.db, 'crm_server', w.u.aAdmin!, { orgId: w.A.id, channel: 'whatsapp', contact: spelling, purpose: 'promotional' }), spelling).toBe('opted_in');
    }
  });

  it('the send gate: promotional needs opt-in, service is allowed unless opted out, opt-out blocks both, latest row wins', async () => {
    const i = { orgId: w.A.id, channel: 'whatsapp' as const, contact: '+919811100001' };
    const may = (purpose: 'service' | 'promotional') => maySend(w.db, 'crm_server', w.u.aAdmin!, { ...i, purpose });
    expect(await may('promotional')).toBe(false); // unknown: not opted in
    expect(await may('service')).toBe(true); // unknown: service allowed
    await recordConsent(w.db, 'crm_server', w.u.aAdmin!, { ...i, purpose: 'service', status: 'opted_in', source: 'qr' });
    expect(await may('promotional')).toBe(false); // service opt-in is not promotional opt-in
    await recordConsent(w.db, 'crm_server', w.u.aAdmin!, { ...i, purpose: 'promotional', status: 'opted_in', source: 'form' });
    expect(await may('promotional')).toBe(true);
    await recordOptOut(w.db, 'crm_server', w.u.aAdmin!, { ...i, source: 'inbound_message' }); // a STOP
    expect(await may('promotional')).toBe(false);
    expect(await may('service')).toBe(false);
    await recordConsent(w.db, 'crm_server', w.u.aAdmin!, { ...i, purpose: 'both', status: 'opted_in', source: 'in_person' });
    expect(await may('promotional')).toBe(true);
    expect(await may('service')).toBe(true);
    const hist = await consentHistory(w.db, 'crm_server', w.u.aAdmin!, i);
    // newest first, per purpose: opt-in again, the STOP, the first opt-in
    for (const purpose of ['service', 'promotional']) {
      expect(hist.filter((h) => h.purpose === purpose).map((h) => h.status), purpose).toEqual(['opted_in', 'opted_out', 'opted_in']);
    }
    expect(hist).toHaveLength(6);
  });

  it('is append-only: nobody can update or delete a ledger row, whichever role they use', async () => {
    for (const role of ['crm_server', 'os_server', 'erp_server', 'platform_admin_server'] as const) {
      const upd = await w.db.run(role, { actorUserId: w.u.aAdmin! }, (q) => q.query(`update core.consent_events set status = 'opted_in'`)).then(() => '', (e: { code?: string }) => e.code);
      const del = await w.db.run(role, { actorUserId: w.u.aAdmin! }, (q) => q.query(`delete from core.consent_events`)).then(() => '', (e: { code?: string }) => e.code);
      expect(upd, role).toBe('42501');
      expect(del, role).toBe('42501');
      const ins = await w.db.run(role, { actorUserId: w.u.aAdmin! }, (q) => q.query(`insert into core.consent_events (org_id, channel, contact, purpose, status, source) values ($1, 'sms', '+911', 'service', 'opted_in', 'x')`, [w.A.id])).then(() => '', (e: { code?: string }) => e.code);
      expect(ins, role).toBe('42501'); // only the helper writes
    }
  });

  it('an org never sees or changes another org: reads, writes and the gate are scoped by the caller org', async () => {
    const mine = await w.db.run('crm_server', { actorUserId: w.u.aAdmin! }, async (q) => Number((await q.query(`select count(*) as n from core.consent_events`)).rows[0]!.n));
    const bs = await w.db.run('crm_server', { actorUserId: w.u.bAdmin! }, async (q) => (await q.query<{ org_id: string }>(`select distinct org_id from core.consent_events`)).rows);
    expect(mine).toBeGreaterThan(5);
    expect(bs.every((r) => r.org_id === w.B.id)).toBe(true);
    await rejects(recordConsent(w.db, 'crm_server', w.u.bAdmin!, { orgId: w.A.id, channel: 'whatsapp', contact: '+919811100001', purpose: 'both', status: 'opted_out', source: 'attack' }), 'forbidden');
    await rejects(maySend(w.db, 'crm_server', w.u.bAdmin!, { orgId: w.A.id, channel: 'whatsapp', contact: '+919811100001', purpose: 'service' }), 'forbidden');
    await rejects(consentStatus(w.db, 'crm_server', w.u.cAdmin!, { orgId: w.A.id, channel: 'whatsapp', contact: '+919811100001', purpose: 'service' }), 'forbidden');
    // the same number in org B has its own state (B recorded an opt-out of 9876500001 in the fixture)
    expect(await consentStatus(w.db, 'crm_server', w.u.bAdmin!, { orgId: w.B.id, channel: 'whatsapp', contact: '+919876500001', purpose: 'promotional' })).toBe('opted_out');
    expect(await consentStatus(w.db, 'crm_server', w.u.aAdmin!, { orgId: w.A.id, channel: 'whatsapp', contact: '+919876500001', purpose: 'promotional' })).toBe('opted_in');
  });

  it('needs a signed-in member with a product (or a platform admin); rejects bad input', async () => {
    await rejects(recordConsent(w.db, 'crm_server', nobody, { orgId: w.A.id, channel: 'whatsapp', contact: '+919811100002', purpose: 'both', status: 'opted_in', source: 'x1' }), 'forbidden');
    await rejects(maySend(w.db, 'crm_server', nobody, { orgId: w.A.id, channel: 'whatsapp', contact: '+919811100002', purpose: 'service' }), 'forbidden');
    await recordConsent(w.db, 'platform_admin_server', w.u.platform!, { orgId: w.A.id, channel: 'sms', contact: '+919811100003', purpose: 'service', status: 'unknown', source: 'import' });
    await rejects(recordConsent(w.db, 'crm_server', w.u.aAdmin!, { orgId: w.A.id, channel: 'telegram' as 'sms', contact: '+919811100002', purpose: 'both', status: 'opted_in', source: 'x1' }), 'invalid');
    await rejects(recordConsent(w.db, 'crm_server', w.u.aAdmin!, { orgId: w.A.id, channel: 'sms', contact: '   ', purpose: 'both', status: 'opted_in', source: 'x1' }), 'invalid');
    await rejects(recordConsent(w.db, 'crm_server', w.u.aAdmin!, { orgId: w.A.id, channel: 'sms', contact: '+919811100002', purpose: 'marketing' as 'both', status: 'opted_in', source: 'x1' }), 'invalid');
  });
});
