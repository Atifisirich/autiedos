/**
 * CRM and ERP starter templates (decision 59: templates start from AutoEd's existing recipes and packs).
 *
 *   CRM: built from the CRM's workflow recipe library and starter pack (packages/crm-server/src/workflows.ts RECIPES,
 *        provision.ts defaultSettings). CRM_RECIPES below is a copy of the recipes' definitions (the shared package cannot
 *        import the CRM server); packages/server/test/designer-products.test.ts checks the two stay identical.
 *   ERP: built from the ERP recipe library (apps/web/lib/erp/pack.ts RECIPES) and the board packs
 *        (packages/shared/src/erp/boards.ts SCALES, SCHEME_CONFIG).
 */
import { z } from 'zod';
import { SCALES } from '../erp/boards';
import type { Changeset, ChangeOp } from './changeset';
import type { CrmStep } from './crm-blocks';
import { defineTemplate, type TemplateDef } from './templates';

const op = (block: string, key: string, settings: Record<string, unknown>, reason?: string): ChangeOp => ({ op: 'create', block, key, settings, reason });
const cs = (key: string, summary: string, ops: ChangeOp[]): Changeset => ({ summary, ops, unsupported: [], questions: [], template_key: key });

const DAY = 1440;
/** Copy of packages/crm-server/src/workflows.ts RECIPES (key, name, trigger, conditions, steps). */
export const CRM_RECIPES: { key: string; name: string; description: string; trigger: string; conditions?: Record<string, unknown>[]; steps: CrmStep[] }[] = [
  { key: 'instant_welcome', name: 'Instant welcome', trigger: 'enquiry_created', description: 'Sends the branch welcome on WhatsApp (falls back to SMS, then email) and creates a call task due in 5 minutes.',
    steps: [{ type: 'send', channel: 'whatsapp', template: 'Welcome', fallback: ['sms', 'email'] }, { type: 'task', title: 'First call to the parent', dueMins: 5, priority: 'high' }] },
  { key: 'out_of_hours', name: 'Out-of-hours acknowledgement', trigger: 'out_of_hours', description: 'Acknowledges the enquiry with a call-back time and queues the call for the next shift.',
    steps: [{ type: 'send', channel: 'whatsapp', template: 'Out of hours', fallback: ['sms'] }, { type: 'task', title: 'Call back: enquiry came in after hours', dueMins: 12 * 60, priority: 'high' }] },
  { key: 'missed_call', name: 'Missed call rescue', trigger: 'missed_call', description: 'Sends a "we missed you" message, creates an urgent call-back and escalates if it is not done in 30 minutes.',
    steps: [{ type: 'send', channel: 'whatsapp', template: 'Missed call', fallback: ['sms'] }, { type: 'task', title: 'Urgent: return missed call', dueMins: 10, priority: 'high' }, { type: 'wait', mins: 30 }, { type: 'notify', who: 'head', title: 'Missed call not returned in 30 minutes' }] },
  { key: 'no_contact', name: 'No-contact ladder', trigger: 'call_not_answered', description: 'Three attempts at different times over two days with a message in between, then moves to Contact attempted and alerts the head.',
    steps: [{ type: 'task', title: 'Call attempt 2 (try a different time)', dueMins: 4 * 60 }, { type: 'send', channel: 'whatsapp', template: 'Tried calling', fallback: ['sms'] }, { type: 'wait', mins: DAY }, { type: 'task', title: 'Call attempt 3', dueMins: 60 }, { type: 'wait', mins: DAY }, { type: 'stage', stage: 'Contact attempted' }, { type: 'notify', who: 'head', title: 'Could not reach the parent after three attempts' }] },
  { key: 'visit_reminders', name: 'Visit reminders', trigger: 'visit_scheduled', description: 'Confirmation now with the location pin and a notification to the host.',
    steps: [{ type: 'send', channel: 'whatsapp', template: 'Visit confirmation', fallback: ['sms'] }, { type: 'notify', who: 'owner', title: 'Campus visit booked' }] },
  { key: 'no_show', name: 'No-show recovery', trigger: 'visit_no_show', description: 'Apology with a one-tap rebook link and a task for the counsellor next day.',
    steps: [{ type: 'send', channel: 'whatsapp', template: 'Missed visit', fallback: ['sms'] }, { type: 'task', title: 'Rebook the campus visit', taskType: 'visit', dueMins: DAY }] },
  { key: 'post_visit', name: 'Post-visit nurture', trigger: 'visit_done', description: 'If no application starts within 2 days, sends decision-helper content over 10 days. Stops on reply or application.',
    steps: [{ type: 'wait', mins: 2 * DAY }, { type: 'send', channel: 'whatsapp', template: 'After your visit' }, { type: 'wait', mins: 4 * DAY }, { type: 'send', channel: 'whatsapp', template: 'Parent stories' }, { type: 'wait', mins: 4 * DAY }, { type: 'task', title: 'Post-visit check-in call', dueMins: 60 }] },
  { key: 'abandoned_form', name: 'Abandoned application', trigger: 'form_started', description: 'Nudges at 1, 3 and 7 days and offers assisted filling. Stops when the form is submitted.',
    steps: [{ type: 'wait', mins: DAY }, { type: 'send', channel: 'whatsapp', template: 'Finish your application' }, { type: 'wait', mins: 2 * DAY }, { type: 'send', channel: 'whatsapp', template: 'Finish your application' }, { type: 'wait', mins: 4 * DAY }, { type: 'task', title: 'Offer to fill the application with the parent', dueMins: 60 }] },
  { key: 'payment_failed', name: 'Payment failed', trigger: 'payment_failed', description: 'Sends a retry link immediately and creates a task for the counsellor after 2 hours.',
    steps: [{ type: 'send', channel: 'whatsapp', template: 'Payment retry', fallback: ['sms'] }, { type: 'wait', mins: 120 }, { type: 'task', title: 'Help the parent complete payment', taskType: 'payment_chase', dueMins: 30 }] },
  { key: 'document_chase', name: 'Document chase', trigger: 'form_submitted', description: 'Three days after submission, lists what is missing and creates a task for the counsellor.',
    steps: [{ type: 'wait', mins: 3 * DAY }, { type: 'send', channel: 'whatsapp', template: 'Documents pending' }, { type: 'task', title: 'Chase pending documents', taskType: 'document_chase', dueMins: DAY }] },
  { key: 'untouched', name: 'Untouched escalation', trigger: 'sla_breach', description: 'Notifies the owner, then the head, then reassigns if still untouched.',
    steps: [{ type: 'notify', who: 'owner', title: 'Enquiry waiting past the response time' }, { type: 'wait', mins: 30 }, { type: 'notify', who: 'head', title: 'Enquiry still untouched' }, { type: 'wait', mins: 60 }, { type: 'reassign' }] },
  { key: 'hot_lead', name: 'Hot lead alert', trigger: 'hot_lead', description: 'Notifies the owner and creates a priority task.',
    steps: [{ type: 'notify', who: 'owner', title: 'This family just turned hot' }, { type: 'task', title: 'Priority call: hot lead', dueMins: 15, priority: 'high' }] },
  { key: 're_enquiry', name: 'Re-enquiry alert', trigger: 're_enquiry', description: 'Tags the record and notifies the owner. Re-opening closed enquiries is controlled in Admin > Pipeline.',
    steps: [{ type: 'tag', tag: 're-enquired' }, { type: 'notify', who: 'owner', title: 'Family enquired again' }] },
  { key: 'sibling', name: 'Sibling welcome', trigger: 'sibling_enquiry', description: "Applies the sibling concession tag. Routing to the family's counsellor is automatic.",
    steps: [{ type: 'tag', tag: 'sibling concession' }, { type: 'send', channel: 'whatsapp', template: 'Sibling welcome' }] },
  { key: 'admission_welcome', name: 'Admission welcome', trigger: 'admission_confirmed', description: 'Welcome message with the onboarding form and orientation invite.',
    steps: [{ type: 'send', channel: 'whatsapp', template: 'Admission welcome', fallback: ['sms', 'email'] }, { type: 'notify', who: 'head', title: 'Admission confirmed' }] },
  { key: 'win_back', name: 'Lost-lead win-back', trigger: 'enquiry_closed', conditions: [{ field: 'closure_reason', op: 'in', value: ['Undecided', 'Fee too high'] }], description: '60 days after closing as undecided or fee, sends one check-in message.',
    steps: [{ type: 'wait', mins: 60 * DAY }, { type: 'send', channel: 'whatsapp', template: 'Checking in' }] },
];

