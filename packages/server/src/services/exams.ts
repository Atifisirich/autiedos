/**
 * Exams and question papers (PRD 6.4), observation and appraisal (PRD 6.5).
 */
import { z } from 'zod';
import {
  planPaperSlots,
  checkPaper,
  validateBlueprint,
  blueprintTable,
  paperWatermark,
  assignInvigilators,
  seatingPlan,
  appraisalScore,
  observationPct,
  addDays,
  eachDate,
  isoWeekday,
  isWorkingDay,
  type Blueprint,
  type PaperQuestion,
  type RosterStaff,
  type AppraisalComponent,
} from '@autoed/shared';
import { ForbiddenError, NotFoundError, ValidationError, insert, insertMany, maybe, one, q, update, type Tx } from '../db';
import { need, needModule, rank, run, staffWithRole, workCalendar, localToday, type Ctx } from '../core';
import { notify } from '../notify';
import { generate } from './ai';
import { systemTask } from './tasks';
import { submitApproval, registerApprovalHook } from './approvals';
import { coverageFor, planCompliance } from './planning';
import { currentVersionId } from './timetable';

// ---------------------------------------------------------------- exams
export async function listExams(ctx: Ctx) {
  needModule(ctx, 'exams');
  return run(ctx, async (c) => q(c, `select e.*, et.name as type_name, (select count(*)::int from core.exam_schedules s where s.exam_id = e.id) as papers from core.exams e left join core.exam_types et on et.id = e.exam_type_id where e.branch_id = $1 and e.deleted_at is null order by e.starts_on desc`, [ctx.branchId]));
}

export async function createExam(ctx: Ctx, input: { name: string; exam_type_id?: string | null; term_id?: string | null; starts_on: string; ends_on: string; programme_ids: string[] }) {
  need(ctx, 'exams', 'create');
  return run(ctx, async (c, sys) => {
    const ay = await maybe<{ id: string }>(c, `select id from core.academic_years where branch_id = $1 and is_current`, [ctx.branchId]);
    const exam = await insert<{ id: string }>(c, 'core.exams', { org_id: ctx.orgId, branch_id: ctx.branchId, academic_year_id: ay?.id ?? null, ...input, status: 'planning' });
    await insert(c, 'core.calendar_events', { org_id: ctx.orgId, branch_id: ctx.branchId, layer: 'exam', title: input.name, starts_on: input.starts_on, ends_on: input.ends_on, linked_type: 'exam', linked_id: exam.id });
    // Task pack: printing and answer-script collection for the coordinator.
    const coord = (await staffWithRole(c, ctx.orgId, 'academic_coordinator', ctx.branchId))[0] ?? ctx.staffId;
    await sys(async () => {
      await systemTask(c, { orgId: ctx.orgId, branchId: ctx.branchId, ownerId: coord, title: `${input.name}: print question papers`, systemKey: `exam:${exam.id}:print`, dueAt: new Date(`${addDays(input.starts_on, -3)}T16:00:00+05:30`).toISOString(), linkedType: 'exam', linkedId: exam.id, categoryKey: 'academic' });
      await systemTask(c, { orgId: ctx.orgId, branchId: ctx.branchId, ownerId: coord, title: `${input.name}: collect answer scripts`, systemKey: `exam:${exam.id}:collect`, dueAt: new Date(`${input.ends_on}T16:00:00+05:30`).toISOString(), linkedType: 'exam', linkedId: exam.id, categoryKey: 'academic' });
    });
    return { id: exam.id };
  });
}

/** Exam timetable builder with clash checks against the calendar. */
export async function addSchedule(ctx: Ctx, input: { exam_id: string; programme_id: string; subject_id: string; date: string; starts_at: string; ends_at: string; room_ids: string[] }) {
  need(ctx, 'exams', 'edit');
  return run(ctx, async (c, sys) => {
    const warnings: string[] = [];
    const cal = await workCalendar(c, ctx.branchId);
    if (!isWorkingDay(input.date, cal)) warnings.push('not_a_working_day');
    const clash = await maybe(c, `select 1 from core.exam_schedules where programme_id = $1 and date = $2 and starts_at < $4 and ends_at > $3 and deleted_at is null`, [input.programme_id, input.date, input.starts_at, input.ends_at]);
    if (clash) throw new ValidationError('class_already_has_exam_at_this_time');
    const other = await q<{ title: string }>(c, `select title from core.calendar_events where (branch_id = $1 or branch_id is null) and $2::date between starts_on and ends_on and layer in ('event','ptm','holiday') and deleted_at is null`, [ctx.branchId, input.date]);
    for (const o of other) warnings.push(`calendar:${o.title}`);
    const s = await insert<{ id: string }>(c, 'core.exam_schedules', { org_id: ctx.orgId, branch_id: ctx.branchId, ...input });
    // Subject teachers of that class: paper submission and correction deadlines.
    const teachers = await q<{ staff_id: string }>(c, `select distinct ta.staff_id from core.teacher_allocations ta join core.sections se on se.id = ta.section_id where se.programme_id = $1 and ta.subject_id = $2`, [input.programme_id, input.subject_id]);
    const exam = await one<{ name: string }>(c, `select name from core.exams where id = $1`, [input.exam_id]);
    await sys(async () => {
      for (const t of teachers) {
        await systemTask(c, { orgId: ctx.orgId, branchId: ctx.branchId, ownerId: t.staff_id, title: `${exam.name}: submit question paper`, systemKey: `exam:${s.id}:${t.staff_id}:paper`, dueAt: new Date(`${addDays(input.date, -14)}T16:00:00+05:30`).toISOString(), linkedType: 'exam', linkedId: input.exam_id, categoryKey: 'academic' });
        await systemTask(c, { orgId: ctx.orgId, branchId: ctx.branchId, ownerId: t.staff_id, title: `${exam.name}: finish correction`, systemKey: `exam:${s.id}:${t.staff_id}:correct`, dueAt: new Date(`${addDays(input.date, 7)}T16:00:00+05:30`).toISOString(), linkedType: 'exam', linkedId: input.exam_id, categoryKey: 'academic' });
      }
    });
    return { id: s.id, warnings };
  });
}

