/**
 * ERP blocks: what the ERP admin screens (apps/web/app/erp/(staff)/admin, fees/structure, x/[entity]) make
 * configurable, as designer blocks. Roles are ERP role keys (core.roles with product 'erp': principal, accounts, ...);
 * fee heads, plans, scales and templates are named, branches by code. The server side
 * (packages/server/src/designer/blocks/erp/) writes the erp.* and core tables as erp_server with the signed-in
 * person's claims: the same row policies as the Data API the ERP screens use, never a bypass of a trigger.
 */
import { z } from 'zod';
import { isoDate } from '../schemas';
import { BOARDS } from '../erp/boards';
import { defineBlock, type BlockDef, type PreviewLine } from './catalogue';
import { slugKey } from './crm-blocks';
import { keySchema, leaveTypeBlock, roleKey } from './os-blocks';

const L = (messageKey: string, vars?: Record<string, string | number>): PreviewLine => ({ messageKey, vars });

// Kept in step with the ERP schema (fee_heads.type check, concession_types.auto_rule, doc_templates.type) and
// apps/web/lib/erp/caps.ts (CAP_MODULES, levelRows).
export const ERP_FEE_HEAD_TYPES = ['tuition', 'admission', 'annual', 'transport', 'hostel', 'lunch', 'activity', 'exam', 'store', 'misc', 'fine'] as const;
export const ERP_CONCESSION_RULES = ['none', 'sibling', 'staff_ward', 'merit', 'rte', 'early_payment'] as const;
export const ERP_DOC_TYPES = ['id_card', 'bonafide', 'study', 'conduct', 'character', 'promotion', 'no_dues', 'fee', 'achievement', 'participation', 'tc', 'letter', 'experience', 'relieving', 'offer'] as const;
export const ERP_APPROVAL_TYPES = ['concession', 'refund', 'receipt_reversal', 'expense', 'purchase_request', 'purchase_order', 'gate_pass', 'marks_unlock', 'gallery', 'announcement', 'attendance_regularisation'] as const;
export const ERP_CAP_MODULES: Record<string, string[]> = {
  students: ['students'], sensitive: ['student_sensitive'], attendance: ['student_attendance', 'staff_attendance'], timetable: ['timetable'], learning: ['learning'],
  homework: ['homework', 'class_posts'], marks: ['marks'], exams: ['exams'], wellbeing: ['wellbeing'], safeguarding: ['safeguarding'], health: ['health'], activities: ['activities'],
  admissions: ['admissions'], fees: ['fees'], concessions: ['concessions'], accounting: ['accounting'], staff: ['staff'], payroll: ['payroll'], leave: ['leave'],
  messages: ['communication', 'notifications'], transport: ['transport'], gate: ['gate', 'incidents'], hostel: ['hostel'], canteen: ['canteen'], inventory: ['inventory'],
  library: ['library'], documents: ['documents', 'files'], events: ['events', 'calendar'], helpdesk: ['helpdesk'], forms: ['forms'], reports: ['reports'],
  admin: ['setup', 'approvals', 'compliance', 'integrations', 'users'], audit: ['audit'], facilities: ['facilities'], leadership: ['leadership'],
};
export const ERP_CAPS = Object.keys(ERP_CAP_MODULES) as [string, ...string[]];
export const ERP_LEVELS = ['F', 'B', 'S', 'V', '-'] as const;
const FULL = ['view', 'create', 'edit', 'delete', 'configure', 'manage'];
/** ERP matrix level -> core.role_permissions rows (apps/web/lib/erp/caps.ts levelRows). */
export function erpLevelRows(level: string): { action: string; scope: 'org' | 'branch' }[] {
  if (level === 'F') return FULL.map((action) => ({ action, scope: 'org' }));
  if (level === 'B') return ['view', 'create', 'edit', 'delete'].map((action) => ({ action, scope: 'branch' }));
  if (level === 'S') return ['view', 'create', 'edit'].map((action) => ({ action, scope: 'branch' }));
  if (level === 'V') return [{ action: 'view', scope: 'branch' }];
  return [];
}
/** core.role_permissions rows -> ERP matrix level (apps/web/lib/erp/caps.ts levelOf). */
export function erpLevelOf(cap: string, perms: { module_key: string; action: string }[]): (typeof ERP_LEVELS)[number] {
  const mods = ERP_CAP_MODULES[cap] ?? [cap];
  const mine = perms.filter((p) => mods.includes(p.module_key) || p.module_key === '*');
  const has = (a: string) => mine.some((p) => p.action === a || p.action === '*');
  if (has('configure') || has('manage')) return 'F';
  if (has('delete')) return 'B';
  if (has('create') || has('edit')) return 'S';
  if (has('view')) return 'V';
  return '-';
}
/** ERP product modules that can be switched per branch (core.product_modules, product 'erp'). */
export const ERP_MODULES = ['accounting', 'activities', 'admissions', 'canteen', 'communication', 'concessions', 'documents', 'events', 'exams', 'facilities', 'fees', 'forms', 'gate', 'health', 'homework', 'hostel', 'inventory', 'leadership', 'learning', 'library', 'marks', 'payroll', 'reports', 'safeguarding', 'staff', 'student_sensitive', 'students', 'timetable', 'transport', 'wellbeing'] as const;

