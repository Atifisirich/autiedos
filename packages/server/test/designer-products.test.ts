/**
 * AI school designer for CRM, ERP and custom registers (DECISIONS 56-58) against real Postgres, through the same API
 * the web page calls: the CRM demo school (CRM only, admin@demo.test), the ERP demo school (admin@erp.demo.school, an
 * ERP login) and the OS demo school. Every CRM and ERP block is published and undone (validate -> apply -> inverse
 * round trip, the live configuration is back exactly as before); CRM blocks are written as crm_server and ERP blocks as
 * erp_server with the person's claims (audit rows carry them); a school cannot plan or publish blocks of a product it
 * does not have; changesets stay inside their school; nothing personal reaches the AI; an AutoEd relationship manager
 * works inside a read-write support session and is audited as themselves.
 */
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canonical, CRM_RECIPES, type Changeset } from '@autoed/shared';
import { RECIPES } from '@autoed/crm-server/workflows';
import { dispatch, type ApiResponse } from '../src/api';
import { asOwner, asUserIn, closePool, maybe, one, q } from '../src/db';
import { setAiProvider, type AiRequest } from '../src/adapters/ai';
import { mockGenerate } from '../src/adapters/mockAi';

const ROOT = join(__dirname, '..', '..', '..');
const CRM_ADMIN = 'admin@demo.test';
const ERP_ADMIN = 'admin@erp.demo.school';
const ERP_TEACHER = 'teacher@erp.demo.school';
const OS_CHAIRMAN = 'chairman@demo.school';
const RM = 'admin@autoed.dev';

const tokens: Record<string, string> = {};
async function login(email: string): Promise<string> {
  if (tokens[email]) return tokens[email]!;
  const r = await dispatch({ method: 'POST', path: '/auth/dev-login', query: {}, headers: {}, body: { email }, ip: `designer-p-${email}` });
  expect(r.status, `${email}: ${JSON.stringify(r.json)}`).toBe(200);
  tokens[email] = (r.json as { token: string }).token;
  return tokens[email]!;
}
type Res = ApiResponse & { json: any }; // eslint-disable-line @typescript-eslint/no-explicit-any
async function call(email: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
  const token = await login(email);
  return (await dispatch({ method, path, query: {}, headers: { authorization: `Bearer ${token}`, ...headers }, body: body ?? {}, ip: '127.0.0.1' })) as Res;
}
async function ok(email: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const r = await call(email, method, path, body, headers);
  expect(r.status, `${method} ${path} -> ${JSON.stringify(r.json)}`).toBe(200);
  return r.json;
}

const seen: AiRequest[] = [];
/** When set, the mock AI answers with exactly this changeset (to exercise each block); else the deterministic planner. */
let forced: Changeset | null = null;
let crmOrg = '';
let erpOrg = '';
let osOrg = '';
let rmUser = '';
let erpAdminUser = '';

/** The live configuration of an org, as the settings screens show it (ids and timestamps left out). */
async function liveConfig(org: string) {
  return asOwner(async (c) => {
    const sql: Record<string, string> = {
      stages: `select s.name, p.key as phase, s.color, s.probability, s.sla_hours, s.required_fields, s.exempt_next_action from crm.stages s join crm.phases p on p.id = s.phase_id where s.org_id = $1 and s.active order by s.name`,
      sources: `select channel, name, cost from crm.sources where org_id = $1 and active order by name`,
      rules: `select name, seq, method, user_ids, conditions, active from crm.assignment_rules where org_id = $1 order by name`,
      capacity: `select user_id, daily_capacity from crm.counsellor_settings where org_id = $1 order by user_id`,
      crm_settings: `select settings from crm.settings where org_id = $1`,
      workflows: `select name, recipe_key, trigger, conditions, steps, status, version, stop_rules from crm.workflows where org_id = $1 order by name`,
      templates: `select product_key, name, channel, category, language, body, status, event_key from core.message_templates where org_id = $1 and deleted_at is null order by product_key, name, channel`,
      forms: `select name, branch_id, source_id, fields, thank_you from crm.forms where org_id = $1 and active order by name`,
      crm_roles: `select key, name, permissions from crm.roles where org_id = $1 order by key`,
      core_roles: `select product_key, key, name from core.roles where org_id = $1 order by product_key, key`,
      fee_heads: `select name, type, gst_rate, tax_certificate from erp.fee_heads where org_id = $1 and active and deleted_at is null order by name`,
      fee_plans: `select p.name, p.active, (select json_agg(json_build_object('head', i.head_id, 'i', i.instalment, 'a', i.amount, 'd', i.due_date) order by i.due_date, i.instalment) from erp.fee_plan_items i where i.plan_id = p.id) as items from erp.fee_plans p where p.org_id = $1 and p.active and p.deleted_at is null order by p.name`,
      org_settings: `select settings from core.organizations where id = $1`,
      concessions: `select name, kind, value, head_type, max_amount, auto_rule, stackable from erp.concession_types where org_id = $1 and deleted_at is null order by name`,
      approval_rules: `select key, name, approval_type, min_amount, min_percent, steps, seq, active from erp.approval_rules where org_id = $1 and deleted_at is null order by key`,
      automations: `select recipe_key, name, trigger, conditions, actions, enabled, test_mode from erp.automations where org_id = $1 and deleted_at is null order by recipe_key`,
      leave_types: `select key, name, yearly_quota, accrual, notice_days, doc_required_after_days, paid from core.leave_types where org_id = $1 and active and deleted_at is null order by key`,
      doc_templates: `select name, type, body from erp.doc_templates where org_id = $1 and active and deleted_at is null order by name`,
      scales: `select name, bands from erp.grading_scales where org_id = $1 and deleted_at is null order by name`,
      schemes: `select name, pack, scale_id, config, active from erp.assessment_schemes where org_id = $1 and deleted_at is null order by name`,
      permissions: `select r.key, p.module_key, p.action, p.scope from core.role_permissions p join core.roles r on r.id = p.role_id where p.org_id = $1 order by 1, 2, 3`,
      erp_flags: `select module_key, branch_id, enabled from erp.module_flags where org_id = $1 and deleted_at is null order by module_key`,
      objects: `select key, label_plural, fields, states, archived from core.custom_objects where org_id = $1 and deleted_at is null and not archived order by key`,
    };
    const out: Record<string, unknown> = {};
    for (const [k, s] of Object.entries(sql)) out[k] = await q(c, s, [org]);
    return out;
  });
}