export async function examDetail(ctx: Ctx, examId: string) {
  needModule(ctx, 'exams');
  return run(ctx, async (c) => {
    const exam = await maybe(c, `select * from core.exams where id = $1`, [examId]);
    if (!exam) throw new NotFoundError();
    const schedules = await q(c, `select s.*, cl.name as class_name, sb.name as subject_name from core.exam_schedules s join core.programmes cl on cl.id = s.programme_id join core.subjects sb on sb.id = s.subject_id where s.exam_id = $1 and s.deleted_at is null order by s.date, s.starts_at`, [examId]);
    const duties = await q(c, `select d.*, st.full_name, r.name as room_name, s.date, s.starts_at, s.ends_at from os.invigilation_duties d join core.exam_schedules s on s.id = d.exam_schedule_id join core.staff st on st.id = d.staff_id left join core.rooms r on r.id = d.room_id where s.exam_id = $1 and d.deleted_at is null order by s.date, s.starts_at`, [examId]);
    const seating = await q(c, `select sp.*, r.name as room_name from public.seating_plans sp join core.rooms r on r.id = sp.room_id where sp.exam_id = $1 and sp.deleted_at is null order by sp.date, r.name`, [examId]);
    return { exam, schedules, duties, seating };
  });
}

/** Automatic, fair invigilation: never the subject teacher, max duties per day, no time clash. */
export async function allocateInvigilation(ctx: Ctx, examId: string) {
  need(ctx, 'exams', 'assign');
  return run(ctx, async (c) => {
    const exam = await one<{ rules: { max_duties_per_day?: number } }>(c, `select rules from core.exams where id = $1`, [examId]);
    const schedules = await q<{ id: string; programme_id: string; subject_id: string; date: string; starts_at: string; ends_at: string; room_ids: string[] }>(c, `select id, programme_id, subject_id, date::text, starts_at::text, ends_at::text, room_ids from core.exam_schedules where exam_id = $1 and deleted_at is null`, [examId]);
    await c.query(`delete from os.invigilation_duties where exam_schedule_id = any($1) and status = 'assigned'`, [schedules.map((s) => s.id)]);
    const staff = await q<{ id: string; full_name: string; load: number }>(c, `select s.id, s.full_name, (select count(*)::int from os.invigilation_duties d where d.staff_id = s.id and d.created_at > now() - interval '180 days') as load from core.staff s where s.branch_id = $1 and s.is_teaching and s.status = 'active' and s.deleted_at is null`, [ctx.branchId]);
    const leave = await q<{ staff_id: string; start_date: string; end_date: string }>(c, `select staff_id, start_date::text, end_date::text from core.leave_requests where branch_id = $1 and status = 'approved'`, [ctx.branchId]);
    const roster: RosterStaff[] = staff.map((s) => ({ id: s.id, name: s.full_name, load: s.load, busy: new Set(leave.filter((l) => l.staff_id === s.id).flatMap((l) => eachDate(l.start_date, l.end_date))) }));
    const slots = [];
    for (const s of schedules) {
      const subjectTeachers = (await q<{ staff_id: string }>(c, `select distinct ta.staff_id from core.teacher_allocations ta join core.sections se on se.id = ta.section_id where se.programme_id = $1 and ta.subject_id = $2`, [s.programme_id, s.subject_id])).map((x) => x.staff_id);
      const rooms = s.room_ids.length ? s.room_ids : [null];
      for (const r of rooms) slots.push({ key: `${s.id}|${r ?? ''}`, date: s.date, subjectTeacherIds: subjectTeachers, windowKey: `${s.date}|${s.starts_at}-${s.ends_at}` });
    }
    const res = assignInvigilators(slots, roster, exam.rules.max_duties_per_day ?? 2);
    for (const a of res.assignments) {
      const [scheduleId, roomId] = a.slotKey.split('|');
      await insert(c, 'os.invigilation_duties', { org_id: ctx.orgId, branch_id: ctx.branchId, exam_schedule_id: scheduleId, room_id: roomId || null, staff_id: a.staffId });
    }
    return { assigned: res.assignments.length, unfilled: res.unfilled };
  });
}

export async function requestInvigilationSwap(ctx: Ctx, dutyId: string, swapWithId: string) {
  needModule(ctx, 'exams');
  return run(ctx, async (c, sys) => {
    const d = await maybe<{ staff_id: string; branch_id: string }>(c, `select staff_id, branch_id from os.invigilation_duties where id = $1`, [dutyId]);
    if (!d || d.staff_id !== ctx.staffId) throw new ForbiddenError();
    const req = await sys(() => submitApproval(c, { orgId: ctx.orgId, branchId: d.branch_id, applicantId: ctx.staffId, typeKey: 'invigilation_swap', title: ctx.t('exams.swapRequest'), data: { duty_id: dutyId, swap_with: swapWithId }, linkedType: 'invigilation_duty', linkedId: dutyId, actorName: ctx.staff.full_name }));
    await sys(() => c.query(`update os.invigilation_duties set status = 'swap_requested', swap_request_id = $2 where id = $1`, [dutyId, req.id]));
    return { approval_id: req.id };
  });
}

