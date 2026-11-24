/**
 * CRM rows for one org (20261117000001..6), written as the table owner. Called for org A and org B by fixture.ts;
 * every crm table gets at least one row per org (the harness fails otherwise).
 *
 * Per org: the automation user and crm.settings already exist (trigger on core.subscriptions); this adds a pipeline,
 * a source, a form, a role with a permission matrix, a family with an enquiry, and one row of everything that hangs
 * off an enquiry.
 */
import type pg from 'pg';

type Q = (sql: string, params?: unknown[]) => Promise<pg.QueryResult>;

export interface CrmOrgInput {
  org: string;
  branch: string;
  admin: string; // auth user id of the org admin (staff, crm admin role)
  year: string; // core.academic_years id
  prog: string; // core.programmes id
}

export async function seedCrm(q: Q, o: CrmOrgInput) {
  const ins = async (table: string, row: Record<string, unknown>, returning = 'id'): Promise<string> => {
    const keys = Object.keys(row);
    const sql = `insert into crm.${table} (org_id, ${keys.join(', ')}) values ($1, ${keys.map((_, i) => `$${i + 2}`).join(', ')}) returning ${returning}`;
    const vals = keys.map((k) => {
      const v = row[k];
      return v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) ? JSON.stringify(v) : Array.isArray(v) ? JSON.stringify(v) : v;
    });
    return (await q(sql, [o.org, ...vals])).rows[0][returning] as string;
  };
  const tag = o.org.slice(0, 8);

  // configuration
  await q(`update crm.settings set settings = $2, wallet_balance = 500 where org_id = $1`, [o.org, JSON.stringify({ hot_at: 60, warm_at: 30, quiet_hours: { from: 21, to: 8 } })]);
  await ins('org_secrets', { key: 'wa_token', value_enc: 'enc-fixture' });
  await ins('field_settings', { entity: 'enquiry', key: 'family_income', sensitive: true });
  await ins('branch_settings', { branch_id: o.branch, open_hour: 9, close_hour: 18 });
  await ins('counsellor_settings', { user_id: o.admin, daily_capacity: 25 });
  await q(`insert into core.roles (org_id, product_key, key, name) values ($1, 'crm', 'counsellor', 'Counsellor')`, [o.org]);
  await ins('roles', { key: 'counsellor', name: 'Counsellor', permissions: { leads: 'O', tasks: 'O', applications: 'O', sensitive: 'Masked' } });
  await ins('intakes', { academic_year_id: o.year, programme_id: o.prog, capacity: 40, min_age_years: 13, age_cutoff: '2026-06-01' });
  const phase = await ins('phases', { key: 'enquiry', name: 'Enquiry', seq: 1 });
  const stage = await ins('stages', { phase_id: phase, name: 'New', seq: 1, color: 'sky', probability: 8, sla_hours: 1 });
  const source = await ins('sources', { channel: 'Website', name: 'Website enquiry form' });
  await ins('assignment_rules', { name: 'Everyone', seq: 99, user_ids: [o.admin] });
  await ins('forms', { slug: `form-${tag}`, name: 'Website enquiry form', branch_id: o.branch, source_id: source, fields: ['student_name', 'mobile'] });
  await ins('saved_views', { user_id: o.admin, name: 'Hot', shared: true, query: 'chip=hot' });
  await q(`insert into core.message_templates (org_id, product_key, name, channel, body, status) values ($1, 'crm', 'Welcome', 'whatsapp', 'Hello {{guardian_name}}', 'approved')`, [o.org]);
  const tpl = (await q(`select id from core.message_templates where org_id = $1 and product_key = 'crm' and name = 'Welcome'`, [o.org])).rows[0].id as string;

  // a family, its child and one enquiry
  const hh = await ins('households', { locality: 'Kondapur', address: '1 Lake Road', pincode: '500084' });
  const guardian = await ins('guardians', { household_id: hh, name: 'Crm Parent', relation: 'mother', phone: `98${tag.replace(/\D/g, '').padEnd(8, '1').slice(0, 8)}` });
  const prospect = await ins('prospects', { household_id: hh, first_name: 'Prospect', last_name: tag, dob: '2015-04-01', gender: 'female', current_school: 'Little Stars' });
  const enquiry = await ins('enquiries', {
    household_id: hh, prospect_id: prospect, branch_id: o.branch, academic_year_id: o.year, programme_id: o.prog, board: 'CBSE', grade: 'Class 8',
    stage_id: stage, owner_id: o.admin, custom: { transport_required: 'Yes' }, tags: ['fixture'],
  });
  await ins('enquiry_sensitive', { branch_id: o.branch, enquiry_id: enquiry, data: { family_income: '10-15L' } });
  await ins('source_touches', { enquiry_id: enquiry, source_id: source, channel: 'Website', source: 'Website enquiry form' });
  await ins('activities', { household_id: hh, enquiry_id: enquiry, type: 'touch', actor_id: o.admin, outcome: 'created', content: 'Enquiry created' });
  await ins('follow_ups', { enquiry_id: enquiry, household_id: hh, title: 'First call', due_at: new Date(Date.now() + 3600e3), owner_id: o.admin });
  await ins('visits', { enquiry_id: enquiry, household_id: hh, branch_id: o.branch, slot_at: new Date(Date.now() + 86400e3), host_id: o.admin });
  await ins('applications', { enquiry_id: enquiry, progress: 30, answers: { mother_tongue: 'Telugu' } });
  await ins('enquiry_documents', { enquiry_id: enquiry, type: 'Birth certificate', status: 'pending' });
  await ins('payments', { enquiry_id: enquiry, purpose: 'Registration fee', amount: 1500 });
  const campaign = await ins('campaigns', { name: 'Open house', channel: 'whatsapp', template_id: tpl, audience: { view: 'interested' } });
  await ins('messages', { household_id: hh, enquiry_id: enquiry, channel: 'whatsapp', direction: 'out', body: 'Hello', status: 'delivered', campaign_id: campaign, sender_id: o.admin });
  const wf = await ins('workflows', { recipe_key: 'instant_welcome', name: 'Instant welcome', trigger: 'enquiry_created', steps: [{ type: 'task', title: 'First call', dueMins: 5 }], status: 'published' });
  await ins('workflow_runs', { workflow_id: wf, enquiry_id: enquiry, status: 'completed', log: [{ step: 1, text: 'done', ok: true }] });
  const batch = await ins('import_batches', { file_name: 'leads.csv', total: 1, created: 1 });
  await ins('import_rows', { batch_id: batch, data: { mobile: '9800000000' }, status: 'created', match_household_id: hh, enquiry_id: enquiry });
  await q(`insert into crm.meta_leads (leadgen_id, org_id, enquiry_id, status) values ($1, $2, $3, 'created')`, [`lead-${o.org}`, o.org, enquiry]);
  // the wallet ledger is written by crm.wallet_post in production; the table owner posts a row directly
  await q(`insert into crm.wallet_ledger (org_id, branch_id, type, category, amount, balance_after, note) values ($1, $2, 'credit', 'recharge', 500, 500, 'fixture')`, [o.org, o.branch]);

  return { hh, guardian, prospect, enquiry, stage, source };
}