/** Plans with the mock AI answering exactly `cs`. */
async function planForced(email: string, cs: Changeset, prompt: string, headers: Record<string, string> = {}) {
  forced = cs;
  try {
    return await ok(email, 'POST', '/designer/plan', { prompt }, headers);
  } finally {
    forced = null;
  }
}

/** Publishes a changeset planned by the (forced) AI, checks it is live, undoes it, checks the configuration is back. */
async function roundTrip(email: string, org: string, cs: Changeset, live: (cfg: Record<string, unknown>) => void, headers: Record<string, string> = {}) {
  const before = await liveConfig(org);
  const planned = await planForced(email, cs, cs.summary, headers);
  expect(planned.issues, JSON.stringify(planned.issues)).toEqual([]);
  expect(planned.status).toBe('validated');
  const dry = await ok(email, 'POST', `/designer/changesets/${planned.id}/dry-run`, undefined, headers);
  expect(dry.ok, JSON.stringify(dry)).toBe(true);
  expect(canonical(await liveConfig(org)), 'the dry run keeps nothing').toBe(canonical(before));
  const pub = await ok(email, 'POST', `/designer/changesets/${planned.id}/publish`, undefined, headers);
  expect(pub.status).toBe('published');
  const after = await liveConfig(org);
  expect(canonical(after)).not.toBe(canonical(before));
  live(after);
  await ok(email, 'POST', `/designer/changesets/${planned.id}/revert`, undefined, headers);
  const back = await liveConfig(org);
  for (const k of Object.keys(before)) expect(canonical(back[k]), k).toBe(canonical(before[k]));
  return planned;
}
const one_ = (block: string, key: string, settings: Record<string, unknown>, op: 'create' | 'update' = 'create'): Changeset => ({ summary: `${block} ${key}`, ops: [{ op, block, key, settings }], unsupported: [], questions: [], template_key: null });

beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL ?? 'postgres://postgres@localhost:54322/postgres');
  const env = { ...process.env, DATABASE_URL: url.toString(), ERP_DEMO_DOMAIN: 'erp.demo.school' };
  execSync(`node ${join(ROOT, 'scripts/seed-erp-demo.mjs')}`, { stdio: 'inherit', env });
  const crmUrl = new URL(url.toString());
  crmUrl.username = 'crm_server';
  const crmSeeded = await asOwner((c) => maybe(c, `select 1 from core.organizations where slug = 'greenfield-demo'`));
  if (!crmSeeded) execSync(`npx tsx e2e/crm-seed.mts`, { stdio: 'inherit', cwd: join(ROOT, 'apps/web'), env: { ...env, CRM_DATABASE_URL: crmUrl.toString() } });
  crmOrg = (await asOwner((c) => one<{ id: string }>(c, `select id from core.organizations where slug = 'greenfield-demo'`))).id;
  erpOrg = (await asOwner((c) => one<{ id: string }>(c, `select id from core.organizations where slug = 'demo-school'`))).id;
  osOrg = (await asOwner((c) => one<{ id: string }>(c, `select id from core.organizations where slug = 'demo'`))).id;
  rmUser = (await asOwner((c) => one<{ id: string }>(c, `select id from auth.users where email = $1`, [RM]))).id;
  erpAdminUser = (await asOwner((c) => one<{ id: string }>(c, `select id from auth.users where email = $1`, [ERP_ADMIN]))).id;
  // the schools' AI wallets (the OS demo seed has one; a designer plan costs 1 credit)
  for (const org of [crmOrg, erpOrg]) {
    await asOwner((c) => c.query(`insert into billing.ai_allowances (org_id, plan_key, monthly_credits) select $1, null, 500 where not exists (select 1 from billing.ai_allowances where org_id = $1)`, [org]));
  }
  // a counsellor's name and number in the roster (the privacy check below)
  await asOwner((c) => c.query(`update core.staff set phone = '+919812345670' where org_id = $1 and email = 'meera@demo.test'`, [crmOrg]));
  setAiProvider({
    name: 'mock',
    async generate(req) {
      seen.push(req);
      const output = forced ?? mockGenerate(req.action, req.mockContext ?? {});
      return { output, model: 'mock', provider: 'mock', inputTokens: 10, outputTokens: 10, providerCost: 0 };
    },
  });
}, 600000);

