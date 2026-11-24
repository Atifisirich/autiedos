/**
 * Validation schemas shared by the web API, web forms and the mobile app (rule 10).
 */
import { z } from 'zod';
import { ACTIONS, PERMISSION_MODULES, SCOPES, MODULE_KEYS } from '../modules';

export const uuid = z.string().uuid();
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date');
export const hhmm = z.string().regex(/^\d{2}:\d{2}$/, 'time');
const i18nLabel = z.object({ en: z.string().min(1), hi: z.string().optional(), te: z.string().optional() });
const optText = z.string().trim().max(5000).optional().nullable();

// ---------------------------------------------------------------- auth & profile
export const devLoginSchema = z.object({ email: z.string().email() });
export const sessionSchema = z.object({ accessToken: z.string().min(10) });
export const profileSchema = z.object({
  language: z.enum(['en', 'hi', 'te']).optional(),
  ui_prefs: z.object({ large_text: z.boolean().optional(), simplified_home: z.boolean().optional() }).optional(),
});
export const deviceTokenSchema = z.object({ token: z.string().min(10), platform: z.enum(['android', 'ios', 'web']), device_name: z.string().max(120).optional() });

// ---------------------------------------------------------------- setup
export const orgProfileSchema = z.object({
  name: z.string().min(2).max(200),
  preset_key: z.enum(['cbse', 'cambridge', 'dual']),
  branch: z.object({
    name: z.string().min(2),
    code: z.string().min(1).max(20),
    address: z.string().optional(),
    latitude: z.number().min(-90).max(90).optional().nullable(),
    longitude: z.number().min(-180).max(180).optional().nullable(),
    geofence_radius_m: z.number().int().min(20).max(5000).default(200),
  }),
});
export const academicYearSchema = z.object({
  name: z.string().min(2),
  starts_on: isoDate,
  ends_on: isoDate,
  working_days: z.array(z.number().int().min(1).max(7)).min(1),
  terms: z.array(z.object({ name: z.string().min(1), starts_on: isoDate, ends_on: isoDate })).min(1),
  bell: z.array(
    z.object({
      wing_id: uuid.nullable().optional(),
      name: z.string().min(1),
      periods: z.array(z.object({ label: z.string().min(1), kind: z.enum(['period', 'break', 'assembly']), starts_at: hhmm, ends_at: hhmm })).min(1),
    }),
  ),
});
export const moduleFlagSchema = z.object({ branch_id: uuid, module_key: z.enum(MODULE_KEYS), enabled: z.boolean() });
export const rolePermissionSchema = z.object({
  role_id: uuid,
  module: z.enum(PERMISSION_MODULES),
  action: z.enum(ACTIONS),
  scope: z.enum(SCOPES).nullable(), // null removes the permission
});
export const roleSchema = z.object({ key: z.string().regex(/^[a-z0-9_]+$/), name: z.string().min(2), description: z.string().optional() });
export const assignmentRuleSchema = z.object({ from_role_id: uuid, to_role_id: uuid, rule: z.enum(['assign', 'request', 'none']) });
export const delegationSchema = z.object({ staff_id: uuid, delegate_id: uuid, starts_on: isoDate, ends_on: isoDate, reason: optText });
export const orgChartMoveSchema = z.object({ staff_id: uuid, reports_to: uuid.nullable() });
export const customFieldSchema = z.object({
  entity: z.enum(['task', 'ticket', 'incident', 'approval', 'staff']),
  key: z.string().regex(/^[a-z0-9_]+$/),
  label: i18nLabel,
  field_type: z.enum(['text', 'number', 'date', 'dropdown', 'yesno', 'file']),
  options: z.array(z.string()).default([]),
  required: z.boolean().default(false),
});
export const importKindSchema = z.enum(['wings_classes_sections', 'subjects', 'staff', 'org_chart', 'students', 'rooms', 'allocations']);
export const importSchema = z.object({ kind: importKindSchema, rows: z.array(z.record(z.string(), z.any())).max(5000), dry_run: z.boolean().default(false) });

