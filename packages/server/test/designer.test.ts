/**
 * AI school designer (DECISIONS 56-59) against the seeded demo database, through the same API the web page calls:
 * plan (mock AI) -> validate -> dry run -> publish -> configuration really changed -> undo restores it exactly;
 * who may use it (management yes, teachers no, AutoEd staff only inside a support session, audited as themselves);
 * org isolation of changesets; and that no personal data reaches the AI provider.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canonical } from '@autoed/shared';
import { dispatch, type ApiResponse } from '../src/api';
import { asOwner, asUser, closePool, maybe, one, q } from '../src/db';
import { setAiProvider, type AiRequest } from '../src/adapters/ai';
import { mockGenerate } from '../src/adapters/mockAi';
import { seedDemo } from '../src/seed/demo';

const tokens: Record<string, string> = {};
async function login(email: string): Promise<string> {
  if (tokens[email]) return tokens[email]!;
  const r = await dispatch({ method: 'POST', path: '/auth/dev-login', query: {}, headers: {}, body: { email }, ip: `designer-${email}` });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  tokens[email] = (r.json as { token: string }).token;
  return tokens[email]!;
}
async function call(email: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<ApiResponse & { json: any }> {
  const token = await login(email);
  return (await dispatch({ method, path, query: {}, headers: { authorization: `Bearer ${token}`, ...headers }, body: body ?? {}, ip: '127.0.0.1' })) as ApiResponse & { json: any };
}
async function ok(email: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const r = await call(email, method, path, body, headers);
  expect(r.status, `${method} ${path} -> ${JSON.stringify(r.json)}`).toBe(200);
  return r.json;
}

const CHAIRMAN = 'chairman@demo.school';
const TEACHER = 'deepa.teacher9@demo.school';
const RM = 'admin@autoed.dev';
const OTHER_CHAIRMAN = 'chairman@riverside.school';
const ABSENCE = 'teacher absent more than 2 days -> coordinator arranges substitution, notify parents, principal approves in exam week';

const seen: AiRequest[] = [];
let demoOrg = '';
let rmUser = '';

/** Leave type and approval type state straight from the tables (what the settings screens show). */
const leaveRow = (org: string, key: string) =>
  asOwner((c) => maybe(c, `select key, name, yearly_quota, accrual, carry_forward, carry_forward_max, half_day_allowed, notice_days, doc_required_after_days, sandwich_rule, paid, active, deleted_at from core.leave_types where org_id = $1 and key = $2`, [org, key]));
const approvalLive = (org: string, key: string) => asOwner((c) => maybe(c, `select id, name from core.approval_types where org_id = $1 and key = $2 and deleted_at is null and active`, [org, key]));

beforeAll(async () => {
  demoOrg = (await asOwner((c) => one<{ id: string }>(c, `select id from core.organizations where slug = 'demo'`))).id;
  await seedDemo({ slug: 'riverside', name: 'Riverside Academy', domain: 'riverside.school', phonePrefix: '+9191000' });
  rmUser = (await asOwner((c) => one<{ id: string }>(c, `select id from auth.users where email = $1`, [RM]))).id;
  // the mock provider, recording exactly what would be sent to Gemini
  setAiProvider({
    name: 'mock',
    async generate(req) {
      seen.push(req);
      const output = mockGenerate(req.action, req.mockContext ?? {});
      return { output, model: 'mock', provider: 'mock', inputTokens: Math.ceil((req.system.length + req.prompt.length) / 4), outputTokens: 10, providerCost: 0 };
    },
  });
}, 600000);

afterAll(async () => {
  setAiProvider(null);
  await closePool();
});

