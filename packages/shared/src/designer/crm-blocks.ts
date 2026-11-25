/**
 * CRM blocks: what the CRM admin console (packages/crm-server/src/api/admin.ts) makes configurable, as designer blocks.
 * Settings name people by ROLE key (crm.roles), stages, sources and templates by NAME, branches by code: never ids,
 * never people. The server side (packages/server/src/designer/blocks/crm/) applies them as crm_server with the
 * signed-in person's claims, through the CRM's own tables and helpers, so the CRM's row policies and audit apply.
 *
 * Instance keys are stable slugs of the name (a stage "Contact attempted" is contact_attempted); a rename is a new item.
 */
import { z } from 'zod';
import { defineBlock, type BlockDef, type PreviewLine } from './catalogue';
import { keySchema, roleKey } from './os-blocks';

const L = (messageKey: string, vars?: Record<string, string | number>): PreviewLine => ({ messageKey, vars });

/** "Contact attempted" -> contact_attempted (the instance key of items identified by name). */
export function slugKey(name: string): string {
  return (
    String(name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .replace(/^(\d)/, 'n$1')
      .slice(0, 60) || 'item'
  );
}

// Kept in step with packages/crm-server (provision.ts PIPELINE phases, admin.ts colours / required fields, perm.ts CAPS
// and LEVELS, workflows.ts TRIGGERS, core.ts SCORE_LABELS). The shared package cannot import the CRM server.
export const CRM_PHASES = ['prospect', 'enquiry', 'visit', 'application', 'evaluation', 'offer', 'enrolled', 'closed'] as const;
export const CRM_STAGE_COLORS = ['slate', 'sky', 'violet', 'amber', 'orange', 'teal', 'green', 'rose'] as const;
export const CRM_REQUIRED_FIELDS = ['closure_reason', 'visit', 'expected_decision'] as const;
export const CRM_CAPS = ['leads', 'reassign', 'bulk', 'delete', 'tasks', 'applications', 'concession', 'payments', 'campaigns', 'workflows', 'templates', 'reports', 'sensitive', 'admin', 'audit'] as const;
export const CRM_LEVELS = ['F', 'T', 'O', 'V', '-', 'Create, V', 'Check-in', 'Own', 'Assist', 'Decide', 'Within limit', 'Request', 'Send link', 'Collect', 'Use', 'Draft', 'Part', 'Branch', 'Branch scope', 'Merge only', 'Masked', 'Mktg', 'Fin.'] as const;
export const CRM_TRIGGERS = [
  'enquiry_created', 'out_of_hours', 'missed_call', 'call_not_answered', 'visit_scheduled', 'visit_no_show', 'visit_done', 'form_started', 'form_submitted', 'payment_failed',
  'sla_breach', 'hot_lead', 'parent_replied', 're_enquiry', 'sibling_enquiry', 'admission_confirmed', 'enquiry_closed', 'stage_changed',
] as const;
export const CRM_SCORE_KEYS = ['call_connected', 'call_attempt', 'whatsapp_in', 'whatsapp_out', 'sms', 'email', 'note', 'visit_booked', 'visit_done', 'form_started', 'form_submitted', 'payment', 're_enquiry', 'sibling'] as const;
export const CRM_FORM_FIELDS = ['email', 'grade', 'branch', 'dob', 'locality', 'heard_about'] as const;
const hours = (mins: number) => (mins % 60 === 0 ? `${mins / 60} h` : `${mins} min`);

// ---------------------------------------------------------------- pipeline
export const crmStageBlock = defineBlock({
  key: 'crm.stage',
  product: 'crm',
  title: 'Pipeline stage',
  description:
    'A stage of the admission pipeline, inside one phase (prospect, enquiry, visit, application, evaluation, offer, enrolled, closed: the phase is how the stage maps onto the funnel and reports). ' +
    'sla_hours = how long a record may stay before it is overdue; required_fields = what must be filled before a record can enter the stage (closure_reason, visit, expected_decision); ' +
    'probability = chance of admission in %. Identified by its name. Removing a stage retires it (only when no record is in it). The phase of an existing stage cannot change.',
  settings: z.object({
    name: z.string().trim().min(2).max(60),
    phase: z.enum(CRM_PHASES),
    color: z.enum(CRM_STAGE_COLORS).default('slate'),
    probability: z.number().int().min(0).max(100).default(0),
    sla_hours: z.number().int().min(1).max(2160).nullable().optional(),
    required_fields: z.array(z.enum(CRM_REQUIRED_FIELDS)).max(3).default([]),
    exempt_next_action: z.boolean().default(false),
  }),
  keyOf: (s) => slugKey(s.name),
  describe: (s) => [
    L('designer.preview.crm.stage', { phase: s.phase, probability: s.probability }),
    ...(s.sla_hours ? [L('designer.preview.crm.stage.sla', { hours: s.sla_hours })] : []),
    ...(s.required_fields.length ? [L('designer.preview.crm.stage.required', { fields: s.required_fields.join(', ') })] : []),
  ],
  examples: [{ prompt: 'Add a "Scholarship test" stage in evaluation; it needs an expected decision date and is overdue after 3 days', settings: { name: 'Scholarship test', phase: 'evaluation', color: 'orange', probability: 80, sla_hours: 72, required_fields: ['expected_decision'], exempt_next_action: false } }],
});

export const crmSourceBlock = defineBlock({
  key: 'crm.lead_source',
  product: 'crm',
  title: 'Lead source',
  description: 'Where enquiries come from: a channel (Meta ads, Google, Website, Walk-in, Referral, Events...) and a source name, with its monthly cost for cost-per-admission reports. Removing a source makes it inactive (history keeps it).',
  settings: z.object({ channel: z.string().trim().min(2).max(40), name: z.string().trim().min(2).max(80), cost: z.number().min(0).max(100000000).default(0), active: z.boolean().default(true) }),
  keyOf: (s) => slugKey(s.name),
  describe: (s) => [L('designer.preview.crm.source', { channel: s.channel, cost: s.cost })],
  examples: [{ prompt: 'Track enquiries from the newspaper insert, it costs 15000', settings: { channel: 'Offline', name: 'Newspaper insert', cost: 15000, active: true } }],
});

// ---------------------------------------------------------------- routing
export const crmAssignmentRuleBlock = defineBlock({
  key: 'crm.assignment_rule',
  product: 'crm',
  title: 'Lead routing rule',
  description:
    'Who receives new enquiries: every active holder of role_key (e.g. counsellor) in turn ("round_robin") or the one with the fewest open enquiries within their daily capacity ("least_load"). ' +
    'Optional conditions: branch_code, channel (e.g. Website), grades. daily_capacity sets how many new enquiries each of those people may get per day. seq orders the rules (first match wins). Identified by name.',
  settings: z.object({
    name: z.string().trim().min(2).max(80),
    seq: z.number().int().min(1).max(99).default(1),
    method: z.enum(['round_robin', 'least_load']).default('round_robin'),
    role_key: roleKey,
    branch_code: z.string().max(20).nullable().optional(),
    channel: z.string().max(40).nullable().optional(),
    grades: z.array(z.string().max(40)).max(20).default([]),
    daily_capacity: z.number().int().min(0).max(500).nullable().optional(),
  }),
  keyOf: (s) => slugKey(s.name),
  describe: (s) => [
    L(`designer.preview.crm.routing.${s.method}`, { role: s.role_key }),
    ...(s.branch_code || s.channel || s.grades.length ? [L('designer.preview.crm.routing.when', { branch: s.branch_code ?? '-', channel: s.channel ?? '-', grades: s.grades.join(', ') || '-' })] : []),
    ...(s.daily_capacity != null ? [L('designer.preview.crm.routing.capacity', { n: s.daily_capacity })] : []),
  ],
  roles: (s) => [s.role_key],
  examples: [{ prompt: 'Give new website enquiries to the counsellors in turn, at most 20 a day each', settings: { name: 'Website to counsellors', seq: 1, method: 'round_robin', role_key: 'counsellor', channel: 'Website', grades: [], daily_capacity: 20 } }],
});

export const crmSlaBlock = defineBlock({
  key: 'crm.follow_up_sla',
  product: 'crm',
  title: 'First follow-up time (SLA)',
  description:
    'How soon a new enquiry must get its first human response (first_response_hours). After that the enquiry is tagged "sla breached" and the workflows with the trigger sla_breach run ' +
    '(use a crm.workflow with trigger sla_breach for the escalation: notify the owner, then a role such as admission_head, then reassign). One per school (key "first_response").',
  settings: z.object({ first_response_hours: z.number().min(0.25).max(720) }),
  keyOf: () => 'first_response',
  describe: (s) => [L('designer.preview.crm.sla', { time: hours(Math.round(s.first_response_hours * 60)) })],
  ops: ['create', 'update'],
  examples: [{ prompt: 'New enquiries must be called back within 2 hours', settings: { first_response_hours: 2 } }],
});

// ---------------------------------------------------------------- workflows
const crmCondition = z.object({ field: z.string().regex(/^(grade|board|branch_name|stage_name|temperature|closure_reason|custom\.[a-z0-9_]+)$/), op: z.enum(['in', 'ne']), value: z.union([z.string().max(80), z.array(z.string().max(80)).max(20)]) });
export const crmStepSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('send'), channel: z.enum(['whatsapp', 'sms', 'email']), template: z.string().trim().min(1).max(80), fallback: z.array(z.enum(['sms', 'email'])).max(2).optional() }),
  z.object({ type: z.literal('task'), title: z.string().trim().min(2).max(160), dueMins: z.number().int().min(1).max(43200), priority: z.enum(['normal', 'high']).optional(), taskType: z.string().max(40).optional() }),
  z.object({ type: z.literal('wait'), mins: z.number().int().min(1).max(129600) }),
  z.object({ type: z.literal('notify'), who: z.enum(['owner', 'head', 'role']), role_key: roleKey.optional(), title: z.string().trim().min(2).max(160) }),
  z.object({ type: z.literal('stage'), stage: z.string().trim().min(1).max(60) }),
  z.object({ type: z.literal('tag'), tag: z.string().trim().min(1).max(40) }),
  z.object({ type: z.literal('reassign') }),
]);
export type CrmStep = z.infer<typeof crmStepSchema>;
const stepLine = (s: CrmStep, i: number): PreviewLine => {
  const n = i + 1;
  switch (s.type) {
    case 'send':
      return L('designer.preview.crm.step.send', { n, channel: s.channel, template: s.template });
    case 'task':
      return L('designer.preview.crm.step.task', { n, title: s.title, due: hours(s.dueMins) });
    case 'wait':
      return L('designer.preview.crm.step.wait', { n, time: hours(s.mins) });
    case 'notify':
      return L('designer.preview.crm.step.notify', { n, who: s.who === 'role' ? String(s.role_key) : s.who, title: s.title });
    case 'stage':
      return L('designer.preview.crm.step.stage', { n, stage: s.stage });
    case 'tag':
      return L('designer.preview.crm.step.tag', { n, tag: s.tag });
    default:
      return L('designer.preview.crm.step.reassign', { n });
  }
};

