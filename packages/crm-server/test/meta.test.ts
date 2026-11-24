// Meta integration tests (autoedcrm tests/meta.test.ts), ported. Meta's Graph API is replaced by a fake fetch, so these
// run offline; the database is real. The webhook goes through the framework-free API handler, as the host would call it.
import crypto from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { asSystem, type Db } from '../src/db';
import { captureEnquiry, sendMessage } from '../src/core';
import { mapLeadFields, toMetaBody, verifySignature, waErrorText } from '../src/meta';
import { setSecret } from '../src/secrets';
import { handle } from '../src/api';
import { createOrg, ownerQ, shutdown, type TestOrg } from './helpers';

let org: TestOrg, branchId: string, webhookKey: string;
let n = 0;
const sys = <T>(fn: (db: Db) => Promise<T>) => asSystem(org.orgId, fn);
const mobile = () => '97' + String(20000000 + ++n).padStart(8, '0');
const calls: { url: string; body: any }[] = [];

function fakeMeta(handler: (url: string, body: any) => { status?: number; json: any }) {
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, body });
    const r = handler(url, body);
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  });
}
const capture = async (over: Partial<Parameters<typeof captureEnquiry>[1]> = {}) => {
  const r = await sys((db) => captureEnquiry(db, { studentName: 'A', guardianName: 'P', mobile: mobile(), branchId, ...over }));
  if (!r.ok) throw new Error(r.error);
  return r;
};