// ---------------------------------------------------------------- fees
export const erpFeeHeadBlock = defineBlock({
  key: 'erp.fee_head',
  product: 'erp',
  title: 'Fee head',
  description: 'A kind of fee the school charges (tuition, admission, annual, transport, hostel, lunch, activity, exam, store, misc, fine) with its GST rate and whether it counts for the tax certificate. Identified by name; removing it makes it inactive.',
  settings: z.object({ name: z.string().trim().min(2).max(80), type: z.enum(ERP_FEE_HEAD_TYPES).default('tuition'), gst_rate: z.number().min(0).max(28).default(0), tax_certificate: z.boolean().default(false), active: z.boolean().default(true) }),
  keyOf: (s) => slugKey(s.name),
  describe: (s) => [L('designer.preview.erp.feeHead', { type: s.type, gst: s.gst_rate })],
  examples: [{ prompt: 'Add a smart class fee head', settings: { name: 'Smart class fee', type: 'activity', gst_rate: 0, tax_certificate: false, active: true } }],
});

export const erpFeePlanBlock = defineBlock({
  key: 'erp.fee_plan',
  product: 'erp',
  title: 'Fee plan (structure)',
  description: 'A fee structure for the current academic year and the active branch: optionally one programme (class) by name and a category, and its items (fee head by name, instalment label, amount in rupees, due date). Demands are raised from it on the fees screen.',
  settings: z.object({
    name: z.string().trim().min(2).max(80),
    programme: z.string().max(80).nullable().optional(),
    category: z.string().max(40).nullable().optional(),
    items: z.array(z.object({ head: z.string().trim().min(2).max(80), instalment: z.string().trim().min(1).max(40), amount: z.number().positive().max(10000000), due_date: isoDate })).min(1).max(40),
    active: z.boolean().default(true),
  }),
  keyOf: (s) => slugKey(s.name),
  describe: (s) => [
    L('designer.preview.erp.feePlan', { programme: s.programme ?? '-', n: s.items.length, total: s.items.reduce((t, i) => t + i.amount, 0) }),
    ...s.items.slice(0, 6).map((i) => L('designer.preview.erp.feePlan.item', { head: i.head, instalment: i.instalment, amount: i.amount, due: i.due_date })),
  ],
  examples: [{ prompt: 'Class 1 tuition in two instalments of 30000, June and November', settings: { name: 'Class 1 tuition 2026-27', programme: 'Class 1', items: [{ head: 'Tuition fee', instalment: 'Term 1', amount: 30000, due_date: '2026-06-10' }, { head: 'Tuition fee', instalment: 'Term 2', amount: 30000, due_date: '2026-11-10' }], active: true } }],
});