export const crmWorkflowBlock = defineBlock({
  key: 'crm.workflow',
  product: 'crm',
  title: 'CRM workflow (automation)',
  description:
    'An automation of the CRM workflow engine: a trigger (enquiry_created, sla_breach, visit_no_show, form_started, ...), optional conditions (field in values / ne value), and steps run in order: ' +
    'send (an approved message template by name, on whatsapp / sms / email, with fallbacks), task (title, due in dueMins), wait (mins), notify (the owner, the branch heads, or every holder of role_key), stage (move to a stage by name), tag, reassign. ' +
    'Stop rules: stop_on_reply ends waiting steps when the parent replies; stop_on_stage_change ends them when the record leaves the stage it entered in. status published = live. ' +
    'key is the recipe key for the standard recipes (instant_welcome, untouched, no_contact, missed_call, ...) or a new key.',
  settings: z
    .object({
      key: keySchema,
      name: z.string().trim().min(2).max(80),
      description: z.string().max(300).nullable().optional(),
      trigger: z.enum(CRM_TRIGGERS),
      conditions: z.array(crmCondition).max(10).default([]),
      steps: z.array(crmStepSchema).min(1).max(20),
      status: z.enum(['draft', 'published', 'paused']).default('published'),
      stop_on_reply: z.boolean().default(true),
      stop_on_stage_change: z.boolean().default(true),
    })
    .superRefine((s, ctx) => {
      s.steps.forEach((st, i) => {
        if (st.type === 'notify' && st.who === 'role' && !st.role_key) ctx.addIssue({ code: 'custom', path: ['steps', i, 'role_key'], message: 'role_key_required' });
      });
    }),
  keyOf: (s) => s.key,
  describe: (s) => [
    L('designer.preview.crm.workflow', { trigger: s.trigger, status: s.status }),
    ...s.steps.map(stepLine),
    L(s.stop_on_reply || s.stop_on_stage_change ? 'designer.preview.crm.workflow.stops' : 'designer.preview.crm.workflow.nostop', { reply: s.stop_on_reply ? 'yes' : 'no', stage: s.stop_on_stage_change ? 'yes' : 'no' }),
  ],
  roles: (s) => s.steps.flatMap((st) => (st.type === 'notify' && st.who === 'role' && st.role_key ? [st.role_key] : [])),
  reachesFamilies: (s) => s.steps.some((st) => st.type === 'send'),
  examples: [
    {
      prompt: 'If a new enquiry is not called within the response time, remind the owner, and after an hour alert the admission head',
      settings: { key: 'untouched', name: 'Untouched escalation', trigger: 'sla_breach', conditions: [], steps: [{ type: 'notify', who: 'owner', title: 'Enquiry waiting past the response time' }, { type: 'wait', mins: 60 }, { type: 'notify', who: 'role', role_key: 'admission_head', title: 'Enquiry still untouched' }], status: 'published', stop_on_reply: true, stop_on_stage_change: true },
    },
  ],
});

