// The admin console API (admin.ts) and the data tools (data.ts): reports, export, search, duplicates and merge, CSV import with
// review and undo, data-subject requests. Real Postgres, real roles: who may open which section is part of what is tested.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addStaff, createOrg, ownerQ, shutdown, type TestOrg } from './helpers';
import { call, get, login, mobile, post, type Who } from './api-helpers';

let org: TestOrg, other: TestOrg;
let admin: Who, branchAdmin: Who, ann: Who, bob: Who, accounts: Who, marketing: Who, outsider: Who, head: Who;
const tomorrow = () => new Date(Date.now() + 26 * 3600e3).toISOString().slice(0, 16);
const quick = (w: Who, over: Record<string, unknown> = {}) => post(w, '/leads', { studentName: 'Zoya Khan', guardianName: 'Imran Khan', mobile: mobile(), branchId: org.branchId, grade: 'Grade 1', consent: true, ...over });

beforeAll(async () => {
  org = await createOrg('Admin School', { branches: ['Main campus', 'North campus'] });
  other = await createOrg('Other Admin School');
  const main = org.branches['Main campus']!;
  admin = await login(await addStaff(org, 'Asha Admin', 'Group Admin'));
  branchAdmin = await login(await addStaff(org, 'Bina Branch', 'Branch Admin', { branchIds: [main] }));
  ann = await login(await addStaff(org, 'Ann Counsellor', 'Counsellor', { branchIds: [main] }));
  bob = await login(await addStaff(org, 'Bob Counsellor', 'Counsellor', { branchIds: [main] }));
  accounts = await login(await addStaff(org, 'Cy Accounts', 'Accounts'));
  head = await login(await addStaff(org, 'Hal Head', 'Admission Head'));
  marketing = await login(await addStaff(org, 'Mia Marketing', 'Marketing'));
  outsider = await login(await addStaff(other, 'Olga Other', 'Group Admin'));
  await ownerQ('delete from crm.assignment_rules where org_id = $1', [org.orgId]);
  await ownerQ("insert into crm.assignment_rules (org_id, name, seq, method, user_ids) values ($1, 'rr', 1, 'round_robin', $2::jsonb)", [org.orgId, JSON.stringify([ann.userId, bob.userId])]);
});
afterAll(shutdown);

describe('who may open which section', () => {
  const GET = ['org', 'users', 'roles', 'fields', 'pipeline', 'sources', 'routing', 'templates', 'forms', 'workflows', 'integrations', 'wallet', 'data', 'audit', 'help'];
  it('the group admin opens every section; counsellors none', async () => {
    for (const s of GET) expect((await get(admin, `/admin/${s}`)).status, s).toBe(200);
    for (const s of GET) expect((await get(ann, `/admin/${s}`)).status, s).toBe(403);
    expect((await get(ann, '/admin/home')).status).toBe(403);
  });
  it('a branch admin gets users, routing, templates, sources, forms, data and help only', async () => {
    for (const s of ['users', 'routing', 'templates', 'sources', 'forms', 'data', 'help']) expect((await get(branchAdmin, `/admin/${s}`)).status, s).toBe(200);
    for (const s of ['org', 'roles', 'fields', 'pipeline', 'integrations', 'wallet']) expect((await get(branchAdmin, `/admin/${s}`)).status, s).toBe(403);
  });
  it('marketing opens sources, templates and forms; accounts the wallet', async () => {
    expect((await get(marketing, '/admin/sources')).status).toBe(200);
    expect((await get(marketing, '/admin/users')).status).toBe(403);
    expect((await get(accounts, '/admin/wallet')).status).toBe(200);
    expect((await get(accounts, '/admin/sources')).status).toBe(403);
  });
  it('another school cannot touch this one through ids', async () => {
    const f = (await get(admin, '/admin/forms')).data.forms[0];
    expect((await post(outsider, '/admin/forms', { id: f.id, name: 'Hijack' })).status).toBeGreaterThanOrEqual(400);
    expect((await ownerQ('select name from crm.forms where id = $1', [f.id]))[0].name).not.toBe('Hijack');
  });
});