export const erpLateFeeBlock = defineBlock({
  key: 'erp.late_fee_rule',
  product: 'erp',
  title: 'Late fee rule',
  description: 'The school\'s late-fee rule: none, a flat amount, an amount per day late, or slabs (after_days -> amount); grace_days before it starts and an optional cap per instalment. One per school (key "late_fee").',
  settings: z
    .object({
      type: z.enum(['none', 'flat', 'per_day', 'slab']),
      amount: z.number().min(0).max(100000).nullable().optional(),
      grace_days: z.number().int().min(0).max(120).default(0),
      cap: z.number().min(0).max(1000000).nullable().optional(),
      slabs: z.array(z.object({ after_days: z.number().int().min(0).max(365), amount: z.number().min(0).max(100000) })).max(10).nullable().optional(),
    })
    .superRefine((s, ctx) => {
      if ((s.type === 'flat' || s.type === 'per_day') && !s.amount) ctx.addIssue({ code: 'custom', path: ['amount'], message: 'amount_required' });
      if (s.type === 'slab' && !s.slabs?.length) ctx.addIssue({ code: 'custom', path: ['slabs'], message: 'slabs_required' });
    }),
  keyOf: () => 'late_fee',
  describe: (s) => [s.type === 'none' ? L('designer.preview.erp.lateFee.none') : L(`designer.preview.erp.lateFee.${s.type}`, { amount: s.amount ?? 0, grace: s.grace_days, cap: s.cap ?? '-', slabs: (s.slabs ?? []).map((x) => `${x.after_days}d: ${x.amount}`).join(', ') })],
  ops: ['create', 'update'],
  reachesFamilies: (s) => s.type !== 'none',
  examples: [{ prompt: 'Charge 50 rupees a day after a 7 day grace, at most 1000', settings: { type: 'per_day', amount: 50, grace_days: 7, cap: 1000 } }],
});

export const erpConcessionTypeBlock = defineBlock({
  key: 'erp.concession_type',
  product: 'erp',
  title: 'Concession type',
  description: 'A kind of fee concession: percent or fixed value on a fee head type, an optional maximum amount, an automatic rule (sibling, staff_ward, merit, rte, early_payment or none) and whether it stacks with others. Who approves a request is an erp.approval_rule (approval_type concession). Identified by name.',
  settings: z
    .object({
      name: z.string().trim().min(2).max(80),
      kind: z.enum(['percent', 'fixed']).default('percent'),
      value: z.number().positive().max(1000000),
      head_type: z.enum(ERP_FEE_HEAD_TYPES).default('tuition'),
      max_amount: z.number().min(0).max(10000000).nullable().optional(),
      auto_rule: z.enum(ERP_CONCESSION_RULES).default('none'),
      stackable: z.boolean().default(false),
    })
    .superRefine((s, ctx) => {
      if (s.kind === 'percent' && s.value > 100) ctx.addIssue({ code: 'custom', path: ['value'], message: 'percent_over_100' });
    }),
  keyOf: (s) => slugKey(s.name),
  describe: (s) => [L(s.kind === 'percent' ? 'designer.preview.erp.concession.percent' : 'designer.preview.erp.concession.fixed', { value: s.value, head: s.head_type, rule: s.auto_rule, max: s.max_amount ?? '-' })],
  examples: [{ prompt: 'A 15% sibling concession on tuition', settings: { name: 'Sibling concession', kind: 'percent', value: 15, head_type: 'tuition', auto_rule: 'sibling', stackable: false } }],
});