registerApprovalHook('invigilation_swap', async (c, req, decision) => {
  const d = req.data as { duty_id: string; swap_with: string };
  if (decision === 'approved') await c.query(`update os.invigilation_duties set staff_id = $2, status = 'assigned' where id = $1`, [d.duty_id, d.swap_with]);
  else await c.query(`update os.invigilation_duties set status = 'assigned' where id = $1`, [d.duty_id]);
});

/** Seating plan by room capacity, mixing classes. */
export async function generateSeating(ctx: Ctx, examId: string, date: string, roomIds: string[]) {
  need(ctx, 'exams', 'edit');
  return run(ctx, async (c) => {
    const classes = (await q<{ programme_id: string }>(c, `select distinct programme_id from core.exam_schedules where exam_id = $1 and date = $2`, [examId, date])).map((r) => r.programme_id);
    const students = await q<{ id: string; programme_id: string; roll_no: number }>(c, `select id, programme_id, coalesce(roll_no, 0) as roll_no from core.students where programme_id = any($1) and status = 'active' and deleted_at is null`, [classes]);
    const rooms = await q<{ id: string; capacity: number }>(c, `select id, capacity from core.rooms where id = any($1) order by name`, [roomIds]);
    const plan = seatingPlan(students.map((s) => ({ id: s.id, classId: s.programme_id, rollNo: s.roll_no })), rooms);
    await c.query(`delete from public.seating_plans where exam_id = $1 and date = $2`, [examId, date]);
    for (const r of plan.rooms) await insert(c, 'seating_plans', { org_id: ctx.orgId, branch_id: ctx.branchId, exam_id: examId, date, room_id: r.roomId, layout: r.seats.map((s) => ({ seat: s.seat, student_id: s.studentId, programme_id: s.classId })) });
    return { rooms: plan.rooms.length, seated: students.length - plan.unseated.length, unseated: plan.unseated.length };
  });
}

// ---------------------------------------------------------------- blueprints & bank
function toBlueprint(b: { total_marks: number; sections: { name: string; question_type: string; count: number; marks_each: number }[]; chapter_weightage: Record<string, number>; difficulty: { easy: number; medium: number; hard: number } }): Blueprint {
  return { totalMarks: b.total_marks, sections: b.sections.map((s) => ({ name: s.name, questionType: s.question_type, count: s.count, marksEach: s.marks_each })), chapterWeightage: b.chapter_weightage, difficulty: b.difficulty };
}

export async function saveBlueprint(ctx: Ctx, input: { id?: string; name: string; board: string; programme_id?: string | null; subject_id?: string | null; total_marks: number; duration_minutes: number; sections: { name: string; question_type: string; count: number; marks_each: number }[]; chapter_weightage: Record<string, number>; difficulty: { easy: number; medium: number; hard: number }; bloom: Record<string, number>; competency_pct: number; instructions?: string; is_template: boolean }) {
  need(ctx, 'question_papers', 'create');
  const errs = validateBlueprint(toBlueprint(input));
  if (errs.length) throw new ValidationError('blueprint_invalid', { errors: errs });
  const plan = planPaperSlots(toBlueprint(input));
  if (plan.errors.length) throw new ValidationError('blueprint_unsatisfiable', { errors: plan.errors });
  return run(ctx, async (c) => {
    const row = { org_id: ctx.orgId, branch_id: ctx.branchId, ...input };
    return input.id ? update(c, 'os.paper_blueprints', input.id, row) : insert(c, 'os.paper_blueprints', row);
  });
}

export async function listBlueprints(ctx: Ctx) {
  needModule(ctx, 'exams');
  return run(ctx, async (c) => q(c, `select b.*, cl.name as class_name, sb.name as subject_name from os.paper_blueprints b left join core.programmes cl on cl.id = b.programme_id left join core.subjects sb on sb.id = b.subject_id where b.org_id = $1 and b.deleted_at is null order by b.created_at desc`, [ctx.orgId]));
}

export async function bankQuestions(ctx: Ctx, filter: { subject_id?: string; programme_id?: string; topic_id?: string }) {
  needModule(ctx, 'exams');
  return run(ctx, async (c) => q(c, `select qb.*, t.name as topic_name from core.question_bank qb left join os.curriculum_topics t on t.id = qb.topic_id where qb.org_id = $1 and qb.deleted_at is null and ($2::uuid is null or qb.subject_id = $2) and ($3::uuid is null or qb.programme_id = $3) and ($4::uuid is null or qb.topic_id = $4) order by qb.created_at desc limit 500`, [ctx.orgId, filter.subject_id ?? null, filter.programme_id ?? null, filter.topic_id ?? null]));
}

export async function addBankQuestion(ctx: Ctx, input: { subject_id: string; programme_id: string; topic_id: string; question_type: string; difficulty: 'easy' | 'medium' | 'hard'; marks: number; bloom?: string; competency?: boolean; content: { text: string; options?: string[]; answer: string; marking?: unknown[] }; tags?: string[] }) {
  need(ctx, 'question_papers', 'create');
  return run(ctx, async (c) => insert(c, 'core.question_bank', { org_id: ctx.orgId, branch_id: ctx.branchId, ...input, status: 'approved', source: 'manual', tags: input.tags ?? [] }));
}

// ---------------------------------------------------------------- papers
interface PaperContent extends PaperQuestion {
  text: string;
  options?: string[];
  answer: string;
  marking: { step: string; marks: number }[];
  source: 'bank' | 'ai';
  bank_id?: string;
}

const AI_PAPER_SCHEMA = { type: 'object', additionalProperties: false, required: ['questions'], properties: { questions: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['no', 'text', 'options', 'answer', 'marking'], properties: { no: { type: 'integer' }, text: { type: 'string' }, options: { type: 'array', items: { type: 'string' } }, answer: { type: 'string' }, marking: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['step', 'marks'], properties: { step: { type: 'string' }, marks: { type: 'number' } } } } } } } } };
const aiPaperZod = z.object({ questions: z.array(z.object({ no: z.number().int(), text: z.string().min(3), options: z.array(z.string()), answer: z.string(), marking: z.array(z.object({ step: z.string(), marks: z.number() })) })) });

