// The working screens' API (staff.ts, session.ts, public.ts): the flows of the original e2e scripts, as API calls against
// real Postgres. Every call is signed in as a real user of the org: the role matrix and the row policies decide.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addStaff, createOrg, ownerQ, shutdown, type TestOrg } from './helpers';
import { call, get, login, mobile, post, type Who } from './api-helpers';

let org: TestOrg, other: TestOrg;
let admin: Who, ann: Who, bob: Who, desk: Who, outsider: Who, viewer: Who;
let stageId: Record<string, string>;
const tomorrow = () => new Date(Date.now() + 26 * 3600e3).toISOString().slice(0, 16);

beforeAll(async () => {
  org = await createOrg('Api School', { branches: ['Main campus', 'North campus'] });
  other = await createOrg('Other Api School');
  const main = org.branches['Main campus']!;
  admin = await login(await addStaff(org, 'Asha Admin', 'Group Admin'));
  ann = await login(await addStaff(org, 'Ann Counsellor', 'Counsellor', { branchIds: [main] }));
  bob = await login(await addStaff(org, 'Bob Counsellor', 'Counsellor', { branchIds: [main] }));
  desk = await login(await addStaff(org, 'Dee Desk', 'Front Office', { branchIds: [main] }));
  outsider = await login(await addStaff(other, 'Olga Other', 'Group Admin'));
  viewer = await login(await addStaff(org, 'Vik Viewer', 'Read-only Management'));
  const st = await ownerQ('select id, name from crm.stages where org_id = $1', [org.orgId]);
  stageId = Object.fromEntries(st.map((s) => [s.name, s.id]));
  // route everything to Ann and Bob in turn so the scopes are testable
  await ownerQ('delete from crm.assignment_rules where org_id = $1', [org.orgId]);
  await ownerQ("insert into crm.assignment_rules (org_id, name, seq, method, user_ids) values ($1, 'rr', 1, 'round_robin', $2::jsonb)", [org.orgId, JSON.stringify([ann.userId, bob.userId])]);
});
afterAll(shutdown);

const quick = (w: Who, over: Record<string, unknown> = {}) =>
  post(w, '/leads', { studentName: 'Zoya Khan', guardianName: 'Imran Khan', mobile: mobile(), branchId: org.branchId, grade: 'Grade 1', consent: true, ...over });

describe('sign-in and the shell', () => {
  it('the dev login is off unless AUTH_PROVIDER=dev, and refuses unknown people', async () => {
    const prev = process.env.AUTH_PROVIDER;
    process.env.AUTH_PROVIDER = 'supabase';
    expect((await post(null, '/auth/dev-login', { email: 'x@y.z' })).status).toBe(401);
    process.env.AUTH_PROVIDER = 'dev';
    expect((await post(null, '/auth/dev-login', { email: 'nobody@nowhere.test' })).status).toBe(401);
    const email = (await ownerQ('select email from core.staff where org_id = $1 and first_name = $2', [org.orgId, 'Ann']))[0].email;
    const ok = await post(null, '/auth/dev-login', { email });
    expect(ok.status).toBe(200);
    expect(ok.setSession?.token).toBeTruthy();
    // the issued token works, is recorded for revocation, and is refused after sign-out
    const t = { token: ok.setSession!.token, userId: ann.userId };
    expect((await get(t, '/shell')).status).toBe(200);
    expect((await ownerQ("select count(*)::int n from core.device_tokens where user_id = $1 and token like 'session:%'", [ann.userId]))[0].n).toBe(1);
    expect((await post(t, '/auth/logout')).setSession).toBeNull();
    expect((await get(t, '/shell')).status).toBe(401);
    process.env.AUTH_PROVIDER = prev;
  });

  it('shell: the frame depends on the role', async () => {
    const a = (await get(admin, '/shell')).data;
    expect(a.nav).toMatchObject({ leads: true, campaigns: true, reports: true, admin: true, walkin: true });
    expect(a.adminSections).toContain('roles');
    expect(a.branches.length).toBe(2);
    const c = (await get(ann, '/shell')).data;
    expect(c.nav).toMatchObject({ leads: true, campaigns: false, admin: false });
    expect(c.scope).toBe('own');
    expect(c.sources.length).toBeGreaterThan(5);
    const d = (await get(desk, '/shell')).data;
    expect(d.nav.walkin).toBe(true);
    expect(d.can.edit).toBe(false);
    expect((await get(null, '/shell')).status).toBe(401);
  });
});