// ---------------------------------------------------------------- approvals and automations
export const erpApprovalRuleBlock = defineBlock({
  key: 'erp.approval_rule',
  product: 'erp',
  title: 'ERP approval rule',
  description:
    'Who approves an ERP request, in order (steps = ERP role keys such as principal, accounts, group_admin), for one approval_type (concession, refund, expense, purchase_request, purchase_order, gate_pass, ...). ' +
    'Optional thresholds: min_amount (the request amount in rupees is above it) and min_percent (a percent concession is above it). The first matching rule by seq wins; without a match the ERP default applies (the principal). ' +
    'Example: "fee concession above 10% needs director approval" = approval_type concession, min_percent 10, steps [group_admin] (or a director role when the school has one).',
  settings: z
    .object({
      key: keySchema,
      name: z.string().trim().min(2).max(120),
      approval_type: z.enum(ERP_APPROVAL_TYPES),
      min_amount: z.number().min(0).max(100000000).nullable().optional(),
      min_percent: z.number().min(0).max(100).nullable().optional(),
      steps: z.array(roleKey).min(1).max(5),
      seq: z.number().int().min(1).max(99).default(1),
      active: z.boolean().default(true),
    })
    .superRefine((s, ctx) => {
      if (new Set(s.steps).size !== s.steps.length) ctx.addIssue({ code: 'custom', path: ['steps'], message: 'step_repeated' });
    }),
  keyOf: (s) => s.key,
  describe: (s) => [
    L('designer.preview.erp.approvalRule', { type: s.approval_type, chain: s.steps.join(' → ') }),
    ...(s.min_amount != null ? [L('designer.preview.erp.approvalRule.amount', { amount: s.min_amount })] : []),
    ...(s.min_percent != null ? [L('designer.preview.erp.approvalRule.percent', { percent: s.min_percent })] : []),
  ],
  roles: (s) => s.steps,
  examples: [{ prompt: 'Refunds above 5000 need accounts then the principal', settings: { key: 'refund_above_5000', name: 'Refunds above Rs 5,000', approval_type: 'refund', min_amount: 5000, steps: ['accounts', 'principal'], seq: 1, active: true } }],
});

export const erpAutomationBlock = defineBlock({
  key: 'erp.automation',
  product: 'erp',
  title: 'ERP automation (recipe)',
  description:
    'An installed ERP automation recipe, by recipe key: fee_reminder_ladder (trigger fee.due_date; conditions.days = reminder days relative to the due date, negative = before, e.g. [-3, 0]; ' +
    'conditions.repeat_every_days = keep reminding every N days after; call_task_at = day after due date when accounts gets a call task), absentee_notice (trigger attendance.submitted; parents of absentees are messaged, ' +
    'after_consecutive days the class teacher gets a task), attendance_not_marked, marks_deadline, homework_posting_check, concession_approval, gate_pass, bus_delay, document_expiry, year_rollover_reminders. ' +
    'test_mode runs it without sending; enabled false pauses it.',
  settings: z.object({
    key: keySchema,
    name: z.string().trim().min(2).max(80),
    trigger: z.string().regex(/^[a-z_]+(\.[a-z0-9_:]+)?$/).max(60),
    conditions: z
      .object({
        days: z.array(z.number().int().min(-60).max(120)).max(12).optional(),
        repeat_every_days: z.number().int().min(1).max(60).optional(),
        call_task_at: z.number().int().min(0).max(120).optional(),
        days_before: z.number().int().min(0).max(120).optional(),
        escalate_at: z.number().int().min(0).max(120).optional(),
        after_consecutive: z.number().int().min(1).max(30).optional(),
      })
      .default({}),
    actions: z.array(z.object({ do: z.string().regex(/^[a-z_]+$/).max(60), at: z.string().regex(/^\d{2}:\d{2}$/).optional(), after_consecutive: z.number().int().min(1).max(30).optional() })).min(1).max(10),
    enabled: z.boolean().default(true),
    test_mode: z.boolean().default(false),
  }),
  keyOf: (s) => s.key,
  describe: (s) => [
    L('designer.preview.erp.automation', { trigger: s.trigger, actions: s.actions.map((a) => a.do).join(', ') }),
    ...(s.conditions.days?.length ? [L('designer.preview.erp.automation.days', { days: s.conditions.days.map((d) => (d < 0 ? `${-d} before` : d === 0 ? 'on the day' : `${d} after`)).join(', ') })] : []),
    ...(s.conditions.repeat_every_days ? [L('designer.preview.erp.automation.repeat', { n: s.conditions.repeat_every_days })] : []),
    ...(s.test_mode ? [L('designer.preview.erp.automation.test')] : []),
    ...(s.enabled ? [] : [L('designer.preview.erp.automation.off')]),
  ],
  reachesFamilies: (s) => s.actions.some((a) => /parent|famil|remind_parent|message/.test(a.do)),
  examples: [{ prompt: 'Remind parents 7 days and 1 day before the fee due date', settings: { key: 'fee_reminder_ladder', name: 'Fee reminder ladder', trigger: 'fee.due_date', conditions: { days: [-7, -1] }, actions: [{ do: 'remind_parent' }], enabled: true, test_mode: false } }],
});

