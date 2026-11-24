/**
 * OS product rows for one org (20261116000001..5, the OS stream), written as the table owner. Called for org A and
 * org B by fixture.ts after seedCore; every os table (and the AI wallet tables of the OS stream in core/billing)
 * gets at least one row per org, so the harness fails for a new OS table without fixture rows.
 */
import type pg from 'pg';

type Q = (sql: string, params?: unknown[]) => Promise<pg.QueryResult>;

export interface OsOrgInput {
  org: string;
  branch: string;
  admin: string; // auth user id of the org admin
  core: { year: string; prog: string; section: string; room: string; subj: string; adminStaff: string; otherStaff: string; teacherStaff: string | null };
}

export async function seedOs(q: Q, o: OsOrgInput) {
  const ins = async (table: string, row: Record<string, unknown>): Promise<string> => {
    const keys = Object.keys(row);
    const vals = keys.map((k) => {
      const v = row[k];
      return v !== null && typeof v === 'object' && (!Array.isArray(v) || v.some((x) => typeof x === 'object')) ? JSON.stringify(v) : v;
    });
    const sql = `insert into ${table} (org_id, ${keys.join(', ')}) values ($1, ${keys.map((_, i) => `$${i + 2}`).join(', ')}) returning id`;
    return (await q(sql, [o.org, ...vals])).rows[0].id as string;
  };
  const c = o.core;
  const b = o.branch;
  const staff = c.teacherStaff ?? c.otherStaff;

  // ------------------------------------------------------------ OS roles and access configuration
  const role = await ins('os.roles', { key: 'principal', name: 'Principal', is_preset: true });
  const role2 = await ins('os.roles', { key: 'teacher', name: 'Teacher', is_preset: true });
  await ins('os.role_permissions', { role_id: role, module: 'tasks', action: 'view', scope: 'branch' });
  await ins('os.staff_roles', { staff_id: c.otherStaff, role_id: role2 });
  await ins('os.reporting_lines', { staff_id: c.otherStaff, manager_id: c.adminStaff, branch_id: b });
  await ins('os.module_flags', { branch_id: b, module_key: 'help_bot', enabled: true });
  await ins('os.assignment_rules', { from_role_id: role, to_role_id: role2, rule: 'assign' });

  // ------------------------------------------------------------ tasks and checklists
  const esc = await ins('os.escalation_rules', { name: 'Default' });
  const cat = await ins('os.task_categories', { key: 'general', name: 'General', escalation_rule_id: esc });
  const rec = await ins('os.task_recurrences', { branch_id: b, template: { title: 'Weekly report' }, target: { staff_ids: [staff] }, frequency: 'weekly', starts_on: '2026-11-01', assigner_id: c.adminStaff });
  const task = await ins('os.tasks', { branch_id: b, title: 'Prepare notice board', category_id: cat, owner_id: staff, assigner_id: c.adminStaff, recurrence_id: rec });
  await ins('os.task_assignees', { branch_id: b, task_id: task, staff_id: c.adminStaff, kind: 'watcher' });
  await ins('os.task_comments', { branch_id: b, task_id: task, author_id: c.adminStaff, body: 'Please add photos' });
  await ins('os.task_attachments', { branch_id: b, task_id: task, kind: 'attachment', storage_path: `${o.org}/task/board.jpg` });
  await ins('os.task_events', { branch_id: b, task_id: task, actor_id: c.adminStaff, event: 'created' });
  const tpl = await ins('os.checklist_templates', { branch_id: b, name: 'Morning rounds', owner_staff_id: staff });
  const item = await ins('os.checklist_items', { branch_id: b, template_id: tpl, label: 'Lights off', item_type: 'tick' });
  const run = await ins('os.checklist_runs', { branch_id: b, template_id: tpl, owner_id: staff, run_date: '2026-11-23', due_at: '2026-11-23T03:00:00Z' });
  await ins('os.checklist_responses', { branch_id: b, run_id: run, item_id: item, value: true });

  // ------------------------------------------------------------ timetable generator and substitution
  await ins('os.timetable_constraints', { branch_id: b, kind: 'teacher_unavailable', data: { staff_id: staff, day: 1, period_seq: 1 } });
  await ins('os.substitutions', { branch_id: b, date: '2026-11-25', day: 3, period_seq: 1, section_id: c.section, subject_id: c.subj, absent_staff_id: c.otherStaff, substitute_staff_id: c.adminStaff, source: 'manual' });

  // ------------------------------------------------------------ curriculum and planning (org rows; global rows have org_id null)
  const board = await ins('os.curriculum_boards', { key: 'SCHOOL', name: 'School syllabus', syllabus_year: '2026' });
  const csub = await ins('os.curriculum_subjects', { board_id: board, stage: 'Class 8', grade_level: 8, name: 'Science' });
  const unit = await ins('os.curriculum_units', { subject_id: csub, seq: 1, name: 'Cells' });
  const topic = await ins('os.curriculum_topics', { unit_id: unit, seq: 1, name: 'Cell structure' });
  await ins('os.learning_outcomes', { topic_id: topic, code: 'SC8.1', text: 'Describe a cell' });
  const doc = await ins('os.reference_documents', { branch_id: b, title: 'Science textbook', kind: 'textbook', storage_path: `${o.org}/docs/sci.pdf`, programme_id: c.prog, subject_id: c.subj });
  await ins('os.document_chunks', { branch_id: b, document_id: doc, seq: 1, content: 'Cells are the unit of life.' });
  await ins('os.lesson_plan_templates', { name: 'School template', sections: [{ key: 'objectives', name: 'Objectives', mandatory: true, seq: 1 }], is_default: true });
  await ins('os.plan_submission_rules', { level: 'daily', name: 'Daily plans' });
  const ap = await ins('os.annual_plans', { branch_id: b, academic_year_id: c.year, programme_id: c.prog, subject_id: c.subj, curriculum_subject_id: csub, staff_id: staff });
  await ins('os.annual_plan_items', { branch_id: b, annual_plan_id: ap, topic_id: topic, seq: 1, planned_start: '2026-11-01', planned_end: '2026-11-07', planned_periods: 4 });
  const plan = await ins('os.lesson_plans', { branch_id: b, staff_id: staff, section_id: c.section, subject_id: c.subj, topic_id: topic, plan_date: '2026-11-24' });
  await ins('os.lesson_plan_versions', { branch_id: b, plan_id: plan, version: 1, content: {} });
  await ins('os.lesson_plan_reviews', { branch_id: b, plan_id: plan, step_seq: 1, reviewer_id: c.adminStaff, action: 'comment', comment: 'Good' });
  const log = await ins('os.class_logs', { branch_id: b, section_id: c.section, subject_id: c.subj, staff_id: staff, date: '2026-11-23', period_seq: 1, topic_id: topic, lesson_plan_id: plan });
  void log;
  await ins('os.notebook_checks', { branch_id: b, section_id: c.section, subject_id: c.subj, staff_id: staff, kind: 'cycle', checked_on: '2026-11-23', checked_by: c.adminStaff });

  // ------------------------------------------------------------ exams (shared exam rows come from seedCore)
  const exam = (await q(`select id from core.exams where org_id = $1 limit 1`, [o.org])).rows[0].id as string;
  const sched = (await q(`select id from core.exam_schedules where org_id = $1 limit 1`, [o.org])).rows[0].id as string;
  await ins('os.exam_plans', { branch_id: b, exam_id: exam, schedule_rooms: { [sched]: [c.room] } });
  await ins('os.invigilation_duties', { branch_id: b, exam_schedule_id: sched, room_id: c.room, staff_id: staff });
  const bp = await ins('os.paper_blueprints', { name: 'UT blueprint', programme_id: c.prog, subject_id: c.subj, total_marks: 25, duration_minutes: 60, sections: '[]' });
  // exam date in the past: no longer confidential, so org admins see it (setter/reviewers see it any time)
  const paper = await ins('os.question_papers', { branch_id: b, exam_id: exam, exam_schedule_id: sched, blueprint_id: bp, subject_id: c.subj, programme_id: c.prog, setter_id: staff, exam_date: '2026-11-01' });
  await ins('os.paper_access_log', { branch_id: b, paper_id: paper, staff_id: staff, action: 'view', watermark: 'fixture' });

  // ------------------------------------------------------------ observation and appraisal
  const rub = await ins('os.observation_rubrics', { name: 'Classroom', domains: '[]' });
  await ins('os.observations', { branch_id: b, rubric_id: rub, observer_id: c.adminStaff, teacher_id: staff, section_id: c.section, subject_id: c.subj, scheduled_at: '2026-11-20T04:00:00Z' });
  const cycle = await ins('os.appraisal_cycles', { name: '2026-27', starts_on: '2026-06-01', ends_on: '2027-03-31', weights: {} });
  await ins('os.appraisal_scores', { cycle_id: cycle, staff_id: staff, total: 3.5 });
  await ins('os.trainings', { staff_id: staff, title: 'First aid', attended_on: '2026-10-10', hours: 4 });

  // ------------------------------------------------------------ circulars, meetings, events, duties, compliance
  const circ = await ins('os.circulars', { branch_id: b, author_id: c.adminStaff, title: 'PTM on Saturday', body: 'Details', status: 'sent' });
  await ins('os.circular_receipts', { branch_id: b, circular_id: circ, staff_id: staff });
  const meet = await ins('os.meetings', { branch_id: b, title: 'Staff meeting', starts_at: '2026-11-25T09:00:00Z', ends_at: '2026-11-25T10:00:00Z', organizer_id: c.adminStaff });
  await ins('os.meeting_actions', { branch_id: b, meeting_id: meet, description: 'Share minutes', owner_id: staff });
  const etpl = await ins('os.event_templates', { key: 'annual_day', name: 'Annual day' });
  const event = (await q(`select id from core.events where org_id = $1 limit 1`, [o.org])).rows[0].id as string;
  await ins('os.event_plans', { event_id: event, template_id: etpl });
  const duty = await ins('os.duty_types', { key: 'gate', name: 'Gate duty', starts_at: '07:30', ends_at: '08:00' });
  await ins('os.duty_assignments', { branch_id: b, duty_type_id: duty, staff_id: staff, date: '2026-11-24' });
  await ins('os.compliance_items', { branch_id: b, name: 'Fire NOC', category: 'safety', owner_id: c.adminStaff });

  // ------------------------------------------------------------ reports and help bot
  const rep = await ins('os.saved_reports', { owner_id: c.adminStaff, name: 'My tasks', dataset: 'tasks', config: {} });
  await ins('os.report_schedules', { report_key: 'saved', saved_report_id: rep });
  const art = await ins('os.kb_articles', { slug: 'school-faq', language: 'en', title: 'School FAQ', body: 'Ask the office.' });
  await ins('os.kb_chunks', { article_id: art, language: 'en', seq: 1, content: 'Ask the office.' });
  const conv = await ins('os.bot_conversations', { staff_id: c.adminStaff, messages: '[]' });
  await ins('os.bot_feedback', { conversation_id: conv, staff_id: c.adminStaff, message_index: 0, rating: 1 });

  // ------------------------------------------------------------ platform settings and the AI wallet (OS stream)
  await ins('core.platform_settings', { key: 'credit_warnings', value: { levels: [90] } });
  const gen = await ins('core.ai_generations', { branch_id: b, product_key: 'os', user_id: o.admin, staff_id: c.adminStaff, action: 'daily_plan', model: 'mock', provider: 'mock', input: {}, status: 'ok', credits: 1 });
  await ins('billing.ai_action_costs', { action: 'daily_plan', credits: 0.5 });
  await ins('billing.ai_allowances', { plan_key: 'os_growth', monthly_credits: 1000 });
  await ins('billing.ai_credit_ledger', { kind: 'allowance', period: '2026-11', credits: 1000 });
  await ins('billing.ai_credit_ledger', { branch_id: b, staff_id: c.adminStaff, kind: 'usage', action: 'daily_plan', period: '2026-11', credits: -1, generation_id: gen });
  await ins('billing.credit_topup_requests', { branch_id: b, requested_by_user_id: o.admin, credits: 100 });
}
