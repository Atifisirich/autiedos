/**
 * OS blocks: everything the OS settings screens already make configurable, as designer blocks. Each settings schema
 * reuses the shared schema of its settings screen where one exists (approvalTypeSchema, checklistItemSchema,
 * MODULE_KEYS / PERMISSION_MODULES / ACTIONS / SCOPES) and names roles by key, never by id. The server side
 * (read / write / remove through the OS config tables) is packages/server/src/designer/blocks/os/.
 */
import { z } from 'zod';
import { ACTIONS, MODULE_KEYS, PERMISSION_MODULES, SCOPES } from '../modules';
import { approvalTypeSchema, checklistItemSchema, hhmm, isoDate } from '../schemas';
import { defineBlock, type BlockDef, type PreviewLine } from './catalogue';

export const keySchema = z.string().regex(/^[a-z][a-z0-9_]*$/, 'lowercase_key').max(60);
export const roleKey = z.string().regex(/^[a-z][a-z0-9_]*$/, 'role_key').max(60);
const WEEKDAY = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const days = (ws: number[]) => ws.map((d) => WEEKDAY[d] ?? String(d)).join(', ');
const L = (messageKey: string, vars?: Record<string, string | number>): PreviewLine => ({ messageKey, vars });

// ---------------------------------------------------------------- approvals
const approvalField = approvalTypeSchema.shape.form_schema.element;
const approvalCondition = approvalTypeSchema.shape.steps.element.shape.condition.unwrap().unwrap();
const approvalTask = approvalTypeSchema.shape.task_template.unwrap().unwrap().element;

export const approvalTypeBlock = defineBlock({
  key: 'os.approval_type',
  product: 'os',
  title: 'Approval type',
  description:
    'A request staff raise in the OS (e.g. purchase, event proposal, extended absence) with a form and an approval chain. ' +
    'Steps run in order of seq; steps with the same seq run in parallel. approver "role" needs role_key; "manager_of_applicant" is the applicant\'s reporting manager. ' +
    'A step with a condition only applies when the form value matches (e.g. amount > 10000, exam_week = "yes"). tasks are created for a role when the request is approved.',
  settings: z
    .object({
      key: keySchema,
      name: z.string().trim().min(2).max(120),
      fields: z.array(approvalField).max(20).default([]),
      steps: z
        .array(
          z.object({
            seq: z.number().int().min(1).max(10),
            approver: z.enum(['role', 'manager_of_applicant']),
            role_key: roleKey.nullable().optional(),
            condition: approvalCondition.nullable().optional(),
            time_limit_hours: z.number().int().min(1).max(720).default(48),
          }),
        )
        .min(1)
        .max(8),
      tasks: z.array(approvalTask).max(10).default([]),
    })
    .superRefine((s, ctx) => {
      s.steps.forEach((st, i) => {
        if (st.approver === 'role' && !st.role_key) ctx.addIssue({ code: 'custom', path: ['steps', i, 'role_key'], message: 'role_key_required' });
        if (st.condition && !s.fields.some((f) => f.key === st.condition!.field)) ctx.addIssue({ code: 'custom', path: ['steps', i, 'condition', 'field'], message: 'condition_field_not_in_form' });
      });
    }),
  keyOf: (s) => s.key,
  describe: (s) => [
    ...(s.fields.length ? [L('designer.preview.approval.fields', { fields: s.fields.map((f) => f.label).join(', ') })] : []),
    ...[...s.steps]
      .sort((a, b) => a.seq - b.seq)
      .map((st) =>
        st.condition
          ? L('designer.preview.approval.stepIf', { seq: st.seq, who: st.approver === 'role' ? String(st.role_key) : 'manager', field: st.condition.field, cmp: st.condition.op, value: st.condition.value, hours: st.time_limit_hours })
          : L('designer.preview.approval.step', { seq: st.seq, who: st.approver === 'role' ? String(st.role_key) : 'manager', hours: st.time_limit_hours }),
      ),
    ...s.tasks.map((t) => L('designer.preview.approval.task', { title: t.title, who: t.role_key ?? 'applicant', days: t.days_after })),
  ],
  roles: (s) => [...s.steps.map((st) => st.role_key).filter((r): r is string => !!r), ...s.tasks.map((t) => t.role_key).filter((r): r is string => !!r)],
  examples: [
    {
      prompt: 'Purchases above 10,000 need the director after the principal',
      settings: { key: 'purchase', name: 'Purchase', fields: [{ key: 'amount', label: 'Amount', type: 'number', required: true, options: [] }], steps: [{ seq: 1, approver: 'role', role_key: 'principal', time_limit_hours: 48 }, { seq: 2, approver: 'role', role_key: 'director', condition: { field: 'amount', op: '>', value: 10000 }, time_limit_hours: 48 }], tasks: [] },
    },
  ],
});