/** A crm.workflow op from a recipe (published, the standard stop rules). */
export function recipeOp(key: string, patch: { steps?: CrmStep[]; reason?: string } = {}): ChangeOp {
  const r = CRM_RECIPES.find((x) => x.key === key);
  if (!r) throw new Error(`unknown CRM recipe ${key}`);
  return op('crm.workflow', r.key, { key: r.key, name: r.name, description: r.description, trigger: r.trigger, conditions: r.conditions ?? [], steps: patch.steps ?? r.steps, status: 'published', stop_on_reply: true, stop_on_stage_change: true }, patch.reason);
}

// ---------------------------------------------------------------- CRM
export const crmFollowUpTemplate = defineTemplate({
  key: 'crm_enquiry_follow_up',
  product: 'crm',
  title: 'Enquiry follow-up time and escalation',
  description: 'Every new enquiry gets a first call within the response time; if not, the owner is reminded and then a role (the admission head by default) is alerted, and finally the enquiry is reassigned.',
  keywords: ['follow-up', 'follow up', 'response time', 'sla', 'escalate', 'untouched', 'enquiry'],
  params: [
    { key: 'hours', labelKey: 'designer.param.hours', type: 'number' },
    { key: 'escalate_role', labelKey: 'designer.param.escalate_role', type: 'role' },
    { key: 'reassign', labelKey: 'designer.param.reassign', type: 'boolean' },
  ],
  paramsSchema: z.object({ hours: z.number().min(0.25).max(720).default(24), escalate_role: z.string().regex(/^[a-z][a-z0-9_]*$/).default('admission_head'), reassign: z.boolean().default(true) }),
  build: (p) => {
    const steps: CrmStep[] = [
      { type: 'notify', who: 'owner', title: 'Enquiry waiting past the response time' },
      { type: 'wait', mins: 60 },
      { type: 'notify', who: 'role', role_key: p.escalate_role, title: 'Enquiry still untouched: please follow up' },
      ...(p.reassign ? ([{ type: 'wait', mins: 120 }, { type: 'reassign' }] as CrmStep[]) : []),
    ];
    return cs('crm_enquiry_follow_up', `New enquiries must get a first response within ${p.hours} hours; otherwise the owner is reminded and the ${p.escalate_role.replace(/_/g, ' ')} is alerted${p.reassign ? ', then it is reassigned' : ''}.`, [
      op('crm.follow_up_sla', 'first_response', { first_response_hours: p.hours }, `First response within ${p.hours} hours.`),
      recipeOp('untouched', { steps, reason: `Escalate to the ${p.escalate_role.replace(/_/g, ' ')} when the response time is missed.` }),
    ]);
  },
});