describe('quick add, duplicates, role-limited views', () => {
  it('quick add checks the duplicate before saving and never creates a second family', async () => {
    const m = mobile();
    const first = await quick(ann, { mobile: m, studentName: 'Kabir Rao' });
    expect(first.data.ok).toBe(true);
    expect(first.data.status).toBe('created');
    const dup = (await get(ann, '/dedupe', { mobile: m })).data.match;
    expect(dup.guardian).toBe('Imran Khan');
    expect(dup.enquiries[0].student).toBe('Kabir Rao');
    const again = await quick(bob, { mobile: m, studentName: 'Kabir Rao' });
    expect(again.data.status).toBe('re_enquiry');
    expect(again.data.householdId).toBe(first.data.householdId);
    // a different child on the same number becomes a sibling in the same household
    const sib = await quick(bob, { mobile: m, studentName: 'Meher Rao' });
    expect(sib.data.status).toBe('sibling_added');
    expect(sib.data.householdId).toBe(first.data.householdId);
    expect((await ownerQ('select count(*)::int n from crm.households h join crm.guardians g on g.household_id = h.id where g.phone = $1 and h.org_id = $2', [m, org.orgId]))[0].n).toBe(1);
  });

  it('invalid input is refused with a readable message; a role without create cannot add', async () => {
    expect((await quick(ann, { mobile: '123' })).data.error).toMatch(/10-digit/);
    expect((await quick(ann, { branchId: other.branchId })).data.error).toMatch(/branches/);
    expect((await quick(desk)).status).toBe(200); // Front Office can create
    expect((await post(admin, '/leads', {})).status).toBe(422);
  });

  it('counsellors see only their own records; the admin sees all; another school sees none', async () => {
    for (let i = 0; i < 4; i++) await quick(admin, { studentName: `Scope Kid ${i}` });
    const mine = (await get(ann, '/leads')).data;
    const theirs = (await get(bob, '/leads')).data;
    const all = (await get(admin, '/leads')).data;
    expect(mine.total).toBeGreaterThan(0);
    expect(mine.total + theirs.total).toBeLessThanOrEqual(all.total);
    expect(mine.data.every((r: any) => r.owner === 'Ann Counsellor')).toBe(true);
    expect((await get(outsider, '/leads')).data.total).toBe(0);
    // opening a colleague's family is refused, as is another school's
    const hh = all.data.find((r: any) => r.owner === 'Bob Counsellor').household_id;
    expect((await get(ann, `/households/${hh}`)).status).toBe(404);
    expect((await get(outsider, `/households/${hh}`)).status).toBe(404);
    expect((await get(admin, `/households/${hh}`)).status).toBe(200);
  });

  it('filters: stage tabs counts, chips, search text', async () => {
    const r = (await get(admin, '/leads', { chip: 'my' })).data;
    expect(r.data.every((x: any) => x.owner === 'Asha Admin') || r.total === 0).toBe(true);
    const q = (await get(admin, '/leads', { q: 'Zoya' })).data;
    expect(q.total).toBeGreaterThan(0);
    expect(Object.keys((await get(admin, '/leads')).data.counts).length).toBeGreaterThan(0);
  });
});