describe('designer: plan, preview, dry run, publish, undo (school management)', () => {
  let csId = '';

  it('management sees the designer; the mock plans the absence workflow as validated blocks with a plain-language preview', async () => {
    const who = await ok(CHAIRMAN, 'GET', '/designer/whoami');
    expect(who.kind).toBe('org_admin');
    const cat = await ok(CHAIRMAN, 'GET', '/designer/catalogue');
    expect(cat.find((b: any) => b.key === 'os.approval_type').available).toBe(true);
    expect(cat.find((b: any) => b.key === 'core.custom_object')).toMatchObject({ stub: false, available: true }); // the custom records engine
    // an OS-only school is offered no CRM or ERP block
    expect(cat.filter((b: any) => b.available && (b.key.startsWith('crm.') || b.key.startsWith('erp.')))).toEqual([]);

    const cs = await ok(CHAIRMAN, 'POST', '/designer/plan', { prompt: ABSENCE });
    csId = cs.id;
    expect(cs.status).toBe('validated');
    expect(cs.author_kind).toBe('org_admin');
    expect(cs.issues).toEqual([]);
    expect(cs.plan.ops.map((o: any) => `${o.op} ${o.block}:${o.key}`)).toEqual([
      'create os.approval_type:extended_absence',
      'create os.notification_rule:absence.extended__family',
      'update os.notification_rule:substitution.assigned__staff', // the preset rule exists: repaired to an update
    ]);
    const first = cs.preview.ops[0];
    expect(first.text[0]).toContain('Teacher absence over 2 days');
    expect(first.text.join(' ')).toContain('academic_coordinator');
    expect(first.roles.sort()).toEqual(['academic_coordinator', 'principal']);
    expect(first.people).toBeGreaterThan(0);
    expect(cs.preview.ops[1].family_count).toBeGreaterThan(0);
    // the planner call went through the AI pipeline and charged the wallet (1 credit)
    const gen = await asOwner((c) => one<{ status: string; credits: number; action: string }>(c, `select status, credits, action from core.ai_generations where id = $1`, [cs.ai_generation_id]));
    expect(gen).toMatchObject({ status: 'ok', action: 'designer_plan' });
    expect(Number(gen.credits)).toBe(1);
  });

  it('try on sample data runs the plan for real and keeps nothing', async () => {
    const r = await ok(CHAIRMAN, 'POST', `/designer/changesets/${csId}/dry-run`);
    expect(r.ok).toBe(true);
    expect(r.ops[0].text.join(' ')).toMatch(/academic_coordinator → principal/);
    expect(await approvalLive(demoOrg, 'extended_absence')).toBeNull();
  });

  it('publish changes the configuration (the approval type appears in OS settings) and undo removes it again', async () => {
    const presetRule = () => asOwner((c) => one(c, `select role_keys, channels, active, settings, deleted_at from core.notification_rules where org_id = $1 and event_key = 'substitution.assigned' and audience = 'staff' and branch_id is null`, [demoOrg]));
    const presetBefore = await presetRule();
    const pub = await ok(CHAIRMAN, 'POST', `/designer/changesets/${csId}/publish`);
    expect(pub).toMatchObject({ status: 'published', items: 3 });
    expect((await presetRule()).role_keys).toEqual(['academic_coordinator']);
    expect(pub.version).toBeGreaterThan(0);
    const types = await ok(CHAIRMAN, 'GET', '/approvals/types');
    const t = types.find((x: any) => x.key === 'extended_absence');
    expect(t.steps.map((s: any) => s.approver_role_key)).toEqual(['academic_coordinator', 'principal']);
    const rule = await asOwner((c) => maybe(c, `select channels, audience from core.notification_rules where org_id = $1 and event_key = 'absence.extended' and deleted_at is null`, [demoOrg]));
    expect(rule).toMatchObject({ audience: 'family', channels: ['whatsapp', 'inapp'] });
    // published twice is refused
    expect((await call(CHAIRMAN, 'POST', `/designer/changesets/${csId}/publish`)).status).toBe(409);

    const undo = await ok(CHAIRMAN, 'POST', `/designer/changesets/${csId}/revert`);
    expect(undo).toMatchObject({ status: 'reverted', items: 3 });
    expect(await approvalLive(demoOrg, 'extended_absence')).toBeNull();
    expect((await ok(CHAIRMAN, 'GET', '/approvals/types')).find((x: any) => x.key === 'extended_absence')).toBeUndefined();
    expect(await asOwner((c) => maybe(c, `select 1 from core.notification_rules where org_id = $1 and event_key = 'absence.extended' and deleted_at is null`, [demoOrg]))).toBeNull();
    // the updated preset rule is back exactly as it was (settings keys included)
    expect(canonical(await presetRule())).toBe(canonical(presetBefore));
    const hist = await ok(CHAIRMAN, 'GET', '/designer/changesets');
    expect(hist.find((h: any) => h.id === csId)).toMatchObject({ status: 'reverted' });
  });

  it('an update of existing configuration is undone exactly (template with parameters)', async () => {
    const before = await leaveRow(demoOrg, 'casual');
    expect(before).not.toBeNull();
    const cs = await ok(CHAIRMAN, 'POST', '/designer/templates/standard_leave_policy/plan', { params: { casual_days: 20 } });
    expect(cs.status).toBe('validated');
    expect(cs.plan.ops.map((o: any) => o.op)).toEqual(['update', 'update', 'update']); // repaired: they already exist
    await ok(CHAIRMAN, 'POST', `/designer/changesets/${cs.id}/publish`);
    expect(Number((await leaveRow(demoOrg, 'casual'))!.yearly_quota)).toBe(20);
    const items = (await ok(CHAIRMAN, 'GET', `/designer/changesets/${cs.id}`)).items;
    expect(items[0]).toMatchObject({ op: 'update', block_key: 'os.leave_type', instance_key: 'casual' });
    expect(items[0].inverse).toMatchObject({ op: 'update', key: 'casual' });
    await ok(CHAIRMAN, 'POST', `/designer/changesets/${cs.id}/revert`);
    expect(canonical(await leaveRow(demoOrg, 'casual'))).toBe(canonical(before));
  });

  it('undo refuses when the configuration was changed since publishing', async () => {
    const cs = await ok(CHAIRMAN, 'POST', '/designer/plan', { prompt: 'Daily opening checklist for housekeeping at 7:15' });
    expect(cs.plan.ops[0]).toMatchObject({ block: 'os.checklist' });
    await ok(CHAIRMAN, 'POST', `/designer/changesets/${cs.id}/publish`);
    await asOwner((c) => c.query(`update os.checklist_templates set name = 'Renamed by hand' where org_id = $1 and key = 'daily_opening' and deleted_at is null`, [demoOrg]));
    const r = await call(CHAIRMAN, 'POST', `/designer/changesets/${cs.id}/revert`);
    expect(r.status).toBe(409);
    expect(r.json.error).toBe('changed_since_publish');
  });

  it('CRM and ERP requests of an OS-only school come back as "not in your plan" notes and cannot be published', async () => {
    const fee = await ok(CHAIRMAN, 'POST', '/designer/plan', { prompt: 'fee concession above 10% needs director approval' });
    expect(fee.plan.ops).toEqual([]);
    expect(fee.plan.unsupported[0].product).toBe('erp');
    expect(fee.status).toBe('draft');
    const crm = await ok(CHAIRMAN, 'POST', '/designer/plan', { prompt: 'new enquiry follow-up within 24h' });
    expect(crm.plan.unsupported[0].product).toBe('crm');
    expect((await call(CHAIRMAN, 'POST', `/designer/changesets/${crm.id}/publish`)).status).toBe(409);
    await ok(CHAIRMAN, 'POST', `/designer/changesets/${crm.id}/discard`);
  });

  it('explain my school summarises the configuration in plain language', async () => {
    const e = await ok(CHAIRMAN, 'GET', '/designer/explain');
    expect(e.text[0]).toContain('Demo International School');
    expect(e.text.join('\n')).toMatch(/approval types/);
  });
});