/** Generates up to 3 parallel sets that match the blueprint exactly (bank, AI or mixed). */
export async function generatePaper(ctx: Ctx, input: { blueprint_id: string; exam_id?: string | null; exam_date: string; sets: number; source: 'bank' | 'ai' | 'mixed'; reviewer_ids: string[] }) {
  need(ctx, 'question_papers', 'create');
  return run(ctx, async (c, sys) => {
    const bp = await maybe<{ id: string; board: string; programme_id: string | null; subject_id: string | null; total_marks: number; sections: { name: string; question_type: string; count: number; marks_each: number }[]; chapter_weightage: Record<string, number>; difficulty: { easy: number; medium: number; hard: number }; name: string }>(c, `select * from os.paper_blueprints where id = $1`, [input.blueprint_id]);
    if (!bp) throw new NotFoundError();
    const blueprint = toBlueprint(bp);
    const plan = planPaperSlots(blueprint);
    if (plan.errors.length) throw new ValidationError('blueprint_unsatisfiable', { errors: plan.errors });
    const topicNames = Object.fromEntries((await q<{ id: string; name: string }>(c, `select id, name from os.curriculum_topics where id = any($1)`, [Object.keys(bp.chapter_weightage)])).map((t) => [t.id, t.name]));
    let reviewers = input.reviewer_ids;
    if (!reviewers.length) {
      const hod = bp.subject_id ? await maybe<{ head_staff_id: string | null }>(c, `select d.head_staff_id from core.subjects s join core.departments d on d.id = s.department_id where s.id = $1`, [bp.subject_id]) : null;
      const coord = (await staffWithRole(c, ctx.orgId, 'academic_coordinator', ctx.branchId))[0];
      reviewers = [hod?.head_staff_id, coord].filter((x): x is string => !!x && x !== ctx.staffId);
    }
    const used = new Set<string>();
    const papers: string[] = [];
    let credits = 0;
    for (let set = 1; set <= input.sets; set++) {
      const questions: PaperContent[] = [];
      const missing: typeof plan.slots = [];
      for (const s of plan.slots) {
        if (input.source !== 'ai') {
          const cand = await q<{ id: string; content: { text: string; options?: string[]; answer: string; marking?: { step: string; marks: number }[] } }>(c, `select id, content from core.question_bank where org_id = $1 and topic_id = $2 and question_type = $3 and marks = $4 and difficulty = $5 and status = 'approved' and deleted_at is null order by random()`, [ctx.orgId, s.topicId, s.questionType, s.marks, s.difficulty]);
          const pick = cand.find((x) => !used.has(x.id));
          if (pick) {
            used.add(pick.id);
            questions.push({ ...s, text: pick.content.text, options: pick.content.options, answer: pick.content.answer, marking: pick.content.marking ?? [{ step: 'Answer', marks: s.marks }], source: 'bank', bank_id: pick.id });
            continue;
          }
          if (input.source === 'bank') throw new ValidationError('bank_has_too_few_questions', { slot: s.no });
        }
        missing.push(s);
      }
      if (missing.length) {
        const gen = await sys(() =>
          generate(c, {
            orgId: ctx.orgId,
            branchId: ctx.branchId,
            staffId: ctx.staffId,
            action: 'question_paper',
            tier: 'strong',
            system: `You set ${bp.board} examination questions with a marking scheme with step marks. Questions must be original, not copied from textbooks. Use LaTeX between $...$ for maths and science.`,
            prompt: `Write questions for these slots (set ${set}, all different from other sets):\n${missing.map((s) => `- Q${s.no}: ${s.questionType}, ${s.marks} marks, ${s.difficulty}, chapter "${topicNames[s.topicId] ?? ''}"`).join('\n')}\nFor multiple choice give 4 options. Marking steps must add up to the marks.`,
            jsonSchema: AI_PAPER_SCHEMA,
            zod: aiPaperZod,
            mockContext: { slots: missing.map((s) => ({ ...s, topicName: topicNames[s.topicId] ?? '' })) },
            validate: (o) => {
              const issues: string[] = [];
              for (const s of missing) {
                const qn = o.questions.find((x) => x.no === s.no);
                if (!qn) issues.push(`missing_Q${s.no}`);
                else if (Math.abs(qn.marking.reduce((a, m) => a + m.marks, 0) - s.marks) > 1e-9) issues.push(`marking_Q${s.no}`);
              }
              return issues;
            },
            logInput: { blueprint: bp.name, set, slots: missing.length },
          }),
        );
        credits += gen.credits;
        for (const s of missing) {
          const g = gen.output.questions.find((x) => x.no === s.no)!;
          questions.push({ ...s, text: g.text, options: g.options.length ? g.options : undefined, answer: g.answer, marking: g.marking, source: 'ai' });
        }
      }
      questions.sort((a, b) => a.no - b.no);
      const check = checkPaper(questions, blueprint);
      if (!check.ok) throw new ValidationError('paper_does_not_match_blueprint', { problems: check.problems });
      const paper = await insert<{ id: string }>(c, 'os.question_papers', { org_id: ctx.orgId, branch_id: ctx.branchId, exam_id: input.exam_id ?? null, blueprint_id: bp.id, subject_id: bp.subject_id, programme_id: bp.programme_id, set_no: set, setter_id: ctx.staffId, reviewer_ids: reviewers, exam_date: input.exam_date, status: 'draft', questions, blueprint_table: blueprintTable(questions, topicNames) });
      papers.push(paper.id);
    }
    return { paper_ids: papers, credits };
  });
}