// ---------------------------------------------------------------- messages and forms
export const crmTemplateBlock = defineBlock({
  key: 'crm.message_template',
  product: 'crm',
  title: 'CRM message template',
  description:
    'A WhatsApp, SMS or e-mail template used by CRM workflows and counsellors, by name. Variables in double braces: {{guardian_name}}, {{student_name}}, {{grade}}, {{branch}}, {{counsellor}}, {{school}}, {{apply_link}}. ' +
    'New WhatsApp templates wait for provider approval. Identified by name and channel.',
  settings: z.object({
    name: z.string().trim().min(2).max(80),
    channel: z.enum(['whatsapp', 'sms', 'email']),
    category: z.enum(['utility', 'marketing']).default('utility'),
    language: z.enum(['en', 'hi', 'te']).default('en'),
    body: z.string().trim().min(5).max(1000),
  }),
  keyOf: (s) => `${slugKey(s.name)}__${s.channel}`,
  describe: (s) => [L('designer.preview.crm.template', { channel: s.channel, language: s.language, body: s.body.length > 90 ? `${s.body.slice(0, 90)}…` : s.body })],
  reachesFamilies: () => true,
  examples: [{ prompt: 'A WhatsApp reminder for the scholarship test', settings: { name: 'Scholarship test reminder', channel: 'whatsapp', category: 'utility', language: 'en', body: 'Hello {{guardian_name}}, a reminder that {{student_name}} has the scholarship test at {{school}} tomorrow.' } }],
});