// Generic config row editor (task categories, leave types, duty types, ...).
export const configRowSchema = z.object({ id: uuid.optional(), data: z.record(z.string(), z.any()) });

// ---------------------------------------------------------------- tasks
export const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export const taskCreateSchema = z.object({
  title: z.string().trim().min(1).max(300),
  description: optText,
  category_id: uuid.optional().nullable(),
  priority: z.enum(PRIORITIES).default('normal'),
  source: z.enum(['assigned', 'self', 'sudden']).default('assigned'),
  assignee_ids: z.array(uuid).default([]),
  target_role_id: uuid.optional().nullable(),
  target_wing_id: uuid.optional().nullable(),
  target_department_id: uuid.optional().nullable(),
  group_mode: z.enum(['each', 'any']).default('each'),
  collaborator_ids: z.array(uuid).default([]),
  watcher_ids: z.array(uuid).default([]),
  start_at: z.string().datetime({ offset: true }).optional().nullable(),
  due_at: z.string().datetime({ offset: true }).optional().nullable(),
  estimated_minutes: z.number().int().min(0).max(10000).optional().nullable(),
  time_spent_minutes: z.number().int().min(0).max(1440).optional().nullable(),
  proof_required: z.enum(['none', 'note', 'photo', 'file']).optional(),
  verification_required: z.boolean().optional(),
  linked_type: z.enum(['class', 'subject', 'event', 'ticket', 'lesson_plan', 'meeting', 'section']).optional().nullable(),
  linked_id: uuid.optional().nullable(),
  voice_note_path: z.string().optional().nullable(),
  subtasks: z.array(z.string().trim().min(1).max(300)).max(50).default([]),
  custom: z.record(z.string(), z.any()).default({}),
  recurrence: z
    .object({
      frequency: z.enum(['daily', 'weekly', 'monthly', 'term', 'custom']),
      interval_n: z.number().int().min(1).max(12).default(1),
      weekdays: z.array(z.number().int().min(1).max(7)).default([]),
      month_day: z.number().int().min(1).max(31).optional().nullable(),
      custom_dates: z.array(isoDate).default([]),
      due_time: hhmm.default('17:00'),
      starts_on: isoDate,
      ends_on: isoDate.optional().nullable(),
    })
    .optional()
    .nullable(),
  client_id: z.string().max(64).optional(),
});
export type TaskCreateInput = z.infer<typeof taskCreateSchema>;

export const quickAddSchema = z.object({
  title: z.string().trim().min(1).max(300),
  time_spent_minutes: z.number().int().min(0).max(1440).optional().nullable(),
  voice_note_path: z.string().optional().nullable(),
  client_id: z.string().max(64).optional(),
});

export const taskActionSchema = z.object({
  action: z.enum(['accept', 'decline', 'start', 'block', 'unblock', 'complete', 'not_done', 'verify', 'reopen', 'cancel', 'carry_forward', 'request_extension', 'delegate', 'change_due']),
  reason: z.string().max(100).optional().nullable(),
  note: z.string().max(2000).optional().nullable(),
  proof_path: z.string().optional().nullable(),
  delegate_to: uuid.optional(),
  due_at: z.string().datetime({ offset: true }).optional(),
  time_spent_minutes: z.number().int().min(0).max(1440).optional(),
  client_id: z.string().max(64).optional(),
  /** offline: when the action happened on the device */
  client_at: z.string().datetime({ offset: true }).optional(),
});
export type TaskActionInput = z.infer<typeof taskActionSchema>;