// ---------------------------------------------------------------- checklists
export const checklistBlock = defineBlock({
  key: 'os.checklist',
  product: 'os',
  title: 'Checklist',
  description:
    'A recurring checklist (opening, closing, safety, lab) one role fills on the phone at a set time in the current branch. ' +
    'frequency daily / weekly (weekdays 1=Mon..7=Sun) / monthly (month_day). Items are tick, yesno, number (min/max), photo or text; ' +
    'on_fail raises a helpdesk ticket (ticket_category_key) or a task for a role when an item fails.',
  settings: z.object({
    key: keySchema,
    name: z.string().trim().min(2).max(120),
    owner_role_key: roleKey,
    frequency: z.enum(['daily', 'weekly', 'monthly']),
    weekdays: z.array(z.number().int().min(1).max(7)).max(7).default([]),
    month_day: z.number().int().min(1).max(28).nullable().optional(),
    time: hhmm,
    location_text: z.string().max(200).nullable().optional(),
    items: z.array(checklistItemSchema).min(1).max(40),
  }),
  keyOf: (s) => s.key,
  describe: (s) => [
    s.frequency === 'weekly'
      ? L('designer.preview.checklist.weekly', { role: s.owner_role_key, days: days(s.weekdays), time: s.time })
      : s.frequency === 'monthly'
        ? L('designer.preview.checklist.monthly', { role: s.owner_role_key, day: s.month_day ?? 1, time: s.time })
        : L('designer.preview.checklist.daily', { role: s.owner_role_key, time: s.time }),
    L('designer.preview.checklist.items', { n: s.items.length, items: s.items.slice(0, 6).map((i) => i.label).join('; ') }),
  ],
  roles: (s) => [s.owner_role_key, ...s.items.map((i) => (i.on_fail && i.on_fail.action === 'task' ? i.on_fail.role_key : null)).filter((r): r is string => !!r)],
  check: (s) => (s.frequency === 'weekly' && !s.weekdays.length ? ['weekdays_required'] : []),
  examples: [
    {
      prompt: 'Daily opening checklist for housekeeping at 7:30',
      settings: { key: 'daily_opening', name: 'Daily opening', owner_role_key: 'housekeeping_supervisor', frequency: 'daily', weekdays: [], time: '07:30', items: [{ label: 'Classrooms unlocked and clean', label_i18n: {}, item_type: 'yesno', required: true }] },
    },
  ],
});

// ---------------------------------------------------------------- tasks
export const taskCategoryBlock = defineBlock({
  key: 'os.task_category',
  product: 'os',
  title: 'Task template (category)',
  description: 'A task category with its defaults: colour, proof needed when done (none, note, photo, file), whether the assigner verifies, and the escalation rule (by name) to use.',
  settings: z.object({
    key: keySchema,
    name: z.string().trim().min(2).max(80),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#64748b'),
    default_proof: z.enum(['none', 'note', 'photo', 'file']).default('none'),
    default_verification: z.boolean().default(false),
    escalation_rule: z.string().max(80).nullable().optional(),
  }),
  keyOf: (s) => s.key,
  describe: (s) => [L('designer.preview.taskCategory', { proof: s.default_proof, verify: s.default_verification ? 'yes' : 'no', rule: s.escalation_rule ?? '-' })],
  examples: [{ prompt: 'Maintenance tasks need a photo and verification', settings: { key: 'maintenance', name: 'Maintenance', color: '#64748b', default_proof: 'photo', default_verification: true } }],
});