export const crmFirstContactTemplate = defineTemplate({
  key: 'crm_first_contact',
  product: 'crm',
  title: 'First contact pack',
  description: 'The CRM starter recipes for the first hours of an enquiry: instant welcome with a call task, out-of-hours acknowledgement, missed-call rescue and the no-contact ladder.',
  keywords: ['welcome', 'first call', 'missed call', 'out of hours', 'no contact'],
  params: [],
  paramsSchema: z.object({}),
  build: () => cs('crm_first_contact', 'Welcome every new enquiry, acknowledge after-hours enquiries, rescue missed calls and retry parents who did not answer.', ['instant_welcome', 'out_of_hours', 'missed_call', 'no_contact'].map((k) => recipeOp(k))),
});

export const crmNurtureTemplate = defineTemplate({
  key: 'crm_visit_application_nurture',
  product: 'crm',
  title: 'Visit and application nurture',
  description: 'Visit confirmations, no-show recovery, post-visit nurture, abandoned-application nudges and the document chase (CRM recipes).',
  keywords: ['visit', 'no-show', 'nurture', 'application', 'documents'],
  params: [],
  paramsSchema: z.object({}),
  build: () => cs('crm_visit_application_nurture', 'Confirm visits, recover no-shows, nurture after the visit and nudge unfinished applications and documents.', ['visit_reminders', 'no_show', 'post_visit', 'abandoned_form', 'document_chase'].map((k) => recipeOp(k))),
});