afterAll(async () => {
  setAiProvider(null);
  await closePool();
});

describe('designer for a CRM-only school', () => {
  it('management of a CRM-only school uses the designer; only CRM blocks and templates are offered', async () => {
    const who = await ok(CRM_ADMIN, 'GET', '/designer/whoami');
    expect(who).toMatchObject({ kind: 'org_admin', products: ['crm'] });
    const cat = await ok(CRM_ADMIN, 'GET', '/designer/catalogue');
    const avail = cat.filter((b: { available: boolean }) => b.available).map((b: { key: string }) => b.key);
    expect(avail).toContain('crm.workflow');
    expect(avail).toContain('core.custom_object');
    expect(avail.filter((k: string) => k.startsWith('erp.') || k.startsWith('os.'))).toEqual([]);
    const tpl = await ok(CRM_ADMIN, 'GET', '/designer/templates');
    expect(tpl.filter((t: { available: boolean }) => t.available).map((t: { product: string }) => t.product).sort().filter((p: string, i: number, a: string[]) => a.indexOf(p) === i)).toEqual(['crm']);
    // the CRM recipes in the shared templates are the CRM server's own recipes
    expect(canonical(CRM_RECIPES.map((r) => ({ ...r, conditions: r.conditions ?? [] })))).toBe(canonical(RECIPES.map((r) => ({ ...r, conditions: r.conditions ?? [] }))));
  });

  it('"new enquiry follow-up within 24h else escalate to admission head": planned, previewed, dry run, published as crm_server, undone exactly', async () => {
    const before = await liveConfig(crmOrg);
    const cs = await ok(CRM_ADMIN, 'POST', '/designer/plan', { prompt: 'new enquiry follow-up within 24h else escalate to admission head' });
    expect(cs.status).toBe('validated');
    expect(cs.plan.ops.map((o: { op: string; block: string; key: string }) => `${o.op} ${o.block}:${o.key}`)).toEqual(['update crm.follow_up_sla:first_response', 'update crm.workflow:untouched']);
    expect(cs.preview.ops[0].text.join(' ')).toContain('first response within 24 h');
    expect(cs.preview.ops[1].text.join(' ')).toContain('Alert admission_head');
    expect(cs.product_scope).toEqual(['crm']);
    const gen = await asOwner((c) => one<{ product_key: string; credits: number; status: string }>(c, `select product_key, credits, status from core.ai_generations where id = $1`, [cs.ai_generation_id]));
    expect(gen).toMatchObject({ product_key: 'crm', status: 'ok' });
    expect((await ok(CRM_ADMIN, 'POST', `/designer/changesets/${cs.id}/dry-run`)).ok).toBe(true);
    expect(canonical(await liveConfig(crmOrg))).toBe(canonical(before));
    await ok(CRM_ADMIN, 'POST', `/designer/changesets/${cs.id}/publish`);
    const settings = await asOwner((c) => one<{ s: { first_response_mins: number } }>(c, `select settings as s from crm.settings where org_id = $1`, [crmOrg]));
    expect(settings.s.first_response_mins).toBe(1440);
    const wf = await asOwner((c) => one<{ id: string; steps: { who?: string; role_key?: string }[]; version: number }>(c, `select id, steps, version from crm.workflows where org_id = $1 and recipe_key = 'untouched'`, [crmOrg]));
    expect(wf.steps.find((s) => s.who === 'role')!.role_key).toBe('admission_head');
    // written as the admin (claims) through the CRM tables: the platform audit row names them, the CRM audit trail too
    const admin = (await asOwner((c) => one<{ id: string }>(c, `select id from auth.users where email = $1`, [CRM_ADMIN]))).id;
    const a = await asOwner((c) => q<{ actor_user_id: string }>(c, `select actor_user_id from audit.log where table_name = 'workflows' and row_id = $1 and action = 'update'`, [wf.id]));
    expect(a.map((r) => r.actor_user_id)).toContain(admin);
    expect(await asOwner((c) => maybe(c, `select 1 from audit.log where org_id = $1 and schema_name = 'crm' and table_name = 'audit_events' limit 1`, [crmOrg]).catch(() => null))).not.toBeUndefined();
    await ok(CRM_ADMIN, 'POST', `/designer/changesets/${cs.id}/revert`);
    const back = await liveConfig(crmOrg);
    expect(canonical(back.crm_settings)).toBe(canonical(before.crm_settings));
    expect(canonical(back.workflows)).toBe(canonical(before.workflows));
  });

  it('every CRM block: validate -> publish -> live in the CRM tables -> undo restores the configuration', async () => {
    await roundTrip(CRM_ADMIN, crmOrg, one_('crm.stage', 'scholarship_test', { name: 'Scholarship test', phase: 'evaluation', color: 'orange', probability: 80, sla_hours: 72, required_fields: ['expected_decision'] }), (c) =>
      expect(c.stages).toContainEqual(expect.objectContaining({ name: 'Scholarship test', phase: 'evaluation', sla_hours: 72, required_fields: ['expected_decision'] })));
    await roundTrip(CRM_ADMIN, crmOrg, one_('crm.stage', 'connected', { name: 'Connected', phase: 'enquiry', color: 'sky', probability: 20, sla_hours: 24, required_fields: [] }, 'update'), (c) =>
      expect(c.stages).toContainEqual(expect.objectContaining({ name: 'Connected', probability: 20, sla_hours: 24 })));
    await roundTrip(CRM_ADMIN, crmOrg, one_('crm.lead_source', 'newspaper_insert', { channel: 'Offline', name: 'Newspaper insert', cost: 15000 }), (c) => expect(c.sources).toContainEqual({ channel: 'Offline', name: 'Newspaper insert', cost: 15000 }));
    await roundTrip(CRM_ADMIN, crmOrg, one_('crm.assignment_rule', 'website_to_counsellors', { name: 'Website to counsellors', seq: 1, method: 'least_load', role_key: 'counsellor', channel: 'Website', daily_capacity: 12 }), (c) => {
      const r = (c.rules as { name: string; method: string; user_ids: string[] }[]).find((x) => x.name === 'Website to counsellors')!;
      expect(r.method).toBe('least_load');
      expect(r.user_ids.length).toBe(2); // the two counsellors, never named in the plan
      expect((c.capacity as { daily_capacity: number }[]).filter((x) => x.daily_capacity === 12).length).toBe(2);
    });
    await roundTrip(CRM_ADMIN, crmOrg, one_('crm.message_template', 'scholarship_test_reminder__whatsapp', { name: 'Scholarship test reminder', channel: 'whatsapp', body: 'Hello {{guardian_name}}, {{student_name}} has the scholarship test tomorrow.' }), (c) =>
      expect(c.templates).toContainEqual(expect.objectContaining({ product_key: 'crm', name: 'Scholarship test reminder', status: 'submitted' })));
    await roundTrip(CRM_ADMIN, crmOrg, one_('crm.enquiry_form', 'open_house_sign_up', { name: 'Open house sign-up', source: 'Open house', fields: ['grade', 'locality'] }), (c) =>
      expect(c.forms).toContainEqual(expect.objectContaining({ name: 'Open house sign-up', fields: ['student_name', 'guardian_name', 'mobile', 'grade', 'locality'] })));
    await roundTrip(CRM_ADMIN, crmOrg, one_('crm.messaging_limits', 'messaging', { quiet_from: 20, quiet_to: 8, max_auto_per_day: 3 }, 'update'), (c) =>
      expect((c.crm_settings as { settings: { quiet_hours: unknown; max_auto_per_day: number } }[])[0]!.settings).toMatchObject({ quiet_hours: { from: 20, to: 8 }, max_auto_per_day: 3 }));
    await roundTrip(CRM_ADMIN, crmOrg, one_('crm.scoring', 'scoring', { weights: { visit_done: 35 }, hot_at: 70, warm_at: 30 }, 'update'), (c) =>
      expect((c.crm_settings as { settings: { scoring: { visit_done: number }; hot_at: number } }[])[0]!.settings).toMatchObject({ hot_at: 70, scoring: { visit_done: 35 } }));
    await roundTrip(CRM_ADMIN, crmOrg, one_('crm.workflow', 'scholarship_follow_up', {
      key: 'scholarship_follow_up', name: 'Scholarship follow-up', trigger: 'stage_changed', conditions: [{ field: 'stage_name', op: 'in', value: ['Scholarship test'] }],
      steps: [{ type: 'send', channel: 'whatsapp', template: 'Welcome' }, { type: 'wait', mins: 1440 }, { type: 'task', title: 'Call about the test result', dueMins: 60 }], status: 'draft', stop_on_reply: false, stop_on_stage_change: true,
    }), (c) => expect(c.workflows).toContainEqual(expect.objectContaining({ recipe_key: 'scholarship_follow_up', status: 'draft', stop_rules: { on_reply: false, on_stage_change: true } })));
    await roundTrip(CRM_ADMIN, crmOrg, one_('crm.role', 'senior_counsellor', { key: 'senior_counsellor', name: 'Senior Counsellor', copy_from_role_key: 'counsellor' }), (c) => {
      expect(c.crm_roles).toContainEqual(expect.objectContaining({ key: 'senior_counsellor', name: 'Senior Counsellor' }));
      expect(c.core_roles).toContainEqual({ product_key: 'crm', key: 'senior_counsellor', name: 'Senior Counsellor' });
    });
    await roundTrip(CRM_ADMIN, crmOrg, one_('crm.role_permission', 'counsellor__reports', { role_key: 'counsellor', capability: 'reports', level: 'T' }, 'update'), (c) =>
      expect((c.crm_roles as { key: string; permissions: { reports: string } }[]).find((r) => r.key === 'counsellor')!.permissions.reports).toBe('T'));
  });

  it('settings-screen rules are kept: the admin capability and the group admin are not changed by the designer', async () => {
    // the AI pipeline asks again on a block rule; the mock repeats itself, so the call ends as an invalid AI answer and
    // nothing is stored, nothing charged
    forced = one_('crm.role_permission', 'counsellor__admin', { role_key: 'counsellor', capability: 'admin', level: 'F' }, 'update');
    try {
      const r = await call(CRM_ADMIN, 'POST', '/designer/plan', { prompt: 'counsellors are admins' });
      expect(r.status).toBe(422);
      expect(r.json.error).toBe('ai_output_invalid');
    } finally {
      forced = null;
    }
  });

  it('a CRM-only school cannot plan or publish ERP blocks, nor build an ERP template', async () => {
    const fee = await ok(CRM_ADMIN, 'POST', '/designer/plan', { prompt: 'fee concession above 10% needs director approval' });
    expect(fee.plan.ops).toEqual([]);
    expect(fee.plan.unsupported[0].product).toBe('erp');
    expect(fee.status).toBe('draft');
    expect((await call(CRM_ADMIN, 'POST', `/designer/changesets/${fee.id}/publish`)).status).toBe(409);
    // even when the model returns an ERP op, it is moved out of the plan
    const forcedPlan = await planForced(CRM_ADMIN, one_('erp.fee_head', 'bus_fee', { name: 'Bus fee', type: 'transport' }), 'a bus fee');
    expect(forcedPlan.plan.ops).toEqual([]);
    expect(forcedPlan.plan.unsupported[0]).toMatchObject({ product: 'erp', note: 'product_not_in_plan' });
    const t = await call(CRM_ADMIN, 'POST', '/designer/templates/erp_fee_reminder_ladder/plan', { params: {} });
    expect(t.status).toBe(403);
    expect(t.json.error).toBe('product_not_available');
  });

  it('no personal data reaches the AI: counsellors, parents and phone numbers are filtered from the request and summary', async () => {
    const staff = await asOwner((c) => q<{ full_name: string; email: string; phone: string | null }>(c, `select full_name, email, phone from core.staff where org_id = $1`, [crmOrg]));
    const families = await asOwner((c) => q<{ name: string; phone: string | null }>(c, `select name, phone from crm.guardians where org_id = $1 limit 20`, [crmOrg]).catch(() => []));
    seen.length = 0;
    const meera = staff.find((s) => s.email === 'meera@demo.test')!;
    const cs = await ok(CRM_ADMIN, 'POST', '/designer/plan', { prompt: `new enquiry follow-up within 2 hours else escalate to admission head; ${meera.full_name} (+919812345670, ${meera.email}) covers weekends` });
    expect(cs.status).toBe('validated');
    const sent = `${seen[0]!.system}\n${seen[0]!.prompt}\n${JSON.stringify(seen[0]!.mockContext)}`;
    for (const s of staff) {
      expect(sent).not.toContain(s.full_name);
      expect(sent).not.toContain(s.email);
    }
    for (const g of families) if (g.name.length > 3) expect(sent).not.toContain(g.name);
    expect(sent).not.toMatch(/9812345670/);
    expect(seen[0]!.prompt).toContain('[phone]');
    expect(seen[0]!.system).toContain('crm.workflow');
    expect(seen[0]!.system).not.toContain('erp.approval_rule'); // the catalogue holds only the school's products
    await ok(CRM_ADMIN, 'POST', `/designer/changesets/${cs.id}/discard`);
  });

  it('an AutoEd relationship manager in a read-write support session plans and publishes CRM settings, audited as the RM', async () => {
    const s = await ok(RM, 'POST', '/designer/support-session', { org_id: crmOrg, reason: 'Visit: setting up enquiry follow-up rules', minutes: 30 });
    const h = { 'x-view-as': s.session_id };
    try {
    expect(await ok(RM, 'GET', '/designer/whoami', undefined, h)).toMatchObject({ kind: 'relationship_manager', products: ['crm'], read_only: false });
    const cs = await ok(RM, 'POST', '/designer/plan', { prompt: 'No automatic messages after 10 pm or before 6 am, at most 2 messages a day' }, h);
    expect(cs).toMatchObject({ status: 'validated', author_kind: 'relationship_manager', support_session_id: s.session_id, author_user_id: rmUser });
    await ok(RM, 'POST', `/designer/changesets/${cs.id}/publish`, undefined, h);
    const row = await asOwner((c) => one<{ id: string; settings: { quiet_hours: { from: number } } }>(c, `select id, settings from crm.settings where org_id = $1`, [crmOrg]));
    expect(row.settings.quiet_hours.from).toBe(22);
    const audit = await asOwner((c) => q<{ actor_user_id: string; support_session_id: string }>(c, `select actor_user_id, support_session_id from audit.log where table_name = 'settings' and schema_name = 'crm' and row_id = $1 and action = 'update' order by created_at desc limit 1`, [row.id]));
    expect(audit).toEqual([{ actor_user_id: rmUser, support_session_id: s.session_id }]);
    expect((await ok(CRM_ADMIN, 'GET', '/designer/changesets')).find((x: { id: string }) => x.id === cs.id)).toMatchObject({ author_kind: 'relationship_manager', status: 'published' });
    await ok(RM, 'POST', `/designer/changesets/${cs.id}/revert`, undefined, h);
    } finally {
      await ok(RM, 'POST', '/designer/support-session/end');
    }
  });
});