export const recurringTaskBlock = defineBlock({
  key: 'os.recurring_task',
  product: 'os',
  title: 'Recurring task',
  description: 'A task created automatically for every holder of a role in the current branch: daily, weekly (weekdays 1=Mon..7=Sun) or monthly (month_day), due at due_time. Holidays are skipped.',
  settings: z.object({
    key: keySchema,
    title: z.string().trim().min(2).max(200),
    description: z.string().max(1000).nullable().optional(),
    role_key: roleKey,
    frequency: z.enum(['daily', 'weekly', 'monthly']),
    weekdays: z.array(z.number().int().min(1).max(7)).max(7).default([]),
    month_day: z.number().int().min(1).max(28).nullable().optional(),
    due_time: hhmm.default('17:00'),
    priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
    starts_on: isoDate.nullable().optional(),
  }),
  keyOf: (s) => s.key,
  describe: (s) => [
    s.frequency === 'weekly'
      ? L('designer.preview.recurring.weekly', { role: s.role_key, days: days(s.weekdays), time: s.due_time })
      : s.frequency === 'monthly'
        ? L('designer.preview.recurring.monthly', { role: s.role_key, day: s.month_day ?? 1, time: s.due_time })
        : L('designer.preview.recurring.daily', { role: s.role_key, time: s.due_time }),
  ],
  roles: (s) => [s.role_key],
  check: (s) => (s.frequency === 'weekly' && !s.weekdays.length ? ['weekdays_required'] : s.frequency === 'monthly' && !s.month_day ? ['month_day_required'] : []),
  examples: [{ prompt: 'Every Friday the admin officer checks fire extinguishers by 3 pm', settings: { key: 'fire_extinguisher_check', title: 'Check fire extinguishers', role_key: 'admin_officer', frequency: 'weekly', weekdays: [5], due_time: '15:00', priority: 'normal' } }],
});

export const escalationRuleBlock = defineBlock({
  key: 'os.escalation_rule',
  product: 'os',
  title: 'Escalation rule',
  description: 'When overdue tasks are chased: reminder minutes before due, owner at due time, assigner after N working minutes, the manager after N working days. urgent_factor shortens the times for urgent tasks. Identified by name.',
  settings: z.object({
    name: z.string().trim().min(2).max(80),
    remind_before_minutes: z.number().int().min(0).max(10080).default(120),
    notify_owner_at_due: z.boolean().default(true),
    notify_assigner_after_working_minutes: z.number().int().min(0).max(100000).default(240),
    notify_manager_after_working_days: z.number().int().min(0).max(60).default(1),
    urgent_factor: z.number().min(0.1).max(1).default(0.5),
  }),
  keyOf: (s) => s.name,
  describe: (s) => [L('designer.preview.escalation', { before: s.remind_before_minutes, assigner: s.notify_assigner_after_working_minutes, manager: s.notify_manager_after_working_days })],
  examples: [{ prompt: 'Chase the manager after 2 working days', settings: { name: 'Default', remind_before_minutes: 120, notify_owner_at_due: true, notify_assigner_after_working_minutes: 240, notify_manager_after_working_days: 2, urgent_factor: 0.5 } }],
});

export const assignmentRuleBlock = defineBlock({
  key: 'os.assignment_rule',
  product: 'os',
  title: 'Assignment rule',
  description: 'Who may give work to whom: holders of from_role_key may "assign" tasks to to_role_key directly, only "request" them (the receiver accepts), or "none".',
  settings: z.object({ from_role_key: roleKey, to_role_key: roleKey, rule: z.enum(['assign', 'request', 'none']) }),
  keyOf: (s) => `${s.from_role_key}__${s.to_role_key}`,
  describe: (s) => [L(`designer.preview.assignment.${s.rule}`, { from: s.from_role_key, to: s.to_role_key })],
  roles: (s) => [s.from_role_key, s.to_role_key],
  examples: [{ prompt: 'Coordinators can assign tasks to class teachers', settings: { from_role_key: 'academic_coordinator', to_role_key: 'class_teacher', rule: 'assign' } }],
});