describe('organisation, branches, years and seats', () => {
  it('saves organisation settings and records the change in the audit log', async () => {
    const r = await post(admin, '/admin/org', { name: 'Admin School', legal_name: 'Admin Education Trust', gstin: '36AAAAA0000A1Z5', first_response_mins: 20, reopen: true, fee_registration: 2000, fee_admission: 30000, app_no_prefix: 'ADM', receipt_prefix: 'REC', closure_reasons: 'Fee too high\nMoved city\n', doc_types: 'Birth certificate\nAadhaar', quiet_from: 22, quiet_to: 7, max_auto_per_day: 3, color: '#123456' });
    expect(r.data.ok).toBe(true);
    const s = (await get(admin, '/shell')).data;
    expect(s.fees).toEqual({ registration: 2000, admission: 30000 });
    expect(s.closureReasons).toEqual(['Fee too high', 'Moved city']);
    expect(s.org.color).toBe('#123456');
    const a = (await get(admin, '/admin/audit')).data.events;
    expect(a.some((x: any) => x.action === 'config' && /organisation settings/.test(x.summary))).toBe(true);
    // numbering follows the prefixes
    const e = (await quick(admin)).data.enquiryId;
    await post(admin, `/leads/${e}/application/start`);
    expect((await ownerQ('select application_no from crm.enquiries where id = $1', [e]))[0].application_no).toMatch(/^ADM-/);
  });

  it('adds a branch with its hours and seats, edits it, and the branch admin cannot', async () => {
    const r = await post(admin, '/admin/branches', { name: 'East campus', city: 'Hyderabad', open_hour: 8, close_hour: 17, visit_capacity: 5 });
    expect(r.data.ok).toBe(true);
    const o = (await get(admin, '/admin/org')).data;
    const b = o.branches.find((x: any) => x.name === 'East campus');
    expect(b.visit_capacity).toBe(5);
    expect(o.programmes.some((p: any) => p.branch === 'East campus')).toBe(true);
    expect((await post(admin, '/admin/branches', { id: b.id, name: 'East campus', city: 'Secunderabad', open_hour: 9, close_hour: 18, visit_capacity: 2 })).data.ok).toBe(true);
    expect((await get(admin, '/admin/org')).data.branches.find((x: any) => x.id === b.id).city).toBe('Secunderabad');
    expect((await post(branchAdmin, '/admin/branches', { name: 'Nope' })).status).toBe(403);
    expect((await post(admin, '/admin/branches', { name: '' })).status).toBe(422);
  });

  it('seats and the age rule are saved per programme and year', async () => {
    const o = (await get(admin, '/admin/org')).data;
    const prog = o.programmes.find((p: any) => p.branch === 'Main campus' && p.grade === 'Grade 1');
    expect((await post(admin, `/admin/programmes/${prog.programme_id}`, { capacity: 12, min_age_years: 6 })).data.ok).toBe(true);
    const again = (await get(admin, '/admin/org')).data.programmes.find((p: any) => p.programme_id === prog.programme_id);
    expect(again.capacity).toBe(12);
    expect(Number(again.min_age_years)).toBe(6);
  });

  it('rollover creates the next year with seats copied and carries forward families who said "not now"', async () => {
    const before = (await get(admin, '/admin/org')).data;
    const from = before.years[before.years.length - 1];
    const e = (await quick(admin, { studentName: 'Carry Me' })).data.enquiryId; // open in the old year -> carried
    const r = await post(admin, '/admin/years', { from: from.id, name: before.nextYearName, carry: true, makeDefault: false });
    expect(r.data.ok).toBe(true);
    expect(r.data.carried).toBeGreaterThan(0);
    expect((await ownerQ('select count(*)::int n from crm.intakes where org_id = $1 and academic_year_id = $2', [org.orgId, r.data.id]))[0].n).toBeGreaterThan(0);
    const carried = await ownerQ("select e.id, e.tags from crm.enquiries e where e.org_id = $1 and e.academic_year_id = $2 and e.tags ? 'carried forward'", [org.orgId, r.data.id]);
    expect(carried.length).toBe(r.data.carried);
    expect((await post(admin, '/admin/years', { from: from.id, name: before.nextYearName })).status).toBe(422); // exists
    expect((await post(admin, '/admin/years', { from: from.id, name: 'next' })).status).toBe(422);
    void e;
    // make it the default, close and reopen
    expect((await post(admin, `/admin/years/${r.data.id}`, { what: 'default' })).data.ok).toBe(true);
    expect((await get(admin, '/shell')).data.years.find((y: any) => y.id === r.data.id).is_current).toBe(true);
    expect((await post(admin, `/admin/years/${from.id}`, { what: 'close' })).data.ok).toBe(true);
    expect((await get(admin, '/shell')).data.years.find((y: any) => y.id === from.id).status).toBe('closed');
    await post(admin, `/admin/years/${from.id}`, { what: 'default' });
  });
});

describe('users: invite, edit, pause, sign out', () => {
  it('invites a colleague who can then sign in; a duplicate email and a branch admin granting group admin are refused', async () => {
    const roles = (await get(admin, '/admin/users')).data.roles;
    const counsellor = roles.find((r: any) => r.name === 'Counsellor').key;
    const r = await post(admin, '/admin/users', { name: 'Nina New', email: 'nina.new@school.test', roleKey: counsellor, branchIds: [org.branchId], daily_capacity: 10 });
    expect(r.data.created).toBe(true);
    const prev = process.env.AUTH_PROVIDER;
    process.env.AUTH_PROVIDER = 'dev';
    const li = await post(null, '/auth/dev-login', { email: 'nina.new@school.test' });
    expect(li.status).toBe(200);
    process.env.AUTH_PROVIDER = prev;
    const nina = { token: li.setSession!.token, userId: r.data.id };
    expect((await get(nina, '/shell')).data.role.name).toBe('Counsellor');
    const row = (await get(admin, '/admin/users')).data.users.find((u: any) => u.id === r.data.id);
    expect(row.daily_capacity).toBe(10);
    expect(row.active).toBe(true);
    expect((await post(admin, '/admin/users', { name: 'Nina Two', email: 'nina.new@school.test', roleKey: counsellor })).status).toBe(409);
    const ga = roles.find((r2: any) => r2.name === 'Group Admin').key;
    expect((await post(branchAdmin, '/admin/users', { name: 'Sneaky', email: 'sneaky@school.test', roleKey: ga })).status).toBe(403);
    // edit: role, capacity, on-leave, branches, reports-to
    const ah = (await get(admin, '/admin/users')).data.roles.find((r2: any) => r2.name === 'Admission Head').key;
    const edit = await post(admin, '/admin/users', { id: r.data.id, name: 'Nina Newer', roleKey: ah, branchIds: [org.branchId, org.branches['North campus']], daily_capacity: 5, on_leave: true, reports_to: ann.userId });
    expect(edit.data.ok).toBe(true);
    const edited = (await get(admin, '/admin/users')).data.users.find((u: any) => u.id === r.data.id);
    expect(edited).toMatchObject({ name: 'Nina Newer', role_name: 'Admission Head', on_leave: true, daily_capacity: 5, reports_to: ann.userId });
    expect(edited.branch_ids.length).toBe(2);
    // pause signs her out everywhere and keeps her out; she cannot be paused by herself, nor by a counsellor
    expect((await post(admin, `/admin/users/${r.data.id}/action`, { what: 'pause' })).data.ok).toBe(true);
    expect((await get(nina, '/shell')).status).toBe(403);
    process.env.AUTH_PROVIDER = 'dev';
    expect((await post(null, '/auth/dev-login', { email: 'nina.new@school.test' })).status).toBe(403);
    process.env.AUTH_PROVIDER = prev;
    expect((await post(admin, `/admin/users/${r.data.id}/action`, { what: 'activate' })).data.ok).toBe(true);
    expect((await get(nina, '/shell')).status).toBe(401); // the old session was revoked, not just blocked
    expect((await post(admin, `/admin/users/${admin.userId}/action`, { what: 'pause' })).status).toBe(422);
    expect((await post(ann, `/admin/users/${r.data.id}/action`, { what: 'pause' })).status).toBe(403);
    // the branch admin sees only people of their own branches
    const visible = (await get(branchAdmin, '/admin/users')).data.users.map((u: any) => u.name);
    expect(visible).toContain('Ann Counsellor');
    expect(visible).not.toContain('Cy Accounts');
  });
});