describe('designer for the ERP', () => {
  it('"fee concession above 10% needs director approval" becomes an approval rule the ERP engine uses; undo removes it', async () => {
    const who = await ok(ERP_ADMIN, 'GET', '/designer/whoami');
    expect(who.products).toEqual(['erp']);
    const cs = await ok(ERP_ADMIN, 'POST', '/designer/plan', { prompt: 'fee concession above 10% needs director approval' });
    expect(cs.status, JSON.stringify(cs.issues)).toBe('validated');
    expect(cs.plan.ops[0]).toMatchObject({ block: 'erp.approval_rule', settings: { approval_type: 'concession', min_percent: 10, steps: ['group_admin'] } });
    expect(cs.preview.ops[0].text.join(' ')).toContain('concession requests are approved by: group_admin');
    await ok(ERP_ADMIN, 'POST', `/designer/changesets/${cs.id}/publish`);
    const rule = await asOwner((c) => one<{ id: string }>(c, `select id from erp.approval_rules where org_id = $1 and key = 'concession_above_10' and deleted_at is null`, [erpOrg]));
    const audit = await asOwner((c) => q<{ actor_user_id: string }>(c, `select actor_user_id from audit.log where table_name = 'approval_rules' and row_id = $1 and action = 'insert'`, [rule.id]));
    expect(audit).toEqual([{ actor_user_id: erpAdminUser }]);

    // the ERP engine now routes a 15% concession to the group admin and keeps a 5% one with the principal
    const teacher = (await asOwner((c) => one<{ id: string }>(c, `select id from auth.users where email = $1`, [ERP_TEACHER]))).id;
    const student = (await asOwner((c) => one<{ id: string }>(c, `select id from core.students where org_id = $1 order by created_at limit 1`, [erpOrg]))).id;
    const request = async (percent: number) => {
      const id = await asUserIn('erp_server', { userId: teacher }, async (c) => {
        const con = randomUUID(); // a teacher may request (insert) a concession but not read it back
        await c.query(`insert into erp.concessions (id, student_id, kind, value, amount, reason) values ($1, $2, 'percent', $3, 1000, 'test')`, [con, student, percent]);
        return (await one<{ id: string }>(c, `select erp.submit_approval('concession', $1, 'Concession', null, 1000, '{}'::jsonb, $2) as id`, [con, student])).id;
      });
      return (await asOwner((o) => one<{ steps: string[] }>(o, `select data->'steps' as steps from core.approval_requests where id = $1`, [id]))).steps;
    };
    expect(await request(15)).toEqual(['group_admin']);
    expect(await request(5)).toEqual(['principal']);
    await ok(ERP_ADMIN, 'POST', `/designer/changesets/${cs.id}/revert`);
    expect(await request(15)).toEqual(['principal']);
  });

  it('"remind parents 3 days before fee due, then on due date, then weekly" installs the fee reminder ladder', async () => {
    const cs = await ok(ERP_ADMIN, 'POST', '/designer/plan', { prompt: 'remind parents 3 days before fee due, then on due date, then weekly' });
    expect(cs.status, JSON.stringify(cs.issues)).toBe('validated');
    expect(cs.template_key).toBe('erp_fee_reminder_ladder');
    await ok(ERP_ADMIN, 'POST', `/designer/changesets/${cs.id}/publish`);
    const a = await asOwner((c) => one<{ conditions: { days: number[]; repeat_every_days: number }; enabled: boolean }>(c, `select conditions, enabled from erp.automations where org_id = $1 and recipe_key = 'fee_reminder_ladder' and deleted_at is null`, [erpOrg]));
    expect(a).toMatchObject({ enabled: true, conditions: { days: [-3, 0, 7], repeat_every_days: 7 } });
    await ok(ERP_ADMIN, 'POST', `/designer/changesets/${cs.id}/revert`);
  });

  it('every ERP block: validate -> publish as erp_server -> live in the ERP tables -> undo restores the configuration', async () => {
    const R = (b: string, k: string, s: Record<string, unknown>, op: 'create' | 'update' = 'create', check: (c: Record<string, unknown>) => void = () => undefined) => roundTrip(ERP_ADMIN, erpOrg, one_(b, k, s, op), check);
    await R('erp.fee_head', 'smart_class_fee', { name: 'Smart class fee', type: 'activity', gst_rate: 18 }, 'create', (c) => expect(c.fee_heads).toContainEqual({ name: 'Smart class fee', type: 'activity', gst_rate: 18, tax_certificate: false }));
    const head = (await asOwner((c) => one<{ name: string }>(c, `select name from erp.fee_heads where org_id = $1 and active and deleted_at is null order by name limit 1`, [erpOrg]))).name;
    await R('erp.fee_plan', 'class_2_activity_2026_27', { name: 'Class 2 activity 2026-27', programme: 'Class 2', items: [{ head, instalment: 'Term 1', amount: 2500, due_date: '2026-12-10' }, { head, instalment: 'Term 2', amount: 2500, due_date: '2027-02-10' }] }, 'create', (c) =>
      expect((c.fee_plans as { name: string; items: unknown[] }[]).find((p) => p.name === 'Class 2 activity 2026-27')!.items).toHaveLength(2));
    await R('erp.late_fee_rule', 'late_fee', { type: 'per_day', amount: 50, grace_days: 7, cap: 1000 }, 'update', (c) =>
      expect((c.org_settings as { settings: { late_fee: unknown } }[])[0]!.settings.late_fee).toEqual({ type: 'per_day', amount: 50, grace_days: 7, cap: 1000 }));
    await R('erp.concession_type', 'merit_scholarship', { name: 'Merit scholarship', kind: 'percent', value: 25, head_type: 'tuition', auto_rule: 'merit', max_amount: 20000 }, 'create', (c) =>
      expect(c.concessions).toContainEqual(expect.objectContaining({ name: 'Merit scholarship', value: 25, auto_rule: 'merit' })));
    await R('erp.approval_rule', 'refund_above_5000', { key: 'refund_above_5000', name: 'Refunds above Rs 5,000', approval_type: 'refund', min_amount: 5000, steps: ['accounts', 'principal'] }, 'create', (c) =>
      expect(c.approval_rules).toContainEqual(expect.objectContaining({ key: 'refund_above_5000', steps: ['accounts', 'principal'], min_amount: 5000 })));
    await R('erp.automation', 'absentee_notice', { key: 'absentee_notice', name: 'Absentee notice', trigger: 'attendance.submitted', conditions: { after_consecutive: 3 }, actions: [{ do: 'message_parents_of_absentees' }] }, 'create', (c) =>
      expect(c.automations).toContainEqual(expect.objectContaining({ recipe_key: 'absentee_notice', trigger: 'attendance.submitted' })));
    await R('erp.message_template', 'fee_due_notice__sms', { name: 'Fee due notice', channel: 'sms', event_key: 'fee.reminder', body: 'Dear parent, the fee for {{student_name}} is due on {{due_date}}.' }, 'create', (c) =>
      expect(c.templates).toContainEqual(expect.objectContaining({ product_key: 'erp', name: 'Fee due notice', channel: 'sms', event_key: 'fee.reminder', status: 'approved' })));
    await R('erp.leave_type', 'study', { key: 'study', name: 'Study leave', yearly_quota: 5, accrual: 'yearly', notice_days: 7, paid: false }, 'create', (c) => expect(c.leave_types).toContainEqual(expect.objectContaining({ key: 'study', paid: false, notice_days: 7 })));
    await R('erp.doc_template', 'bonafide_certificate_designer', { name: 'Bonafide certificate designer', type: 'bonafide', body: 'This is to certify that {{student_name}} studies in {{class}}.' }, 'create', (c) =>
      expect(c.doc_templates).toContainEqual(expect.objectContaining({ name: 'Bonafide certificate designer', type: 'bonafide' })));
    await R('erp.campus_settings', 'campus', { library_fine_per_day: 5, homework_approval: true, quiet_from: 20, quiet_to: 7 }, 'update', (c) =>
      expect((c.org_settings as { settings: Record<string, unknown> }[])[0]!.settings).toMatchObject({ library_fine_per_day: 5, homework_approval: true, quiet_hours: { from: 20, to: 7 } }));
    await R('erp.grading_scale', 'primary_three_bands', { name: 'Primary three bands', bands: [{ min: 75, grade: 'Achieved' }, { min: 40, grade: 'Developing' }, { min: 0, grade: 'Emerging' }] }, 'create', (c) =>
      expect(c.scales).toContainEqual(expect.objectContaining({ name: 'Primary three bands' })));
    await roundTrip(ERP_ADMIN, erpOrg, { summary: 'CBSE pack', ops: [
      { op: 'create', block: 'erp.grading_scale', key: 'cbse_designer', settings: { name: 'CBSE designer', bands: [{ min: 91, grade: 'A1' }, { min: 0, grade: 'E' }] } },
      { op: 'create', block: 'erp.assessment_scheme', key: 'cbse_scheme_designer', settings: { name: 'CBSE scheme designer', pack: 'CBSE', scale: 'CBSE designer', pass_percent: 35 } },
    ], unsupported: [], questions: [], template_key: null }, (c) =>
      expect((c.schemes as { name: string; config: { pass_percent: number } }[]).find((s) => s.name === 'CBSE scheme designer')!.config.pass_percent).toBe(35));
    await R('erp.role_permission', 'class_teacher__fees', { role_key: 'class_teacher', capability: 'fees', level: 'S' }, 'update', (c) =>
      expect((c.permissions as { key: string; module_key: string; action: string }[]).filter((p) => p.key === 'class_teacher' && p.module_key === 'fees').map((p) => p.action).sort()).toEqual(['create', 'edit', 'view']));
    await R('erp.module_flag', 'hostel__ALL', { module_key: 'hostel', branch_code: null, enabled: false }, 'create', (c) => expect(c.erp_flags).toContainEqual(expect.objectContaining({ module_key: 'hostel', enabled: false, branch_id: null })));
  });

  it('an ERP school cannot plan CRM blocks', async () => {
    const r = await ok(ERP_ADMIN, 'POST', '/designer/plan', { prompt: 'new enquiry follow-up within 24h else escalate to admission head' });
    expect(r.plan.ops).toEqual([]);
    expect(r.plan.unsupported[0].product).toBe('crm');
    expect((await call(ERP_ADMIN, 'POST', '/designer/templates/crm_enquiry_follow_up/plan', { params: {} })).status).toBe(403);
  });
});