export const taskCommentSchema = z.object({
  body: z.string().trim().min(1).max(4000),
  kind: z.enum(['comment', 'question']).default('comment'),
  mentions: z.array(uuid).default([]),
});
export const taskBulkSchema = z.object({
  task_ids: z.array(uuid).min(1).max(500),
  op: z.enum(['reassign', 'reschedule', 'cancel']),
  to_staff_id: uuid.optional(),
  due_at: z.string().datetime({ offset: true }).optional(),
});
export const reassignLeaverSchema = z.object({ from_staff_id: uuid, to_staff_id: uuid });
export const dayCloseSchema = z.object({
  items: z.array(
    z.object({
      task_id: uuid,
      outcome: z.enum(['done', 'not_done', 'carry_forward']),
      reason: z.enum(['no_time', 'not_possible', 'not_needed', 'other']).optional(),
      note: z.string().max(500).optional(),
    }),
  ),
});

// ---------------------------------------------------------------- checklists
export const checklistItemSchema = z.object({
  label: z.string().min(1),
  label_i18n: z.object({ hi: z.string().optional(), te: z.string().optional() }).default({}),
  item_type: z.enum(['tick', 'yesno', 'number', 'photo', 'text']),
  min_value: z.number().optional().nullable(),
  max_value: z.number().optional().nullable(),
  required: z.boolean().default(true),
  on_fail: z
    .union([z.object({ action: z.literal('ticket'), ticket_category_key: z.string() }), z.object({ action: z.literal('task'), role_key: z.string() })])
    .optional()
    .nullable(),
});
export const checklistTemplateSchema = z.object({
  name: z.string().min(2),
  schedule: z.object({ frequency: z.enum(['daily', 'weekly', 'monthly']), weekdays: z.array(z.number().int().min(1).max(7)).default([]), month_day: z.number().int().optional(), time: hhmm }),
  owner_role_id: uuid.optional().nullable(),
  owner_staff_id: uuid.optional().nullable(),
  room_id: uuid.optional().nullable(),
  location_text: z.string().optional().nullable(),
  items: z.array(checklistItemSchema).min(1),
});
export const checklistSubmitSchema = z.object({
  answers: z.array(z.object({ item_id: uuid, value: z.union([z.boolean(), z.number(), z.string(), z.null()]), photo_path: z.string().optional().nullable(), note: z.string().optional().nullable() })),
  complete: z.boolean().default(true),
  client_id: z.string().max(64).optional(),
});

// ---------------------------------------------------------------- timetable & substitution
export const allocationSchema = z.object({
  staff_id: uuid,
  section_id: uuid,
  subject_id: uuid,
  periods_per_week: z.number().int().min(0).max(60),
  double_periods: z.number().int().min(0).max(10).default(0),
  co_teacher_id: uuid.optional().nullable(),
  group_key: z.string().max(40).optional().nullable(),
  combined_key: z.string().max(40).optional().nullable(),
  room_type: z.string().max(40).optional().nullable(),
});
export const timetableGenerateSchema = z.object({ name: z.string().min(1).max(100), keep_locked_from_version_id: uuid.optional().nullable() });
export const timetableEditSchema = z.object({
  op: z.enum(['move', 'swap', 'lock', 'unlock', 'clear', 'set']),
  entry_id: uuid.optional(),
  other_entry_id: uuid.optional(),
  day: z.number().int().min(1).max(7).optional(),
  period_seq: z.number().int().min(1).max(20).optional(),
  section_id: uuid.optional(),
  subject_id: uuid.optional().nullable(),
  staff_id: uuid.optional().nullable(),
  room_id: uuid.optional().nullable(),
  force: z.boolean().default(false),
});
export const timetablePublishSchema = z.object({ effective_from: isoDate });
export const substitutionAssignSchema = z.object({
  substitution_id: uuid,
  resolution: z.enum(['substitute', 'combine', 'library', 'games', 'supervision']),
  substitute_staff_id: uuid.optional().nullable(),
});
export const markAbsentSchema = z.object({ staff_id: uuid, date: isoDate });

