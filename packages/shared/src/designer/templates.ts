/**
 * Designer TEMPLATES: a template is a named, parameterised changeset. The starter library is built from AutoEd's
 * existing presets (packages/shared/src/presets) so a school can apply a known-good setup in one step, and the
 * planner prefers a template when one matches the request (decision 59: templates start from presets and recipes;
 * real school workflows are added later as templates).
 *
 * Adding a template: append a defineTemplate({...}) to TEMPLATES below (or registerTemplates() from another file),
 * give it designer.template.<key>.title / .description keys, and keep build() pure (no database).
 */
import { z, type ZodTypeAny } from 'zod';
import { PRESET_CHECKLISTS, PRESET_DUTY_TYPES, PRESET_LEAVE_TYPES } from '../presets';
import type { DesignerProduct } from './catalogue';
import type { Changeset, ChangeOp } from './changeset';

export interface TemplateParam {
  key: string;
  /** i18n key of the label (designer.param.<key>). */
  labelKey: string;
  type: 'number' | 'time' | 'role' | 'text' | 'boolean';
}

export interface TemplateDef<P extends ZodTypeAny = ZodTypeAny> {
  key: string;
  product: DesignerProduct;
  /** English title and description (the AI reads these; the UI shows designer.template.<key>.*). */
  title: string;
  description: string;
  /** Words that suggest this template (the mock planner and the AI prompt use them). */
  keywords: string[];
  params: TemplateParam[];
  /** zod schema of the parameters, with defaults for every one. */
  paramsSchema: P;
  build: (params: z.infer<P>) => Changeset;
}

export function defineTemplate<P extends ZodTypeAny>(t: TemplateDef<P>): TemplateDef<P> {
  return t;
}

const op = (block: string, key: string, settings: Record<string, unknown>, reason?: string): ChangeOp => ({ op: 'create', block, key, settings, reason });
const cs = (key: string, summary: string, ops: ChangeOp[]): Changeset => ({ summary, ops, unsupported: [], questions: [], template_key: key });

// ---------------------------------------------------------------- starter library (OS)
export const leavePolicyTemplate = defineTemplate({
  key: 'standard_leave_policy',
  product: 'os',
  title: 'Standard leave policy',
  description: 'Casual, sick and earned leave with AutoEd\'s default quotas, notice and carry-forward rules.',
  keywords: ['leave policy', 'leave types', 'casual leave', 'sick leave', 'earned leave'],
  params: [
    { key: 'casual_days', labelKey: 'designer.param.casual_days', type: 'number' },
    { key: 'sick_days', labelKey: 'designer.param.sick_days', type: 'number' },
    { key: 'earned_days', labelKey: 'designer.param.earned_days', type: 'number' },
  ],
  paramsSchema: z.object({ casual_days: z.number().int().min(0).max(60).default(12), sick_days: z.number().int().min(0).max(60).default(10), earned_days: z.number().int().min(0).max(60).default(15) }),
  build: (p) => {
    const quota: Record<string, number> = { casual: p.casual_days, sick: p.sick_days, earned: p.earned_days };
    const ops = PRESET_LEAVE_TYPES.filter((l) => l.key in quota).map((l) =>
      op('os.leave_type', l.key, { key: l.key, name: l.name, unit: l.unit, yearly_quota: quota[l.key], accrual: l.accrual, carry_forward: l.carry_forward, carry_forward_max: l.carry_forward_max, half_day_allowed: l.half_day_allowed, notice_days: l.notice_days, doc_required_after_days: l.doc_required_after_days, sandwich_rule: l.sandwich_rule, paid: l.paid }),
    );
    return cs('standard_leave_policy', `Standard leave policy: ${p.casual_days} casual, ${p.sick_days} sick and ${p.earned_days} earned days a year.`, ops);
  },
});