// ---------------------------------------------------------------- notifications
export const NOTIFY_CHANNELS = ['inapp', 'push', 'whatsapp', 'email'] as const;
export const notificationRuleBlock = defineBlock({
  key: 'os.notification_rule',
  product: 'os',
  title: 'Notification rule',
  description:
    'Who hears about an event and how: event_key (e.g. approval.pending, substitution.assigned, leave.decision, digest.daily, or a new key such as absence.extended), ' +
    'audience staff (role_keys) or family (parents of the students concerned), channels inapp / push / whatsapp / email, optional message text. Identified by event_key and audience.',
  settings: z.object({
    event_key: z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_.]*$/).max(80),
    audience: z.enum(['staff', 'family', 'student']).default('staff'),
    role_keys: z.array(roleKey).max(20).default([]),
    channels: z.array(z.enum(NOTIFY_CHANNELS)).min(1).max(4),
    active: z.boolean().default(true),
    urgent: z.boolean().default(false),
    message: z.string().max(500).nullable().optional(),
  }),
  keyOf: (s) => `${s.event_key}__${s.audience}`,
  describe: (s) => [
    s.audience === 'family'
      ? L('designer.preview.notify.family', { event: s.event_key, channels: s.channels.join(', ') })
      : L('designer.preview.notify.staff', { event: s.event_key, roles: s.role_keys.length ? s.role_keys.join(', ') : 'the people concerned', channels: s.channels.join(', ') }),
    ...(s.message ? [L('designer.preview.notify.message', { text: s.message })] : []),
    ...(s.active ? [] : [L('designer.preview.notify.off')]),
  ],
  roles: (s) => s.role_keys,
  reachesFamilies: (s) => s.audience === 'family',
  examples: [{ prompt: 'WhatsApp parents when their child is marked absent', settings: { event_key: 'attendance.student_absent', audience: 'family', role_keys: [], channels: ['whatsapp', 'inapp'], active: true, urgent: false } }],
});

// ---------------------------------------------------------------- leave and attendance
export const leaveTypeBlock = defineBlock({
  key: 'os.leave_type',
  product: 'os',
  title: 'Leave type',
  description: 'A staff leave type with its policy: yearly quota, accrual (none / monthly / yearly), carry forward (and maximum), half days, notice days, document after N days, sandwich rule, paid.',
  settings: z.object({
    key: keySchema,
    name: z.string().trim().min(2).max(80),
    unit: z.enum(['day', 'hour']).default('day'),
    yearly_quota: z.number().min(0).max(400).nullable().optional(),
    accrual: z.enum(['none', 'monthly', 'yearly']).default('yearly'),
    carry_forward: z.boolean().default(false),
    carry_forward_max: z.number().min(0).max(400).nullable().optional(),
    half_day_allowed: z.boolean().default(true),
    notice_days: z.number().int().min(0).max(90).default(0),
    doc_required_after_days: z.number().int().min(0).max(90).nullable().optional(),
    sandwich_rule: z.boolean().default(false),
    paid: z.boolean().default(true),
  }),
  keyOf: (s) => s.key,
  describe: (s) => [
    L('designer.preview.leave', { quota: s.yearly_quota ?? 0, unit: s.unit, accrual: s.accrual, notice: s.notice_days }),
    ...(s.carry_forward ? [L('designer.preview.leave.carry', { max: s.carry_forward_max ?? 0 })] : []),
    ...(s.doc_required_after_days != null ? [L('designer.preview.leave.doc', { days: s.doc_required_after_days })] : []),
    ...(s.paid ? [] : [L('designer.preview.leave.unpaid')]),
  ],
  examples: [{ prompt: '12 casual leaves a year, one day notice', settings: { key: 'casual', name: 'Casual leave', unit: 'day', yearly_quota: 12, accrual: 'monthly', carry_forward: false, half_day_allowed: true, notice_days: 1, sandwich_rule: false, paid: true } }],
});