async function logAccess(c: Tx, ctx: Ctx, paperId: string, action: 'view' | 'download' | 'export', branchId: string) {
  const watermark = action === 'view' ? null : paperWatermark(ctx.staff.full_name, ctx.now);
  await c.query(`insert into os.paper_access_log (org_id, branch_id, paper_id, staff_id, action, watermark) values ($1,$2,$3,$4,$5,$6)`, [ctx.orgId, branchId, paperId, ctx.staffId, action, watermark]);
  return watermark;
}

/** Every view is logged; RLS hides the paper from anyone but setter and named reviewers before the exam date. */
export async function getPaper(ctx: Ctx, id: string) {
  needModule(ctx, 'exams');
  return run(ctx, async (c, sys) => {
    const p = await maybe<{ id: string; branch_id: string; questions: PaperContent[]; setter_id: string; reviewer_ids: string[]; status: string; blueprint_id: string; exam_date: string } & Record<string, unknown>>(
      c,
      `select qp.*, s.full_name as setter_name, sb.name as subject_name, cl.name as class_name, b.name as blueprint_name, b.total_marks, b.duration_minutes, b.instructions from os.question_papers qp join core.staff s on s.id = qp.setter_id left join core.subjects sb on sb.id = qp.subject_id left join core.programmes cl on cl.id = qp.programme_id left join os.paper_blueprints b on b.id = qp.blueprint_id where qp.id = $1`,
      [id],
    );
    if (!p) throw new NotFoundError();
    await sys(() => logAccess(c, ctx, id, 'view', p.branch_id));
    const log = await sys(() => q(c, `select l.action, l.created_at, s.full_name, l.watermark from os.paper_access_log l left join core.staff s on s.id = l.staff_id where l.paper_id = $1 order by l.created_at desc limit 100`, [id]));
    const reviewers = await q(c, `select id, full_name from core.staff where id = any($1)`, [p.reviewer_ids]);
    return { ...p, access_log: log, reviewers, is_setter: p.setter_id === ctx.staffId, is_reviewer: p.reviewer_ids.includes(ctx.staffId) };
  });
}

/** Review workflow: setter -> HOD -> coordinator. Returned with comments or approved. */
export async function paperReview(ctx: Ctx, id: string, input: { action: 'submit' | 'approve' | 'return' | 'replace_question'; comment?: string; question_no?: number }) {
  needModule(ctx, 'exams');
  return run(ctx, async (c, sys) => {
    const p = await maybe<{ id: string; org_id: string; branch_id: string; setter_id: string; reviewer_ids: string[]; status: string; questions: PaperContent[]; review_comments: unknown[]; blueprint_id: string; subject_id: string | null; programme_id: string | null }>(c, `select * from os.question_papers where id = $1`, [id]);
    if (!p) throw new NotFoundError();
    const comments = [...(p.review_comments ?? []), ...(input.comment ? [{ by: ctx.staff.full_name, at: ctx.now.toISOString(), status: p.status, comment: input.comment }] : [])];
    const hodId = p.reviewer_ids[0];
    const coordId = p.reviewer_ids[1] ?? p.reviewer_ids[0];
    switch (input.action) {
      case 'submit': {
        if (p.setter_id !== ctx.staffId || !['draft', 'returned'].includes(p.status)) throw new ForbiddenError();
        await update(c, 'os.question_papers', id, { status: 'hod_review', review_comments: comments });
        await sys(() => notify(c, { orgId: p.org_id, branchId: p.branch_id, staffIds: [hodId], event: 'paper.review', titleKey: 'notif.paper.review', vars: { who: ctx.staff.full_name }, link: `/os/exams/papers/${id}` }));
        return { status: 'hod_review' };
      }
      case 'approve':
      case 'return': {
        const step = p.status === 'hod_review' ? hodId : p.status === 'coordinator_review' ? coordId : null;
        if (!step || step !== ctx.staffId) throw new ForbiddenError('not_your_review_step');
        let status = input.action === 'return' ? 'returned' : p.status === 'hod_review' && coordId !== hodId ? 'coordinator_review' : 'approved';
        if (input.action === 'approve' && p.status === 'coordinator_review') status = 'approved';
        await update(c, 'os.question_papers', id, { status, review_comments: comments });
        if (status === 'approved') {
          // Approved questions are saved to the school's question bank.
          await sys(async () => {
            for (const qn of p.questions.filter((x) => x.source === 'ai')) {
              await insert(c, 'core.question_bank', { org_id: p.org_id, branch_id: p.branch_id, subject_id: p.subject_id, programme_id: p.programme_id, topic_id: qn.topicId, question_type: qn.questionType, difficulty: qn.difficulty, marks: qn.marks, content: { text: qn.text, options: qn.options, answer: qn.answer, marking: qn.marking }, status: 'approved', source: 'paper' });
            }
          });
        }
        const nextIds = status === 'coordinator_review' ? [coordId] : [p.setter_id];
        await sys(() => notify(c, { orgId: p.org_id, branchId: p.branch_id, staffIds: nextIds, event: 'paper.review', titleKey: `notif.paper.${status}`, vars: { who: ctx.staff.full_name }, link: `/os/exams/papers/${id}` }));
        return { status };
      }
      case 'replace_question': {
        if (p.setter_id !== ctx.staffId || !['draft', 'returned'].includes(p.status)) throw new ForbiddenError();
        const qn = p.questions.find((x) => x.no === input.question_no);
        if (!qn) throw new NotFoundError('question');
        const usedIds = new Set(p.questions.map((x) => x.bank_id).filter(Boolean));
        const cand = await q<{ id: string; content: { text: string; options?: string[]; answer: string; marking?: { step: string; marks: number }[] } }>(c, `select id, content from core.question_bank where org_id = $1 and topic_id = $2 and question_type = $3 and marks = $4 and difficulty = $5 and status = 'approved' and deleted_at is null`, [p.org_id, qn.topicId, qn.questionType, qn.marks, qn.difficulty]);
        const pick = cand.find((x) => !usedIds.has(x.id));
        let replacement: PaperContent;
        if (pick) replacement = { ...qn, text: pick.content.text, options: pick.content.options, answer: pick.content.answer, marking: pick.content.marking ?? [{ step: 'Answer', marks: qn.marks }], source: 'bank', bank_id: pick.id };
        else {
          const topic = await maybe<{ name: string }>(c, `select name from os.curriculum_topics where id = $1`, [qn.topicId]);
          const gen = await sys(() =>
            generate(c, {
              orgId: ctx.orgId,
              branchId: ctx.branchId,
              staffId: ctx.staffId,
              action: 'section_rewrite',
              tier: 'strong',
              system: 'You set examination questions with marking schemes.',
              prompt: `Write one replacement question: ${qn.questionType}, ${qn.marks} marks, ${qn.difficulty}, chapter "${topic?.name ?? ''}". Different from: ${qn.text}`,
              jsonSchema: AI_PAPER_SCHEMA,
              zod: aiPaperZod,
              mockContext: { slots: [{ ...qn, topicName: topic?.name ?? '' }] },
              logInput: { replace: qn.no },
            }),
          );
          const g = gen.output.questions[0]!;
          replacement = { ...qn, text: g.text, options: g.options.length ? g.options : undefined, answer: g.answer, marking: g.marking, source: 'ai' };
        }
        const questions = p.questions.map((x) => (x.no === qn.no ? replacement : x));
        await update(c, 'os.question_papers', id, { questions });
        return { question: replacement };
      }
    }
  });
}