export const substitutionTemplate = defineTemplate({
  key: 'substitution_workflow',
  product: 'os',
  title: 'Teacher absence and substitution',
  description: 'A long absence is approved by the coordinator (and the principal in exam week), the coordinator gets a task to arrange substitution, and parents are told.',
  keywords: ['absent', 'absence', 'substitution', 'substitute', 'cover'],
  params: [
    { key: 'min_days', labelKey: 'designer.param.min_days', type: 'number' },
    { key: 'arranger_role', labelKey: 'designer.param.arranger_role', type: 'role' },
    { key: 'exam_week_role', labelKey: 'designer.param.exam_week_role', type: 'role' },
    { key: 'notify_parents', labelKey: 'designer.param.notify_parents', type: 'boolean' },
  ],
  paramsSchema: z.object({ min_days: z.number().int().min(1).max(30).default(2), arranger_role: z.string().default('academic_coordinator'), exam_week_role: z.string().default('principal'), notify_parents: z.boolean().default(true) }),
  build: (p) => {
    const ops: ChangeOp[] = [
      op('os.approval_type', 'extended_absence', {
        key: 'extended_absence',
        name: `Teacher absence over ${p.min_days} days`,
        fields: [
          { key: 'days', label: 'Days absent', type: 'number', required: true, options: [] },
          { key: 'exam_week', label: 'During exam week', type: 'dropdown', required: true, options: ['yes', 'no'] },
          { key: 'classes', label: 'Classes affected', type: 'text', required: false, options: [] },
        ],
        steps: [
          { seq: 1, approver: 'role', role_key: p.arranger_role, condition: { field: 'days', op: '>', value: p.min_days }, time_limit_hours: 24 },
          { seq: 2, approver: 'role', role_key: p.exam_week_role, condition: { field: 'exam_week', op: '=', value: 'yes' }, time_limit_hours: 24 },
        ],
        tasks: [{ title: 'Arrange substitution for the absence', role_key: p.arranger_role, days_after: 0 }],
      }, `Absences over ${p.min_days} days go to the ${p.arranger_role}; in exam week the ${p.exam_week_role} approves too.`),
    ];
    if (p.notify_parents) {
      ops.push(op('os.notification_rule', 'absence.extended__family', { event_key: 'absence.extended', audience: 'family', role_keys: [], channels: ['whatsapp', 'inapp'], active: true, urgent: false, message: 'A substitute teacher will take your child\'s classes while the class teacher is away.' }, 'Parents of the classes concerned are told.'));
    }
    ops.push(op('os.notification_rule', 'substitution.assigned__staff', { event_key: 'substitution.assigned', audience: 'staff', role_keys: [p.arranger_role], channels: ['inapp', 'push', 'whatsapp'], active: true, urgent: true }, 'The coordinator and the substitute hear about each cover at once.'));
    return cs('substitution_workflow', `Teacher absent more than ${p.min_days} days: the ${p.arranger_role} approves and arranges substitution${p.notify_parents ? ', parents are told' : ''}, and the ${p.exam_week_role} approves in exam week.`, ops);
  },
});

const opening = PRESET_CHECKLISTS.find((c) => c.key === 'morning_opening')!;
export const housekeepingTemplate = defineTemplate({
  key: 'daily_housekeeping_checklist',
  product: 'os',
  title: 'Daily opening checklist (housekeeping)',
  description: 'The morning opening checklist from AutoEd\'s presets: gates, classrooms, drinking water, power; failures raise a ticket or a task.',
  keywords: ['checklist', 'opening', 'housekeeping', 'morning'],
  params: [
    { key: 'time', labelKey: 'designer.param.time', type: 'time' },
    { key: 'role', labelKey: 'designer.param.role', type: 'role' },
  ],
  paramsSchema: z.object({ time: z.string().regex(/^\d{2}:\d{2}$/).default(opening.time), role: z.string().default(opening.ownerRole) }),
  build: (p) =>
    cs('daily_housekeeping_checklist', `Daily opening checklist for ${p.role} at ${p.time}.`, [
      op('os.checklist', 'daily_opening', {
        key: 'daily_opening',
        name: 'Daily opening checklist',
        owner_role_key: p.role,
        frequency: 'daily',
        weekdays: [],
        time: p.time,
        items: opening.items.map((i) => ({ label: i.label, label_i18n: i.label_i18n, item_type: i.type, required: true, on_fail: i.onFail ?? null })),
      }),
    ]),
});

export const lessonReviewTemplate = defineTemplate({
  key: 'lesson_plan_review_chain',
  product: 'os',
  title: 'Lesson plan review chain',
  description: 'Daily lesson plans are due the day before and reviewed by the HOD, then the academic coordinator (AutoEd default, DECISIONS 16).',
  keywords: ['lesson plan', 'review', 'hod', 'plan review'],
  params: [
    { key: 'due_time', labelKey: 'designer.param.due_time', type: 'time' },
    { key: 'days_before', labelKey: 'designer.param.days_before', type: 'number' },
  ],
  paramsSchema: z.object({ due_time: z.string().regex(/^\d{2}:\d{2}$/).default('16:00'), days_before: z.number().int().min(0).max(7).default(1) }),
  build: (p) =>
    cs('lesson_plan_review_chain', `Daily lesson plans due ${p.days_before} day(s) before at ${p.due_time}, reviewed by the HOD then the academic coordinator.`, [
      op('os.plan_review_chain', 'Daily lesson plans', { name: 'Daily lesson plans', level: 'daily', due_time: p.due_time, days_before: p.days_before, review_steps: ['hod', 'academic_coordinator'], active: true }),
      op('os.notification_rule', 'plan.review__staff', { event_key: 'plan.review', audience: 'staff', role_keys: ['hod', 'academic_coordinator'], channels: ['inapp', 'push'], active: true, urgent: false }),
    ]),
});