export const attendanceRuleBlock = defineBlock({
  key: 'os.attendance_rule',
  product: 'os',
  title: 'Staff attendance rule',
  description: 'Late and half-day thresholds for staff in the current branch: grace minutes after the start time, half day after N minutes late, edit window in hours. position_key null = all staff; else one position.',
  settings: z.object({
    position_key: keySchema.nullable().default(null),
    grace_minutes: z.number().int().min(0).max(240).default(10),
    half_day_after_minutes: z.number().int().min(0).max(600).default(120),
    edit_window_hours: z.number().int().min(0).max(720).nullable().optional(),
  }),
  keyOf: (s) => s.position_key ?? 'all_staff',
  describe: (s) => [L('designer.preview.attendance', { who: s.position_key ?? 'all staff', grace: s.grace_minutes, half: s.half_day_after_minutes })],
  examples: [{ prompt: 'Staff are late after 15 minutes', settings: { position_key: null, grace_minutes: 15, half_day_after_minutes: 120 } }],
});

// ---------------------------------------------------------------- modules, roles, fields
export const moduleFlagBlock = defineBlock({
  key: 'os.module_flag',
  product: 'os',
  title: 'Module on or off for a branch',
  description: 'Switches an OS module (tasks, checklists, duty_roster, helpdesk, ...) on or off for one branch, by branch code.',
  settings: z.object({ module_key: z.enum(MODULE_KEYS), branch_code: z.string().min(1).max(20), enabled: z.boolean() }),
  keyOf: (s) => `${s.module_key}__${s.branch_code}`,
  describe: (s) => [L(s.enabled ? 'designer.preview.module.on' : 'designer.preview.module.off', { module: s.module_key, branch: s.branch_code })],
  examples: [{ prompt: 'Turn off the duty roster at the city branch', settings: { module_key: 'duty_roster', branch_code: 'CITY', enabled: false } }],
});

export const roleBlock = defineBlock({
  key: 'os.role',
  product: 'os',
  title: 'Role',
  description: 'A new OS role (job function) that staff can hold; copy_from_role_key copies another role\'s permissions on creation. Preset roles cannot be deleted.',
  settings: z.object({ key: keySchema, name: z.string().trim().min(2).max(80), description: z.string().max(300).nullable().optional(), copy_from_role_key: roleKey.nullable().optional() }),
  keyOf: (s) => s.key,
  describe: (s) => [s.copy_from_role_key ? L('designer.preview.role.copy', { from: s.copy_from_role_key }) : L('designer.preview.role.empty')],
  roles: (s) => (s.copy_from_role_key ? [s.copy_from_role_key] : []),
  examples: [{ prompt: 'Add an exam coordinator role like the academic coordinator', settings: { key: 'exam_coordinator', name: 'Exam Coordinator', copy_from_role_key: 'academic_coordinator' } }],
});

export const rolePermissionBlock = defineBlock({
  key: 'os.role_permission',
  product: 'os',
  title: 'Role permission',
  description: 'One cell of the permission matrix: role_key may do action on module at scope (own, team, department, wing, branch, group). Delete removes the permission. Setup permissions are changed only on the roles screen.',
  settings: z.object({ role_key: roleKey, module: z.enum(PERMISSION_MODULES), action: z.enum(ACTIONS), scope: z.enum(SCOPES) }),
  keyOf: (s) => `${s.role_key}__${s.module}__${s.action}`,
  describe: (s) => [L('designer.preview.permission', { role: s.role_key, action: s.action, module: s.module, scope: s.scope })],
  roles: (s) => [s.role_key],
  check: (s) => (s.module === 'setup' ? ['setup_permissions_are_manual'] : []),
  examples: [{ prompt: 'Coordinators can approve leave for the branch', settings: { role_key: 'academic_coordinator', module: 'leave', action: 'approve', scope: 'branch' } }],
});