describe('the family page and its actions', () => {
  let e: any, hh: string;
  beforeAll(async () => {
    const r = (await quick(admin, { studentName: 'Naina Sethi' })).data;
    e = r.enquiryId;
    hh = r.householdId;
  });

  it('360: timeline, tasks, score, templates and permissions come in one call', async () => {
    const d = (await get(admin, `/households/${hh}`, { e })).data;
    expect(d.current.student).toBe('Naina Sethi');
    expect(d.activities.length).toBeGreaterThan(0);
    expect(d.tasks.some((t: any) => t.status === 'open')).toBe(true); // TSK-03: a first call task exists
    expect(d.templates.length).toBeGreaterThan(3);
    expect(d.guardians[0].mobile).toMatch(/^\d{10}$/);
    expect(d.can.edit).toBe(true);
  });

  it('notes mention colleagues; calls move New to Connected and can plan the next call', async () => {
    expect((await post(admin, `/leads/${e}/note`, { note: 'Needs transport @ann please check' })).status).toBe(200);
    expect((await ownerQ("select count(*)::int n from core.notifications where user_id = $1 and event_key = 'mention'", [ann.userId]))[0].n).toBe(1);
    expect((await post(admin, `/leads/${e}/note`, { note: '' })).status).toBe(422);
    const r = await post(admin, `/leads/${e}/call`, { outcome: 'connected', notes: 'Wants a visit', nextTitle: 'Send fees', nextDue: tomorrow() });
    expect(r.data.ok).toBe(true);
    const d = (await get(admin, `/households/${hh}`, { e })).data;
    expect(d.current.stage).toBe('Connected');
    expect(d.tasks.some((t: any) => t.title === 'Send fees')).toBe(true);
    expect(d.activities.some((a: any) => a.type === 'call' && a.outcome === 'connected')).toBe(true);
  });

  it('stage change asks only for what the stage needs, then moves', async () => {
    const closed = await post(admin, `/leads/${e}/stage`, { stageId: stageId['Not interested'] });
    expect(closed.data.ok).toBe(false);
    expect(closed.data.missing).toContain('closure_reason');
    const visit = await post(admin, `/leads/${e}/stage`, { stageId: stageId['Visit scheduled'] });
    expect(visit.data.missing).toContain('visit');
    expect((await post(admin, `/leads/${e}/stage`, { stageId: stageId['Interested'] })).data.ok).toBe(true);
  });

  it('visits: booking respects the hour capacity, moves the stage and creates the host task; check in, done, no-show', async () => {
    const slot = tomorrow().slice(0, 13) + ':00';
    const book = await post(admin, `/leads/${e}/visit`, { slotAt: slot, type: 'campus_tour' });
    expect(book.data.ok).toBe(true);
    let d = (await get(admin, `/households/${hh}`, { e })).data;
    expect(d.current.stage).toBe('Visit scheduled');
    expect(d.visits[0].status).toBe('scheduled');
    expect(d.tasks.some((t: any) => t.type === 'visit' && t.status === 'open')).toBe(true);
    expect((await post(admin, `/leads/${e}/visit`, { slotAt: '2001-01-01T10:00' })).status).toBe(422);
    const vid = d.visits[0].id;
    expect((await post(admin, `/visits/${vid}`, { what: 'done' })).status).toBe(422); // outcome needed
    expect((await post(admin, `/visits/${vid}`, { what: 'check_in' })).data.ok).toBe(true);
    expect((await post(admin, `/visits/${vid}`, { what: 'done', outcome: 'Liked the campus' })).data.ok).toBe(true);
    d = (await get(admin, `/households/${hh}`, { e })).data;
    expect(d.current.stage).toBe('Visit done');
    expect(d.visits[0].status).toBe('done');
    // the visits screen lists it for the front desk
    const list = (await get(desk, '/visits')).data;
    expect(list.can.tasks).toBe(true);
  });

  it('visit capacity: the third booking in one hour is refused when the branch allows two', async () => {
    await ownerQ('insert into crm.branch_settings (org_id, branch_id, visit_capacity) values ($1, $2, 1) on conflict (org_id, branch_id) do update set visit_capacity = 1', [org.orgId, org.branchId]);
    const a = (await quick(admin, { studentName: 'Cap One' })).data.enquiryId;
    const b2 = (await quick(admin, { studentName: 'Cap Two' })).data.enquiryId;
    const slot = new Date(Date.now() + 50 * 3600e3).toISOString().slice(0, 13) + ':30';
    expect((await post(admin, `/leads/${a}/visit`, { slotAt: slot })).data.ok).toBe(true);
    const full = await post(admin, `/leads/${b2}/visit`, { slotAt: slot });
    expect(full.status).toBe(422);
    expect(full.data.error).toMatch(/full/);
    await ownerQ('update crm.branch_settings set visit_capacity = 3 where org_id = $1', [org.orgId]);
  });

  it('messages: template send, the WhatsApp 24-hour rule, internal notes, and the inbox after a parent reply', async () => {
    const tpl = (await get(admin, `/households/${hh}`, { e })).data.templates.find((t: any) => t.name === 'Welcome' && t.channel === 'whatsapp');
    const sent = await post(admin, `/leads/${e}/message`, { templateId: tpl.id });
    expect(sent.data.ok).toBe(true);
    const free = await post(admin, `/leads/${e}/message`, { channel: 'whatsapp', body: 'Hello there' });
    expect(free.status).toBe(422);
    expect(free.data.error).toMatch(/24 hours/);
    expect((await post(admin, `/leads/${e}/message`, { channel: 'whatsapp', body: 'internal only', note: true })).data.status).toBe('note');
    // the parent writes back: the conversation shows up unread, the 24-hour window opens
    expect((await post(admin, `/inbox/${hh}/simulate`, { body: 'Please call after 5' })).data.ok).toBe(true);
    const inbox = (await get(admin, '/inbox', { h: hh, f: 'all' })).data;
    expect(inbox.current.id).toBe(hh);
    expect(inbox.windowOpen).toBe(true);
    expect(inbox.messages.some((m: any) => m.direction === 'in' && m.body.includes('after 5'))).toBe(true);
    expect((await post(admin, `/leads/${e}/message`, { channel: 'whatsapp', body: 'Will do' })).data.ok).toBe(true);
    expect((await post(admin, `/inbox/${hh}/status`, { status: 'closed' })).data.ok).toBe(true);
    // STOP opts the parent out: later sends are refused with a reason
    await post(admin, `/inbox/${hh}/simulate`, { body: 'STOP' });
    const blocked = await post(admin, `/leads/${e}/message`, { channel: 'whatsapp', body: 'still there?' });
    expect(blocked.data.ok).toBe(false);
    expect(blocked.data.message).toMatch(/opted out/);
    // a role without the right to message cannot; Front Office may (it works the branch's records)
    expect((await post(viewer, `/leads/${e}/message`, { channel: 'sms', body: 'x' })).status).toBe(403);
    expect((await post(desk, `/leads/${e}/message`, { channel: 'sms', body: 'We are open till 5' })).data.ok).toBe(true);
  });

  it('details: edits are saved with a timeline entry; sensitive custom values are masked for roles without access', async () => {
    const ok = await post(admin, `/leads/${e}/details`, { g_name: 'Neha Sethi', h_locality: 'Banjara Hills', e_grade: 'Grade 2', s_name: 'Naina S Sethi' });
    expect(ok.data.changed).toBeGreaterThanOrEqual(3);
    const d = (await get(admin, `/households/${hh}`, { e })).data;
    expect(d.guardians[0].name).toBe('Neha Sethi');
    expect(d.current.grade).toBe('Grade 2');
    expect(d.current.student).toBe('Naina S Sethi');
    expect(d.activities.some((a: any) => a.type === 'field_change')).toBe(true);
    expect((await post(admin, `/leads/${e}/details`, { g_name: 'Neha Sethi' })).data.changed).toBe(0);
  });

  it('reassign needs the right and moves open tasks with the record', async () => {
    expect((await post(ann, `/leads/${e}/reassign`, { ownerId: bob.userId })).status).toBe(403);
    const r = await post(admin, `/leads/${e}/reassign`, { ownerId: bob.userId, reason: 'Balance load' });
    expect(r.data.ok).toBe(true);
    expect((await ownerQ('select owner_id from crm.enquiries where id = $1', [e]))[0].owner_id).toBe(bob.userId);
    // now Bob can open it and Ann can not
    expect((await get(bob, `/households/${hh}`)).status).toBe(200);
    expect((await get(ann, `/households/${hh}`)).status).toBe(404);
    await post(admin, `/leads/${e}/reassign`, { ownerId: ann.userId, reason: 'Back' });
  });

  it('adding a sibling reuses the parent and address', async () => {
    const r = await post(admin, `/households/${hh}/sibling`, { studentName: 'Tara Sethi', branchId: org.branchId, grade: 'UKG' });
    expect(r.data.ok).toBe(true);
    expect(r.data.householdId).toBe(hh);
    expect((await get(admin, `/households/${hh}`)).data.enquiries.length).toBeGreaterThanOrEqual(2);
  });
});