// ---------------------------------------------------------------- messages, leave, documents
export const erpTemplateBlock = defineBlock({
  key: 'erp.message_template',
  product: 'erp',
  title: 'ERP message template',
  description: 'A parent or staff message template of the ERP (fee reminders, absence notices, circulars), by name and channel (whatsapp, sms, email, app = in-app), optionally tied to an event key such as fee.reminder or attendance.absent. Variables in double braces.',
  settings: z.object({
    name: z.string().trim().min(2).max(80),
    channel: z.enum(['whatsapp', 'sms', 'email', 'app']),
    event_key: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/).max(80).nullable().optional(),
    category: z.enum(['utility', 'marketing']).default('utility'),
    language: z.enum(['en', 'hi', 'te']).default('en'),
    body: z.string().trim().min(5).max(1000),
  }),
  keyOf: (s) => `${slugKey(s.name)}__${s.channel}`,
  describe: (s) => [L('designer.preview.erp.template', { channel: s.channel, event: s.event_key ?? '-', body: s.body.length > 90 ? `${s.body.slice(0, 90)}…` : s.body })],
  reachesFamilies: () => true,
  examples: [{ prompt: 'A fee reminder SMS', settings: { name: 'Fee reminder', channel: 'sms', event_key: 'fee.reminder', category: 'utility', language: 'en', body: 'Dear parent, the fee of {{amount}} for {{student_name}} is due on {{due_date}}.' } }],
});

export const erpLeaveTypeBlock = defineBlock({
  key: 'erp.leave_type',
  product: 'erp',
  title: 'Staff leave type (ERP HR)',
  description: `${leaveTypeBlock.description} Used by ERP HR leave and payroll (loss of pay for unpaid leave).`,
  settings: leaveTypeBlock.settings,
  keyOf: (s) => s.key,
  describe: leaveTypeBlock.describe,
  examples: [{ prompt: 'Staff get 6 sick leaves a year, a certificate after 2 days', settings: { key: 'sick', name: 'Sick leave', unit: 'day', yearly_quota: 6, accrual: 'yearly', carry_forward: false, half_day_allowed: true, notice_days: 0, doc_required_after_days: 2, sandwich_rule: false, paid: true } }],
});

export const erpDocTemplateBlock = defineBlock({
  key: 'erp.doc_template',
  product: 'erp',
  title: 'Document / certificate template',
  description: `A certificate or letter template (type: ${ERP_DOC_TYPES.join(', ')}) whose body uses {{student_name}}, {{class}}, {{admission_no}}, {{date}}, {{school}} placeholders. Identified by name; removing it makes it inactive.`,
  settings: z.object({ name: z.string().trim().min(2).max(80), type: z.enum(ERP_DOC_TYPES), body: z.string().trim().min(10).max(5000), active: z.boolean().default(true) }),
  keyOf: (s) => slugKey(s.name),
  describe: (s) => [L('designer.preview.erp.docTemplate', { type: s.type, length: s.body.length })],
  examples: [{ prompt: 'A bonafide certificate', settings: { name: 'Bonafide certificate', type: 'bonafide', body: 'This is to certify that {{student_name}} is a bonafide student of {{class}} at {{school}} (admission no. {{admission_no}}).', active: true } }],
});