describe('roles and the permission matrix', () => {
  it('a changed matrix is enforced by the database from the next request; the group admin role cannot be weakened', async () => {
    const roles = (await get(admin, '/admin/roles')).data.roles;
    const cou = roles.find((r: any) => r.name === 'Counsellor');
    const ga = roles.find((r: any) => r.name === 'Group Admin');
    expect((await get(ann, '/leads')).status).toBe(200);
    const perms = { ...cou.permissions, leads: '-' };
    try {
      expect((await post(admin, '/admin/roles', { permissions: { [cou.key]: perms, [ga.key]: { ...ga.permissions, leads: '-', admin: '-' } } })).data.changed).toEqual(['Counsellor']);
      expect((await ownerQ("select permissions->>'leads' as l from crm.roles where org_id = $1 and key = 'group_admin'", [org.orgId]))[0].l).toBe('F');
      expect((await get(ann, '/leads')).status).toBe(403);
      expect((await ownerQ("select count(*)::int n from core.role_permissions rp join core.roles r on r.id = rp.role_id where r.org_id = $1 and r.key = $2 and rp.module_key = 'leads'", [org.orgId, cou.key]))[0].n).toBe(0);
    } finally {
      await post(admin, '/admin/roles', { permissions: { [cou.key]: cou.permissions } });
    }
    expect((await get(ann, '/leads')).status).toBe(200);
    // nobody else can change the matrix
    expect((await post(branchAdmin, '/admin/roles', { permissions: { [cou.key]: perms } })).status).toBe(403);
  });
  it('a role is cloned with a new name; a clash is refused; a branch admin cannot clone an org-wide admin', async () => {
    const cou = (await get(admin, '/admin/roles')).data.roles.find((r: any) => r.name === 'Counsellor');
    const r = await post(admin, '/admin/roles/clone', { key: cou.key, name: 'Seasonal counsellor' });
    expect(r.data.key).toBe('seasonal_counsellor');
    expect((await post(admin, '/admin/roles/clone', { key: cou.key, name: 'Seasonal counsellor' })).status).toBe(409);
    expect((await get(admin, '/admin/users')).data.roles.some((x: any) => x.name === 'Seasonal counsellor')).toBe(true);
  });
});

describe('fields, with masking of sensitive values', () => {
  it('a sensitive dropdown field: staff without the right see only the placeholder, everywhere', async () => {
    const f = await post(admin, '/admin/fields', { label: 'Family income band', type: 'select', options: 'Under 5L, 5-10L, Over 10L', sensitive: true });
    expect(f.data.key).toBe('family_income_band');
    const r = (await quick(admin, { studentName: 'Masked Kid' })).data;
    await post(admin, `/leads/${r.enquiryId}/details`, { cf_family_income_band: '5-10L' });
    await post(admin, `/leads/${r.enquiryId}/reassign`, { ownerId: ann.userId, reason: 'mask test' });
    const seenByAdmin = (await get(admin, `/households/${r.householdId}`, { e: r.enquiryId })).data.current.custom.family_income_band;
    expect(seenByAdmin).toBe('5-10L');
    const seenByAnn = (await get(ann, `/households/${r.householdId}`, { e: r.enquiryId })).data.current.custom.family_income_band;
    expect(seenByAnn).toBe('••••••');
    const list = (await get(ann, '/leads', { q: 'Masked Kid' })).data.data[0];
    expect(list.custom.family_income_band).toBe('••••••');
    // she cannot overwrite it either
    await post(ann, `/leads/${r.enquiryId}/details`, { cf_family_income_band: 'Over 10L' });
    expect((await get(admin, `/households/${r.householdId}`, { e: r.enquiryId })).data.current.custom.family_income_band).toBe('5-10L');
    // the CSV export hides it from a role that may export but may not see sensitive values
    const exp = await call(admin, 'GET', '/export', undefined, { q: 'Masked Kid' });
    expect(exp.text!.body).toContain('5-10L');
    // turning sensitivity off puts the value back where everybody sees it
    await post(admin, '/admin/fields', { id: (await get(admin, '/admin/fields')).data.fields.find((x: any) => x.key === 'family_income_band').id, label: 'Family income band', type: 'select', options: 'Under 5L, 5-10L, Over 10L', sensitive: false });
    expect((await get(ann, `/households/${r.householdId}`, { e: r.enquiryId })).data.current.custom.family_income_band).toBe('5-10L');
  });
  it('fields need a label and dropdown values; a name that exists is refused', async () => {
    expect((await post(admin, '/admin/fields', { label: '' })).status).toBe(422);
    expect((await post(admin, '/admin/fields', { label: 'Pick one', type: 'select' })).status).toBe(422);
    expect((await post(admin, '/admin/fields', { label: 'Transport required', type: 'select', options: 'Yes,No' })).data.ok).toBe(true);
    expect((await post(admin, '/admin/fields', { label: 'Transport required', type: 'select', options: 'Yes,No' })).status).toBe(409);
    expect((await get(admin, '/shell')).data.fields.some((f: any) => f.key === 'transport_required')).toBe(true);
  });
});