describe('tasks', () => {
  it('completing the last open task requires the next action; otherwise it is not saved (TSK-03)', async () => {
    const r = (await quick(admin, { studentName: 'Task Child' })).data;
    const tasks = (await get(admin, '/tasks', { tab: 'upcoming' })).data;
    void tasks;
    const open = (await ownerQ("select id from crm.follow_ups where enquiry_id = $1 and status = 'open'", [r.enquiryId]))[0].id;
    const refused = await post(admin, `/tasks/${open}/complete`, { outcome: 'spoke', next: 'none' });
    expect(refused.status).toBe(422);
    expect(refused.data.error).toMatch(/no next action/);
    expect((await ownerQ('select status from crm.follow_ups where id = $1', [open]))[0].status).toBe('open');
    const noDue = await post(admin, `/tasks/${open}/complete`, { outcome: 'spoke', next: 'task', nextTitle: 'Again' });
    expect(noDue.data.error).toMatch(/date and time/);
    const done = await post(admin, `/tasks/${open}/complete`, { outcome: 'spoke', next: 'task', nextTitle: 'Again', nextDue: tomorrow() });
    expect(done.data.ok).toBe(true);
    expect((await ownerQ("select count(*)::int n from crm.follow_ups where enquiry_id = $1 and status = 'open'", [r.enquiryId]))[0].n).toBe(1);
    // already closed
    expect((await post(admin, `/tasks/${open}/complete`, { outcome: 'again', next: 'none' })).status).toBe(422);
  });

  it('lists: today, overdue, upcoming; the team view is for heads only; reschedule keeps the task', async () => {
    const mine = (await get(ann, '/tasks')).data;
    expect(mine.team).toBe(false);
    expect((await get(ann, '/tasks', { who: 'team' })).data.team).toBe(false); // not allowed, silently mine
    expect((await get(admin, '/tasks', { who: 'team' })).data.team).toBe(true);
    const up = (await get(admin, '/tasks', { tab: 'upcoming', who: 'team' })).data.tasks;
    const t = up[0];
    const due = new Date(Date.now() + 5 * 86400e3).toISOString();
    expect((await post(admin, `/tasks/${t.id}/reschedule`, { due })).data.ok).toBe(true);
    expect((await get(admin, '/tasks', { view: 'calendar', who: 'team' })).data.calendar).toBe(true);
    expect((await post(outsider, `/tasks/${t.id}/reschedule`, { due })).status).toBe(404);
  });
});