// ---------------------------------------------------------------- attendance
export const checkInSchema = z.object({
  kind: z.enum(['in', 'out']),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracy_m: z.number().min(0).max(10000).optional(),
  selfie_path: z.string().optional().nullable(),
  client_at: z.string().datetime({ offset: true }).optional(),
});
export const biometricImportSchema = z.object({
  device_type: z.string().min(1).max(60),
  mapping: z.object({ employeeCode: z.string(), date: z.string(), checkIn: z.string(), checkOut: z.string().optional(), dateFormat: z.string() }),
  rows: z.array(z.record(z.string(), z.string())).max(20000),
  file_name: z.string().optional(),
  save_mapping: z.boolean().default(true),
});
export const regularisationSchema = z.object({ date: isoDate, check_in: hhmm.optional(), check_out: hhmm.optional(), reason: z.string().min(3).max(500) });
export const STUDENT_MARKS = ['present', 'absent', 'late', 'half_day', 'on_duty', 'leave'] as const;
export const studentAttendanceSchema = z.object({
  section_id: uuid,
  date: isoDate,
  session_key: z.string().regex(/^(day|am|pm|p\d{1,2})$/),
  marks: z.array(z.object({ student_id: uuid, status: z.enum(STUDENT_MARKS), note: z.string().max(200).optional() })),
  edit_reason: z.string().max(500).optional(),
  client_id: z.string().max(64).optional(),
});

// ---------------------------------------------------------------- leave & approvals
export const leaveApplySchema = z.object({
  leave_type_id: uuid,
  start_date: isoDate,
  end_date: isoDate,
  half_day: z.enum(['none', 'first', 'second']).default('none'),
  hours: z.number().min(0.5).max(12).optional().nullable(),
  reason: z.string().max(1000).optional().nullable(),
  attachment_path: z.string().optional().nullable(),
  handover_note: z.string().max(2000).optional().nullable(),
  parent_request_id: uuid.optional().nullable(),
});
export const approvalTypeSchema = z.object({
  key: z.string().regex(/^[a-z0-9_]+$/),
  name: z.string().min(2),
  form_schema: z.array(z.object({ key: z.string().regex(/^[a-z0-9_]+$/), label: z.string().min(1), type: z.enum(['text', 'number', 'date', 'dropdown', 'yesno', 'file']), required: z.boolean().default(false), options: z.array(z.string()).default([]) })),
  task_template: z.array(z.object({ title: z.string(), role_key: z.string().optional(), days_after: z.number().int().default(0) })).optional().nullable(),
  steps: z.array(
    z.object({
      seq: z.number().int().min(1),
      approver_kind: z.enum(['role', 'manager_of_applicant', 'staff']),
      approver_role_id: uuid.optional().nullable(),
      approver_staff_id: uuid.optional().nullable(),
      condition: z.object({ field: z.string(), op: z.enum(['>', '>=', '<', '<=', '=', '!=']), value: z.union([z.number(), z.string()]) }).optional().nullable(),
      time_limit_hours: z.number().int().min(1).max(720).default(48),
    }),
  ).min(1),
});
export const approvalRequestSchema = z.object({ approval_type_key: z.string(), title: z.string().min(2).max(200), data: z.record(z.string(), z.any()).default({}) });
export const approvalActionSchema = z.object({ action: z.enum(['approve', 'reject', 'return', 'forward', 'resubmit', 'cancel']), comment: z.string().max(2000).optional().nullable(), forward_to: uuid.optional() });