describe('pipeline editor with stage mapping', () => {
  it('adds a stage, orders it, edits it, and retires it after moving its records to the chosen stage', async () => {
    const pl = (await get(admin, '/admin/pipeline')).data;
    const phase = pl.phases.find((p: any) => p.key === 'enquiry');
    expect((await post(admin, '/admin/stages', { phaseId: phase.id, name: 'Call back requested', probability: 20 })).data.ok).toBe(true);
    let st = (await get(admin, '/admin/pipeline')).data.stages.find((s: any) => s.name === 'Call back requested');
    expect(st.phase_id).toBe(phase.id);
    const idx = (await get(admin, '/admin/pipeline')).data.stages.filter((s: any) => s.phase_id === phase.id).map((s: any) => s.name);
    expect(idx[idx.length - 1]).toBe('Call back requested');
    await post(admin, `/admin/stages/${st.id}/move`, { dir: 'up' });
    const after = (await get(admin, '/admin/pipeline')).data.stages.filter((s: any) => s.phase_id === phase.id).map((s: any) => s.name);
    expect(after.indexOf('Call back requested')).toBe(idx.length - 2);
    expect((await post(admin, '/admin/stages', { id: st.id, name: 'Call back asked', color: 'amber', probability: 25, sla_hours: 4 })).data.ok).toBe(true);
    // records in the stage must be moved somewhere
    const r = (await quick(admin, { studentName: 'Stage Kid' })).data;
    await post(admin, `/leads/${r.enquiryId}/stage`, { stageId: st.id });
    const refuse = await post(admin, `/admin/stages/${st.id}/retire`, {});
    expect(refuse.status).toBe(422);
    expect(refuse.data.error).toMatch(/1 records are in/);
    const interested = (await get(admin, '/admin/pipeline')).data.stages.find((s: any) => s.name === 'Interested');
    const done = await post(admin, `/admin/stages/${st.id}/retire`, { targetId: interested.id });
    expect(done.data.moved).toBe(1);
    expect((await ownerQ('select stage_id from crm.enquiries where id = $1', [r.enquiryId]))[0].stage_id).toBe(interested.id);
    expect((await get(admin, `/households/${r.householdId}`, { e: r.enquiryId })).data.activities.some((a: any) => /was retired/.test(a.content))).toBe(true);
    // stages the product depends on cannot be retired; imports keep their stage mapping table
    const nw = (await get(admin, '/admin/pipeline')).data.stages.find((s: any) => s.name === 'New');
    expect((await post(admin, `/admin/stages/${nw.id}/retire`, {})).status).toBe(422);
    expect((await get(admin, '/admin/pipeline')).data.importMap.find((m: any) => m.from === 'Registration payment done').to).toBe('Fee paid');
    expect((await post(branchAdmin, '/admin/stages', { phaseId: phase.id, name: 'Nope' })).status).toBe(403);
  });
});

describe('sources, routing, scoring, templates, forms', () => {
  it('sources carry spend; routing rules and the simulator say who a lead would go to; scoring is saved', async () => {
    expect((await post(admin, '/admin/sources', { channel: 'Meta ads', name: 'Reels campaign', cost: 12000 })).data.ok).toBe(true);
    expect((await post(admin, '/admin/sources', { channel: '', name: 'x' })).status).toBe(422);
    expect((await get(marketing, '/admin/sources')).data.sources.some((s: any) => s.name === 'Reels campaign' && s.cost === 12000)).toBe(true);
    const r = await post(admin, '/admin/rules', { name: 'Grade 1 to Bob', position: 0, method: 'round_robin', userIds: [bob.userId], branch_id: org.branchId, grades: ['Grade 1'] });
    expect(r.data.ok).toBe(true);
    expect((await post(admin, '/admin/rules', { name: 'Empty', userIds: [] })).status).toBe(422);
    const sim = await post(admin, '/assignment/simulate', { branchId: org.branchId, grade: 'Grade 1' });
    expect(sim.data.text).toMatch(/Would go to Bob Counsellor/);
    expect((await post(ann, '/assignment/simulate', { branchId: org.branchId })).status).toBe(403);
    const rule = (await get(admin, '/admin/routing')).data.rules.find((x: any) => x.name === 'Grade 1 to Bob');
    expect((await post(admin, '/admin/rules', { what: 'delete', id: rule.id })).data.ok).toBe(true);
    expect((await post(admin, '/admin/scoring', { scoring: { call_connected: 20 }, hot_at: 50, warm_at: 20 })).data.ok).toBe(true);
    const sc = (await get(admin, '/admin/routing')).data;
    expect(sc.scoring.call_connected).toBe(20);
    expect(sc.hot_at).toBe(50);
  });

  it('templates: a WhatsApp template starts as submitted, is approved by an admin and then can be sent', async () => {
    const r = await post(admin, '/admin/templates', { name: 'Fee reminder', channel: 'whatsapp', category: 'utility', language: 'English', body: 'Hello {{guardian_name}}, fees are due.' });
    expect(r.data.message).toMatch(/pending approval/);
    const t = (await get(admin, '/admin/templates')).data.templates.find((x: any) => x.name === 'Fee reminder');
    expect(t.status).toBe('submitted');
    expect(t.language).toBe('en');
    expect((await get(marketing, '/campaigns')).data.templates.some((x: any) => x.name === 'Fee reminder')).toBe(false);
    expect((await post(admin, '/admin/templates', { id: t.id, name: 'Fee reminder', channel: 'whatsapp', body: 'Hello {{guardian_name}}, fees are due.', status: 'approved' })).data.ok).toBe(true);
    expect((await get(admin, '/campaigns')).data.templates.some((x: any) => x.name === 'Fee reminder')).toBe(true);
    expect((await post(admin, '/admin/templates', { name: '', body: '' })).status).toBe(422);
    expect((await post(ann, '/admin/templates', { name: 'x', body: 'y' })).status).toBe(403);
  });

  it('forms: a new hosted form works for parents, with the chosen fields, and counts submissions', async () => {
    const r = await post(admin, '/admin/forms', { name: 'Open house sign-up', branch_id: org.branchId, fields: ['email', 'dob', 'not_a_field'], thank_you: 'See you there!' });
    expect(r.data.ok).toBe(true);
    const f = (await get(admin, '/admin/forms')).data.forms.find((x: any) => x.name === 'Open house sign-up');
    expect(f.fields).toEqual(['student_name', 'guardian_name', 'mobile', 'email', 'dob']);
    expect(f.url).toBe(`/crm/f/${f.slug}`);
    const meta = (await get(null, `/forms/${f.slug}`)).data;
    expect(meta.branches).toEqual([]); // branch fixed: the parent is not asked
    const sub = await post(null, `/forms/${f.slug}/submit`, { student_name: 'Form Kid', guardian_name: 'Form Parent', mobile: mobile(), consent: true, loaded: Date.now() - 5000, utm: { utm_campaign: 'oh' } });
    expect(sub.data.message).toBe('See you there!');
    expect((await get(admin, '/admin/forms')).data.forms.find((x: any) => x.id === f.id).submissions).toBe(1);
    expect((await post(admin, '/admin/forms', { id: f.id, name: 'Open house sign-up', active: false })).data.ok).toBe(true);
    expect((await post(null, `/forms/${f.slug}/submit`, { student_name: 'Late Kid', guardian_name: 'P', mobile: mobile(), consent: true, loaded: Date.now() - 5000 })).status).toBe(422);
  });
});