beforeAll(async () => {
  org = await createOrg('Meta School');
  branchId = org.branchId;
  const { addStaff } = await import('./helpers');
  await addStaff(org, 'Meta Counsellor', 'Counsellor', { branchIds: [branchId] });
  webhookKey = (await ownerQ('select webhook_key from crm.settings where org_id = $1', [org.orgId]))[0].webhook_key;
  await sys(async (db) => {
    await db.q("update crm.settings set settings = settings || $2::jsonb where org_id = $1", [org.orgId, { integrations: { whatsapp: { enabled: true, phone_number_id: 'PNID', waba_id: 'WABA' } } }]);
    await setSecret(db, 'wa_token', 'token-123');
    await setSecret(db, 'meta_app_secret', 'app-secret');
    await setSecret(db, 'meta_verify_token', 'verify-abc');
    await setSecret(db, 'meta_page_token', 'page-token');
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  calls.length = 0;
});
afterAll(shutdown);

describe('helpers', () => {
  it("turns named variables into Meta's positional ones, reusing repeats", () => {
    expect(toMetaBody('Hi {{guardian_name}}, {{student_name}} ({{guardian_name}})')).toEqual({ text: 'Hi {{1}}, {{2}} ({{1}})', vars: ['guardian_name', 'student_name'] });
  });
  it("checks Meta's webhook signature", () => {
    const raw = '{"a":1}';
    const sig = 'sha256=' + crypto.createHmac('sha256', 's3cret').update(raw).digest('hex');
    expect(verifySignature(raw, sig, 's3cret')).toBe(true);
    expect(verifySignature(raw, sig, 'other')).toBe(false);
    expect(verifySignature(raw, null, 's3cret')).toBe(false);
  });
  it('explains error codes in plain words', () => {
    expect(waErrorText(131026)).toBe('This number cannot receive WhatsApp messages. Try SMS or call.');
    expect(waErrorText(999999, 'Weird')).toMatch(/could not deliver this message \(Weird\)/);
  });
  it('maps common lead form questions', () => {
    const m = mapLeadFields(
      [{ name: 'full_name', values: ['Ritu Verma'] }, { name: 'phone_number', values: ['+919812300001'] }, { name: "child's_name", values: ['Asha'] }, { name: 'which_class?', values: ['Grade 2'] }, { name: 'preferred_campus', values: ['Whitefield'] }, { name: 'budget', values: ['2-3L'] }],
      ['Grade 1', 'Grade 2'], [{ id: 'b1', name: 'Kondapur campus' }, { id: 'b2', name: 'Whitefield campus' }],
    );
    expect(m).toMatchObject({ guardianName: 'Ritu Verma', mobile: '+919812300001', studentName: 'Asha', grade: 'Grade 2', branchId: 'b2' });
    expect(m.extra).toEqual(['budget: 2-3L']);
  });
});

describe('sending', () => {
  it('refuses free text outside the 24-hour window and says why', async () => {
    const r = await capture();
    fakeMeta(() => ({ json: {} }));
    const res = await sys((db) => sendMessage(db, { householdId: r.householdId, enquiryId: r.enquiryId, channel: 'whatsapp', body: 'Hello' }));
    expect(res.status).toBe('failed');
    expect(res.reason).toMatch(/24 hours/);
    expect(calls.filter((c) => c.url.includes('/messages')).length).toBe(0);
  });

  it("sends an approved template with parameters in Meta's order, and does not charge the wallet", async () => {
    const m = mobile();
    const r = await capture({ studentName: 'Kabir', guardianName: 'Neha', mobile: m });
    const tpl = await sys((db) =>
      db.insert('core.message_templates', { product_key: 'crm', channel: 'whatsapp', name: 'Hello test', body: 'Hi {{guardian_name}}, about {{student_name}}', provider_template_name: 'hello_test', provider_status: 'APPROVED', provider_vars: ['guardian_name', 'student_name'], status: 'approved' }),
    );
    const wallet = Number((await ownerQ('select wallet_balance from crm.settings where org_id = $1', [org.orgId]))[0].wallet_balance);
    fakeMeta(() => ({ json: { messages: [{ id: 'wamid.TEST1' }] } }));
    const res = await sys((db) => sendMessage(db, { householdId: r.householdId, enquiryId: r.enquiryId, channel: 'whatsapp', body: 'Hi Neha, about Kabir', template: tpl, vars: { guardian_name: 'Neha', student_name: 'Kabir' } }));
    expect(res.status).toBe('sent');
    const sent = calls.find((c) => c.url.endsWith('/PNID/messages'))!;
    expect(sent.body).toMatchObject({ to: '91' + m, type: 'template', template: { name: 'hello_test', language: { code: 'en' }, components: [{ type: 'body', parameters: [{ type: 'text', text: 'Neha' }, { type: 'text', text: 'Kabir' }] }] } });
    expect((await ownerQ("select status, provider_id from crm.messages where provider_id = 'wamid.TEST1'"))[0]).toMatchObject({ status: 'sent' });
    expect(Number((await ownerQ('select wallet_balance from crm.settings where org_id = $1', [org.orgId]))[0].wallet_balance)).toBe(wallet);
  });
});

describe('webhook', () => {
  const sign = (raw: string) => 'sha256=' + crypto.createHmac('sha256', 'app-secret').update(raw).digest('hex');
  const post = (payload: unknown, sig?: string) => {
    const raw = JSON.stringify(payload);
    return handle({ method: 'POST', path: `/webhooks/meta/${webhookKey}`, query: {}, headers: { 'x-hub-signature-256': sig ?? sign(raw) }, body: payload, rawBody: raw });
  };
  const wa = (value: unknown) => ({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value }] }] });

  it("answers Meta's verification only with the right token", async () => {
    const ok = await handle({ method: 'GET', path: `/webhooks/meta/${webhookKey}`, query: { 'hub.mode': 'subscribe', 'hub.verify_token': 'verify-abc', 'hub.challenge': '42' }, headers: {}, body: null });
    expect(ok.status).toBe(200);
    expect(ok.text?.body).toBe('42');
    const bad = await handle({ method: 'GET', path: `/webhooks/meta/${webhookKey}`, query: { 'hub.mode': 'subscribe', 'hub.verify_token': 'nope', 'hub.challenge': '42' }, headers: {}, body: null });
    expect(bad.status).toBe(403);
  });

  it('rejects calls without a valid signature', async () => {
    expect((await post(wa({}), 'sha256=deadbeef')).status).toBe(401);
  });

  it('an unknown number messaging the school becomes a new enquiry; a retried delivery is ignored', async () => {
    const from = '91' + mobile();
    const payload = wa({ contacts: [{ wa_id: from, profile: { name: 'Farah K' } }], messages: [{ id: 'wamid.IN1', from, type: 'text', text: { body: 'Is Grade 3 open?' } }] });
    expect((await post(payload)).status).toBe(200);
    expect((await post(payload)).status).toBe(200);
    const g = (await ownerQ('select household_id, name from crm.guardians where org_id = $1 and phone = $2', [org.orgId, from.slice(2)]))[0];
    expect(g.name).toBe('Farah K');
    expect((await ownerQ("select count(*)::int n from crm.messages where org_id = $1 and household_id = $2 and direction = 'in'", [org.orgId, g.household_id]))[0].n).toBe(1);
  });

  it('delivery, read and failure statuses update the message; failures read in plain words on the timeline', async () => {
    const r = await capture({ studentName: 'S', guardianName: 'G' });
    const msg = (id: string, body: string) => ownerQ("insert into crm.messages (org_id, household_id, enquiry_id, channel, direction, body, status, provider_id) values ($1, $2, $3, 'whatsapp', 'out', $4, 'sent', $5)", [org.orgId, r.householdId, r.enquiryId, body, id]);
    await msg('wamid.OUT1', 'x');
    await msg('wamid.OUT2', 'y');
    await post(wa({ statuses: [{ id: 'wamid.OUT1', status: 'delivered' }, { id: 'wamid.OUT1', status: 'read' }, { id: 'wamid.OUT2', status: 'failed', errors: [{ code: 131026, title: 'Message undeliverable' }] }] }));
    expect((await ownerQ("select status, read_at is not null as r from crm.messages where provider_id = 'wamid.OUT1'"))[0]).toMatchObject({ status: 'read', r: true });
    expect((await ownerQ("select status, fail_reason from crm.messages where provider_id = 'wamid.OUT2'"))[0]).toMatchObject({ status: 'failed', fail_reason: 'This number cannot receive WhatsApp messages. Try SMS or call.' });
    expect((await ownerQ("select content from crm.activities where enquiry_id = $1 and content like 'Not delivered: This number%'", [r.enquiryId]))[0].content).toMatch(/cannot receive WhatsApp/);
  });

  it('template review results update the template', async () => {
    await sys((db) => db.insert('core.message_templates', { product_key: 'crm', channel: 'whatsapp', name: 'Review me', body: 'Hi', provider_template_name: 'review_me', provider_status: 'PENDING', status: 'submitted' }));
    await post({ entry: [{ changes: [{ field: 'message_template_status_update', value: { event: 'APPROVED', message_template_name: 'review_me' } }] }] });
    expect((await ownerQ("select status, provider_status from core.message_templates where org_id = $1 and provider_template_name = 'review_me'", [org.orgId]))[0]).toMatchObject({ status: 'approved', provider_status: 'APPROVED' });
  });

  it('a lead ad becomes an enquiry with source and campaign; the same lead twice is imported once', async () => {
    const m = mobile();
    fakeMeta((url) =>
      url.includes('LEAD77')
        ? { json: { platform: 'ig', campaign_name: 'Admissions Open', form_id: 'F1', field_data: [{ name: 'full_name', values: ['Arun Rao'] }, { name: 'phone_number', values: ['+91' + m] }, { name: 'student_name', values: ['Diya'] }, { name: 'grade', values: ['Grade 1'] }] } }
        : { status: 404, json: { error: { message: 'unknown' } } },
    );
    const payload = { object: 'page', entry: [{ changes: [{ field: 'leadgen', value: { leadgen_id: 'LEAD77', form_id: 'F1', page_id: 'P1' } }] }] };
    await post(payload);
    await post(payload);
    const e = (await ownerQ('select e.id, e.grade, st.first_name as student from crm.enquiries e join crm.prospects st on st.id = e.prospect_id join crm.guardians g on g.household_id = e.household_id where e.org_id = $1 and g.phone = $2', [org.orgId, m]))[0];
    expect(e).toMatchObject({ grade: 'Grade 1', student: 'Diya' });
    const touch = (await ownerQ('select channel, source, campaign from crm.source_touches where enquiry_id = $1', [e.id]))[0];
    expect(touch).toMatchObject({ channel: 'Meta ads', source: 'Instagram lead form', campaign: 'Admissions Open' });
    expect((await ownerQ("select count(*)::int n from crm.meta_leads where leadgen_id = 'LEAD77'"))[0].n).toBe(1);
    expect(calls.filter((c) => c.url.includes('LEAD77')).length).toBe(1);
  });
});
