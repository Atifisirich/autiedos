/**
 * Custom records server (docs/custom-records.md) on the seeded demo school (OS only): the route table as the chairman
 * (management) and a class teacher, list filters / sort / search / paging, CSV export (audited), workflow with approval,
 * reminders on private.jobs, and the designer adapter (validate / preview / apply / inverse). Every call runs as
 * os_server with the person's claims (createPoolRecordsDb), never the table owner.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dispatch } from '../src/api';
import { asOwner, closePool, one, q } from '../src/db';
import { closeRecordsDb, customObjectBlock, defaultRecordsDb, dispatchRecords, runRecordReminders, type CustomObjectBlockConfig } from '../src/custom-records';

const CHAIRMAN = 'chairman@demo.school';
const PRINCIPAL = 'principal@demo.school';
const TEACHER = 'deepa.teacher9@demo.school';
let n = 0;
const tokens: Record<string, string> = {};
const ids: Record<string, string> = {};
let students: string[] = [];

async function login(email: string) {
  const r = (await dispatch({ method: 'POST', path: '/auth/dev-login', query: {}, headers: { 'user-agent': 'vitest' }, body: { email }, ip: `10.8.0.${++n}` })) as { status: number; json: { token: string } };
  expect(r.status).toBe(200);
  tokens[email] = r.json.token;
  ids[email] = (await asOwner((c) => one<{ id: string }>(c, `select id from auth.users where email = $1`, [email]))).id;
}
async function call(who: string, method: string, path: string, body?: unknown, query: Record<string, string> = {}) {
  return (await dispatchRecords({ method, path, query, headers: { authorization: `Bearer ${tokens[who]}` }, body })) as { status: number; json: any; text?: { body: string; filename?: string } };
}

const VISITOR_LOG: CustomObjectBlockConfig = {
  key: 'hostel_visitors',
  product_key: 'core',
  label_singular: 'Hostel visitor',
  label_plural: 'Hostel visitor log',
  icon: 'door',
  fields: [
    { key: 'visitor_name', label: 'Visitor name', type: 'text', required: true },
    { key: 'student', label: 'Student', type: 'learner', required: true },
    { key: 'visit_date', label: 'Date', type: 'date', default: 'today' },
    { key: 'purpose', label: 'Purpose', type: 'choice', options: ['Parent visit', 'Delivery', 'Other'] },
    { key: 'items', label: 'Items brought', type: 'multi_choice', options: ['Food', 'Clothes', 'Books'] },
    { key: 'amount', label: 'Deposit', type: 'money', min: 0 },
  ],
  title_field: 'visitor_name',
  list_columns: ['visitor_name', 'student', 'visit_date', 'state'],
  permissions: [{ who: 'role', product: 'os', role: 'os_class_teacher', view: 'own', create: true, edit: 'own', delete: 'own' }],
  states: {
    list: [{ key: 'open', label: 'Inside' }, { key: 'closed', label: 'Left', final: true }],
    initial: 'open',
    transitions: [{ from: 'open', to: 'closed', label: 'Mark as left', approval: true, approver_roles: ['os:os_principal'] }],
  },
  schedule: { reminder: { date_field: 'visit_date', days_before: 0 } },
};

beforeAll(async () => {
  for (const e of [CHAIRMAN, PRINCIPAL, TEACHER]) await login(e);
  students = (await asOwner((c) => q<{ id: string }>(c, `select s.id from core.students s join core.organizations o on o.id = s.org_id where o.slug = 'demo' order by s.full_name limit 3`))).map((r) => r.id);
});
afterAll(async () => {
  await closeRecordsDb();
  await closePool();
});

describe('designer adapter', () => {
  it('validates with the same rules as the builder and the school configuration', async () => {
    const ctx = { db: defaultRecordsDb(), userId: ids[CHAIRMAN]!, products: ['os' as const] };
    const bad = await customObjectBlock.validate({ ...VISITOR_LOG, fields: [{ key: 'x', label: 'X', type: 'choice' }] }, ctx);
    expect(bad.ok).toBe(false);
    const role = await customObjectBlock.validate({ ...VISITOR_LOG, permissions: [{ who: 'role', product: 'os', role: 'os_nobody', view: 'all' }] }, ctx);
    expect(role.issues.map((i) => i.message)).toContain('role os:os_nobody does not exist in this school');
    const teacher = await customObjectBlock.validate(VISITOR_LOG, { ...ctx, userId: ids[TEACHER]! });
    expect(teacher.ok).toBe(false);
    expect((await customObjectBlock.validate(VISITOR_LOG, ctx)).ok).toBe(true);
  });

  it('previews in plain words, applies, and undoes (delete when empty)', async () => {
    const ctx = { db: defaultRecordsDb(), userId: ids[CHAIRMAN]!, products: ['os' as const] };
    const p = await customObjectBlock.preview({ ...VISITOR_LOG, key: 'probe_log' }, ctx);
    expect(p.mode).toBe('create');
    expect(p.changes[0]).toContain('Creates a new list "Hostel visitor log"');
    expect(p.affects.join('\n')).toContain('Class Teacher: see their own entries, add entries');
    expect(p.changes.join('\n')).toContain('needs approval by Principal');
    const applied = await customObjectBlock.apply({ ...VISITOR_LOG, key: 'probe_log' }, ctx);
    expect(applied).toMatchObject({ mode: 'create', key: 'probe_log', version: 1, before: null });
    const upd = await customObjectBlock.apply({ ...VISITOR_LOG, key: 'probe_log', label_plural: 'Probe log 2' }, ctx);
    expect(upd).toMatchObject({ mode: 'update', version: 2 });
    expect(await customObjectBlock.inverse(upd, ctx)).toEqual({ undone: 'restored' });
    expect((await call(CHAIRMAN, 'GET', '/objects/probe_log')).json.object.label_plural).toBe('Hostel visitor log');
    expect(await customObjectBlock.inverse(applied, ctx)).toEqual({ undone: 'deleted' });
    expect((await call(CHAIRMAN, 'GET', '/objects/probe_log')).status).toBe(404);
  });
});

describe('routes', () => {
  it('management creates the object; a teacher cannot', async () => {
    expect((await call(TEACHER, 'POST', '/objects', VISITOR_LOG)).status).toBe(403);
    const r = await call(CHAIRMAN, 'POST', '/objects', VISITOR_LOG);
    expect(r.status).toBe(201);
    expect(r.json.object.access).toMatchObject({ view: 'all', create: 'all', manage: true });
    expect((await call(CHAIRMAN, 'POST', '/objects', VISITOR_LOG)).status).toBe(409);
    const meta = await call(CHAIRMAN, 'GET', '/meta');
    expect(meta.json.manage).toContain('core');
    expect(meta.json.roles.some((x: { key: string }) => x.key === 'os_class_teacher')).toBe(true);
    expect((await call(TEACHER, 'GET', '/meta')).json.manage).toEqual([]);
  });

  it('records: create, validate, list with filters, sort, search and paging', async () => {
    const add = (data: Record<string, unknown>, who = CHAIRMAN) => call(who, 'POST', '/objects/hostel_visitors/records', { data });
    expect((await add({ visitor_name: 'Ramesh', student: students[0], purpose: 'Delivery', items: ['Food'], amount: '250' })).status).toBe(201);
    expect((await add({ visitor_name: 'Sita', student: students[1], purpose: 'Parent visit', amount: 100 })).status).toBe(201);
    expect((await add({ visitor_name: 'Abdul', student: students[2], purpose: 'Parent visit', items: ['Books', 'Food'] })).status).toBe(201);
    const bad = await add({ visitor_name: 'x', student: students[0], purpose: 'Party', amount: -5 });
    expect(bad.status).toBe(422);
    expect(bad.json.message).toContain('Purpose must be one of the choices');
    expect(bad.json.message).toContain('Deposit must be at least 0');

    const all = await call(CHAIRMAN, 'GET', '/objects/hostel_visitors/records', undefined, { sort: 'visitor_name', dir: 'asc' });
    expect(all.json.total).toBe(3);
    expect(all.json.rows.map((r: any) => r.data.visitor_name)).toEqual(['Abdul', 'Ramesh', 'Sita']);
    expect(all.json.rows[0].state).toBe('open');
    expect(Object.keys(all.json.labels)).toContain(students[2]);
    const byChoice = await call(CHAIRMAN, 'GET', '/objects/hostel_visitors/records', undefined, { 'f.purpose': 'Parent visit' });
    expect(byChoice.json.total).toBe(2);
    expect((await call(CHAIRMAN, 'GET', '/objects/hostel_visitors/records', undefined, { 'f.items': 'Food' })).json.total).toBe(2);
    expect((await call(CHAIRMAN, 'GET', '/objects/hostel_visitors/records', undefined, { 'f.amount.from': '200' })).json.total).toBe(1);
    expect((await call(CHAIRMAN, 'GET', '/objects/hostel_visitors/records', undefined, { q: 'rames' })).json.rows.map((r: any) => r.data.visitor_name)).toEqual(['Ramesh']);
    const paged = await call(CHAIRMAN, 'GET', '/objects/hostel_visitors/records', undefined, { sort: 'amount', dir: 'desc', page: '2', pageSize: '2' });
    expect(paged.json.rows).toHaveLength(1);
    expect((await call(CHAIRMAN, 'GET', '/objects/hostel_visitors/records', undefined, { sort: 'nope' })).status).toBe(422);
  });

  it('a teacher sees only own entries, can add and edit own, cannot export', async () => {
    expect((await call(TEACHER, 'GET', '/objects')).json.objects.map((o: any) => o.key)).toEqual(['hostel_visitors']);
    expect((await call(TEACHER, 'GET', '/objects/hostel_visitors/records')).json.total).toBe(0);
    const mine = await call(TEACHER, 'POST', '/objects/hostel_visitors/records', { data: { visitor_name: 'Teacher guest', student: students[0] } });
    expect(mine.status).toBe(201);
    expect((await call(TEACHER, 'PATCH', `/objects/hostel_visitors/records/${mine.json.record.id}`, { data: { purpose: 'Other' } })).status).toBe(200);
    const list = await call(TEACHER, 'GET', '/objects/hostel_visitors/records');
    expect(list.json.rows.map((r: any) => r.data.visitor_name)).toEqual(['Teacher guest']);
    const other = (await call(CHAIRMAN, 'GET', '/objects/hostel_visitors/records', undefined, { q: 'Ramesh' })).json.rows[0].id;
    expect((await call(TEACHER, 'GET', `/objects/hostel_visitors/records/${other}`)).status).toBe(404);
    expect((await call(TEACHER, 'PATCH', `/objects/hostel_visitors/records/${other}`, { data: { purpose: 'Other' } })).status).toBe(404);
    expect((await call(TEACHER, 'GET', '/objects/hostel_visitors/export.csv')).status).toBe(403);
    expect((await call(TEACHER, 'DELETE', `/objects/hostel_visitors/records/${mine.json.record.id}`)).status).toBe(200);
    expect((await call(TEACHER, 'GET', '/objects/hostel_visitors/records')).json.total).toBe(0);
  });

  it('CSV export of the filtered list is written to audit.log and the history', async () => {
    const r = await call(CHAIRMAN, 'GET', '/objects/hostel_visitors/export.csv', undefined, { 'f.purpose': 'Parent visit', sort: 'visitor_name', dir: 'asc' });
    expect(r.status).toBe(200);
    const lines = r.text!.body.replace(/^﻿/, '').trim().split('\r\n');
    expect(lines[0]).toBe('Visitor name,Student,Date,Purpose,Items brought,Deposit,State,Created,Updated');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toMatch(/^Abdul,[^,]+,\d{4}-\d{2}-\d{2},Parent visit,Books; Food,,Inside,/);
    const audit = await asOwner((c) => q<{ detail: any }>(c, `select detail from audit.log where action = 'records.export' order by created_at desc limit 1`));
    expect(audit[0]!.detail).toMatchObject({ rows: 2, format: 'csv' });
  });

  it('workflow: a change of state waits for the principal\'s approval and is in the history', async () => {
    const id = (await call(CHAIRMAN, 'GET', '/objects/hostel_visitors/records', undefined, { q: 'Ramesh' })).json.rows[0].id;
    const d1 = await call(CHAIRMAN, 'GET', `/objects/hostel_visitors/records/${id}`);
    expect(d1.json.transitions).toEqual([{ to: 'closed', label: 'Mark as left', approval: true }]);
    expect((await call(CHAIRMAN, 'POST', `/objects/hostel_visitors/records/${id}/transition`, { to: 'closed', note: 'left at 6pm' })).json).toEqual({ result: 'pending' });
    const pending = await call(PRINCIPAL, 'GET', '/approvals');
    expect(pending.json.approvals).toHaveLength(1);
    expect((await call(TEACHER, 'POST', `/approvals/${pending.json.approvals[0].id}/decide`, { ok: true })).status).toBe(403);
    expect((await call(PRINCIPAL, 'POST', `/approvals/${pending.json.approvals[0].id}/decide`, { ok: true, comment: 'fine' })).json).toEqual({ result: 'approved' });
    const d2 = await call(CHAIRMAN, 'GET', `/objects/hostel_visitors/records/${id}`);
    expect(d2.json.record.state).toBe('closed');
    expect(d2.json.history.map((h: any) => h.kind)).toEqual(expect.arrayContaining(['created', 'approval_requested', 'approved', 'state']));
  });

  it('reminders: due entries notify their owner once', async () => {
    const out = await runRecordReminders(defaultRecordsDb());
    expect(out.enqueued).toBeGreaterThanOrEqual(2); // open entries due today (the closed one is final)
    expect(out.delivered).toBe(out.enqueued);
    expect((await runRecordReminders(defaultRecordsDb())).enqueued).toBe(0);
    const notes = await asOwner((c) => q<{ n: number }>(c, `select count(*)::int as n from core.notifications where event_key = 'records.reminder' and user_id = $1`, [ids[CHAIRMAN]]));
    expect(notes[0]!.n).toBeGreaterThanOrEqual(2);
  });

  it('archiving hides the object from staff; management still sees it with ?archived=1', async () => {
    expect((await call(CHAIRMAN, 'PATCH', '/objects/hostel_visitors', { archived: true })).status).toBe(200);
    expect((await call(TEACHER, 'GET', '/objects')).json.objects).toEqual([]);
    expect((await call(CHAIRMAN, 'GET', '/objects', undefined, { archived: '1' })).json.objects.map((o: any) => o.key)).toContain('hostel_visitors');
    expect((await call(CHAIRMAN, 'POST', '/objects/hostel_visitors/records', { data: { visitor_name: 'x', student: students[0] } })).status).toBe(403);
    expect((await call(CHAIRMAN, 'PATCH', '/objects/hostel_visitors', { archived: false })).json.object.archived).toBe(false);
    expect((await call(CHAIRMAN, 'DELETE', '/objects/hostel_visitors')).status).toBe(409); // has records: archive instead
    expect((await dispatchRecords({ method: 'GET', path: '/objects', headers: {} })).status).toBe(401);
  });
});