export const customFieldBlock = defineBlock({
  key: 'os.custom_field',
  product: 'os',
  title: 'Custom field',
  description: 'An extra field on an OS form: entity task, ticket, incident, approval or staff; type text, number, date, boolean, select (options), multiselect, file.',
  settings: z.object({
    entity: z.enum(['task', 'ticket', 'incident', 'approval', 'staff']),
    key: keySchema,
    label: z.string().trim().min(1).max(80),
    field_type: z.enum(['text', 'number', 'date', 'boolean', 'select', 'multiselect', 'file']),
    options: z.array(z.string().max(80)).max(30).default([]),
    required: z.boolean().default(false),
  }),
  keyOf: (s) => `${s.entity}__${s.key}`,
  describe: (s) => [L('designer.preview.field', { entity: s.entity, type: s.field_type, required: s.required ? 'yes' : 'no' })],
  check: (s) => ((s.field_type === 'select' || s.field_type === 'multiselect') && !s.options.length ? ['options_required'] : []),
  examples: [{ prompt: 'Add a "vendor" field to tickets', settings: { entity: 'ticket', key: 'vendor', label: 'Vendor', field_type: 'text', options: [], required: false } }],
});

export const reportScheduleBlock = defineBlock({
  key: 'os.report_schedule',
  product: 'os',
  title: 'Report or digest schedule',
  description: 'Sends a report (report_key, e.g. daily_digest) to the holders of roles in the current branch daily, weekly (weekday 1..7) or monthly, at send_time, in the app, by e-mail or as a WhatsApp link.',
  settings: z.object({
    report_key: z.string().regex(/^[a-z][a-z0-9_:-]*$/).max(80),
    frequency: z.enum(['daily', 'weekly', 'monthly']),
    send_time: hhmm,
    weekday: z.number().int().min(1).max(7).nullable().optional(),
    recipient_role_keys: z.array(roleKey).min(1).max(10),
    channel: z.enum(['inapp', 'email', 'whatsapp_link']).default('inapp'),
  }),
  keyOf: (s) => s.report_key,
  describe: (s) => [L('designer.preview.report', { report: s.report_key, frequency: s.frequency, time: s.send_time, roles: s.recipient_role_keys.join(', '), channel: s.channel })],
  roles: (s) => s.recipient_role_keys,
  check: (s) => (s.frequency === 'weekly' && !s.weekday ? ['weekday_required'] : []),
  examples: [{ prompt: 'Send the principal the daily digest at 7:30 on WhatsApp', settings: { report_key: 'daily_digest', frequency: 'daily', send_time: '07:30', recipient_role_keys: ['principal'], channel: 'whatsapp_link' } }],
});

// ---------------------------------------------------------------- calendar and events
export const eventTemplateBlock = defineBlock({
  key: 'os.event_template',
  product: 'os',
  title: 'Event template',
  description: 'A school event plan (annual day, PTM, field trip): tasks for roles N days before the event, committees, a checklist and budget lines. Used when an event is created from the calendar.',
  settings: z.object({
    key: keySchema,
    name: z.string().trim().min(2).max(120),
    tasks: z.array(z.object({ title: z.string().min(2).max(200), role_key: roleKey, days_before: z.number().int().min(0).max(365), priority: z.enum(['normal', 'high']).default('normal') })).max(30).default([]),
    committees: z.array(z.string().max(80)).max(20).default([]),
    checklist: z.array(z.string().max(200)).max(30).default([]),
    budget_lines: z.array(z.object({ line: z.string().max(120), amount: z.number().min(0) })).max(30).default([]),
  }),
  keyOf: (s) => s.key,
  describe: (s) => [
    ...s.tasks.map((t) => L('designer.preview.event.task', { title: t.title, role: t.role_key, days: t.days_before })),
    ...(s.committees.length ? [L('designer.preview.event.committees', { list: s.committees.join(', ') })] : []),
  ],
  roles: (s) => s.tasks.map((t) => t.role_key),
  examples: [{ prompt: 'For PTMs the admin officer shares the schedule a week before', settings: { key: 'ptm', name: 'Parent-teacher meeting', tasks: [{ title: 'Share PTM schedule with parents', role_key: 'admin_officer', days_before: 7, priority: 'normal' }], committees: [], checklist: [], budget_lines: [] } }],
});