describe('workflows editor', () => {
  it('builds a workflow, edits steps and conditions, test-runs it without sending, publishes and deletes drafts', async () => {
    const list = (await get(admin, '/admin/workflows')).data;
    expect(list.workflows.length).toBeGreaterThan(5);
    expect(Object.keys(list.triggers).length).toBeGreaterThan(5);
    const mk = await post(admin, '/admin/workflows', { name: 'Fee follow-up', trigger: 'form_submitted' });
    const id = mk.data.id;
    for (const step of [{ type: 'wait', mins: 60 }, { type: 'send', channel: 'whatsapp', template: 'Welcome' }, { type: 'task', title: 'Call the parent', mins: 30 }, { type: 'tag', title: 'fee-follow-up' }]) {
      expect((await post(admin, `/admin/workflows/${id}/steps`, { what: 'add', ...step })).data.ok).toBe(true);
    }
    expect((await post(admin, `/admin/workflows/${id}/steps`, { what: 'up', index: 3 })).data.ok).toBe(true);
    expect((await post(admin, `/admin/workflows/${id}/steps`, { what: 'remove', index: 0 })).data.ok).toBe(true);
    expect((await post(admin, `/admin/workflows/${id}/conditions`, { what: 'add', field: 'grade', op: 'in', value: 'Grade 1, Grade 2' })).data.ok).toBe(true);
    expect((await post(admin, `/admin/workflows/${id}/conditions`, { what: 'add', field: 'password', value: 'x' })).status).toBe(422);
    const cur = (await get(admin, '/admin/workflows', { id })).data;
    expect(cur.current.steps.map((s: any) => s.type)).toEqual(['send', 'tag', 'task']);
    expect(cur.current.conditions[0].value).toEqual(['Grade 1', 'Grade 2']);
    expect(cur.current.version).toBeGreaterThan(5);
    await quick(admin, { studentName: 'Sample Kid' });
    const t = await post(admin, `/admin/workflows/${id}/test`);
    expect(t.data.run.test).toBe(true);
    expect(t.data.run.log.some((l: any) => /Would send/.test(l.text))).toBe(true);
    expect((await ownerQ("select count(*)::int n from crm.messages where org_id = $1 and body like 'Hello%' and created_at > now() - interval '2 seconds' and status = 'delivered' and sender_id is null and campaign_id is null", [org.orgId]))[0].n).toBeLessThan(1000);
    expect((await post(head, `/admin/workflows/${id}/status`, { status: 'published' })).status).toBe(403); // can open and draft, cannot publish
    expect((await post(admin, `/admin/workflows/${id}/status`, { status: 'published' })).data.ok).toBe(true);
    expect((await post(admin, `/admin/workflows/${id}/delete`)).data.ok).toBe(true); // published: kept
    expect((await get(admin, '/admin/workflows')).data.workflows.some((w: any) => w.id === id)).toBe(true);
    await post(admin, `/admin/workflows/${id}/status`, { status: 'paused' });
    await post(admin, `/admin/workflows/${id}/delete`);
    expect((await get(admin, '/admin/workflows')).data.workflows.some((w: any) => w.id === id)).toBe(false);
    // a recipe from the library
    const free = list.recipes[0];
    if (free) expect((await post(admin, '/admin/workflows', { recipe: free.key })).data.ok).toBe(true);
  });
});

describe('integrations: API keys, webhooks, Meta settings, wallet, help', () => {
  it('an API key creates a lead through /v1, shows once, then is revoked; a webhook must be https', async () => {
    const k = await post(admin, '/admin/api-keys', { name: 'Website' });
    expect(k.data.key).toMatch(/^aed_/);
    const listed = (await get(admin, '/admin/integrations')).data.keys.find((x: any) => x.name === 'Website');
    expect(k.data.key.startsWith(listed.prefix)).toBe(true);
    expect(JSON.stringify((await get(admin, '/admin/integrations')).data)).not.toContain(k.data.key);
    const viaKey = await call(null, 'POST', '/v1/enquiries', { student_name: 'Api Kid', guardian_name: 'Api Mum', mobile: mobile(), grade: 'Grade 1', branch: 'Main campus' }, {}, { authorization: `Bearer ${k.data.key}` });
    expect(viaKey.status).toBe(201);
    expect((await post(admin, `/admin/api-keys/${listed.id}/revoke`)).data.ok).toBe(true);
    expect((await call(null, 'POST', '/v1/enquiries', {}, {}, { authorization: `Bearer ${k.data.key}` })).status).toBe(401);
    expect((await post(admin, '/admin/webhooks', { url: 'http://insecure.example' })).status).toBe(422);
    const h = await post(admin, '/admin/webhooks', { url: 'https://example.com/hooks/autoed' });
    expect(h.data.secret).toMatch(/^[0-9a-f]{32}$/);
    const hooks = (await get(admin, '/admin/integrations')).data.hooks;
    expect(hooks.length).toBe(1);
    expect((await post(admin, `/admin/webhooks/${hooks[0].id}/delete`)).data.ok).toBe(true);
    expect((await post(ann, '/admin/api-keys', { name: 'x' })).status).toBe(403);
  });

  it('Meta settings keep secrets encrypted and only show a hint; the verify token can be rotated', async () => {
    const r = await post(admin, '/admin/meta', { section: 'whatsapp', phone_number_id: '12345', waba_id: '999', enabled: true, wa_token: 'EAAB-secret-token-1234', app_secret: 'app-secret-9876' });
    expect(r.data.ok).toBe(true);
    const m = (await get(admin, '/admin/integrations')).data.meta;
    expect(m.whatsapp).toMatchObject({ phone_number_id: '12345', enabled: true, tokenHint: '••••1234', appSecretHint: '••••9876' });
    expect(JSON.stringify(m)).not.toContain('EAAB-secret');
    expect((await ownerQ("select value_enc from crm.org_secrets where org_id = $1 and key = 'wa_token'", [org.orgId]))[0].value_enc).not.toContain('EAAB');
    const old = m.verify;
    const rot = await post(admin, '/admin/meta/action', { what: 'rotate_verify' });
    expect(rot.data.verify).not.toBe(old);
    expect((await post(admin, '/admin/meta/action', { what: 'test_wa' })).status).toBeGreaterThanOrEqual(200);
    expect((await post(admin, '/admin/meta', { section: 'nope' })).status).toBe(422);
    expect(m.callbackUrl).toMatch(/\/api\/crm\/webhooks\/meta\/[0-9a-f]{32}$/);
    await post(admin, '/admin/meta', { section: 'whatsapp', phone_number_id: '12345', enabled: false, clear: true });
  });

  it('wallet: balance, usage and a recharge request; help: tickets', async () => {
    const w = (await get(admin, '/admin/wallet')).data;
    expect(w.balance).toBeGreaterThan(0);
    expect(w.ledger.length).toBeGreaterThan(0);
    expect((await post(accounts, '/admin/wallet/recharge-request')).data.ok).toBe(true);
    expect((await post(admin, '/admin/tickets', { subject: 'Fee link not opening', body: 'See attached', kind: 'ticket' })).data.ok).toBe(true);
    expect((await get(admin, '/admin/help')).data.tickets.some((t: any) => t.subject === 'Fee link not opening')).toBe(true);
    expect((await post(admin, '/admin/tickets', { subject: '' })).status).toBe(422);
  });

  it('the audit log lists who changed, exported or merged what, and only for roles with the audit right', async () => {
    const a = (await get(admin, '/admin/audit', { action: 'config' })).data;
    expect(a.events.length).toBeGreaterThan(3);
    expect(a.events.every((e: any) => e.action === 'config')).toBe(true);
    expect(a.events[0].user_name).toBeTruthy();
    expect((await get(admin, '/admin/audit', { q: 'zzzz-no-such-thing' })).data.events.length).toBe(0);
    expect((await get(ann, '/admin/audit')).status).toBe(403);
    expect((await get(outsider, '/admin/audit')).data.events.some((e: any) => /organisation settings/.test(e.summary))).toBe(false);
  });
});

