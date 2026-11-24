/**
 * End-to-end flows from PRD 10.1, exercised through the same API the web and mobile apps call,
 * against a freshly seeded database. Plus phase acceptance checks that are API-level.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, isoWeekday, toLocal } from '@autoed/shared';
import { dispatch, type ApiResponse } from '../src/api';
import { asService, closePool, one, q } from '../src/db';
import { escalationSweep, generateRecurrences } from '../src/services/tasks';
import { unmarkedSweep } from '../src/services/attendance';
import { loadKb } from '../src/services/bot';
import { join } from 'node:path';

const tokens: Record<string, string> = {};
async function login(email: string): Promise<string> {
  if (tokens[email]) return tokens[email]!;
  const r = await dispatch({ method: 'POST', path: '/auth/dev-login', query: {}, headers: {}, body: { email }, ip: `t-${email}` });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  tokens[email] = (r.json as { token: string }).token;
  return tokens[email]!;
}

async function call(email: string, method: string, path: string, body?: unknown, query: Record<string, string> = {}, headers: Record<string, string> = {}): Promise<ApiResponse & { json: any }> {
  const token = await login(email);
  const r = await dispatch({ method, path, query, headers: { authorization: `Bearer ${token}`, ...headers }, body: body ?? {}, ip: '127.0.0.1' });
  return r as ApiResponse & { json: any };
}

async function ok(email: string, method: string, path: string, body?: unknown, query: Record<string, string> = {}) {
  const r = await call(email, method, path, body, query);
  expect(r.status, `${method} ${path} -> ${JSON.stringify(r.json)}`).toBe(200);
  return r.json;
}

const today = toLocal(new Date()).date;
function nextWorkingDay(from: string, skip = 1): string {
  let d = addDays(from, skip);
  while (isoWeekday(d) === 7) d = addDays(d, 1);
  return d;
}

const PRINCIPAL = 'principal@demo.school';
const COORD = 'coordinator@demo.school';
const ADMIN = 'admin@demo.school';
const TEACHER = 'deepa.teacher9@demo.school'; // Science, reports to Science HOD
const SCI_HOD = 'priya.hod6@demo.school';
const LANG_TEACHER = 'sneha.teacher11@demo.school';
const LANG_HOD = 'lakshmi.hod7@demo.school';
const HOUSEKEEPING = 'manoj.housekeeping21@demo.school';

beforeAll(async () => {
  await asService((c) => loadKb(c, join(__dirname, '..', '..', '..', 'kb')));
});
afterAll(async () => {
  await closePool();
});

describe('flow 1: school setup through the wizard to the first login of a teacher', () => {
  it('works end to end', async () => {
    const org = await ok('admin@autoed.dev', 'POST', '/admin/orgs', { name: 'Lotus Public School', slug: 'lotus', preset_key: 'cbse', branch_name: 'Main campus', branch_code: 'MAIN', admin_name: 'Rekha Director', admin_email: 'director@lotus.school', plan_key: 'starter' });
    expect(org.org_id).toBeTruthy();
    const D = 'director@lotus.school';
    let state = await ok(D, 'GET', '/setup');
    expect(state.steps).toHaveLength(8);
    await ok(D, 'POST', '/setup/profile', { name: 'Lotus Public School', preset_key: 'cbse', branch: { name: 'Main campus', code: 'MAIN', latitude: 17.4, longitude: 78.4, geofence_radius_m: 200 } });
    await ok(D, 'POST', '/setup/year', { name: '2026-27', starts_on: '2026-04-01', ends_on: '2027-03-31', working_days: [1, 2, 3, 4, 5, 6], terms: [{ name: 'Term 1', starts_on: '2026-04-01', ends_on: '2026-09-30' }, { name: 'Term 2', starts_on: '2026-10-01', ends_on: '2027-03-31' }], bell: [{ name: 'Main', periods: [{ label: 'P1', kind: 'period', starts_at: '08:30', ends_at: '09:10' }, { label: 'P2', kind: 'period', starts_at: '09:10', ends_at: '09:50' }, { label: 'Break', kind: 'break', starts_at: '09:50', ends_at: '10:05' }, { label: 'P3', kind: 'period', starts_at: '10:05', ends_at: '10:45' }] }] });
    // Sample Excel files: download the template, parse it back, import it.
    const tpl = await call(D, 'GET', '/setup/templates/wings_classes_sections');
    expect(tpl.status).toBe(200);
    const parsed = await ok(D, 'POST', '/setup/parse', { base64: tpl.binary!.buffer.toString('base64'), file_name: 'structure.xlsx' });
    expect(parsed.rows).toHaveLength(2);
    expect((await ok(D, 'POST', '/setup/import', { kind: 'wings_classes_sections', rows: parsed.rows, dry_run: false })).ok).toBe(true);
    // Row-level errors are reported and nothing is written.
    const bad = await ok(D, 'POST', '/setup/import', { kind: 'staff', rows: [{ 'Employee code': 'T9', 'Full name': 'No Position', Email: 'x@lotus.school' }, { 'Employee code': 'T8', 'Full name': 'Bad email', Email: 'nope', Position: 'Subject Teacher' }], dry_run: false });
    expect(bad.ok).toBe(false);
    expect(bad.errors.map((e: { row: number; column: string }) => [e.row, e.column])).toEqual([[2, 'Position'], [3, 'Email']]);
    expect((await ok(D, 'POST', '/setup/import', { kind: 'subjects', rows: [{ Code: 'MAT', Name: 'Mathematics', Department: 'Mathematics', Language: 'en', Core: 'Y', Class: 'Class 6', 'Periods per week': 7 }], dry_run: false })).ok).toBe(true);
    const staff = await ok(D, 'POST', '/setup/import', { kind: 'staff', rows: [{ 'Employee code': 'P001', 'Full name': 'Anil Principal', Email: 'principal@lotus.school', Position: 'Principal', Department: 'Administration' }, { 'Employee code': 'T001', 'Full name': 'Asha Rao', Email: 'asha@lotus.school', Position: 'Subject Teacher', Department: 'Mathematics', Wing: 'Middle' }], dry_run: false });
    expect(staff).toMatchObject({ ok: true, created: 2 });
    expect((await ok(D, 'POST', '/setup/import', { kind: 'org_chart', rows: [{ 'Employee code': 'T001', 'Reports to': 'P001' }], dry_run: false })).ok).toBe(true);
    const roles = await ok(D, 'GET', '/roles');
    expect(roles.roles.length).toBeGreaterThan(10);
    await ok(D, 'POST', '/setup/step', { step: 8 });
    state = await ok(D, 'GET', '/setup');
    expect(state.org.setup_step).toBe(8);
    // First login of the teacher.
    const me = await ok('asha@lotus.school', 'GET', '/me');
    expect(me.staff.full_name).toBe('Asha Rao');
    expect(me.modules.tasks).toBe(true);
    const day = await ok('asha@lotus.school', 'GET', '/my-day');
    expect(day.date).toBeTruthy();
    // Presets load and reset.
    await ok(D, 'POST', '/config/leave_types', { data: { key: 'study', name: 'Study leave', yearly_quota: 5 } });
    expect((await ok(D, 'GET', '/config/leave_types')).some((l: { key: string }) => l.key === 'study')).toBe(true);
    await ok(D, 'POST', '/config/leave_types/reset');
    expect((await ok(D, 'GET', '/config/leave_types')).some((l: { key: string }) => l.key === 'study')).toBe(false);
    expect((await ok(D, 'GET', '/config/leave_types/history')).length).toBeGreaterThan(0);
  });
});

describe('flow 2: assign -> delegate -> complete with photo proof -> verify -> task report', () => {
  it('works end to end', async () => {
    const coord = await asService((c) => one<{ id: string }>(c, `select s.id from core.staff s join auth.users u on u.id = s.user_id where u.email = $1`, [COORD]));
    const teacher = await asService((c) => one<{ id: string }>(c, `select s.id from core.staff s join auth.users u on u.id = s.user_id where u.email = $1`, [TEACHER]));
    const created = await ok(PRINCIPAL, 'POST', '/tasks', { title: 'Photograph the new science lab setup', assignee_ids: [coord.id], priority: 'high', proof_required: 'photo', verification_required: true, due_at: new Date(Date.now() + 86400000).toISOString() });
    const id = created.id;
    expect((await call(COORD, 'POST', `/tasks/${id}/action`, { action: 'delegate', delegate_to: teacher.id })).status).toBe(200);
    // Proof is required.
    const noProof = await call(TEACHER, 'POST', `/tasks/${id}/action`, { action: 'complete' });
    expect(noProof.status).toBe(422);
    expect(noProof.json.error).toBe('proof_required');
    const up = await ok(TEACHER, 'POST', '/uploads', { purpose: 'task_proof', file_name: 'lab.jpg', mime: 'image/jpeg', size_bytes: 1000 });
    expect(up.path.startsWith(created.id ? '' : 'x')).toBe(true);
    await ok(TEACHER, 'POST', `/tasks/${id}/action`, { action: 'complete', proof_path: up.path, note: 'Done' });
    // The teacher cannot verify their own work; the assigner can.
    expect((await call(TEACHER, 'POST', `/tasks/${id}/action`, { action: 'verify' })).status).toBe(403);
    const v = await ok(PRINCIPAL, 'POST', `/tasks/${id}/action`, { action: 'verify' });
    expect(v.status).toBe('verified');
    const t = await ok(PRINCIPAL, 'GET', `/tasks/${id}`);
    expect(t.events.map((e: { event: string }) => e.event)).toEqual(expect.arrayContaining(['created', 'delegated', 'complete', 'verify']));
    const report = await ok(PRINCIPAL, 'GET', '/reports/task_performance', undefined, { from: addDays(today, -1), to: addDays(today, 1) });
    const row = report.rows.find((r: { name: string }) => r.name === 'Deepa Krishnan');
    expect(row.completed).toBeGreaterThanOrEqual(1);
  });

  it('a peer request needs acceptance and a sudden task is logged in two taps', async () => {
    const peer = await asService((c) => one<{ id: string }>(c, `select s.id from core.staff s join auth.users u on u.id = s.user_id where u.email = $1`, [LANG_TEACHER]));
    const r = await ok(TEACHER, 'POST', '/tasks', { title: 'Lend me the projector remote', assignee_ids: [peer.id] });
    expect(r.requested).toHaveLength(1);
    const t = await ok(LANG_TEACHER, 'GET', `/tasks/${r.id}`);
    expect(t.status).toBe('requested');
    expect((await call(LANG_TEACHER, 'POST', `/tasks/${r.id}/action`, { action: 'start' })).status).toBe(422);
    expect((await ok(LANG_TEACHER, 'POST', `/tasks/${r.id}/action`, { action: 'accept' })).status).toBe('todo');
    const quick = await ok(TEACHER, 'POST', '/tasks/quick', { title: 'Covered a fight in the corridor', time_spent_minutes: 10 });
    const qt = await ok(TEACHER, 'GET', `/tasks/${quick.id}`);
    expect(qt).toMatchObject({ unplanned: true, status: 'done', source: 'sudden' });
  });

  it('escalation fires on schedule and recurring tasks skip holidays', async () => {
    const teacher = await asService((c) => one<{ id: string }>(c, `select s.id from core.staff s join auth.users u on u.id = s.user_id where u.email = $1`, [TEACHER]));
    const due = new Date(Date.now() - 6 * 3600000).toISOString();
    const created = await ok(SCI_HOD, 'POST', '/tasks', { title: 'Overdue escalation test', assignee_ids: [teacher.id], due_at: due });
    const fired = await asService((c) => escalationSweep(c, new Date()));
    expect(fired).toBeGreaterThan(0);
    const ev = await asService((c) => q<{ event: string; data: { level: number } }>(c, `select event, data from os.task_events where task_id = $1 and event = 'escalated'`, [created.id]));
    expect(ev.length).toBe(1);
    const holiday = nextWorkingDay(today, 3);
    await asService(async (c) => {
      const org = await one<{ id: string }>(c, `select id from core.organizations where slug = 'demo'`);
      await c.query(`insert into core.calendar_events (org_id, branch_id, layer, title, starts_on, ends_on, is_working_day) values ($1, null, 'holiday', 'Test holiday', $2, $2, false)`, [org.id, holiday]);
    });
    const rec = await ok(SCI_HOD, 'POST', '/tasks', { title: 'Daily lab log', assignee_ids: [teacher.id], recurrence: { frequency: 'daily', interval_n: 1, weekdays: [], custom_dates: [], due_time: '16:00', starts_on: today } });
    const n = await asService((c) => generateRecurrences(c, holiday, rec.recurrence_id));
    expect(n).toBe(0);
    const n2 = await asService((c) => generateRecurrences(c, nextWorkingDay(holiday), rec.recurrence_id));
    expect(n2).toBe(1);
  });
});

describe('flow 3: leave -> approval -> substitutes assigned -> substitute sees the period and cover plan', () => {
  it('works end to end', async () => {
    const lt = await asService((c) => one<{ id: string }>(c, `select id from core.leave_types where key = 'casual' and org_id = (select id from core.organizations where slug = 'demo')`));
    // A working day on which the teacher has periods.
    let date = nextWorkingDay(today, 2);
    const teacher = await asService((c) => one<{ id: string }>(c, `select s.id from core.staff s join auth.users u on u.id = s.user_id where u.email = $1`, [TEACHER]));
    for (let i = 0; i < 10; i++) {
      const n = await asService((c) => one<{ n: number }>(c, `select count(*)::int as n from core.timetable_entries e join core.timetable_versions v on v.id = e.version_id and v.status = 'published' where e.staff_id = $1 and e.day = $2`, [teacher.id, isoWeekday(date)]));
      const hol = await asService((c) => q(c, `select 1 from core.calendar_events where layer = 'holiday' and $1::date between starts_on and ends_on`, [date]));
      if (n.n > 0 && !hol.length) break;
      date = nextWorkingDay(date);
    }
    const preview = await ok(TEACHER, 'POST', '/leave/preview', { leave_type_id: lt.id, start_date: date, end_date: date, half_day: 'none' });
    expect(preview.days).toBe(1);
    expect(preview.errors).toEqual([]);
    const applied = await ok(TEACHER, 'POST', '/leave', { leave_type_id: lt.id, start_date: date, end_date: date, half_day: 'none', reason: 'Family function', handover_note: 'Worksheets in staff room' });
    // Chain: manager of applicant (Science HOD) then principal.
    const pending = await ok(SCI_HOD, 'GET', '/approvals', undefined, { view: 'pending_me' });
    expect(pending.some((p: { id: string }) => p.id === applied.approval_id)).toBe(true);
    await ok(SCI_HOD, 'POST', `/approvals/${applied.approval_id}/action`, { action: 'approve', comment: 'OK' });
    const done = await ok(PRINCIPAL, 'POST', `/approvals/${applied.approval_id}/action`, { action: 'approve' });
    expect(done.status).toBe('approved');
    const board = await ok(COORD, 'GET', '/substitution', undefined, { date });
    const mine = board.filter((s: { absent_name: string }) => s.absent_name === 'Deepa Krishnan');
    expect(mine.length).toBeGreaterThan(0);
    const first = mine[0];
    expect(first.ranked.length).toBeGreaterThan(0);
    const sub = first.ranked[0].staffId;
    await ok(COORD, 'POST', '/substitution/assign', { substitution_id: first.id, resolution: 'substitute', substitute_staff_id: sub });
    const subEmail = await asService((c) => one<{ email: string }>(c, `select u.email from core.staff s join auth.users u on u.id = s.user_id where s.id = $1`, [sub]));
    const day = await ok(subEmail.email, 'GET', '/my-day', undefined, { date });
    const item = day.items.find((i: { kind: string }) => i.kind === 'substitution');
    expect(item).toBeTruthy();
    expect(item.meta.cover_plan_id).toBeTruthy();
    const cover = await ok(subEmail.email, 'GET', `/lesson-plans/${item.meta.cover_plan_id}`);
    expect(cover.id).toBe(item.meta.cover_plan_id);
    const inbox = await ok(subEmail.email, 'GET', '/inbox');
    expect(inbox.some((n: { event_key: string }) => n.event_key === 'substitution.assigned')).toBe(true);
    // Leave balance reflects the approved day.
    const bal = await ok(TEACHER, 'GET', '/leave/balances');
    expect(bal.find((b: { key: string }) => b.key === 'casual').used).toBe(1);
  });
});

describe('flow 4: lesson plan generate, edit, submit, return, resubmit, approve, deliver, coverage', () => {
  it('works end to end, in the school template, with exact timings', async () => {
    const ids = await asService(async (c) => {
      const sec = await one<{ id: string }>(c, `select se.id from core.sections se join core.programmes cl on cl.id = se.programme_id where cl.name = 'Class 10' and se.name = 'A' and se.org_id = (select id from core.organizations where slug = 'demo')`);
      const subj = await one<{ id: string }>(c, `select id from core.subjects where code = 'SCI' and branch_id = (select id from core.branches where code = 'GACH' and org_id = (select id from core.organizations where slug = 'demo'))`);
      const topic = await one<{ id: string }>(c, `select t.id from os.curriculum_topics t join os.curriculum_units u on u.id = t.unit_id join os.curriculum_subjects cs on cs.id = u.subject_id join os.curriculum_boards b on b.id = cs.board_id where b.org_id is null and b.key = 'CBSE' and cs.grade_level = 10 and cs.name = 'Science' and t.kind = 'topic' order by u.seq, t.seq limit 1`);
      return { sec: sec.id, subj: subj.id, topic: topic.id };
    });
    const quote = await ok(TEACHER, 'GET', '/lesson-plans/quote', undefined, { action: 'daily_plan' });
    expect(quote.credits).toBe(1);
    const date = nextWorkingDay(today, 1);
    const gen = await ok(TEACHER, 'POST', '/lesson-plans/generate', { section_ids: [ids.sec], subject_id: ids.subj, topic_id: ids.topic, plan_date: date, period_count: 1, period_minutes: 40, teaching_model: '5E', resources: ['smart_board'], class_profile: { ability_mix: 'mixed', medium: 'English' } });
    let p = await ok(TEACHER, 'GET', `/lesson-plans/${gen.id}`);
    expect(p.content.flow.reduce((s: number, f: { minutes: number }) => s + f.minutes, 0)).toBe(40);
    expect(p.content.objectives.every((o: { outcome_codes: string[] }) => o.outcome_codes.length > 0)).toBe(true);
    expect(p.status).toBe('draft');
    // Cannot submit before the teacher confirms.
    expect((await call(TEACHER, 'POST', `/lesson-plans/${gen.id}/workflow`, { action: 'submit' })).json.error).toBe('confirm_before_submit');
    await ok(TEACHER, 'PATCH', `/lesson-plans/${gen.id}`, { content: { board_work: 'Edited by teacher' } });
    await ok(TEACHER, 'POST', `/lesson-plans/${gen.id}/section`, { section: 'flow', action: 'shorten', minutes: 35 });
    await ok(TEACHER, 'POST', `/lesson-plans/${gen.id}/section`, { section: 'flow', action: 'more_hands_on' });
    p = await ok(TEACHER, 'GET', `/lesson-plans/${gen.id}`);
    expect(p.content.flow.reduce((s: number, f: { minutes: number }) => s + f.minutes, 0)).toBe(40);
    await ok(TEACHER, 'POST', `/lesson-plans/${gen.id}/workflow`, { action: 'confirm' });
    await ok(TEACHER, 'POST', `/lesson-plans/${gen.id}/workflow`, { action: 'submit' });
    expect([403, 404]).toContain((await call(LANG_TEACHER, 'POST', `/lesson-plans/${gen.id}/workflow`, { action: 'approve' })).status);
    expect((await ok(SCI_HOD, 'POST', `/lesson-plans/${gen.id}/workflow`, { action: 'return', comment: 'Add safety note', section_comments: [{ section: 'materials', comment: 'Goggles' }] })).status).toBe('returned');
    await ok(TEACHER, 'PATCH', `/lesson-plans/${gen.id}`, { content: { materials: ['Goggles', 'Beakers'] } });
    await ok(TEACHER, 'POST', `/lesson-plans/${gen.id}/workflow`, { action: 'confirm' });
    await ok(TEACHER, 'POST', `/lesson-plans/${gen.id}/workflow`, { action: 'submit' });
    expect((await ok(SCI_HOD, 'POST', `/lesson-plans/${gen.id}/workflow`, { action: 'approve' })).status).toBe('in_review');
    expect((await ok(COORD, 'POST', `/lesson-plans/${gen.id}/workflow`, { action: 'approve' })).status).toBe('approved');
    const before = await ok(PRINCIPAL, 'GET', '/coverage', undefined, { subject_id: ids.subj });
    const covBefore = before.find((r: { section_id: string }) => r.section_id === ids.sec)?.actual ?? 0;
    await ok(TEACHER, 'POST', `/lesson-plans/${gen.id}/workflow`, { action: 'deliver' });
    const after = await ok(PRINCIPAL, 'GET', '/coverage', undefined, { subject_id: ids.subj });
    expect(after.find((r: { section_id: string }) => r.section_id === ids.sec).actual).toBe(covBefore + 1);
    // Approved plans are in the bank; DOCX export works.
    const bank = await ok(LANG_TEACHER, 'GET', '/lesson-plans', undefined, { view: 'bank' });
    expect(bank.some((b: { id: string }) => b.id === gen.id)).toBe(true);
    const docx = await call(TEACHER, 'GET', `/lesson-plans/${gen.id}/docx`);
    expect(docx.binary!.buffer.subarray(0, 2).toString()).toBe('PK');
  });

  it('a Hindi subject plan is generated in Hindi and a Cambridge plan has Cambridge elements', async () => {
    const ids = await asService(async (c) => {
      const sec = await one<{ id: string }>(c, `select se.id from core.sections se join core.programmes cl on cl.id = se.programme_id where cl.name = 'Class 8' and se.name = 'A' and se.org_id = (select id from core.organizations where slug = 'demo')`);
      const subj = await one<{ id: string }>(c, `select id from core.subjects where code = 'HIN' and branch_id = (select id from core.branches where code = 'GACH' and org_id = (select id from core.organizations where slug = 'demo'))`);
      const topic = await one<{ id: string }>(c, `select t.id from os.curriculum_topics t join os.curriculum_units u on u.id = t.unit_id join os.curriculum_subjects cs on cs.id = u.subject_id join os.curriculum_boards b on b.id = cs.board_id where b.org_id is null and cs.content_language = 'hi' and t.kind = 'topic' order by u.seq, t.seq limit 1`);
      return { sec: sec.id, subj: subj.id, topic: topic.id };
    });
    const gen = await ok(LANG_HOD, 'POST', '/lesson-plans/generate', { section_ids: [ids.sec], subject_id: ids.subj, topic_id: ids.topic, plan_date: nextWorkingDay(today), period_count: 1, period_minutes: 40, teaching_model: 'direct', resources: [], class_profile: { ability_mix: 'mixed', medium: 'Hindi' } });
    const p = await ok(LANG_HOD, 'GET', `/lesson-plans/${gen.id}`);
    expect(p.language).toBe('hi');
    expect(/[ऀ-ॿ]/.test(p.content.flow[0].teacher_activity)).toBe(true);
  });
});

describe('flow 5: student attendance offline -> sync -> daily summary', () => {
  it('works end to end', async () => {
    const sections = await ok(TEACHER, 'GET', '/student-attendance/sections');
    const sec = sections[0];
    const roster = await ok(TEACHER, 'GET', '/student-attendance/roster', undefined, { section_id: sec.id, date: today, session_key: 'day' });
    const marks = roster.students.map((s: { id: string }, i: number) => ({ student_id: s.id, status: i < 2 ? 'absent' : 'present' }));
    const outbox = [{ client_id: 'offline-att-0001', method: 'POST', path: '/api/os/student-attendance', body: { section_id: sec.id, date: today, session_key: 'day', marks, client_id: 'offline-att-0001' }, created_at: new Date().toISOString() }];
    const res = await ok(TEACHER, 'POST', '/sync', { items: outbox });
    expect(res.results[0].status).toBe(200);
    // Replaying the same outbox item is idempotent.
    const again = await ok(TEACHER, 'POST', '/sync', { items: outbox });
    expect(again.results[0].result.status).toBe('duplicate');
    const summary = await ok(PRINCIPAL, 'GET', '/student-attendance/summary', undefined, { date: today });
    const s = summary.sections.find((x: { section_id: string }) => x.section_id === sec.id);
    expect(s.marked).toBe(true);
    expect(s.summary.absent).toBe(2);
    expect(summary.absentees.filter((a: { section: string }) => a.section === s.section)).toHaveLength(2);
  });

  it('unmarked attendance creates a reminder task after the cut-off', async () => {
    const b = await asService((c) => one<{ id: string }>(c, `select id from core.branches where code = 'GACH' and org_id = (select id from core.organizations where slug = 'demo')`));
    let d = today;
    while (isoWeekday(d) === 7) d = addDays(d, 1);
    const at = new Date(`${d}T11:00:00+05:30`);
    const n = await asService((c) => unmarkedSweep(c, b.id, at));
    expect(n).toBeGreaterThan(0);
    const t = await asService((c) => q(c, `select id from os.tasks where system_key like $1`, [`att:%:${d}`]));
    expect(t.length).toBeGreaterThan(0);
  });
});

describe('flow 6: blueprint -> generate paper -> review -> approve -> restricted access', () => {
  it('works end to end', async () => {
    const bp = await asService((c) => one<{ id: string }>(c, `select id from os.paper_blueprints where name like 'Class 10 Science%' and org_id = (select id from core.organizations where slug = 'demo')`));
    const hod = await asService((c) => one<{ id: string }>(c, `select s.id from core.staff s join auth.users u on u.id = s.user_id where u.email = $1`, [SCI_HOD]));
    const coord = await asService((c) => one<{ id: string }>(c, `select s.id from core.staff s join auth.users u on u.id = s.user_id where u.email = $1`, [COORD]));
    const examDate = addDays(today, 60);
    const gen = await ok(TEACHER, 'POST', '/exams/papers/generate', { blueprint_id: bp.id, exam_date: examDate, sets: 2, source: 'mixed', reviewer_ids: [hod.id, coord.id] });
    expect(gen.paper_ids).toHaveLength(2);
    const paper = await ok(TEACHER, 'GET', `/exams/papers/${gen.paper_ids[0]}`);
    expect(paper.questions.reduce((s: number, x: { marks: number }) => s + x.marks, 0)).toBe(40);
    // Sets differ (bank questions are not reused across sets).
    const p2 = await ok(TEACHER, 'GET', `/exams/papers/${gen.paper_ids[1]}`);
    expect(p2.questions.map((x: { text: string }) => x.text)).not.toEqual(paper.questions.map((x: { text: string }) => x.text));
    await ok(TEACHER, 'POST', `/exams/papers/${paper.id}/review`, { action: 'submit' });
    expect((await ok(SCI_HOD, 'POST', `/exams/papers/${paper.id}/review`, { action: 'approve' })).status).toBe('coordinator_review');
    expect((await ok(COORD, 'POST', `/exams/papers/${paper.id}/review`, { action: 'approve' })).status).toBe('approved');
    // A non-reviewer cannot open the paper before the exam date, not even the principal.
    expect((await call(LANG_TEACHER, 'GET', `/exams/papers/${paper.id}`)).status).toBe(404);
    expect((await call(PRINCIPAL, 'GET', `/exams/papers/${paper.id}`)).status).toBe(404);
    const dl = await call(SCI_HOD, 'GET', `/exams/papers/${paper.id}/docx`, undefined, { scheme: '1' });
    expect(dl.status).toBe(200);
    const log = await asService((c) => q<{ action: string; watermark: string | null }>(c, `select action, watermark from os.paper_access_log where paper_id = $1`, [paper.id]));
    expect(log.some((l) => l.action === 'download' && l.watermark?.includes('Priya Menon'))).toBe(true);
    expect(log.filter((l) => l.action === 'view').length).toBeGreaterThanOrEqual(1);
  });
});

describe('flow 7: checklist failure -> ticket -> resolve -> close', () => {
  it('works end to end', async () => {
    const runs = await ok(HOUSEKEEPING, 'GET', '/checklists/runs', undefined, { date: today });
    const run = runs.find((r: { name: string; status: string }) => r.name === 'Morning opening' && r.status === 'pending');
    expect(run).toBeTruthy();
    const detail = await ok(HOUSEKEEPING, 'GET', `/checklists/runs/${run.id}`);
    const answers = detail.items.map((i: { id: string; label: string }) => ({ item_id: i.id, value: i.label.startsWith('Power') ? 'no' : 'yes' }));
    const res = await ok(HOUSEKEEPING, 'POST', `/checklists/runs/${run.id}`, { answers, complete: true });
    const ticketId = res.follow_ups.find((f: { type: string }) => f.type === 'ticket').id;
    const ticket = await ok(ADMIN, 'GET', `/tickets/${ticketId}`);
    expect(ticket.category).toBe('Electrical');
    expect(ticket.owner_name).toBe('Manoj Pillai'); // electrical -> housekeeping supervisor
    await ok(HOUSEKEEPING, 'POST', `/tickets/${ticketId}/action`, { action: 'start' });
    await ok(HOUSEKEEPING, 'POST', `/tickets/${ticketId}/action`, { action: 'resolve', note: 'Replaced MCB' });
    expect((await ok(HOUSEKEEPING, 'POST', `/tickets/${ticketId}/action`, { action: 'close' })).status).toBe('closed'); // raiser closes
  });
});

describe('flow 8: credits exhausted -> blocked -> top-up -> unblocked', () => {
  it('works end to end, ledger total equals the sum of generations', async () => {
    const branch = await asService((c) => one<{ id: string; org_id: string }>(c, `select id, org_id from core.branches where code = 'KOND' and org_id = (select id from core.organizations where slug = 'demo')`));
    const KTEACH = 'nandini.principal.kond24@demo.school';
    const email = await asService((c) => one<{ email: string }>(c, `select u.email from core.staff s join auth.users u on u.id = s.user_id where s.branch_id = $1 and s.is_teaching order by s.full_name limit 1`, [branch.id]));
    void KTEACH;
    const ids = await asService(async (c) => {
      const alloc = await one<{ section_id: string; subject_id: string }>(c, `select ta.section_id, ta.subject_id from core.teacher_allocations ta join core.staff s on s.id = ta.staff_id join auth.users u on u.id = s.user_id join core.subjects sb on sb.id = ta.subject_id where u.email = $1 limit 1`, [email.email]);
      const topic = await one<{ id: string }>(c, `select t.id from os.curriculum_topics t join os.curriculum_units u on u.id = t.unit_id join os.curriculum_subjects cs on cs.id = u.subject_id join os.curriculum_boards b on b.id = cs.board_id where b.org_id is null and b.key = 'CAMBRIDGE' and t.kind = 'topic' limit 1`);
      // Use up the branch's credits.
      const period = new Date().toISOString().slice(0, 7);
      const bal = await one<{ b: number }>(c, `select coalesce(sum(credits), 0) as b from public.ai_credit_ledger where branch_id = $1 and period = $2`, [branch.id, period]);
      await c.query(`insert into public.ai_credit_ledger (org_id, branch_id, kind, period, credits, note) values ($1,$2,'adjustment',$3,$4,'test: use up')`, [branch.org_id, branch.id, period, -Number(bal.b)]);
      return { ...alloc, topic: topic.id };
    });
    const body = { section_ids: [ids.section_id], subject_id: ids.subject_id, topic_id: ids.topic, plan_date: nextWorkingDay(today), period_count: 1, period_minutes: 45, teaching_model: '5E', resources: [], class_profile: { ability_mix: 'mixed', medium: 'English' } };
    const blocked = await call(email.email, 'POST', '/lesson-plans/generate', body);
    expect(blocked.status).toBe(402);
    expect(blocked.json.error).toBe('credits_exhausted');
    await ok('admin@autoed.dev', 'POST', '/admin/topup', { branch_id: branch.id, credits: 50, note: 'test top-up' });
    const gen = await ok(email.email, 'POST', '/lesson-plans/generate', body);
    expect(gen.credits).toBe(1);
    const p = await ok(email.email, 'GET', `/lesson-plans/${gen.id}`);
    expect(p.content.board_elements.assessment_objectives.length).toBeGreaterThan(0); // Cambridge elements
    const totals = await asService((c) =>
      one<{ ledger: number; gens: number }>(c, `select (select coalesce(-sum(credits), 0) from public.ai_credit_ledger where kind = 'usage') as ledger, (select coalesce(sum(credits), 0) from core.ai_generations where status = 'ok') as gens`),
    );
    expect(Number(totals.ledger)).toBeCloseTo(Number(totals.gens), 5);
  });
});

describe('phase acceptance checks (API level)', () => {
  it('check-in is refused outside the boundary and accepted inside', async () => {
    const out = await call(TEACHER, 'POST', '/attendance/check', { kind: 'in', lat: 17.5, lng: 78.6 });
    expect(out.status).toBe(422);
    expect(out.json.error).toBe('outside_boundary');
    await asService((c) => c.query(`delete from core.staff_attendance where staff_id = (select s.id from core.staff s join auth.users u on u.id = s.user_id where u.email = $1) and date = $2`, [TEACHER, today]));
    const inside = await ok(TEACHER, 'POST', '/attendance/check', { kind: 'in', lat: 17.4402, lng: 78.349 });
    expect(['present', 'late', 'half_day']).toContain(inside.status);
  });

  it('biometric file import merges and lists conflicts', async () => {
    const res = await ok(ADMIN, 'POST', '/attendance/import', { device_type: 'eSSL', mapping: { employeeCode: 'Emp', date: 'Date', checkIn: 'In', checkOut: 'Out', dateFormat: 'DD/MM/YYYY' }, rows: [{ Emp: 'E010', Date: today.split('-').reverse().join('/'), In: '06:00', Out: '15:45' }, { Emp: 'NOPE', Date: '01/01/2026', In: '08:00', Out: '' }], save_mapping: true });
    expect(res.merged).toBe(1);
    expect(res.conflicts.length).toBe(1);
    expect(res.errors.some((e: { error: string }) => e.error === 'unknown_employee_code')).toBe(true);
  });

  it('timetable generates for the seed school with zero clashes', async () => {
    const g = await ok('vp@demo.school', 'POST', '/timetable/generate', { name: 'Regenerated' });
    const { runDueJobs } = await import('../src/jobs');
    await import('../src/scheduler');
    await runDueJobs(10);
    const v = (await ok('vp@demo.school', 'GET', '/timetable/versions')).find((x: { id: string }) => x.id === g.version_id);
    expect(v.status).toBe('generated');
    expect(v.unplaced).toEqual([]);
    const pub = await call(PRINCIPAL, 'POST', `/timetable/versions/${g.version_id}/publish`, { effective_from: addDays(today, 30) });
    expect(pub.status).toBe(200);
  });

  it('a disabled module is blocked at the API and hidden from /me', async () => {
    await ok(PRINCIPAL, 'POST', '/modules', { branch_id: (await ok(PRINCIPAL, 'GET', '/me')).branch_id, module_key: 'incidents', enabled: false });
    const r = await call(PRINCIPAL, 'GET', '/incidents');
    expect(r.status).toBe(403);
    expect(r.json.error).toBe('module_disabled');
    expect((await ok(PRINCIPAL, 'GET', '/me')).modules.incidents).toBe(false);
    await ok(PRINCIPAL, 'POST', '/modules', { branch_id: (await ok(PRINCIPAL, 'GET', '/me')).branch_id, module_key: 'incidents', enabled: true });
  });

  it('every dashboard number matches its drill-down list', async () => {
    for (const who of [PRINCIPAL, COORD, SCI_HOD, ADMIN, TEACHER]) {
      const d = await ok(who, 'GET', '/dashboard');
      for (const s of d.sections) {
        for (const m of s.metrics) {
          const list = await ok(who, 'GET', `/dashboard/drill/${m.key}`);
          expect(list.rows.length, `${who} ${m.key}`).toBe(m.value);
        }
      }
    }
  });

  it('a teacher asking a question cannot get another department\'s data', async () => {
    const hodAns = await ok(SCI_HOD, 'POST', '/reports/ask', { question: 'Which teachers have the most overdue tasks this month?' });
    const teacherAns = await ok(LANG_TEACHER, 'POST', '/reports/ask', { question: 'Which teachers have the most overdue tasks this month?' });
    expect(teacherAns.answered).toBe(true);
    expect(teacherAns.rows.every((r: { person: string }) => r.person === 'Sneha Kulkarni')).toBe(true);
    expect(hodAns.rows.some((r: { person: string }) => r.person === 'Sneha Kulkarni')).toBe(false);
  });

  it('exports open as Excel files', async () => {
    const x = await call(PRINCIPAL, 'GET', '/reports/staff_attendance/xlsx', undefined, { from: addDays(today, -7), to: today });
    expect(x.status).toBe(200);
    expect(x.binary!.buffer.subarray(0, 2).toString()).toBe('PK');
  });

  it('a group chairman sees the branch comparison', async () => {
    const d = await ok('chairman@demo.school', 'GET', '/dashboard');
    const g = d.sections.find((s: { key: string }) => s.key === 'group');
    expect(g.extra.comparison).toHaveLength(2);
  });

  it('the help bot answers common jobs in each language and refuses out-of-scope questions', async () => {
    const en = await ok(TEACHER, 'POST', '/bot/ask', { message: 'How do I apply for leave?' });
    expect(en.message.answerable).toBe(true);
    expect(en.message.link).toBeTruthy();
    const off = await ok(TEACHER, 'POST', '/bot/ask', { message: 'What is the weather in Delhi tomorrow?' });
    expect(off.message.answerable).toBe(false);
    await ok(TEACHER, 'PATCH', '/me', { language: 'hi' });
    tokens[TEACHER] = '';
    delete tokens[TEACHER];
    const hi = await ok(TEACHER, 'POST', '/bot/ask', { message: 'छुट्टी के लिए आवेदन कैसे करें?' });
    expect(hi.message.answerable).toBe(true);
    expect(/[ऀ-ॿ]/.test(hi.message.content)).toBe(true);
    await ok(TEACHER, 'PATCH', '/me', { language: 'te' });
    const te = await ok(TEACHER, 'POST', '/bot/ask', { message: 'సెలవు కోసం ఎలా దరఖాస్తు చేయాలి?' });
    expect(te.message.answerable).toBe(true);
    expect(/[ఀ-౿]/.test(te.message.content)).toBe(true);
    await ok(TEACHER, 'PATCH', '/me', { language: 'en' });
  });

  it('the bot answers every common job correctly in English, Hindi and Telugu', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const failures: string[] = [];
    let asked = 0;
    // The help bot's per-user daily fair-use cap would stop this many questions; lift it for the test.
    await asService((c) => c.query(`update public.ai_action_costs set daily_fair_use = null where action = 'help_bot'`));
    for (const lang of ['en', 'hi', 'te'] as const) {
      await ok(PRINCIPAL, 'PATCH', '/me', { language: lang });
      for (const f of readdirSync(join(__dirname, '..', '..', '..', 'kb', lang))) {
        const text = readFileSync(join(__dirname, '..', '..', '..', 'kb', lang, f), 'utf8');
        const title = text.match(/title: "(.*)"/)![1]!;
        const screen = text.match(/screen: (.*)/)![1]!.trim();
        const r = await ok(PRINCIPAL, 'POST', '/bot/ask', { message: title });
        asked++;
        if (!r.message.answerable || r.message.link !== screen) failures.push(`${lang}:${f} -> ${r.message.link}`);
      }
    }
    await ok(PRINCIPAL, 'PATCH', '/me', { language: 'en' });
    expect(asked).toBeGreaterThanOrEqual(90);
    expect(failures).toEqual([]);
  });
});