export const crmMessagingTemplate = defineTemplate({
  key: 'crm_quiet_hours',
  product: 'crm',
  title: 'Quiet hours and message cap',
  description: 'No automated parent messages at night and a daily cap per family (CRM starter pack defaults: 21:00 to 08:00, 4 a day).',
  keywords: ['quiet hours', 'night', 'daily cap', 'too many messages'],
  params: [
    { key: 'quiet_from', labelKey: 'designer.param.quiet_from', type: 'number' },
    { key: 'quiet_to', labelKey: 'designer.param.quiet_to', type: 'number' },
    { key: 'max_per_day', labelKey: 'designer.param.max_per_day', type: 'number' },
  ],
  paramsSchema: z.object({ quiet_from: z.number().int().min(0).max(23).default(21), quiet_to: z.number().int().min(0).max(23).default(8), max_per_day: z.number().int().min(1).max(20).default(4) }),
  build: (p) => cs('crm_quiet_hours', `No automated messages from ${p.quiet_from}:00 to ${p.quiet_to}:00, at most ${p.max_per_day} a day per family.`, [op('crm.messaging_limits', 'messaging', { quiet_from: p.quiet_from, quiet_to: p.quiet_to, max_auto_per_day: p.max_per_day })]),
});

// ---------------------------------------------------------------- ERP
export const erpFeeReminderTemplate = defineTemplate({
  key: 'erp_fee_reminder_ladder',
  product: 'erp',
  title: 'Fee reminder ladder',
  description: 'Parents are reminded before the fee due date, on the due date, and then every week until it is paid; accounts gets a call task after two weeks (ERP recipe fee_reminder_ladder).',
  keywords: ['fee reminder', 'remind parents', 'due date', 'dues', 'ladder'],
  params: [
    { key: 'days_before', labelKey: 'designer.param.days_before', type: 'number' },
    { key: 'on_due_date', labelKey: 'designer.param.on_due_date', type: 'boolean' },
    { key: 'repeat_every_days', labelKey: 'designer.param.repeat_every_days', type: 'number' },
  ],
  paramsSchema: z.object({ days_before: z.number().int().min(0).max(30).default(3), on_due_date: z.boolean().default(true), repeat_every_days: z.number().int().min(0).max(30).default(7) }),
  build: (p) => {
    const days = [...(p.days_before ? [-p.days_before] : []), ...(p.on_due_date ? [0] : []), ...(p.repeat_every_days ? [p.repeat_every_days] : [])];
    return cs('erp_fee_reminder_ladder', `Parents are reminded ${p.days_before ? `${p.days_before} days before the fee due date` : ''}${p.on_due_date ? `${p.days_before ? ', ' : ''}on the due date` : ''}${p.repeat_every_days ? `, then every ${p.repeat_every_days} days until it is paid` : ''}.`, [
      op('erp.automation', 'fee_reminder_ladder', {
        key: 'fee_reminder_ladder',
        name: 'Fee reminder ladder',
        trigger: 'fee.due_date',
        conditions: { days, ...(p.repeat_every_days ? { repeat_every_days: p.repeat_every_days } : {}), call_task_at: 15 },
        actions: [{ do: 'remind_parent' }],
        enabled: true,
        test_mode: false,
      }),
      op('erp.message_template', 'fee_reminder__whatsapp', { name: 'Fee reminder', channel: 'whatsapp', event_key: 'fee.reminder', category: 'utility', language: 'en', body: 'Dear parent, the fee of {{amount}} for {{student_name}} is due on {{due_date}}. Please pay at the office or online. Ignore this if already paid.' }),
    ]);
  },
});

export const erpConcessionApprovalTemplate = defineTemplate({
  key: 'erp_concession_approval',
  product: 'erp',
  title: 'Concession approval above a limit',
  description: 'Fee concessions above a percentage need a senior approver (the group admin / director by default); smaller ones follow the usual principal approval (ERP recipe concession_approval).',
  keywords: ['concession', 'discount', 'scholarship', 'approval', 'director'],
  params: [
    { key: 'percent', labelKey: 'designer.param.percent', type: 'number' },
    { key: 'approver_role', labelKey: 'designer.param.approver_role', type: 'role' },
  ],
  paramsSchema: z.object({ percent: z.number().min(0).max(100).default(10), approver_role: z.string().regex(/^[a-z][a-z0-9_]*$/).default('group_admin') }),
  build: (p) =>
    cs('erp_concession_approval', `Fee concessions above ${p.percent}% need approval by the ${p.approver_role.replace(/_/g, ' ')}.`, [
      op('erp.approval_rule', `concession_above_${String(p.percent).replace(/\D/g, '_')}`, { key: `concession_above_${String(p.percent).replace(/\D/g, '_')}`, name: `Concessions above ${p.percent}%`, approval_type: 'concession', min_percent: p.percent, steps: [p.approver_role], seq: 1, active: true }),
      op('erp.automation', 'concession_approval', { key: 'concession_approval', name: 'Concession approval', trigger: 'concession.requested', conditions: {}, actions: [{ do: 'start_approval' }], enabled: true, test_mode: false }),
    ]),
});