describe('designer: who may use it', () => {
  it('a teacher is refused', async () => {
    for (const [m, p, b] of [['GET', '/designer/changesets'], ['POST', '/designer/plan', { prompt: ABSENCE }], ['GET', '/designer/explain']] as const) {
      const r = await call(TEACHER, m, p, b);
      expect(r.status, p).toBe(403);
      expect(r.json.error).toBe('designer_management_only');
    }
    expect((await ok(TEACHER, 'GET', '/designer/whoami')).kind).toBe('none');
  });

  it('an AutoEd relationship manager without a support session is refused; read-only view-as cannot plan', async () => {
    expect((await call(RM, 'POST', '/designer/plan', { prompt: ABSENCE })).json.error).toBe('support_session_required');
    expect((await ok(RM, 'GET', '/designer/whoami')).needs_session).toBe(true);
    const ro = await ok(RM, 'POST', '/admin/view-as', { org_id: demoOrg, reason: 'Looking at setup with the school', minutes: 15 });
    const r = await call(RM, 'POST', '/designer/plan', { prompt: ABSENCE }, { 'x-view-as': ro.session_id });
    expect(r.status).toBe(403);
    expect(r.json.error).toBe('view_as_is_read_only');
    // reading is fine inside any open session
    expect((await call(RM, 'GET', '/designer/changesets', undefined, { 'x-view-as': ro.session_id })).status).toBe(200);
    // a reason is required for a designer session
    expect((await call(RM, 'POST', '/designer/support-session', { org_id: demoOrg, reason: 'short', minutes: 30 })).status).toBe(422);
  });

  it('inside a read-write support session the RM plans and publishes, audited as the RM with the session', async () => {
    const s = await ok(RM, 'POST', '/designer/support-session', { org_id: demoOrg, reason: 'School visit: setting up housekeeping checklists', minutes: 30 });
    const h = { 'x-view-as': s.session_id };
    const who = await ok(RM, 'GET', '/designer/whoami', undefined, h);
    expect(who).toMatchObject({ kind: 'relationship_manager', read_only: false, support_session_id: s.session_id });
    const cs = await ok(RM, 'POST', '/designer/plan', { prompt: 'Purchases above 25,000 need director approval' }, h);
    expect(cs).toMatchObject({ status: 'validated', author_kind: 'relationship_manager', support_session_id: s.session_id, author_user_id: rmUser });
    await ok(RM, 'POST', `/designer/changesets/${cs.id}/publish`, undefined, h);
    const t = await approvalLive(demoOrg, 'purchase_approval');
    expect(t).not.toBeNull();
    const audit = await asOwner((c) => q<{ actor_user_id: string; support_session_id: string }>(c, `select actor_user_id, support_session_id from audit.log where table_name = 'approval_types' and row_id = $1 and action = 'insert'`, [t!.id]));
    expect(audit).toEqual([{ actor_user_id: rmUser, support_session_id: s.session_id }]);
    const csAudit = await asOwner((c) => q<{ support_session_id: string }>(c, `select support_session_id from audit.log where table_name = 'design_changesets' and row_id = $1`, [cs.id]));
    expect(csAudit.length).toBeGreaterThan(0);
    expect(csAudit.every((a) => a.support_session_id === s.session_id)).toBe(true);
    // the school's management sees the RM's change in its history
    expect((await ok(CHAIRMAN, 'GET', '/designer/changesets')).find((x: any) => x.id === cs.id)).toMatchObject({ author_kind: 'relationship_manager', status: 'published' });
    await ok(RM, 'POST', `/designer/changesets/${cs.id}/revert`, undefined, h);
    await ok(RM, 'POST', '/designer/support-session/end');
    expect((await call(RM, 'GET', '/designer/changesets', undefined, h)).status).toBe(401);
  });
});