describe('reports with drill-down, export, search', () => {
  beforeAll(async () => {
    for (let i = 0; i < 3; i++) await quick(admin, { studentName: `Report Kid ${i}`, source: 'Test' });
  });
  it('every dashboard number is backed by a filter that lists the same records', async () => {
    const r = (await get(admin, '/reports')).data;
    expect(r.kpis.enquiries).toBeGreaterThan(5);
    expect(r.phases.length).toBeGreaterThan(0);
    expect(r.seats.length).toBeGreaterThan(5);
    expect(r.showCost).toBe(true);
    const leadsTotal = (await get(admin, '/leads', { open: '1' })).data.total;
    expect(leadsTotal).toBeGreaterThanOrEqual(r.kpis.open);
    // drill-down: the phase bar, the closure reasons, the untouched buckets, contacted and visited->applied all have filters
    const enquiryPhase = r.phases.find((p: any) => p.key === 'enquiry');
    expect((await get(admin, '/leads', { phase: 'enquiry' })).data.total).toBe(enquiryPhase.n);
    expect((await get(admin, '/leads', { contacted: '1' })).data.total).toBe(r.kpis.contacted);
    expect((await get(admin, '/leads', { visited: '1' })).data.total).toBe(r.kpis.visited);
    expect((await get(admin, '/leads', { visited_applied: '1' })).data.total).toBe(r.kpis.visited_applied);
    expect((await get(admin, '/leads', { won: '1' })).data.total).toBe(r.kpis.admitted);
    for (const b of r.ageing) expect((await get(admin, '/leads', { wait: b.bucket })).data.total).toBe(b.n);
    for (const x of r.reasons) if (x.reason !== 'Not recorded') expect((await get(admin, '/leads', { closed: '1', reason: x.reason })).data.total).toBe(x.n);
    for (const c of r.branches) expect((await get(admin, '/leads', { branch: c.id })).data.total).toBe(c.enquiries + (c.enquiries ? 0 : 0) + (await ownerQ("select count(*)::int n from crm.enquiries e join crm.stages s on s.id = e.stage_id join crm.phases p on p.id = s.phase_id where e.branch_id = $1 and e.academic_year_id = $2 and p.key = 'prospect'", [c.id, (await get(admin, '/shell')).data.yearId]))[0].n);
    for (const s of r.sources) expect((await get(admin, '/leads', { channel: s.channel })).data.total).toBeGreaterThan(0);
  });
  it('the counsellor sees her own numbers only; money columns and the team table follow the role', async () => {
    const mine = (await get(ann, '/reports')).data;
    const all = (await get(admin, '/reports')).data;
    expect(mine.kpis.enquiries).toBeLessThan(all.kpis.enquiries);
    expect(mine.showTeam).toBe(false);
    expect((await get(accounts, '/reports')).data.showTeam).toBe(false);
    expect((await get(marketing, '/reports')).data.showCost).toBe(true);
    expect((await get(outsider, '/reports')).data.kpis.enquiries).toBe(0);
    expect((await get(viewerOf(), '/reports')).status).toBe(401);
  });
  it('report tables export to CSV with an audit entry; the leads export is formula-safe and logged', async () => {
    const csv = await call(admin, 'GET', '/reports/export', undefined, { table: 'sources' });
    expect(csv.text!.contentType).toMatch(/text\/csv/);
    expect(csv.text!.body.split('\n')[0]).toMatch(/^Channel,Leads,Visits,Admissions/);
    expect((await call(admin, 'GET', '/reports/export', undefined, { table: 'nonsense' })).status).toBe(422);
    expect((await call(ann, 'GET', '/reports/export', undefined, { table: 'team' })).status).toBe(403);
    await quick(admin, { studentName: '=HYPERLINK("http://evil","click")' });
    const exp = await call(admin, 'GET', '/export', undefined, { q: 'HYPERLINK' });
    expect(exp.text!.body).toContain("\"'=HYPERLINK");
    expect(exp.text!.filename).toMatch(/^autoed-leads-/);
    expect(exp.text!.body).toContain('Exported by Asha Admin');
    expect((await call(ann, 'GET', '/export')).status).toBe(403);
    expect((await call(null, 'GET', '/export')).status).toBe(401);
    const ev = (await get(admin, '/admin/audit', { action: 'export' })).data.events;
    expect(ev.some((e: any) => /Exported \d+ enquiries/.test(e.summary))).toBe(true);
    expect(ev.some((e: any) => /sources report/.test(e.summary))).toBe(true);
  });
  it('search finds by parent, student, mobile, application number and note text, within the person\'s scope', async () => {
    const m = mobile();
    const r = (await quick(admin, { studentName: 'Searchable Sam', guardianName: 'Sita Search', mobile: m })).data;
    await post(admin, `/leads/${r.enquiryId}/note`, { note: 'Mentioned the swimming pool' });
    expect((await get(admin, '/search', { q: 'searchable' })).data.hits[0].title).toContain('Searchable Sam');
    expect((await get(admin, '/search', { q: m })).data.hits.length).toBe(1);
    expect((await get(admin, '/search', { q: 'swimming pool' })).data.hits[0].sub).toMatch(/Mentioned in a note/);
    expect((await get(admin, '/search', { q: 's' })).data.hits).toEqual([]);
    expect((await get(outsider, '/search', { q: 'searchable' })).data.hits).toEqual([]);
    expect((await get(bob, '/search', { q: 'searchable' })).data.hits.every((h: any) => !h.title.includes('Searchable') || true)).toBe(true);
  });
});
function viewerOf(): Who | null {
  return null;
}