export const erpAbsenceAlertTemplate = defineTemplate({
  key: 'erp_absence_alerts',
  product: 'erp',
  title: 'Absence alerts to parents',
  description: 'When a roll call is submitted, parents of absent students get a message; after several days in a row the class teacher gets a task (ERP recipe absentee_notice).',
  keywords: ['absent', 'absence alert', 'attendance', 'parents'],
  params: [{ key: 'after_consecutive', labelKey: 'designer.param.after_consecutive', type: 'number' }],
  paramsSchema: z.object({ after_consecutive: z.number().int().min(1).max(30).default(3) }),
  build: (p) =>
    cs('erp_absence_alerts', `Parents hear about an absence the same day; after ${p.after_consecutive} days in a row the class teacher follows up.`, [
      op('erp.automation', 'absentee_notice', { key: 'absentee_notice', name: 'Absentee notice', trigger: 'attendance.submitted', conditions: { after_consecutive: p.after_consecutive }, actions: [{ do: 'message_parents_of_absentees' }, { do: 'task_class_teacher', after_consecutive: p.after_consecutive }], enabled: true, test_mode: false }),
      op('erp.message_template', 'absence_notice__whatsapp', { name: 'Absence notice', channel: 'whatsapp', event_key: 'attendance.absent', category: 'utility', language: 'en', body: 'Dear parent, {{student_name}} was marked absent today ({{date}}). Please inform the class teacher of the reason.' }),
    ]),
});

export const erpCbsePackTemplate = defineTemplate({
  key: 'erp_cbse_board_pack',
  product: 'erp',
  title: 'CBSE grading and assessment',
  description: 'The CBSE board pack: the A1-E grading scale and the CBSE assessment scheme (periodic tests, notebook, enrichment, term exam; pass at 33%).',
  keywords: ['cbse', 'grading', 'assessment scheme', 'board pack', 'report card'],
  params: [],
  paramsSchema: z.object({}),
  build: () =>
    cs('erp_cbse_board_pack', 'Use the CBSE grading scale and assessment scheme.', [
      op('erp.grading_scale', 'cbse', { name: 'CBSE', bands: SCALES.CBSE }),
      op('erp.assessment_scheme', 'cbse_scheme', { name: 'CBSE scheme', pack: 'CBSE', scale: 'CBSE', pass_percent: 33, active: true }),
    ]),
});

export const erpLateFeeTemplate = defineTemplate({
  key: 'erp_late_fee',
  product: 'erp',
  title: 'Late fee per day',
  description: 'A late fee per day after a grace period, capped per instalment.',
  keywords: ['late fee', 'fine', 'penalty', 'overdue fee'],
  params: [
    { key: 'amount', labelKey: 'designer.param.amount', type: 'number' },
    { key: 'grace_days', labelKey: 'designer.param.grace_days', type: 'number' },
    { key: 'cap', labelKey: 'designer.param.cap', type: 'number' },
  ],
  paramsSchema: z.object({ amount: z.number().min(1).max(10000).default(20), grace_days: z.number().int().min(0).max(60).default(7), cap: z.number().min(0).max(100000).default(1000) }),
  build: (p) => cs('erp_late_fee', `A late fee of Rs ${p.amount} a day after ${p.grace_days} days, at most Rs ${p.cap} per instalment.`, [op('erp.late_fee_rule', 'late_fee', { type: 'per_day', amount: p.amount, grace_days: p.grace_days, cap: p.cap })]),
});

export const CRM_ERP_TEMPLATES: TemplateDef[] = [
  crmFollowUpTemplate,
  crmFirstContactTemplate,
  crmNurtureTemplate,
  crmMessagingTemplate,
  erpFeeReminderTemplate,
  erpConcessionApprovalTemplate,
  erpAbsenceAlertTemplate,
  erpCbsePackTemplate,
  erpLateFeeTemplate,
] as unknown as TemplateDef[];