// ---------------------------------------------------------------- campus settings, grading
export const erpCampusSettingsBlock = defineBlock({
  key: 'erp.campus_settings',
  product: 'erp',
  title: 'Campus settings (library, homework, parent message quiet hours)',
  description: 'School-wide ERP settings: library_fine_per_day (rupees per late day), homework_approval (homework is checked before families see it), quiet_from / quiet_to (hours when no parent message is sent). Only the settings given change. One per school (key "campus").',
  settings: z.object({
    library_fine_per_day: z.number().min(0).max(1000).nullable().optional(),
    homework_approval: z.boolean().nullable().optional(),
    quiet_from: z.number().int().min(0).max(23).nullable().optional(),
    quiet_to: z.number().int().min(0).max(23).nullable().optional(),
  }),
  keyOf: () => 'campus',
  describe: (s) => [
    ...(s.library_fine_per_day != null ? [L('designer.preview.erp.campus.library', { n: s.library_fine_per_day })] : []),
    ...(s.homework_approval != null ? [L(s.homework_approval ? 'designer.preview.erp.campus.homeworkOn' : 'designer.preview.erp.campus.homeworkOff')] : []),
    ...(s.quiet_from != null && s.quiet_to != null ? [L('designer.preview.erp.campus.quiet', { from: `${String(s.quiet_from).padStart(2, '0')}:00`, to: `${String(s.quiet_to).padStart(2, '0')}:00` })] : []),
  ],
  ops: ['create', 'update'],
  check: (s) => ((s.quiet_from == null) !== (s.quiet_to == null) ? ['quiet_hours_need_both'] : []),
  examples: [{ prompt: 'Library fine of 5 rupees a day', settings: { library_fine_per_day: 5 } }],
});

const band = z.object({ min: z.number().min(0).max(100), grade: z.string().trim().min(1).max(20), point: z.number().min(0).max(100).optional(), descriptor: z.string().max(60).optional() });
export const erpGradingScaleBlock = defineBlock({
  key: 'erp.grading_scale',
  product: 'erp',
  title: 'Grading scale',
  description: 'A grading scale: bands from the highest minimum percentage down to 0 (e.g. A1 from 91, A2 from 81 ... E from 0). Board scales: CBSE, Cambridge, ICSE, IB, NEP-HPC, Pre-school. Identified by name.',
  settings: z
    .object({ name: z.string().trim().min(2).max(80), bands: z.array(band).min(2).max(20) })
    .superRefine((s, ctx) => {
      const mins = s.bands.map((b) => b.min);
      if (!mins.includes(0)) ctx.addIssue({ code: 'custom', path: ['bands'], message: 'needs_band_from_0' });
      if (new Set(mins).size !== mins.length) ctx.addIssue({ code: 'custom', path: ['bands'], message: 'duplicate_min' });
    }),
  keyOf: (s) => slugKey(s.name),
  describe: (s) => [L('designer.preview.erp.scale', { bands: [...s.bands].sort((a, b) => b.min - a.min).map((b) => `${b.grade} ≥${b.min}`).join(', ') })],
  examples: [{ prompt: 'A simple three-band scale for the primary wing', settings: { name: 'Primary three bands', bands: [{ min: 75, grade: 'Achieved' }, { min: 40, grade: 'Developing' }, { min: 0, grade: 'Emerging' }] } }],
});