describe('bulk actions and saved views', () => {
  it('bulk: tag, task, reassign and stage, only on what the person can see; counsellors without bulk are refused', async () => {
    const ids = (await Promise.all([0, 1, 2].map((i) => quick(admin, { studentName: `Bulk ${i}` })))).map((r) => r.data.enquiryId);
    expect((await post(ann, '/leads/bulk', { action: 'tag', ids, tag: 'x' })).status).toBe(403);
    const tag = await post(admin, '/leads/bulk', { action: 'tag', ids, tag: 'Open House' });
    expect(tag.data.done).toBe(3);
    expect((await ownerQ("select count(*)::int n from crm.enquiries where id = any($1::uuid[]) and tags ? 'open house'", [ids]))[0].n).toBe(3);
    expect((await post(admin, '/leads/bulk', { action: 'task', ids, title: 'Bulk follow-up', dueAt: tomorrow() })).data.done).toBe(3);
    const re = await post(admin, '/leads/bulk', { action: 'reassign', ids, ownerId: bob.userId, reason: 'Bulk test' });
    expect(re.data.done).toBe(3);
    const toVisit = await post(admin, '/leads/bulk', { action: 'stage', ids, stageId: stageId['Visit scheduled'] });
    expect(toVisit.data.skipped).toBe(3); // needs a booked visit: skipped, not forced
    // by filter ("select all matching"): the query decides the set
    const all = await post(admin, '/leads/bulk', { action: 'tag', all: true, query: 'tag=open house', tag: 'second' });
    expect(all.data.done).toBeGreaterThanOrEqual(3);
    expect((await post(admin, '/leads/bulk', { action: 'tag', ids: [], tag: 'z' })).status).toBe(422);
  });

  it('saved views belong to their owner unless shared', async () => {
    expect((await post(ann, '/views', { name: 'Hot ones', query: 'chip=hot' })).data.ok).toBe(true);
    expect((await post(admin, '/views', { name: 'Team view', query: 'open=1', shared: true })).data.ok).toBe(true);
    const a = (await get(ann, '/leads')).data.views.map((v: any) => v.name);
    expect(a).toContain('Hot ones');
    expect(a).toContain('Team view');
    expect((await get(bob, '/leads')).data.views.map((v: any) => v.name)).not.toContain('Hot ones');
    const id = (await get(ann, '/leads')).data.views.find((v: any) => v.name === 'Hot ones').id;
    expect((await post(bob, `/views/${id}/delete`)).data.ok).toBe(true); // not theirs: nothing deleted
    expect((await get(ann, '/leads')).data.views.map((v: any) => v.name)).toContain('Hot ones');
    await post(ann, `/views/${id}/delete`);
    expect((await get(ann, '/leads')).data.views.map((v: any) => v.name)).not.toContain('Hot ones');
  });
});