// ---------------------------------------------------------------- lesson planning
export const dailyPlanRequestSchema = z.object({
  section_ids: z.array(uuid).min(1),
  subject_id: uuid,
  topic_id: uuid,
  plan_date: isoDate,
  period_count: z.number().int().min(1).max(3),
  period_minutes: z.number().int().min(20).max(120),
  teaching_model: z.enum(['5E', 'gradual_release', 'experiential', 'inquiry', 'direct', 'flipped', 'school']),
  resources: z.array(z.enum(['smart_board', 'lab', 'projector', 'none'])).default([]),
  class_profile: z.object({ size: z.number().int().min(1).max(100).optional(), ability_mix: z.enum(['mixed', 'mostly_strong', 'mostly_support']).default('mixed'), medium: z.string().default('English') }).default({}),
  notes: z.string().max(2000).optional(),
  language: z.enum(['en', 'hi', 'te']).optional(),
});
export const planSectionActionSchema = z.object({
  section: z.string(),
  action: z.enum(['regenerate', 'more_hands_on', 'simplify', 'add_unplugged_activity', 'shorten', 'add_questions', 'translate']),
  minutes: z.number().int().min(5).max(240).optional(),
  language: z.enum(['en', 'hi', 'te']).optional(),
});
export const companionSchema = z.object({ kind: z.enum(['worksheet', 'quiz', 'exit_ticket', 'homework', 'slides', 'activities', 'rubric', 'remedial', 'enrichment', 'cover_plan']) });
export const planUpdateSchema = z.object({ content: z.record(z.string(), z.any()), note: z.string().max(200).optional() });
export const planWorkflowSchema = z.object({
  action: z.enum(['confirm', 'submit', 'approve', 'return', 'deliver', 'reflect', 'add_to_bank', 'rate']),
  comment: z.string().max(4000).optional(),
  section_comments: z.array(z.object({ section: z.string(), comment: z.string().max(2000) })).default([]),
  reflection: z.string().max(4000).optional(),
  rating: z.number().int().min(1).max(5).optional(),
});
export const annualPlanSchema = z.object({ programme_id: uuid, subject_id: uuid, curriculum_subject_id: uuid, use_ai: z.boolean().default(false) });
export const classLogSchema = z.object({
  section_id: uuid,
  subject_id: uuid,
  date: isoDate,
  period_seq: z.number().int().min(1).max(20),
  topic_id: uuid.optional().nullable(),
  lesson_plan_id: uuid.optional().nullable(),
  taught_as_planned: z.boolean().default(true),
  topic_text: z.string().max(500).optional().nullable(),
  classwork: z.string().max(2000).optional().nullable(),
  remarks: z.string().max(2000).optional().nullable(),
  homework: z.object({ description: z.string().min(1).max(2000), due_on: isoDate, est_minutes: z.number().int().min(0).max(300) }).optional().nullable(),
  client_id: z.string().max(64).optional(),
});
export const notebookCheckSchema = z.object({ section_id: uuid, subject_id: uuid, staff_id: uuid, kind: z.enum(['cycle', 'spot_check']), checked_on: isoDate, rubric: z.record(z.string(), z.number()).default({}), notes: z.string().max(2000).optional() });
export const curriculumCloneSchema = z.object({ board_id: uuid });
export const documentUploadSchema = z.object({ title: z.string().min(1).max(200), kind: z.enum(['textbook', 'year_plan', 'lesson_plan', 'worksheet', 'sop', 'other']), storage_path: z.string().min(1), mime: z.string().max(120), size_bytes: z.number().int().min(1).max(26214400), subject_id: uuid.optional().nullable(), programme_id: uuid.optional().nullable(), text: z.string().max(2_000_000).optional() });

// ---------------------------------------------------------------- exams & papers
export const examSchema = z.object({ name: z.string().min(2), exam_type_id: uuid.optional().nullable(), term_id: uuid.optional().nullable(), starts_on: isoDate, ends_on: isoDate, programme_ids: z.array(uuid).min(1) });
export const examScheduleSchema = z.object({ exam_id: uuid, programme_id: uuid, subject_id: uuid, date: isoDate, starts_at: hhmm, ends_at: hhmm, room_ids: z.array(uuid).default([]) });
export const blueprintSchema = z.object({
  name: z.string().min(2),
  board: z.enum(['CBSE', 'CAMBRIDGE']),
  programme_id: uuid.optional().nullable(),
  subject_id: uuid.optional().nullable(),
  total_marks: z.number().int().min(1).max(500),
  duration_minutes: z.number().int().min(10).max(600),
  sections: z.array(z.object({ name: z.string().min(1), question_type: z.string().min(1), count: z.number().int().min(1).max(100), marks_each: z.number().int().min(1).max(50) })).min(1),
  chapter_weightage: z.record(uuid, z.number().int().min(0)),
  difficulty: z.object({ easy: z.number().int().min(0).max(100), medium: z.number().int().min(0).max(100), hard: z.number().int().min(0).max(100) }),
  bloom: z.record(z.string(), z.number()).default({}),
  competency_pct: z.number().min(0).max(100).default(0),
  instructions: z.string().max(4000).optional(),
  is_template: z.boolean().default(false),
});
export const paperGenerateSchema = z.object({ blueprint_id: uuid, exam_id: uuid.optional().nullable(), exam_date: isoDate, sets: z.number().int().min(1).max(3).default(1), source: z.enum(['bank', 'ai', 'mixed']).default('mixed'), reviewer_ids: z.array(uuid).default([]) });
export const paperReviewSchema = z.object({ action: z.enum(['submit', 'approve', 'return', 'replace_question']), comment: z.string().max(4000).optional(), question_no: z.number().int().optional() });