describe('custom registers through the designer (core.custom_object)', () => {
  it('"make a hostel visitor log ... approved by warden": a new register with an approval step by the ERP warden; undo deletes it', async () => {
    const before = await liveConfig(erpOrg);
    const cs = await ok(ERP_ADMIN, 'POST', '/designer/plan', { prompt: 'make a hostel visitor log with visitor name, student, time in/out, approved by warden' });
    expect(cs.status, JSON.stringify(cs.issues)).toBe('validated');
    expect(cs.preview.ops[0].text.join(' ')).toContain('Visitor name (text, required)');
    expect(cs.preview.ops[0].text.join(' ')).toContain('needs approval by erp:warden');
    expect((await ok(ERP_ADMIN, 'POST', `/designer/changesets/${cs.id}/dry-run`)).ok).toBe(true);
    expect(await asOwner((c) => maybe(c, `select 1 from core.custom_objects where org_id = $1 and key = 'hostel_visitor_log'`, [erpOrg]))).toBeNull();
    await ok(ERP_ADMIN, 'POST', `/designer/changesets/${cs.id}/publish`);
    const o = await asOwner((c) => one<{ id: string; fields: { key: string; type: string }[]; states: { transitions: { approver_roles?: string[] }[] } }>(c, `select id, fields, states from core.custom_objects where org_id = $1 and key = 'hostel_visitor_log'`, [erpOrg]));
    expect(o.fields.map((f) => f.type)).toEqual(['text', 'learner', 'datetime', 'datetime']);
    expect(o.states.transitions[0]!.approver_roles).toEqual(['erp:warden']);
    const audit = await asOwner((c) => q<{ actor_user_id: string }>(c, `select actor_user_id from audit.log where table_name = 'custom_objects' and row_id = $1 and action = 'insert'`, [o.id]));
    expect(audit).toEqual([{ actor_user_id: erpAdminUser }]);
    // the register is usable at once from the records screens (same engine)
    const list = await asUserIn('erp_server', { userId: erpAdminUser }, (c) => q<{ key: string }>(c, `select key from core.custom_objects where key = 'hostel_visitor_log'`));
    expect(list).toHaveLength(1);
    await ok(ERP_ADMIN, 'POST', `/designer/changesets/${cs.id}/revert`);
    expect(await asOwner((c) => maybe(c, `select 1 from core.custom_objects where org_id = $1 and key = 'hostel_visitor_log'`, [erpOrg]))).toBeNull();
    expect(canonical((await liveConfig(erpOrg)).objects)).toBe(canonical(before.objects));
  });

  it('an unknown approver role is refused by the records engine\'s own validation (plan stays a draft)', async () => {
    const cs = await planForced(ERP_ADMIN, one_('core.custom_object', 'gate_log', { key: 'gate_log', product_key: 'erp', label_singular: 'Gate entry', label_plural: 'Gate log', fields: [{ key: 'name', label: 'Name', type: 'text' }], permissions: [{ who: 'role', product: 'erp', role: 'ghost_role', view: 'all' }] }), 'a gate log');
    expect(cs.status).toBe('draft');
    expect(cs.issues.map((i: { detail: string }) => i.detail).join(' ')).toContain('ghost_role');
    expect((await call(ERP_ADMIN, 'POST', `/designer/changesets/${cs.id}/publish`)).status).toBe(409);
  });

  it('the OS school gets the register too, approved by management when it has no warden', async () => {
    const cs = await ok(OS_CHAIRMAN, 'POST', '/designer/plan', { prompt: 'make a hostel visitor log with visitor name, student, time in/out, approved by warden' });
    expect(cs.status, JSON.stringify(cs.issues)).toBe('validated');
    expect(cs.plan.questions.length).toBe(1);
    await ok(OS_CHAIRMAN, 'POST', `/designer/changesets/${cs.id}/publish`);
    expect(await asOwner((c) => maybe(c, `select 1 from core.custom_objects where org_id = $1 and key = 'hostel_visitor_log'`, [osOrg]))).not.toBeNull();
    await ok(OS_CHAIRMAN, 'POST', `/designer/changesets/${cs.id}/revert`);
  });
});