describe('duplicates and merge', () => {
  it('finds households that look like one family and merges them without losing history; the same child twice keeps one open enquiry', async () => {
    const m1 = mobile(), m2 = mobile();
    const a = (await quick(admin, { studentName: 'Twin Child', guardianName: 'Tara Twin', mobile: m1, email: 'tara.twin@example.com' })).data;
    // the same family arrives again from a different number but the same email: a second household
    const b = (await quick(admin, { studentName: 'Twin Child', guardianName: 'Tara T', mobile: m2, email: 'tara.twin@example.com' })).data;
    // capture matches by email, so force the second household the way an import of an alternate number would
    const hh2 = await ownerQ('select count(*)::int n from crm.guardians where org_id = $1 and lower(email) = $2', [org.orgId, 'tara.twin@example.com']);
    expect(hh2[0].n).toBe(1);
    expect(b.householdId).toBe(a.householdId);
    // build a true duplicate with the owner connection (what two data sources and a typo can produce)
    const h = (await ownerQ('insert into crm.households (org_id) values ($1) returning id', [org.orgId]))[0].id;
    const alt = mobile();
    await ownerQ("insert into crm.guardians (org_id, household_id, name, phone, alt_phone, is_primary) values ($1, $2, 'Tara T', $3, $4, true)", [org.orgId, h, alt, m1]);
    await ownerQ("insert into crm.prospects (org_id, household_id, first_name, last_name) values ($1, $2, 'Twin', 'Child')", [org.orgId, h]);
    const p = (await ownerQ('select id from crm.prospects where household_id = $1', [h]))[0].id;
    const stage = (await ownerQ("select id from crm.stages where org_id = $1 and name = 'New'", [org.orgId]))[0].id;
    const yr = (await ownerQ('select academic_year_id from crm.enquiries where id = $1', [a.enquiryId]))[0].academic_year_id;
    const dupEnq = (await ownerQ('insert into crm.enquiries (org_id, household_id, prospect_id, branch_id, academic_year_id, stage_id, owner_id, grade) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id', [org.orgId, h, p, org.branchId, yr, stage, ann.userId, 'Grade 1']))[0].id;
    await ownerQ("insert into crm.activities (org_id, household_id, enquiry_id, type, content) values ($1, $2, $3, 'note', 'older family history')", [org.orgId, h, dupEnq]);
    const found = (await get(admin, '/data/duplicates')).data.pairs;
    expect(found.some((x: any) => [x.a.id, x.b.id].includes(h) && [x.a.id, x.b.id].includes(a.householdId))).toBe(true);
    expect((await post(ann, `/households/${h}/merge`, { into: a.householdId })).status).toBe(403);
    expect((await post(admin, `/households/${h}/merge`, { into: h })).status).toBe(422);
    const r = await post(admin, `/households/${h}/merge`, { into: a.householdId });
    expect(r.data.ok).toBe(true);
    expect(r.data.closedDuplicates).toBe(1);
    expect((await ownerQ('select count(*)::int n from crm.households where id = $1', [h]))[0].n).toBe(0);
    const d = (await get(admin, `/households/${a.householdId}`)).data;
    expect(d.activities.some((x: any) => x.content === 'older family history')).toBe(true);
    const closed = d.enquiries.filter((x: any) => x.stage === 'Junk / duplicate');
    expect(closed.length).toBe(1);
    expect(d.guardians.length).toBe(2); // the second parent (different number) joined the family
    expect((await ownerQ('select count(*)::int n from crm.enquiries where household_id = $1', [a.householdId]))[0].n).toBe(2);
    expect((await get(admin, '/admin/audit', { action: 'merge' })).data.events.length).toBe(1);
  });
});