export const dutyTypeBlock = defineBlock({
  key: 'os.duty_type',
  product: 'os',
  title: 'Duty type (roster)',
  description: 'A duty in the duty roster (gate, lunch, exam relief): time window, how many staff are needed, which weekdays (1..7). The roster generator fills it fairly.',
  settings: z.object({
    key: keySchema,
    name: z.string().trim().min(2).max(80),
    location: z.string().max(120).nullable().optional(),
    starts_at: hhmm,
    ends_at: hhmm,
    staff_needed: z.number().int().min(0).max(50).default(1),
    days: z.array(z.number().int().min(1).max(7)).max(7).default([1, 2, 3, 4, 5, 6]),
  }),
  keyOf: (s) => s.key,
  describe: (s) => [L('designer.preview.duty', { from: s.starts_at, to: s.ends_at, n: s.staff_needed, days: days(s.days) })],
  check: (s) => (s.ends_at <= s.starts_at ? ['ends_before_start'] : []),
  examples: [{ prompt: 'Two teachers on exam relief duty 9 to 12', settings: { key: 'exam_relief', name: 'Exam relief', starts_at: '09:00', ends_at: '12:00', staff_needed: 2, days: [1, 2, 3, 4, 5, 6] } }],
});

export const planReviewBlock = defineBlock({
  key: 'os.plan_review_chain',
  product: 'os',
  title: 'Lesson plan review chain',
  description: 'When lesson plans are due (daily: days_before the lesson at due_time; weekly: due_weekday) and which roles review them, in order (e.g. hod then academic_coordinator). Identified by name.',
  settings: z.object({
    name: z.string().trim().min(2).max(80),
    level: z.enum(['daily', 'weekly', 'unit']).default('daily'),
    due_weekday: z.number().int().min(1).max(7).nullable().optional(),
    due_time: hhmm.default('16:00'),
    days_before: z.number().int().min(0).max(14).default(1),
    review_steps: z.array(roleKey).min(1).max(5),
    active: z.boolean().default(true),
  }),
  keyOf: (s) => s.name,
  describe: (s) => [L('designer.preview.planReview', { level: s.level, chain: s.review_steps.join(' → '), days: s.days_before, time: s.due_time })],
  roles: (s) => s.review_steps,
  examples: [{ prompt: 'Daily plans are reviewed by the HOD then the coordinator, due the day before at 4 pm', settings: { name: 'Daily plans', level: 'daily', due_time: '16:00', days_before: 1, review_steps: ['hod', 'academic_coordinator'], active: true } }],
});

// ---------------------------------------------------------------- stub for the custom records stream
/**
 * STUB. The generic custom records engine (core.custom_objects, packages/server/src/custom-records/**) is built by
 * another stream, which replaces this definition with the real block (same key) and its server side.
 */
export const customObjectBlock = defineBlock({
  key: 'core.custom_object',
  product: 'core',
  title: 'Custom record type',
  description: 'A new kind of record the school keeps (e.g. visitor log, asset register) with its own fields. Not available yet.',
  settings: z.object({ key: keySchema, name: z.string().min(2).max(120), fields: z.array(z.record(z.string(), z.unknown())).max(50).default([]) }),
  keyOf: (s) => s.key,
  describe: () => [L('designer.preview.stub')],
  stub: true,
  examples: [],
});

export const OS_BLOCKS: BlockDef[] = [
  approvalTypeBlock,
  checklistBlock,
  taskCategoryBlock,
  recurringTaskBlock,
  escalationRuleBlock,
  assignmentRuleBlock,
  notificationRuleBlock,
  leaveTypeBlock,
  attendanceRuleBlock,
  moduleFlagBlock,
  roleBlock,
  rolePermissionBlock,
  customFieldBlock,
  reportScheduleBlock,
  eventTemplateBlock,
  dutyTypeBlock,
  planReviewBlock,
] as unknown as BlockDef[];

export const CORE_BLOCKS: BlockDef[] = [customObjectBlock] as unknown as BlockDef[];