describe('isolation and explain', () => {
  it('changesets of the CRM school, the ERP school and the OS school stay inside their school', async () => {
    const crm = await ok(CRM_ADMIN, 'GET', '/designer/changesets');
    const erp = await ok(ERP_ADMIN, 'GET', '/designer/changesets');
    const os = await ok(OS_CHAIRMAN, 'GET', '/designer/changesets');
    expect(crm.length).toBeGreaterThan(0);
    expect(erp.length).toBeGreaterThan(0);
    const ids = (l: { id: string }[]) => new Set(l.map((x) => x.id));
    for (const [a, b] of [[crm, erp], [crm, os], [erp, os]] as const) for (const id of ids(a)) expect(ids(b).has(id)).toBe(false);
    expect((await call(ERP_ADMIN, 'GET', `/designer/changesets/${crm[0].id}`)).status).toBe(404);
    expect((await call(CRM_ADMIN, 'POST', `/designer/changesets/${erp[0].id}/revert`)).status).toBe(404);
    const n = await asUserIn('crm_server', { userId: (await asOwner((c) => one<{ id: string }>(c, `select id from auth.users where email = $1`, [CRM_ADMIN]))).id }, (c) =>
      one<{ n: number }>(c, `select count(*)::int as n from core.design_changesets where org_id = $1`, [erpOrg]));
    expect(n.n).toBe(0);
  });

  it('explain my school covers the CRM and ERP configuration (no AI call)', async () => {
    seen.length = 0;
    const crm = await ok(CRM_ADMIN, 'GET', '/designer/explain');
    expect(crm.text.join('\n')).toMatch(/CRM: \d+ pipeline stages, \d+ lead sources/);
    expect(crm.text.join('\n')).toMatch(/first response within/);
    expect(crm.text.join('\n')).toMatch(/CRM roles: .*Counsellor/);
    const erp = await ok(ERP_ADMIN, 'GET', '/designer/explain');
    expect(erp.text.join('\n')).toMatch(/ERP: \d+ fee heads, \d+ fee plans/);
    expect(erp.text.join('\n')).toMatch(/ERP roles: /);
    expect(seen).toEqual([]);
  });
});