const relief = PRESET_DUTY_TYPES.find((d) => d.key === 'exam_relief')!;
export const examDutyTemplate = defineTemplate({
  key: 'exam_week_duty_roster',
  product: 'os',
  title: 'Exam-week duty roster',
  description: 'Exam relief and corridor duties for exam week, with a reminder to the people on duty.',
  keywords: ['exam week', 'duty', 'roster', 'invigilation', 'relief'],
  params: [
    { key: 'relief_staff', labelKey: 'designer.param.relief_staff', type: 'number' },
    { key: 'starts_at', labelKey: 'designer.param.starts_at', type: 'time' },
    { key: 'ends_at', labelKey: 'designer.param.ends_at', type: 'time' },
  ],
  paramsSchema: z.object({ relief_staff: z.number().int().min(1).max(20).default(2), starts_at: z.string().regex(/^\d{2}:\d{2}$/).default(relief.starts_at), ends_at: z.string().regex(/^\d{2}:\d{2}$/).default(relief.ends_at) }),
  build: (p) =>
    cs('exam_week_duty_roster', `Exam week: ${p.relief_staff} staff on exam relief ${p.starts_at}-${p.ends_at} and corridor duty, with duty reminders.`, [
      op('os.duty_type', 'exam_relief', { key: 'exam_relief', name: relief.name, starts_at: p.starts_at, ends_at: p.ends_at, staff_needed: p.relief_staff, days: [1, 2, 3, 4, 5, 6] }),
      op('os.duty_type', 'exam_corridor', { key: 'exam_corridor', name: 'Exam corridor', location: 'Exam block corridors', starts_at: p.starts_at, ends_at: p.ends_at, staff_needed: 2, days: [1, 2, 3, 4, 5, 6] }),
      op('os.notification_rule', 'duty.reminder__staff', { event_key: 'duty.reminder', audience: 'staff', role_keys: [], channels: ['inapp', 'push'], active: true, urgent: false }),
    ]),
});

export const parentAbsenceTemplate = defineTemplate({
  key: 'parent_absence_alerts',
  product: 'os',
  title: 'Parent absence alerts',
  description: 'Parents get a WhatsApp and app message when their child is marked absent, and the class teacher is reminded when attendance is not marked.',
  keywords: ['parent', 'absent', 'absence alert', 'attendance alert', 'whatsapp'],
  params: [{ key: 'whatsapp', labelKey: 'designer.param.whatsapp', type: 'boolean' }],
  paramsSchema: z.object({ whatsapp: z.boolean().default(true) }),
  build: (p) =>
    cs('parent_absence_alerts', `Parents are told when their child is absent${p.whatsapp ? ' on WhatsApp and in the app' : ' in the app'}; class teachers are reminded to mark attendance.`, [
      op('os.notification_rule', 'attendance.student_absent__family', { event_key: 'attendance.student_absent', audience: 'family', role_keys: [], channels: p.whatsapp ? ['whatsapp', 'inapp'] : ['inapp'], active: true, urgent: false, message: 'Your child was marked absent today. Please reply if this is not expected.' }),
      op('os.notification_rule', 'attendance.unmarked__staff', { event_key: 'attendance.unmarked', audience: 'staff', role_keys: ['class_teacher'], channels: ['inapp', 'push'], active: true, urgent: false }),
    ]),
});

const registry = new Map<string, TemplateDef>();
export function registerTemplates(defs: readonly TemplateDef[]): void {
  for (const d of defs) registry.set(d.key, d);
}
export function getTemplate(key: string): TemplateDef | undefined {
  return registry.get(key);
}
export function listTemplates(product?: DesignerProduct): TemplateDef[] {
  return [...registry.values()].filter((t) => !product || t.product === product);
}

export const OS_TEMPLATES: TemplateDef[] = [leavePolicyTemplate, substitutionTemplate, housekeepingTemplate, lessonReviewTemplate, examDutyTemplate, parentAbsenceTemplate] as unknown as TemplateDef[];

/** Builds a template's changeset; unknown params are dropped, missing ones take their defaults. */
export function buildTemplate(key: string, params: Record<string, unknown> = {}): Changeset {
  const t = getTemplate(key);
  if (!t) throw new Error(`unknown template ${key}`);
  return t.build(t.paramsSchema.parse(params));
}