describe('designer: isolation and privacy', () => {
  it('another school cannot see or act on this school\'s changesets', async () => {
    const mine = await ok(CHAIRMAN, 'GET', '/designer/changesets');
    expect(mine.length).toBeGreaterThan(0);
    const theirs = await ok(OTHER_CHAIRMAN, 'GET', '/designer/changesets');
    expect(theirs.some((x: any) => mine.some((m: any) => m.id === x.id))).toBe(false);
    expect((await call(OTHER_CHAIRMAN, 'GET', `/designer/changesets/${mine[0].id}`)).status).toBe(404);
    expect((await call(OTHER_CHAIRMAN, 'POST', `/designer/changesets/${mine[0].id}/revert`)).status).toBe(404);
    const otherUser = (await asOwner((c) => one<{ id: string }>(c, `select id from auth.users where email = $1`, [OTHER_CHAIRMAN]))).id;
    const n = await asUser({ userId: otherUser }, (c) => one<{ n: number }>(c, `select count(*)::int as n from core.design_changesets where org_id = $1`, [demoOrg]));
    expect(n.n).toBe(0);
    const items = await asUser({ userId: otherUser }, (c) => one<{ n: number }>(c, `select count(*)::int as n from core.design_changeset_items where org_id = $1`, [demoOrg]));
    expect(items.n).toBe(0);
  });

  it('the AI provider receives no personal data: no staff, student or guardian names, phones or e-mails', async () => {
    const staff = await asOwner((c) => q<{ full_name: string; phone: string | null; email: string | null }>(c, `select full_name, phone, email from core.staff where org_id = $1`, [demoOrg]));
    const students = await asOwner((c) => q<{ full_name: string }>(c, `select full_name from core.students where org_id = $1`, [demoOrg]));
    const guardians = await asOwner((c) => q<{ name: string; phone: string | null }>(c, `select name, phone from core.guardians where org_id = $1`, [demoOrg]));
    const named = staff.find((s) => s.full_name.split(' ').length > 1 && s.full_name.length > 8)!;
    const pupil = students[0]!.full_name;
    seen.length = 0;
    const cs = await ok(CHAIRMAN, 'POST', '/designer/plan', { prompt: `Every Friday the admin officer checks fire extinguishers by 3 pm; ${named.full_name} (${named.phone ?? '+919876543210'}, ${named.email ?? 'x@y.in'}) checks ${pupil}'s bus` });
    expect(cs.status).toBe('validated');
    expect(seen.length).toBe(1);
    const sent = `${seen[0]!.system}\n${seen[0]!.prompt}\n${JSON.stringify(seen[0]!.mockContext)}`;
    const leaks: string[] = [];
    const word = (s: string) => new RegExp(`\\b${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    for (const s of staff) {
      if (word(s.full_name).test(sent)) leaks.push(s.full_name);
      if (s.email && sent.includes(s.email)) leaks.push(s.email);
      if (s.phone && sent.includes(s.phone.replace(/^\+/, ''))) leaks.push(s.phone);
    }
    for (const s of students) if (word(s.full_name).test(sent)) leaks.push(s.full_name);
    for (const g of guardians) if (g.name.length > 3 && word(g.name).test(sent)) leaks.push(g.name);
    expect(leaks).toEqual([]);
    expect(sent).not.toMatch(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    expect(seen[0]!.prompt).toContain('[phone]');
    expect(seen[0]!.prompt).toMatch(/T-\d/);
    // the catalogue and configuration summary are there (names and keys only)
    expect(seen[0]!.system).toContain('os.approval_type');
    expect(seen[0]!.system).toContain('academic_coordinator');
    expect(seen[0]!.schema).toHaveProperty('properties.ops');
  });
});