// ---------------------------------------------------------------- observation & appraisal
export const observationSchema = z.object({ rubric_id: uuid, teacher_id: uuid, section_id: uuid.optional().nullable(), subject_id: uuid.optional().nullable(), scheduled_at: z.string().datetime({ offset: true }), announced: z.boolean().default(true) });
export const observationFillSchema = z.object({ scores: z.record(z.string(), z.number()), evidence: z.record(z.string(), z.string()).default({}), feedback: z.string().max(4000).optional(), agreed_actions: z.array(z.object({ description: z.string().min(1), due_on: isoDate })).default([]), share: z.boolean().default(false) });
export const observationAckSchema = z.object({ reflection: z.string().max(4000) });
export const appraisalCycleSchema = z.object({ name: z.string().min(2), starts_on: isoDate, ends_on: isoDate, weights: z.record(z.string(), z.number().min(0).max(100)) });
export const trainingSchema = z.object({ staff_id: uuid.optional(), title: z.string().min(2), provider: z.string().optional(), attended_on: isoDate, hours: z.number().min(0.5).max(500), certificate_path: z.string().optional().nullable() });

// ---------------------------------------------------------------- admin modules
export const ticketSchema = z.object({
  category_id: uuid,
  room_id: uuid.optional().nullable(),
  location_text: z.string().max(200).optional().nullable(),
  title: z.string().trim().min(1).max(200).optional(),
  description: optText,
  priority: z.enum(PRIORITIES).default('normal'),
  photo_path: z.string().optional().nullable(),
  voice_path: z.string().optional().nullable(),
  source: z.enum(['manual', 'qr']).default('manual'),
});
export const ticketActionSchema = z.object({
  action: z.enum(['assign', 'start', 'wait', 'resolve', 'close', 'reopen', 'update_costs']),
  owner_id: uuid.optional(),
  note: z.string().max(2000).optional(),
  vendor: z.string().max(200).optional(),
  cost: z.number().min(0).optional(),
  parts: z.string().max(1000).optional(),
});
export const circularSchema = z.object({
  title: z.string().min(2).max(200),
  body: z.string().min(1).max(20000),
  attachments: z.array(z.object({ path: z.string(), name: z.string() })).default([]),
  target: z.object({ branch_ids: z.array(uuid).default([]), wing_ids: z.array(uuid).default([]), department_ids: z.array(uuid).default([]), role_ids: z.array(uuid).default([]), staff_ids: z.array(uuid).default([]) }),
  response_mode: z.enum(['read', 'acknowledge', 'reply']).default('read'),
  reply_form: z.object({ question: z.string(), options: z.array(z.string()).default(['yes', 'no']) }).optional().nullable(),
  important: z.boolean().default(false),
  tags: z.array(z.string().max(40)).default([]),
  scheduled_at: z.string().datetime({ offset: true }).optional().nullable(),
  reminder_after_hours: z.number().int().min(1).max(240).default(24),
});
export const circularResponseSchema = z.object({ action: z.enum(['read', 'acknowledge', 'reply']), reply: z.object({ choice: z.string(), comment: z.string().max(1000).optional() }).optional() });
export const calendarEventSchema = z.object({
  layer: z.enum(['holiday', 'exam', 'event', 'ptm', 'staff_meeting', 'training', 'deadline']),
  title: z.string().min(1).max(200),
  starts_on: isoDate,
  ends_on: isoDate,
  starts_at: hhmm.optional().nullable(),
  ends_at: hhmm.optional().nullable(),
  group_level: z.boolean().default(false),
});
export const meetingSchema = z.object({
  title: z.string().min(2),
  agenda: z.string().max(10000).optional(),
  starts_at: z.string().datetime({ offset: true }),
  ends_at: z.string().datetime({ offset: true }),
  room_id: uuid.optional().nullable(),
  attendee_ids: z.array(uuid).min(1),
  recurrence: z.object({ frequency: z.enum(['weekly', 'monthly']), count: z.number().int().min(1).max(52) }).optional().nullable(),
});
export const meetingMinutesSchema = z.object({
  minutes: z.string().max(50000),
  attendance: z.record(uuid, z.boolean()).default({}),
  actions: z.array(z.object({ description: z.string().min(1), owner_id: uuid, due_on: isoDate })).default([]),
  close: z.boolean().default(false),
});
export const eventSchema = z.object({ template_id: uuid.optional().nullable(), name: z.string().min(2), event_date: isoDate, owner_id: uuid.optional().nullable(), budget: z.array(z.object({ line: z.string(), amount: z.number().min(0) })).default([]) });
export const eventReviewSchema = z.object({ went_well: z.string().max(4000), improve: z.string().max(4000), attendance: z.number().int().min(0).optional() });
export const dutyGenerateSchema = z.object({ from: isoDate, to: isoDate });
export const dutySwapSchema = z.object({ assignment_id: uuid, swap_with_id: uuid });
export const incidentSchema = z.object({
  type: z.enum(['discipline', 'injury', 'parent_complaint', 'safety', 'property', 'ptm_note']),
  student_ids: z.array(uuid).default([]),
  staff_ids: z.array(uuid).default([]),
  room_id: uuid.optional().nullable(),
  location_text: z.string().max(200).optional().nullable(),
  occurred_at: z.string().datetime({ offset: true }),
  description: z.string().min(3).max(10000),
  action_taken: z.string().max(4000).optional().nullable(),
  severity: z.enum(['low', 'medium', 'high', 'critical']),
  confidential: z.boolean().default(false),
  owner_id: uuid.optional().nullable(),
  follow_ups: z.array(z.object({ title: z.string().min(1), owner_id: uuid, due_on: isoDate })).default([]),
});
export const complianceItemSchema = z.object({ name: z.string().min(2), category: z.string().min(2), owner_id: uuid.optional().nullable(), issued_on: isoDate.optional().nullable(), expires_on: isoDate.optional().nullable(), notes: z.string().max(2000).optional(), documents: z.array(z.object({ path: z.string(), name: z.string() })).default([]) });