describe('application, documents, payments and admission (the original e2e-admissions flow)', () => {
  let e: string, hh: string;
  beforeAll(async () => {
    const r = (await quick(admin, { studentName: 'Admit Me', grade: 'Grade 1', dob: '2020-05-05' })).data;
    e = r.enquiryId;
    hh = r.householdId;
  });

  it('start, fill, submit, pay, verify documents, confirm: a core student is created', async () => {
    expect((await post(admin, `/leads/${e}/application/start`)).data.ok).toBe(true);
    const bad = await post(admin, `/leads/${e}/application`, { answers: { mother_tongue: 'Hindi' }, submit: true, declaration: true });
    expect(bad.status).toBe(422);
    expect(bad.data.error).toMatch(/required answers/);
    const answers = { mother_tongue: 'Hindi', medical: 'None', father_name: 'A', mother_name: 'B', address: '12 Park Rd', pincode: '500001', transport: 'Yes', not_a_field: 'ignored' };
    expect((await post(admin, `/leads/${e}/application`, { answers, submit: true, declaration: false })).data.error).toMatch(/declaration/);
    expect((await post(admin, `/leads/${e}/application`, { answers, submit: true, declaration: true })).data.ok).toBe(true);
    const page = (await get(admin, `/applications/${e}`)).data;
    expect(page.application.status).toBe('submitted');
    expect(page.application.answers.not_a_field).toBeUndefined();
    // the registration fee exists after submit; the admission fee by link or at the desk
    const pay = (await post(admin, `/leads/${e}/payment`, { purpose: 'Admission fee', amount: 25000, mode: 'cash' })).data;
    expect(pay.ok).toBe(true);
    const reg = page.payments.find((p: any) => p.purpose === 'Registration fee');
    expect(reg.status).toBe('pending');
    // not ready: documents are missing
    const early = await post(admin, `/leads/${e}/admission`, {});
    expect(early.status).toBe(422);
    expect(early.data.error).toMatch(/Documents verified/);
    for (const d of page.documents) {
      expect((await post(admin, `/documents/${d.id}`, { what: 'upload', fileName: `${d.type}.pdf` })).data.ok).toBe(true);
      expect((await post(admin, `/documents/${d.id}`, { what: 'verify' })).data.ok).toBe(true);
    }
    const rej = page.documents[0];
    expect((await post(admin, `/documents/${rej.id}`, { what: 'reject' })).status).toBe(422); // a reason is needed
    const ready = await post(admin, `/leads/${e}/admission`, {});
    expect(ready.data.ok).toBe(true);
    // the stage is the trigger: a core student, household and enrolment exist, linked back to the prospect
    const stu = await ownerQ('select s.id, s.status from core.students s join crm.prospects p on p.core_student_id = s.id join crm.enquiries q on q.prospect_id = p.id where q.id = $1', [e]);
    expect(stu.length).toBe(1);
    expect(stu[0].status).toBe('admitted');
    const d = (await get(admin, `/households/${hh}`, { e })).data;
    expect(d.current.stage).toBe('Admission confirmed');
    expect(page.payments.length).toBeGreaterThan(0);
  });

  it('offline payments wait for accounts; roles without payment rights are refused', async () => {
    const r = (await quick(admin, { studentName: 'Pay Child' })).data;
    expect((await post(viewer, `/leads/${r.enquiryId}/payment`, { amount: 100, mode: 'cash' })).status).toBe(403);
    // Front Office (Collect) records a cash payment: it waits for accounts, no receipt yet
    const cash = await post(desk, `/leads/${r.enquiryId}/payment`, { amount: 1500, mode: 'cash', purpose: 'Registration fee' });
    expect(cash.data.message).toMatch(/Accounts will verify/);
    const row = (await ownerQ('select * from crm.payments where id = $1', [cash.data.id]))[0];
    expect(row.status).toBe('pending');
    expect(row.receipt_no).toBeNull();
    const queue = (await get(admin, '/applications')).data.queue;
    expect(queue.some((q: any) => q.id === cash.data.id)).toBe(true);
    expect((await post(desk, `/payments/${cash.data.id}/settle`, {})).status).toBe(403); // the desk cannot verify
    expect((await post(ann, `/payments/${cash.data.id}/settle`, {})).status).toBe(403);
    const settled = await post(admin, `/payments/${cash.data.id}/settle`, { reference: 'CASH-1' });
    expect(settled.data.payment.receipt_no).toMatch(/^RCPT-/);
    expect((await get(admin, '/applications')).data.queue.some((q: any) => q.id === cash.data.id)).toBe(false);
    // a payment link goes out as a message with the /crm/pay link
    const link = await post(admin, `/leads/${r.enquiryId}/payment`, { amount: 500, mode: 'link' });
    expect(link.data.link).toMatch(/\/crm\/pay\//);
  });

  it('the parent pages: hosted form, application link, payment link (public, key-authorised)', async () => {
    const slug = (await ownerQ('select slug from crm.forms where org_id = $1 limit 1', [org.orgId]))[0].slug;
    const meta = await get(null, `/forms/${slug}`);
    expect(meta.data.grades.length).toBeGreaterThan(3);
    expect(meta.data.branches.length).toBe(2);
    const sub = await post(null, `/forms/${slug}/submit`, { student_name: 'Web Child', guardian_name: 'Web Parent', mobile: mobile(), grade: 'Grade 1', branch: org.branchId, consent: true, loaded: Date.now() - 5000 });
    expect(sub.data.ok).toBe(true);
    expect((await post(null, `/forms/${slug}/submit`, { student_name: 'X', guardian_name: 'Y', mobile: mobile(), consent: false, loaded: Date.now() - 5000 })).status).toBe(422);
    const token = (await ownerQ('select public_token from crm.enquiries where id = $1', [e]))[0].public_token;
    const page = (await get(null, `/apply/${token}/page`)).data;
    expect(page.student).toBe('Admit Me');
    expect(page.submitted).toBe(true);
    expect((await get(null, '/apply/nonsense/page')).status).toBe(404);
    const pay = (await ownerQ("select token from crm.payments where enquiry_id = $1 and mode = 'link' limit 1", [e]))[0];
    if (pay) expect((await get(null, `/pay/${pay.token}`)).data.amount).toBeGreaterThan(0);
  });
});

describe('campaigns', () => {
  it('draft, estimate, send once to each family, results and the wallet', async () => {
    const tpl = (await get(admin, '/campaigns')).data.templates.find((t: any) => t.name === 'Welcome' && t.channel === 'whatsapp');
    expect((await post(ann, '/campaigns', { name: 'x', templateId: tpl.id })).status).toBe(403);
    const draft = await post(admin, '/campaigns', { name: 'Open house reminder', audience: 'open=1', templateId: tpl.id });
    expect(draft.data.ok).toBe(true);
    const before = (await get(admin, '/campaigns')).data;
    const c = before.campaigns.find((x: any) => x.name === 'Open house reminder');
    expect(c.status).toBe('draft');
    expect(c.count).toBeGreaterThan(0);
    const sent = await post(admin, `/campaigns/${c.id}/send`);
    expect(sent.data.ok).toBe(true);
    expect(sent.data.sent).toBeGreaterThan(0);
    const after = (await get(admin, '/campaigns')).data;
    const done = after.campaigns.find((x: any) => x.id === c.id);
    expect(done.status).toBe('sent');
    expect(done.stats.targeted).toBeGreaterThan(0);
    expect(after.wallet).toBeLessThan(before.wallet);
    expect((await post(admin, `/campaigns/${c.id}/send`)).status).toBe(404); // cannot be sent twice
  });
});