/** Export with a watermark of the user's name and time; every download is logged. */
export async function exportPaper(ctx: Ctx, id: string, withScheme: boolean): Promise<{ filename: string; buffer: Buffer }> {
  needModule(ctx, 'exams');
  return run(ctx, async (c, sys) => {
    const p = await maybe<{ id: string; branch_id: string; set_no: number; questions: PaperContent[]; subject_name: string; class_name: string; total_marks: number; duration_minutes: number; instructions: string | null; org_name: string; branding: Record<string, string> }>(
      c,
      `select qp.*, sb.name as subject_name, cl.name as class_name, b.total_marks, b.duration_minutes, b.instructions, o.name as org_name, o.branding from os.question_papers qp left join core.subjects sb on sb.id = qp.subject_id left join core.programmes cl on cl.id = qp.programme_id left join os.paper_blueprints b on b.id = qp.blueprint_id join core.organizations o on o.id = qp.org_id where qp.id = $1`,
      [id],
    );
    if (!p) throw new NotFoundError();
    const watermark = (await sys(() => logAccess(c, ctx, id, 'download', p.branch_id)))!;
    const { paperDocx } = await import('../exports');
    const buffer = await paperDocx(p, watermark, withScheme);
    return { filename: `${p.class_name}-${p.subject_name}-set${p.set_no}${withScheme ? '-scheme' : ''}.docx`.replace(/\s+/g, '_'), buffer };
  });
}

export async function listPapers(ctx: Ctx) {
  needModule(ctx, 'exams');
  return run(ctx, async (c) => q(c, `select qp.id, qp.set_no, qp.status, qp.exam_date, qp.setter_id, s.full_name as setter_name, sb.name as subject_name, cl.name as class_name from os.question_papers qp join core.staff s on s.id = qp.setter_id left join core.subjects sb on sb.id = qp.subject_id left join core.programmes cl on cl.id = qp.programme_id where qp.deleted_at is null order by qp.created_at desc limit 200`));
}

// ---------------------------------------------------------------- observation & appraisal
export async function rubrics(ctx: Ctx) {
  needModule(ctx, 'observation');
  return run(ctx, async (c) => q(c, `select * from os.observation_rubrics where org_id = $1 and deleted_at is null order by is_preset desc, name`, [ctx.orgId]));
}

export async function scheduleObservation(ctx: Ctx, input: { rubric_id: string; teacher_id: string; section_id?: string | null; subject_id?: string | null; scheduled_at: string; announced: boolean }) {
  need(ctx, 'observation', 'create');
  return run(ctx, async (c, sys) => {
    const t = await one<{ branch_id: string }>(c, `select branch_id from core.staff where id = $1`, [input.teacher_id]);
    const o = await insert<{ id: string }>(c, 'os.observations', { org_id: ctx.orgId, branch_id: t.branch_id, observer_id: ctx.staffId, ...input, status: 'scheduled' });
    if (input.announced) await sys(() => notify(c, { orgId: ctx.orgId, branchId: t.branch_id, staffIds: [input.teacher_id], event: 'meeting.scheduled', titleKey: 'notif.observation.scheduled', vars: { who: ctx.staff.full_name }, link: '/os/observation' }));
    await sys(() => systemTask(c, { orgId: ctx.orgId, branchId: t.branch_id, ownerId: ctx.staffId, title: `Observation`, systemKey: `obs:${o.id}`, dueAt: input.scheduled_at, linkedType: 'observation', linkedId: o.id, categoryKey: 'academic' }));
    return { id: o.id };
  });
}