export const crmFormBlock = defineBlock({
  key: 'crm.enquiry_form',
  product: 'crm',
  title: 'Enquiry form',
  description: 'A hosted public enquiry form (student name, parent name and mobile always; optional email, grade, branch, dob, locality, heard_about), tied to a lead source by name and optionally a branch by code. Removing it switches it off.',
  settings: z.object({
    name: z.string().trim().min(2).max(80),
    branch_code: z.string().max(20).nullable().optional(),
    source: z.string().max(80).nullable().optional(),
    fields: z.array(z.enum(CRM_FORM_FIELDS)).max(6).default([]),
    thank_you: z.string().max(300).nullable().optional(),
  }),
  keyOf: (s) => slugKey(s.name),
  describe: (s) => [L('designer.preview.crm.form', { fields: ['student_name', 'guardian_name', 'mobile', ...s.fields].join(', '), source: s.source ?? '-' })],
  reachesFamilies: () => true,
  examples: [{ prompt: 'An open house sign-up form with grade and locality', settings: { name: 'Open house sign-up', source: 'Open house', fields: ['grade', 'locality'] } }],
});

// ---------------------------------------------------------------- limits, scoring
export const crmMessagingLimitsBlock = defineBlock({
  key: 'crm.messaging_limits',
  product: 'crm',
  title: 'Quiet hours and daily message cap',
  description: 'No automated parent messages between quiet_from and quiet_to (hours 0-23), and at most max_auto_per_day automated messages per family per day. One per school (key "messaging").',
  settings: z.object({ quiet_from: z.number().int().min(0).max(23), quiet_to: z.number().int().min(0).max(23), max_auto_per_day: z.number().int().min(1).max(20) }),
  keyOf: () => 'messaging',
  describe: (s) => [L('designer.preview.crm.limits', { from: `${String(s.quiet_from).padStart(2, '0')}:00`, to: `${String(s.quiet_to).padStart(2, '0')}:00`, n: s.max_auto_per_day })],
  ops: ['create', 'update'],
  reachesFamilies: () => true,
  examples: [{ prompt: 'No automatic messages after 8 pm or before 8 am, and at most 3 a day', settings: { quiet_from: 20, quiet_to: 8, max_auto_per_day: 3 } }],
});