// ---------------------------------------------------------------- reports, AI, help bot, platform
export const reportQuerySchema = z.object({
  from: isoDate,
  to: isoDate,
  branch_id: uuid.optional().nullable(),
  wing_id: uuid.optional().nullable(),
  department_id: uuid.optional().nullable(),
  staff_id: uuid.optional().nullable(),
});
export const REPORT_DATASETS = ['tasks', 'staff_attendance', 'student_attendance', 'lesson_plans', 'tickets', 'leave', 'substitutions', 'checklists', 'approvals'] as const;
export const savedReportSchema = z.object({
  name: z.string().min(2).max(120),
  dataset: z.enum(REPORT_DATASETS),
  config: z.object({
    columns: z.array(z.string()).min(1),
    filters: z.array(z.object({ column: z.string(), op: z.enum(['=', '!=', '>', '<', 'in']), value: z.any() })).default([]),
    group_by: z.string().optional().nullable(),
    chart: z.enum(['table', 'bar', 'line', 'pie']).default('table'),
  }),
  shared_role_ids: z.array(uuid).default([]),
});
export const reportScheduleSchema = z.object({ report_key: z.string(), frequency: z.enum(['daily', 'weekly', 'monthly']), send_time: hhmm, weekday: z.number().int().min(1).max(7).optional().nullable(), recipient_ids: z.array(uuid).min(1), channel: z.enum(['inapp', 'email', 'whatsapp_link']) });
export const askSchema = z.object({ question: z.string().trim().min(3).max(500) });
export const botAskSchema = z.object({ conversation_id: uuid.optional().nullable(), message: z.string().trim().min(1).max(1000), screen_path: z.string().max(200).optional() });
export const botFeedbackSchema = z.object({ conversation_id: uuid, message_index: z.number().int().min(0), rating: z.union([z.literal(1), z.literal(-1)]), comment: z.string().max(1000).optional() });
export const topupRequestSchema = z.object({ credits: z.number().min(10).max(100000), note: z.string().max(500).optional() });
export const adminTopupSchema = z.object({ branch_id: uuid, credits: z.number().min(1).max(100000), note: z.string().max(500).optional(), request_id: uuid.optional() });
export const notificationRuleSchema = z.object({ event_key: z.string(), channels: z.array(z.enum(['inapp', 'push', 'whatsapp'])), recipients: z.array(z.string()).min(1), optional: z.boolean(), urgent: z.boolean(), enabled: z.boolean() });
export const notificationPrefSchema = z.object({ event_key: z.string(), muted: z.boolean() });
export const viewAsSchema = z.object({ org_id: uuid, reason: z.string().min(5).max(500), minutes: z.number().int().min(5).max(120).default(30) });
export const uploadUrlSchema = z.object({ purpose: z.enum(['task_proof', 'task_attachment', 'voice', 'selfie', 'ticket_photo', 'document', 'circular', 'compliance', 'certificate', 'checklist_photo', 'leave_doc']), file_name: z.string().min(1).max(200), mime: z.string().min(3).max(120), size_bytes: z.number().int().min(1) });

