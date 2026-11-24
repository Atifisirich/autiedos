// The CRM starter pack for a new org (PT-01): roles, pipeline, sources, templates, workflow recipes, a hosted form,
// routing, the current academic year and programmes. Ported from autoedcrm lib/seed.ts createTenant.
// The org, its branches and the CRM subscription are platform business (core.organizations, core.branches,
// core.subscriptions); inserting the subscription makes the database create crm.settings and the automation user
// (trigger trg_crm_provision). This file fills the CRM on top, as that automation user.
import { asSystem, type Db, type Row } from './db';
import { DEFAULT_ROLES } from './perm';
import { DEFAULT_SCORING } from './core';
import { RECIPES } from './workflows';

const ALL_GRADES = ['Playgroup', 'Nursery', 'LKG', 'UKG', ...Array.from({ length: 12 }, (_, i) => `Grade ${i + 1}`)];
export const PACKS: Record<string, { label: string; boards: string[]; grades: string[] }> = {
  cbse_day: { label: 'CBSE day school', boards: ['CBSE'], grades: ALL_GRADES.slice(1, 14) },
  cambridge: { label: 'Cambridge / international', boards: ['Cambridge', 'IB'], grades: ALL_GRADES.slice(1, 14) },
  preschool: { label: 'Pre-school chain', boards: ['Play-based'], grades: ALL_GRADES.slice(0, 4) },
  residential: { label: 'Residential school', boards: ['CBSE'], grades: ALL_GRADES.slice(8) },
};

const PIPELINE: [string, string, [string, string, number, Row?][]][] = [
  ['prospect', 'Prospect', [['New data', 'slate', 2, { exempt_next_action: true }], ['Verified', 'slate', 4, { exempt_next_action: true }], ['Nurturing', 'slate', 6, { exempt_next_action: true }]]],
  ['enquiry', 'Enquiry', [['New', 'sky', 8, { sla_hours: 1 }], ['Contact attempted', 'sky', 10, { sla_hours: 48 }], ['Connected', 'sky', 15, { sla_hours: 72 }], ['Interested', 'sky', 25, { sla_hours: 120 }]]],
  ['visit', 'Visit', [['Visit scheduled', 'violet', 35, { required_fields: ['visit'] }], ['Visit done', 'violet', 45], ['No-show', 'violet', 15]]],
  ['application', 'Application', [['Form started', 'amber', 50], ['Form submitted', 'amber', 60], ['Fee paid', 'amber', 70], ['Documents pending', 'amber', 70], ['Documents verified', 'amber', 75]]],
  ['evaluation', 'Evaluation', [['Interaction scheduled', 'orange', 78], ['Interaction completed', 'orange', 82], ['Decision pending', 'orange', 85]]],
  ['offer', 'Offer', [['Offer made', 'teal', 88], ['Offer accepted', 'teal', 95], ['Waitlisted', 'teal', 40]]],
  ['enrolled', 'Enrolled', [['Admission confirmed', 'green', 100, { is_won: true, exempt_next_action: true }], ['Sent to ERP', 'green', 100, { is_won: true, exempt_next_action: true }]]],
  ['closed', 'Closed', ['Not interested', 'Joined another school', 'Not eligible', 'Junk / duplicate', 'Cancelled / refunded'].map((n) => [n, 'rose', 0, { is_closed: true, exempt_next_action: true, required_fields: ['closure_reason'] }] as [string, string, number, Row])],
];

const SOURCES: [string, string][] = [
  ['Meta ads', 'Facebook lead form'], ['Meta ads', 'Instagram lead form'], ['Google', 'Google Ads search'], ['Google', 'Google Business Profile'],
  ['Website', 'Website enquiry form'], ['WhatsApp', 'School WhatsApp number'], ['Walk-in', 'Front desk walk-in'], ['Phone', 'Inbound call'],
  ['Referral', 'Parent referral'], ['Events', 'Open house'], ['Events', 'Society activation'], ['Offline', 'Newspaper ad'], ['Data', 'Pre-school tie-up list'],
];