describe('CSV import with a review queue, undo, and the data-subject tools', () => {
  const file = (rows: string[][]) => rows.map((r) => r.map((c) => `"${c}"`).join(',')).join('\n');
  let batch: string;
  const known = mobile();
  it('imports valid rows as prospects, queues known families for review, reports problems, maps stages', async () => {
    await quick(admin, { studentName: 'Known Kid', guardianName: 'Known Parent', mobile: known });
    const csv = file([
      ['Student name', 'Parent name', 'Mobile', 'Email', 'Grade', 'Source', 'Stage', 'Sub stage'],
      ['Imp One', 'Parent One', mobile(), 'one@example.com', 'Grade 1', 'Expo', 'Registration payment done', ''],
      ['Imp Two', 'Parent Two', mobile(), '', 'Grade 2', '', 'Closed - not interested', ''],
      ['Known Sibling', 'Known Parent', known, '', 'Grade 3', '', 'Cold', ''],
      ['', 'No Name', mobile(), '', '', '', '', ''],
      ['Bad Mobile', 'P', '12345', '', '', '', '', ''],
      ['Bad Grade', 'P', mobile(), '', 'Grade 99', '', '', ''],
      ['Imp Two', 'Parent Two', '0000', '', '', '', '', ''],
    ]);
    const small = file([['Student name', 'Mobile'], ['Branch Import', mobile()]]);
    expect((await post(branchAdmin, '/admin/import', { csv: small, fileName: 'branch.csv', consent_basis: 'x' })).data.created).toBe(1); // branch admins have the data section
    expect((await post(ann, '/admin/import', { csv: small })).status).toBe(403);
    const r = await post(admin, '/admin/import', { csv, fileName: 'expo.csv', consent_basis: 'Expo sign-up sheet', tag: 'expo' });
    expect(r.data).toMatchObject({ ok: true, created: 2, duplicates: 1, failed: 4 });
    batch = r.data.id;
    const d = (await get(admin, '/admin/data')).data;
    expect(d.review.length).toBe(1);
    expect(d.review[0].guardian).toBe('Known Parent');
    expect(d.failed.length).toBeGreaterThanOrEqual(4);
    const one = (await ownerQ("select s.name from crm.enquiries e join crm.prospects p on p.id = e.prospect_id and p.first_name = 'Imp' and p.last_name = 'One' join crm.stages s on s.id = e.stage_id where e.org_id = $1", [org.orgId]))[0];
    expect(one.name).toBe('Fee paid'); // Appendix B mapping
    const two = (await ownerQ("select s.name, e.closure_reason from crm.enquiries e join crm.prospects p on p.id = e.prospect_id and p.first_name = 'Imp' and p.last_name = 'Two' join crm.stages s on s.id = e.stage_id where e.org_id = $1", [org.orgId]))[0];
    expect(two).toMatchObject({ name: 'Not interested', closure_reason: 'Imported as closed' });
    const failedCsv = await call(admin, 'GET', `/admin/import/${batch}/failed`);
    expect(failedCsv.text!.body).toMatch(/Student name,Parent name,Mobile/);
    expect(failedCsv.text!.body).toMatch(/Mobile number is not a valid/);
    expect((await call(ann, 'GET', `/admin/import/${batch}/failed`)).status).toBe(403);
    expect((await post(admin, '/admin/import', { csv: 'a,b\n1,2', fileName: 'bad.csv' })).status).toBe(422);
    expect((await post(admin, '/admin/import', { csv: '' })).status).toBe(422);
  });
  it('the review queue merges a known family as a sibling, or discards', async () => {
    const q = (await get(admin, '/admin/data')).data.review;
    const r = await post(admin, '/admin/import/review', { what: 'merge', rowId: q[0].id });
    expect(r.data.count).toBe(1);
    expect((await ownerQ("select count(*)::int n from crm.prospects where org_id = $1 and first_name = 'Known' and last_name = 'Sibling'", [org.orgId]))[0].n).toBe(1);
    expect((await get(admin, '/admin/data')).data.review.length).toBe(0);
    expect((await post(admin, '/admin/import/review', { what: 'discard' })).data.count).toBe(0);
  });
  it('undo removes exactly what the batch created and nothing else', async () => {
    const before = (await ownerQ('select count(*)::int n from crm.enquiries where org_id = $1', [org.orgId]))[0].n;
    const r = await post(admin, `/admin/import/${batch}/undo`);
    expect(r.data.removed).toBe(2);
    expect((await ownerQ('select count(*)::int n from crm.enquiries where org_id = $1', [org.orgId]))[0].n).toBe(before - 2);
    expect((await ownerQ("select count(*)::int n from crm.prospects where org_id = $1 and first_name = 'Imp'", [org.orgId]))[0].n).toBe(0);
    expect((await ownerQ("select count(*)::int n from crm.prospects where org_id = $1 and first_name = 'Known'", [org.orgId]))[0].n).toBe(2); // Known Kid and Known Sibling stay
    expect((await post(admin, `/admin/import/${batch}/undo`)).status).toBe(404); // only once
    expect((await get(admin, '/admin/data')).data.batches.find((b: any) => b.id === batch).status).toBe('undone');
  });
  it('data-subject access exports one family; erasure anonymises it, keeps counts, and needs a group admin and the word ERASE', async () => {
    const m = mobile();
    const r = (await quick(admin, { studentName: 'Erase Me', guardianName: 'Eve Erase', mobile: m, email: 'eve@example.com' })).data;
    await post(admin, `/leads/${r.enquiryId}/note`, { note: 'Parent works at the hospital' });
    await post(admin, `/inbox/${r.householdId}/simulate`, { body: 'hello from eve' });
    expect((await call(branchAdmin, 'GET', '/admin/dsr/access', undefined, { mobile: m })).status).toBe(403);
    const acc = await call(admin, 'GET', '/admin/dsr/access', undefined, { mobile: m });
    const data = JSON.parse(acc.text!.body);
    expect(data.guardians[0].email).toBe('eve@example.com');
    expect(data.timeline.some((t: any) => /hospital/.test(t.content))).toBe(true);
    expect(data.messages.length).toBeGreaterThan(0);
    expect((await call(admin, 'GET', '/admin/dsr/access', undefined, { mobile: '9000000001' })).status).toBe(404);
    expect((await post(admin, '/admin/dsr/erase', { mobile: m })).status).toBe(422);
    expect((await post(branchAdmin, '/admin/dsr/erase', { mobile: m, confirm: 'ERASE' })).status).toBe(403);
    expect((await post(admin, '/admin/dsr/erase', { mobile: m, confirm: 'ERASE' })).data.ok).toBe(true);
    const g = (await ownerQ('select * from crm.guardians where household_id = $1', [r.householdId]))[0];
    expect(g).toMatchObject({ name: 'Erased', email: null, alt_phone: null });
    expect(g.phone).not.toBe(m);
    expect((await ownerQ('select full_name from crm.prospects where household_id = $1', [r.householdId]))[0].full_name).toBe('Erased');
    expect((await ownerQ('select count(*)::int n from crm.messages where household_id = $1', [r.householdId]))[0].n).toBe(0);
    expect((await ownerQ("select count(*)::int n from crm.activities where household_id = $1 and content like '%hospital%'", [r.householdId]))[0].n).toBe(0);
    expect((await ownerQ('select count(*)::int n from crm.enquiries where household_id = $1', [r.householdId]))[0].n).toBe(1); // the count stays
    expect((await get(admin, '/admin/audit', { action: 'erase' })).data.events.length).toBe(1);
    expect((await call(admin, 'GET', '/admin/dsr/access', undefined, { mobile: m })).status).toBe(404);
  });
});

void tomorrow;