export async function fillObservation(ctx: Ctx, id: string, input: { scores: Record<string, number>; evidence: Record<string, string>; feedback?: string; agreed_actions: { description: string; due_on: string }[]; share: boolean }) {
  needModule(ctx, 'observation');
  return run(ctx, async (c, sys) => {
    const o = await maybe<{ id: string; observer_id: string; teacher_id: string; rubric_id: string; org_id: string; branch_id: string }>(c, `select * from os.observations where id = $1`, [id]);
    if (!o) throw new NotFoundError();
    if (o.observer_id !== ctx.staffId) throw new ForbiddenError();
    const r = await one<{ domains: { key: string; weight: number; indicators: { key: string }[] }[]; scale: { min: number; max: number } }>(c, `select domains, scale from os.observation_rubrics where id = $1`, [o.rubric_id]);
    for (const v of Object.values(input.scores)) if (v < r.scale.min || v > r.scale.max) throw new ValidationError('score_out_of_scale');
    const overall = observationPct(r.domains, input.scores, r.scale);
    await update(c, 'os.observations', id, { scores: input.scores, evidence: input.evidence, feedback: input.feedback ?? null, agreed_actions: input.agreed_actions, overall, status: input.share ? 'shared' : 'completed' });
    await sys(() => c.query(`update os.tasks set status = 'done', completed_at = now() where system_key = $1 and status = 'todo'`, [`obs:${id}`]));
    if (input.share) await sys(() => notify(c, { orgId: o.org_id, branchId: o.branch_id, staffIds: [o.teacher_id], event: 'observation.shared', titleKey: 'notif.observation.shared', vars: { who: ctx.staff.full_name }, link: `/os/observation/${id}` }));
    return { overall };
  });
}

/** Teacher acknowledges and reflects; agreed actions become tasks. */
export async function acknowledgeObservation(ctx: Ctx, id: string, reflection: string) {
  return run(ctx, async (c, sys) => {
    const o = await maybe<{ id: string; teacher_id: string; observer_id: string; status: string; agreed_actions: { description: string; due_on: string }[]; org_id: string; branch_id: string }>(c, `select * from os.observations where id = $1`, [id]);
    if (!o || o.teacher_id !== ctx.staffId || o.status !== 'shared') throw new ForbiddenError();
    await update(c, 'os.observations', id, { teacher_reflection: reflection, status: 'acknowledged', acknowledged_at: ctx.now.toISOString() });
    await sys(async () => {
      for (const [i, a] of o.agreed_actions.entries()) await systemTask(c, { orgId: o.org_id, branchId: o.branch_id, ownerId: o.teacher_id, assignerId: o.observer_id, title: a.description, systemKey: `obsact:${id}:${i}`, dueAt: new Date(`${a.due_on}T16:00:00+05:30`).toISOString(), linkedType: 'observation', linkedId: id, categoryKey: 'academic' });
    });
    return { ok: true };
  });
}

export async function listObservations(ctx: Ctx) {
  needModule(ctx, 'observation');
  return run(ctx, async (c) => q(c, `select o.id, o.status, o.scheduled_at, o.overall, o.announced, t.full_name as teacher_name, ob.full_name as observer_name, sb.name as subject_name, cl.name || ' ' || se.name as section_name, o.teacher_id, o.observer_id from os.observations o join core.staff t on t.id = o.teacher_id join core.staff ob on ob.id = o.observer_id left join core.subjects sb on sb.id = o.subject_id left join core.sections se on se.id = o.section_id left join core.programmes cl on cl.id = se.programme_id where o.deleted_at is null order by o.scheduled_at desc limit 200`));
}

export async function getObservation(ctx: Ctx, id: string) {
  return run(ctx, async (c) => {
    const o = await maybe(c, `select o.*, t.full_name as teacher_name, ob.full_name as observer_name, r.domains, r.scale, r.name as rubric_name from os.observations o join core.staff t on t.id = o.teacher_id join core.staff ob on ob.id = o.observer_id join os.observation_rubrics r on r.id = o.rubric_id where o.id = $1`, [id]);
    if (!o) throw new NotFoundError();
    return o;
  });
}

/** Scorecard components for one staff member in a cycle (each 0..100). */
async function components(c: Tx, staffId: string, branchId: string, from: string, to: string, today: string): Promise<Partial<Record<AppraisalComponent, number | null>>> {
  const obs = await one<{ v: number | null }>(c, `select avg(overall) as v from os.observations where teacher_id = $1 and status in ('shared','acknowledged','completed') and scheduled_at::date between $2 and $3`, [staffId, from, to]);
  const tasks = await one<{ done: number; on_time: number }>(c, `select count(*) filter (where status in ('done','verified') and due_at is not null)::int as done, count(*) filter (where status in ('done','verified') and due_at is not null and completed_at <= due_at)::int as on_time from os.tasks where owner_id = $1 and created_at::date between $2 and $3`, [staffId, from, to]);
  const plans = (await planCompliance(c, branchId, from, to)).find((r) => (r as { staff_id: string }).staff_id === staffId) as { on_time: number; late: number; missing: number } | undefined;
  const cov = (await coverageFor(c, branchId, today, { staffId })).filter((r) => r.pct_covered != null && r.periods_ahead != null);
  const covPct = cov.length ? cov.reduce((s, r) => s + Math.max(0, Math.min(100, 100 + (r.periods_ahead! * 100) / Math.max(1, (r as { planned_to_date?: number }).planned_to_date ?? 1))), 0) / cov.length : null;
  const logs = await one<{ logged: number }>(c, `select count(*)::int as logged from os.class_logs where staff_id = $1 and date between $2 and $3`, [staffId, from, to]);
  const att = await one<{ ok: number; total: number }>(c, `select count(*) filter (where status = 'present')::int as ok, count(*) filter (where status in ('present','late','half_day','absent'))::int as total from core.staff_attendance where staff_id = $1 and date between $2 and $3`, [staffId, from, to]);
  const training = await one<{ h: number }>(c, `select coalesce(sum(hours), 0) as h from os.trainings where staff_id = $1 and attended_on between $2 and $3`, [staffId, from, to]);
  const score = await maybe<{ self_appraisal: number | null; manager_rating: number | null }>(c, `select self_appraisal, manager_rating from os.appraisal_scores s join os.appraisal_cycles cy on cy.id = s.cycle_id where s.staff_id = $1 and cy.starts_on = $2`, [staffId, from]);
  const planTotal = plans ? plans.on_time + plans.late + plans.missing : 0;
  let expectedLogs = 0;
  const vid = await currentVersionId(c, branchId, to);
  if (vid) {
    const perDay = new Map((await q<{ day: number; n: number }>(c, `select day, count(*)::int as n from core.timetable_entries where version_id = $1 and staff_id = $2 group by day`, [vid, staffId])).map((r) => [r.day, r.n]));
    const cal = await workCalendar(c, branchId, from, to);
    for (const d of eachDate(from, to)) if (isWorkingDay(d, cal)) expectedLogs += perDay.get(isoWeekday(d)) ?? 0;
  }
  expectedLogs = Math.max(1, expectedLogs);
  return {
    observation: obs.v != null ? Number(obs.v) : null,
    task_on_time: tasks.done ? (tasks.on_time / tasks.done) * 100 : null,
    plan_timeliness: planTotal ? (plans!.on_time / planTotal) * 100 : null,
    syllabus_coverage: covPct,
    class_log_compliance: logs.logged ? Math.min(100, (logs.logged / expectedLogs) * 100) : null,
    punctuality: att.total ? (att.ok / att.total) * 100 : null,
    training_hours: Math.min(100, (Number(training.h) / 20) * 100),
    self_appraisal: score?.self_appraisal != null ? Number(score.self_appraisal) * 20 : null,
    manager_rating: score?.manager_rating != null ? Number(score.manager_rating) * 20 : null,
  };
}