const TEMPLATES: [string, string, string, string][] = [
  ['whatsapp', 'Welcome', 'utility', 'Hello {{guardian_name}}, thank you for your interest in {{school}}, {{branch}} for {{student_name}}. {{counsellor}} from our admissions team will call you shortly. Reply here any time with questions.'],
  ['sms', 'Welcome', 'utility', 'Thank you for enquiring at {{school}} {{branch}}. {{counsellor}} will call you shortly.'],
  ['whatsapp', 'Out of hours', 'utility', 'Hello {{guardian_name}}, we have received your enquiry for {{student_name}}. Our admissions office is closed right now; {{counsellor}} will call you when we open.'],
  ['whatsapp', 'Missed call', 'utility', 'Hello {{guardian_name}}, sorry we missed your call to {{school}}. {{counsellor}} will call you back within a few minutes.'],
  ['whatsapp', 'Tried calling', 'utility', 'Hello {{guardian_name}}, {{counsellor}} from {{school}} tried to reach you about admission for {{student_name}}. What is a good time to call?'],
  ['whatsapp', 'Visit confirmation', 'utility', 'Your campus visit at {{school}}, {{branch}} is confirmed. {{counsellor}} will meet you at the front office. Reply here if you need to reschedule.'],
  ['whatsapp', 'Missed visit', 'utility', 'Hello {{guardian_name}}, sorry we missed you at the campus today. Reply with a day that suits you and we will rebook your visit.'],
  ['whatsapp', 'After your visit', 'marketing', 'Hello {{guardian_name}}, it was lovely meeting you. Here is a short guide on what a day in {{grade}} looks like at {{school}}.'],
  ['whatsapp', 'Parent stories', 'marketing', 'Hello {{guardian_name}}, hear from parents of {{grade}} students about their first year at {{school}}.'],
  ['whatsapp', 'Finish your application', 'utility', 'Hello {{guardian_name}}, the application for {{student_name}} is saved. Continue here: {{apply_link}} — or reply and {{counsellor}} will fill it with you.'],
  ['whatsapp', 'Payment retry', 'utility', 'Hello {{guardian_name}}, the payment for {{student_name}}\'s application did not go through. No money was taken. Please try again from the link we sent.'],
  ['whatsapp', 'Documents pending', 'utility', 'Hello {{guardian_name}}, a few documents are still pending for {{student_name}}\'s application. {{counsellor}} will share the list.'],
  ['whatsapp', 'Sibling welcome', 'utility', 'Hello {{guardian_name}}, wonderful to see {{student_name}} joining the {{school}} family too. A sibling concession applies to this admission.'],
  ['whatsapp', 'Admission welcome', 'utility', "Welcome to {{school}}! {{student_name}}'s admission to {{grade}} is confirmed. We will share the onboarding form and orientation date soon."],
  ['whatsapp', 'Checking in', 'marketing', 'Hello {{guardian_name}}, admissions for {{grade}} at {{school}} are still open. Would you like {{counsellor}} to call you?'],
  ['whatsapp', 'Fee structure', 'utility', 'Hello {{guardian_name}}, here is the fee structure for {{grade}} at {{school}}, {{branch}}. {{counsellor}} can walk you through it.'],
  ['whatsapp', 'Payment link', 'utility', 'Hello {{guardian_name}}, here is the secure link to pay the {{purpose}} of {{amount}} for {{student_name}}: {{pay_link}}'],
  ['whatsapp', 'Application link', 'utility', 'Hello {{guardian_name}}, you can fill the application for {{student_name}} here: {{apply_link}}'],
  ['sms', 'Visit reminder', 'utility', 'Reminder: your campus visit at {{school}} {{branch}} is tomorrow. See you there.'],
  ['email', 'Welcome', 'utility', 'Dear {{guardian_name}},\n\nThank you for your interest in {{school}}, {{branch}} for {{student_name}}. {{counsellor}} from our admissions team will be in touch.\n\nWarm regards,\nAdmissions Office'],
  ['whatsapp', 'Open house invite', 'marketing', 'Hello {{guardian_name}}, you are invited to our Open House at {{school}}, {{branch}} this Saturday. Meet the teachers and tour the campus.'],
];

export const defaultSettings = (pack: string) => ({
  closure_reasons: ['Fee too high', 'Distance / transport', 'Joined another school', 'Undecided', 'Not eligible by age', 'No seat available', 'No response', 'Other'],
  scoring: DEFAULT_SCORING, hot_at: 60, warm_at: 30, first_response_mins: 30, reopen_on_reenquiry: true,
  grades: PACKS[pack]!.grades, boards: PACKS[pack]!.boards,
  doc_types: ['Birth certificate', 'Previous report card', 'Transfer certificate', 'Address proof', 'Photographs'],
  fees: { registration: 1500, admission: 25000 },
  modules: { visits: true, applications: true, payments: true, campaigns: true, workflows: true },
  app_no_prefix: 'APP', receipt_prefix: 'RCPT',
  call_recording: false, quiet_hours: { from: 21, to: 8 }, max_auto_per_day: 4,
});

export const roleKey = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