export const crmScoringBlock = defineBlock({
  key: 'crm.scoring',
  product: 'crm',
  title: 'Lead scoring rules',
  description: `Points each activity adds to an enquiry's score (${CRM_SCORE_KEYS.join(', ')}; 0-100 each, unlisted keep their value) and the hot / warm thresholds. One per school (key "scoring").`,
  settings: z
    .object({
      weights: z.object(Object.fromEntries(CRM_SCORE_KEYS.map((k) => [k, z.number().int().min(0).max(100).optional()])) as Record<(typeof CRM_SCORE_KEYS)[number], z.ZodOptional<z.ZodNumber>>).default({}),
      hot_at: z.number().int().min(1).max(500),
      warm_at: z.number().int().min(1).max(500),
    })
    .superRefine((s, ctx) => {
      if (s.warm_at >= s.hot_at) ctx.addIssue({ code: 'custom', path: ['warm_at'], message: 'warm_below_hot' });
    }),
  keyOf: () => 'scoring',
  describe: (s) => [
    L('designer.preview.crm.scoring', { hot: s.hot_at, warm: s.warm_at }),
    ...(Object.keys(s.weights).length ? [L('designer.preview.crm.scoring.weights', { list: Object.entries(s.weights).filter(([, v]) => v != null).map(([k, v]) => `${k} ${v}`).join(', ') })] : []),
  ],
  ops: ['create', 'update'],
  examples: [{ prompt: 'A completed campus visit should count more; hot from 70', settings: { weights: { visit_done: 35 }, hot_at: 70, warm_at: 30 } }],
});

// ---------------------------------------------------------------- roles
export const crmRoleBlock = defineBlock({
  key: 'crm.role',
  product: 'crm',
  title: 'CRM role',
  description: 'A new CRM role, created as a copy of an existing role\'s permission matrix (copy_from_role_key, e.g. counsellor); change single cells with crm.role_permission. Only roles nobody holds can be removed.',
  settings: z.object({ key: keySchema, name: z.string().trim().min(2).max(60), copy_from_role_key: roleKey }),
  keyOf: (s) => s.key,
  describe: (s) => [L('designer.preview.crm.role', { from: s.copy_from_role_key })],
  roles: (s) => [s.copy_from_role_key],
  check: (s) => (s.copy_from_role_key === 'group_admin' ? ['cannot_copy_group_admin'] : []),
  examples: [{ prompt: 'A senior counsellor role like the counsellor', settings: { key: 'senior_counsellor', name: 'Senior Counsellor', copy_from_role_key: 'counsellor' } }],
});

export const crmRolePermissionBlock = defineBlock({
  key: 'crm.role_permission',
  product: 'crm',
  title: 'CRM role permission',
  description: `One cell of the CRM permission matrix: role_key gets level on capability. Levels: F full, T team or branch, O own records, V view only, - none (and the special levels of the matrix such as "Within limit", "Request", "Masked"). Capabilities: ${CRM_CAPS.join(', ')}. The group admin and the admin-console capability are changed only on the roles screen.`,
  settings: z.object({ role_key: roleKey, capability: z.enum(CRM_CAPS), level: z.enum(CRM_LEVELS) }),
  keyOf: (s) => `${s.role_key}__${s.capability}`,
  describe: (s) => [L('designer.preview.crm.permission', { role: s.role_key, capability: s.capability, level: s.level })],
  roles: (s) => [s.role_key],
  ops: ['create', 'update'],
  check: (s) => [...(s.role_key === 'group_admin' || s.role_key === 'system' ? ['group_admin_is_fixed'] : []), ...(s.capability === 'admin' ? ['admin_permissions_are_manual'] : [])],
  examples: [{ prompt: 'Counsellors can see their team\'s reports', settings: { role_key: 'counsellor', capability: 'reports', level: 'T' } }],
});

export const CRM_BLOCKS: BlockDef[] = [
  crmStageBlock,
  crmSourceBlock,
  crmAssignmentRuleBlock,
  crmSlaBlock,
  crmWorkflowBlock,
  crmTemplateBlock,
  crmFormBlock,
  crmMessagingLimitsBlock,
  crmScoringBlock,
  crmRoleBlock,
  crmRolePermissionBlock,
] as unknown as BlockDef[];