/** Scorecards per cycle with school-set weights (decision support; visibility by permission). */
export async function computeScorecards(ctx: Ctx, cycleId: string) {
  need(ctx, 'appraisal', 'edit');
  return run(ctx, async (c, sys) => {
    const cy = await one<{ id: string; branch_id: string | null; starts_on: string; ends_on: string; weights: Partial<Record<AppraisalComponent, number>> }>(c, `select id, branch_id, starts_on::text, ends_on::text, weights from os.appraisal_cycles where id = $1`, [cycleId]);
    const branchId = cy.branch_id ?? ctx.branchId;
    const staff = await q<{ id: string }>(c, `select id from core.staff where branch_id = $1 and is_teaching and status = 'active' and deleted_at is null`, [branchId]);
    const today = localToday(ctx);
    const to = cy.ends_on < today ? cy.ends_on : today;
    let n = 0;
    for (const s of staff) {
      const comp = await sys(() => components(c, s.id, branchId, cy.starts_on, to, today));
      const r = appraisalScore(cy.weights, comp);
      await sys(() => c.query(`insert into os.appraisal_scores (org_id, branch_id, cycle_id, staff_id, components, total, computed_at) values ($1,$2,$3,$4,$5,$6,now()) on conflict (cycle_id, staff_id) do update set components = excluded.components, total = excluded.total, computed_at = now()`, [ctx.orgId, branchId, cycleId, s.id, JSON.stringify(r.breakdown), r.total]));
      n++;
    }
    return { computed: n };
  });
}

export async function scorecards(ctx: Ctx, cycleId: string) {
  needModule(ctx, 'observation');
  return run(ctx, async (c) => q(c, `select sc.*, s.full_name from os.appraisal_scores sc join core.staff s on s.id = sc.staff_id where sc.cycle_id = $1 order by sc.total desc nulls last`, [cycleId]));
}

export async function setRating(ctx: Ctx, cycleId: string, staffId: string, input: { manager_rating?: number; self_appraisal?: number }) {
  return run(ctx, async (c, sys) => {
    if (input.self_appraisal !== undefined && staffId !== ctx.staffId) throw new ForbiddenError();
    if (input.manager_rating !== undefined) need(ctx, 'appraisal', 'edit');
    const s = await one<{ branch_id: string }>(c, `select branch_id from core.staff where id = $1`, [staffId]);
    await sys(() => c.query(`insert into os.appraisal_scores (org_id, branch_id, cycle_id, staff_id, manager_rating, self_appraisal) values ($1,$2,$3,$4,$5,$6) on conflict (cycle_id, staff_id) do update set manager_rating = coalesce($5, appraisal_scores.manager_rating), self_appraisal = coalesce($6, appraisal_scores.self_appraisal)`, [ctx.orgId, s.branch_id, cycleId, staffId, input.manager_rating ?? null, input.self_appraisal ?? null]));
    return { ok: true };
  });
}

export async function trainings(ctx: Ctx, staffId?: string) {
  return run(ctx, async (c) => q(c, `select t.*, s.full_name from os.trainings t join core.staff s on s.id = t.staff_id where ($1::uuid is null or t.staff_id = $1) and t.deleted_at is null order by t.attended_on desc limit 300`, [staffId ?? null]));
}

export async function addTraining(ctx: Ctx, input: { staff_id?: string; title: string; provider?: string; attended_on: string; hours: number; certificate_path?: string | null }) {
  return run(ctx, async (c, sys) => {
    const who = input.staff_id ?? ctx.staffId;
    if (who !== ctx.staffId && rank(ctx, 'observation', 'edit') < 3) throw new ForbiddenError();
    const s = await one<{ branch_id: string }>(c, `select branch_id from core.staff where id = $1`, [who]);
    return sys(() => insert(c, 'os.trainings', { org_id: ctx.orgId, branch_id: s.branch_id, staff_id: who, title: input.title, provider: input.provider ?? null, attended_on: input.attended_on, hours: input.hours, certificate_path: input.certificate_path ?? null }));
  });
}

export { eachDate };