export const erpAssessmentSchemeBlock = defineBlock({
  key: 'erp.assessment_scheme',
  product: 'erp',
  title: 'Assessment scheme',
  description: `The assessment scheme for the current year from a board pack (${BOARDS.join(', ')}): terms, components and weightages of the pack, the grading scale by name, optionally one programme (class) by name, pass percentage. Identified by name.`,
  settings: z.object({
    name: z.string().trim().min(2).max(80),
    pack: z.enum(BOARDS),
    scale: z.string().max(80).nullable().optional(),
    programme: z.string().max(80).nullable().optional(),
    pass_percent: z.number().min(0).max(100).nullable().optional(),
    active: z.boolean().default(true),
  }),
  keyOf: (s) => slugKey(s.name),
  describe: (s) => [L('designer.preview.erp.scheme', { pack: s.pack, scale: s.scale ?? '-', programme: s.programme ?? '-', pass: s.pass_percent ?? '-' })],
  examples: [{ prompt: 'Use the CBSE scheme with the CBSE scale, pass at 33', settings: { name: 'CBSE 2026-27', pack: 'CBSE', scale: 'CBSE', pass_percent: 33, active: true } }],
});

// ---------------------------------------------------------------- roles and modules
export const erpRolePermissionBlock = defineBlock({
  key: 'erp.role_permission',
  product: 'erp',
  title: 'ERP role permission',
  description: `One cell of the ERP permission matrix: role_key gets level on capability (F full incl. configure for all branches, B branch edit, S scoped own classes, V view, - none). Capabilities: ${ERP_CAPS.join(', ')}. The group admin and the admin capability are changed only on the roles screen.`,
  settings: z.object({ role_key: roleKey, capability: z.enum(ERP_CAPS), level: z.enum(ERP_LEVELS) }),
  keyOf: (s) => `${s.role_key}__${s.capability}`,
  describe: (s) => [L('designer.preview.erp.permission', { role: s.role_key, capability: s.capability, level: s.level })],
  roles: (s) => [s.role_key],
  ops: ['create', 'update'],
  check: (s) => [...(['group_admin', 'portal'].includes(s.role_key) ? ['group_admin_is_fixed'] : []), ...(s.capability === 'admin' ? ['admin_permissions_are_manual'] : [])],
  examples: [{ prompt: 'Class teachers can view fee dues', settings: { role_key: 'class_teacher', capability: 'fees', level: 'V' } }],
});

export const erpModuleFlagBlock = defineBlock({
  key: 'erp.module_flag',
  product: 'erp',
  title: 'ERP module on or off',
  description: `Switches an ERP module (${ERP_MODULES.join(', ')}) on or off for one branch by code, or for the whole school (branch_code null).`,
  settings: z.object({ module_key: z.enum(ERP_MODULES), branch_code: z.string().max(20).nullable().default(null), enabled: z.boolean() }),
  keyOf: (s) => `${s.module_key}__${s.branch_code ?? 'ALL'}`,
  describe: (s) => [L(s.enabled ? 'designer.preview.erp.module.on' : 'designer.preview.erp.module.off', { module: s.module_key, branch: s.branch_code ?? 'all branches' })],
  ops: ['create', 'update'],
  examples: [{ prompt: 'Turn off the hostel module', settings: { module_key: 'hostel', branch_code: null, enabled: false } }],
});

export const ERP_BLOCKS: BlockDef[] = [
  erpFeeHeadBlock,
  erpFeePlanBlock,
  erpLateFeeBlock,
  erpConcessionTypeBlock,
  erpApprovalRuleBlock,
  erpAutomationBlock,
  erpTemplateBlock,
  erpLeaveTypeBlock,
  erpDocTemplateBlock,
  erpCampusSettingsBlock,
  erpGradingScaleBlock,
  erpAssessmentSchemeBlock,
  erpRolePermissionBlock,
  erpModuleFlagBlock,
] as unknown as BlockDef[];