export async function seedProgrammes(db: Db, branchId: string, yearId: string, pack: string, startYear: number) {
  const { boards, grades } = PACKS[pack]!;
  for (let i = 0; i < grades.length; i++) {
    const grade = grades[i]!;
    const order = ALL_GRADES.indexOf(grade);
    const prog = await db.one(
      `insert into core.programmes (org_id, branch_id, name, board, seq) values ($1,$2,$3,$4,$5)
       on conflict (org_id, branch_id, name, board) do update set seq = excluded.seq returning id`,
      [db.requireOrg(), branchId, grade, boards[0], order],
    );
    await db.insert('crm.intakes', { academic_year_id: yearId, programme_id: prog!.id, capacity: order < 4 ? 40 : 30, min_age_years: order + 2, age_cutoff: `${startYear}-06-01` });
  }
}

export type StarterPackInput = { branchId: string; pack?: string; formSlug: string; wallet?: number; year?: { name: string; startYear: number } };

/** Fills an org that has just been given the CRM. Idempotent only on an empty CRM: call it once, at onboarding. */
export async function seedStarterPack(orgId: string, o: StarterPackInput): Promise<{ roles: Record<string, string>; yearId: string }> {
  const pack = o.pack && PACKS[o.pack] ? o.pack : 'cbse_day';
  return asSystem(orgId, async (db) => {
    await db.q('update crm.settings set settings = $2, onboarding = $3 where org_id = $1', [orgId, defaultSettings(pack), { branches: true, users: false, whatsapp: false, dlt: false, telephony: false, forms: true, migration: false, training: false }]);
    const credit = o.wallet ?? 500;
    if (credit > 0) await db.q('select crm.wallet_post($1, $2, $3, $4)', ['credit', 'recharge', credit, 'Starting credits included in plan']);
    const roles: Record<string, string> = {};
    for (const [name, permissions] of DEFAULT_ROLES) {
      const key = roleKey(name);
      await db.q('insert into core.roles (org_id, product_key, key, name) values ($1, $2, $3, $4) on conflict (org_id, product_key, key) do nothing', [orgId, 'crm', key, name]);
      await db.insert('crm.roles', { key, name, permissions, is_system: true });
      roles[name] = key;
    }
    for (let i = 0; i < PIPELINE.length; i++) {
      const [key, name, stages] = PIPELINE[i]!;
      const ph = await db.insert('crm.phases', { key, name, seq: i });
      for (let j = 0; j < stages.length; j++) {
        const [sn, color, probability, extra] = stages[j]!;
        await db.insert('crm.stages', { phase_id: ph.id, name: sn, seq: j, color, probability, ...(extra ?? {}) });
      }
    }
    for (const [channel, name] of SOURCES) await db.insert('crm.sources', { channel, name });
    for (const [channel, name, category, body] of TEMPLATES) {
      await db.insert('core.message_templates', { product_key: 'crm', channel, name, category, body, language: 'en', status: 'approved' });
    }
    for (const r of RECIPES) await db.insert('crm.workflows', { recipe_key: r.key, name: r.name, description: r.description, trigger: r.trigger, conditions: r.conditions ?? [], steps: r.steps, status: 'published' });
    await db.q('update core.branches set boards = array(select jsonb_array_elements_text($2::jsonb)) where org_id = $1 and id = $3 and cardinality(boards) = 0', [orgId, JSON.stringify(PACKS[pack]!.boards), o.branchId]);
    await db.q('insert into crm.branch_settings (org_id, branch_id) values ($1, $2) on conflict do nothing', [orgId, o.branchId]);
    const now = new Date();
    const start = o.year?.startYear ?? (now.getMonth() >= 6 ? now.getFullYear() + 1 : now.getFullYear());
    const yearName = o.year?.name ?? `${start}-${String(start + 1).slice(2)}`;
    const year = await db.insert('core.academic_years', { name: yearName, starts_on: `${start}-04-01`, ends_on: `${start + 1}-03-31`, is_current: true, status: 'active', seq: 1 });
    await seedProgrammes(db, o.branchId, year.id, pack, start);
    const web = await db.one("select id from crm.sources where org_id = $1 and name = 'Website enquiry form'", [orgId]);
    await db.insert('crm.forms', { slug: o.formSlug, name: 'Website enquiry form', source_id: web!.id, fields: ['student_name', 'guardian_name', 'mobile', 'email', 'grade', 'branch', 'heard_about'] });
    await db.insert('crm.assignment_rules', { name: 'Everyone, round robin', seq: 99, conditions: {}, method: 'round_robin', user_ids: [] });
    return { roles, yearId: year.id as string };
  });
}