/** Size limits per upload purpose, bytes (PRD 3: size limits per file type). */
export const UPLOAD_LIMITS: Record<z.infer<typeof uploadUrlSchema>['purpose'], { max: number; mimes: RegExp }> = {
  task_proof: { max: 10 * 1024 * 1024, mimes: /^(image\/|application\/pdf)/ },
  task_attachment: { max: 20 * 1024 * 1024, mimes: /^(image\/|application\/|text\/)/ },
  voice: { max: 10 * 1024 * 1024, mimes: /^audio\// },
  selfie: { max: 3 * 1024 * 1024, mimes: /^image\// },
  ticket_photo: { max: 10 * 1024 * 1024, mimes: /^image\// },
  document: { max: 25 * 1024 * 1024, mimes: /^(application\/pdf|application\/vnd\.openxmlformats|image\/|text\/)/ },
  circular: { max: 20 * 1024 * 1024, mimes: /^(image\/|application\/)/ },
  compliance: { max: 20 * 1024 * 1024, mimes: /^(image\/|application\/pdf)/ },
  certificate: { max: 10 * 1024 * 1024, mimes: /^(image\/|application\/pdf)/ },
  checklist_photo: { max: 10 * 1024 * 1024, mimes: /^image\// },
  leave_doc: { max: 10 * 1024 * 1024, mimes: /^(image\/|application\/pdf)/ },
};

/** Offline outbox item (mobile, PRD 9.2). */
export const outboxItemSchema = z.object({
  client_id: z.string().min(8).max(64),
  method: z.enum(['POST', 'PATCH']),
  path: z.string().startsWith('/api/os/'),
  body: z.any(),
  created_at: z.string().datetime({ offset: true }),
});
export const syncSchema = z.object({ items: z.array(outboxItemSchema).max(200) });
