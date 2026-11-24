/**
 * Academic planning (PRD 6.1 – 6.3): curriculum library, school uploads and search, AI lesson
 * planner, review workflow, plan bank, annual/unit/weekly plans, coverage tracker, class log.
 */
import { z } from 'zod';
import {
  dailyPlanSchema,
  validatePlan,
  fixTimings,
  rescaleFlow,
  canMovePlan,
  coverage,
  spreadChapters,
  homeworkLoad,
  projectedCompletion,
  DEFAULT_TEMPLATE_SECTIONS,
  PLAN_SECTION_KEYS,
  isoWeekday,
  addDays,
  eachDate,
  isWorkingDay,
  type DailyPlan,
  type TemplateSection,
  type PlanSectionKey,
} from '@autoed/shared';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError, insert, maybe, one, q, update, type Tx } from '../db';
import { need, needModule, rank, run, workCalendar, localToday, branchInfo, staffWithRole, now, type Ctx } from '../core';
import { notify } from '../notify';
import { generate } from './ai';
import { systemTask } from './tasks';
import { embed, toVectorLiteral, chunkText } from '../adapters/channels';
import { cloneBoard } from '../curriculum';
import { currentVersionId } from './timetable';

// ---------------------------------------------------------------- curriculum library
export async function boards(ctx: Ctx) {
  needModule(ctx, 'lesson_planner');
  return run(ctx, async (c) => q(c, `select id, org_id, key, name, syllabus_year, is_latest, cloned_from_id from os.curriculum_boards where deleted_at is null and (org_id is null or org_id = $1) order by org_id nulls first, key, syllabus_year desc`, [ctx.orgId]));
}

export async function boardTree(ctx: Ctx, boardId: string) {
  needModule(ctx, 'lesson_planner');
  return run(ctx, async (c) => {
    const subjects = await q<{ id: string }>(c, `select id, stage, grade_level, name, content_language from os.curriculum_subjects where board_id = $1 and deleted_at is null order by grade_level, name`, [boardId]);
    return subjects;
  });
}

export async function subjectTree(ctx: Ctx, curriculumSubjectId: string) {
  needModule(ctx, 'lesson_planner');
  return run(ctx, async (c) => {
    const units = await q<{ id: string; seq: number; name: string }>(c, `select id, seq, name from os.curriculum_units where subject_id = $1 and deleted_at is null order by seq`, [curriculumSubjectId]);
    const topics = await q<{ id: string; unit_id: string; parent_topic_id: string | null; kind: string; seq: number; name: string; est_periods: number; weight: number }>(c, `select id, unit_id, parent_topic_id, kind, seq, name, est_periods, weight from os.curriculum_topics where unit_id = any($1) and deleted_at is null order by seq`, [units.map((u) => u.id)]);
    const outcomes = await q<{ topic_id: string; code: string; text: string; kind: string }>(c, `select topic_id, code, text, kind from os.learning_outcomes where topic_id = any($1) and deleted_at is null order by code`, [topics.map((t) => t.id)]);
    return units.map((u) => ({
      ...u,
      chapters: topics
        .filter((t) => t.unit_id === u.id && t.kind === 'chapter')
        .map((ch) => ({ ...ch, topics: topics.filter((t) => t.parent_topic_id === ch.id).map((t) => ({ ...t, outcomes: outcomes.filter((o) => o.topic_id === t.id) })) })),
    }));
  });
}

export async function cloneMap(ctx: Ctx, boardId: string) {
  need(ctx, 'lesson_planner', 'configure');
  return run(ctx, async (c) => ({ board_id: await cloneBoard(c, ctx.orgId, boardId) }));
}

/** Edits to a school's own map: rename, reorder, add/remove topics and outcomes. */
export async function editMap(ctx: Ctx, input: { op: 'rename' | 'reorder' | 'add_topic' | 'remove_topic' | 'add_outcome' | 'add_chapter'; id?: string; name?: string; seq?: number; parent_id?: string; unit_id?: string; text?: string; est_periods?: number }) {
  need(ctx, 'lesson_planner', 'configure');
  return run(ctx, async (c) => {
    const own = async (table: string, id: string) => {
      const r = await maybe<{ org_id: string | null }>(c, `select org_id from public.${table} where id = $1`, [id]);
      if (!r || r.org_id !== ctx.orgId) throw new ForbiddenError('clone_the_map_first');
    };
    switch (input.op) {
      case 'rename':
        await own('curriculum_topics', input.id!);
        return update(c, 'os.curriculum_topics', input.id!, { name: input.name, est_periods: input.est_periods });
      case 'reorder':
        await own('curriculum_topics', input.id!);
        return update(c, 'os.curriculum_topics', input.id!, { seq: input.seq });
      case 'remove_topic':
        await own('curriculum_topics', input.id!);
        return update(c, 'os.curriculum_topics', input.id!, { deleted_at: new Date().toISOString() });
      case 'add_chapter': {
        await own('curriculum_units', input.unit_id!);
        const seq = (await one<{ m: number }>(c, `select coalesce(max(seq), 0)::int + 1 as m from os.curriculum_topics where unit_id = $1 and kind = 'chapter'`, [input.unit_id])).m;
        return insert(c, 'os.curriculum_topics', { org_id: ctx.orgId, unit_id: input.unit_id, kind: 'chapter', seq, name: input.name, est_periods: input.est_periods ?? 6, weight: input.est_periods ?? 6 });
      }
      case 'add_topic': {
        await own('curriculum_topics', input.parent_id!);
        const parent = await one<{ unit_id: string }>(c, `select unit_id from os.curriculum_topics where id = $1`, [input.parent_id]);
        const seq = (await one<{ m: number }>(c, `select coalesce(max(seq), 0)::int + 1 as m from os.curriculum_topics where parent_topic_id = $1`, [input.parent_id])).m;
        return insert(c, 'os.curriculum_topics', { org_id: ctx.orgId, unit_id: parent.unit_id, parent_topic_id: input.parent_id, kind: 'topic', seq, name: input.name, est_periods: input.est_periods ?? 1 });
      }
      case 'add_outcome': {
        await own('curriculum_topics', input.id!);
        const n = (await one<{ n: number }>(c, `select count(*)::int + 1 as n from os.learning_outcomes where topic_id = $1`, [input.id])).n;
        return insert(c, 'os.learning_outcomes', { org_id: ctx.orgId, topic_id: input.id, code: `SCH.${input.id!.slice(0, 4)}.${n}`, text: input.text, kind: 'outcome' });
      }
    }
  });
}

async function topicContext(c: Tx, topicId: string) {
  const t = await maybe<{ id: string; name: string; parent_topic_id: string | null; unit_id: string; kind: string }>(c, `select id, name, parent_topic_id, unit_id, kind from os.curriculum_topics where id = $1`, [topicId]);
  if (!t) throw new NotFoundError('topic');
  const chapter = t.parent_topic_id ? await one<{ name: string }>(c, `select name from os.curriculum_topics where id = $1`, [t.parent_topic_id]) : { name: t.name };
  const subj = await one<{ name: string; stage: string; key: string; content_language: string }>(c, `select cs.name, cs.stage, b.key, cs.content_language from os.curriculum_units u join os.curriculum_subjects cs on cs.id = u.subject_id join os.curriculum_boards b on b.id = cs.board_id where u.id = $1`, [t.unit_id]);
  const outcomes = await q<{ code: string; text: string; kind: string }>(c, `select code, text, kind from os.learning_outcomes where topic_id = $1 and deleted_at is null order by code`, [t.kind === 'chapter' ? null : topicId]);
  const chapterOutcomes = t.kind === 'chapter' ? await q<{ code: string; text: string; kind: string }>(c, `select lo.code, lo.text, lo.kind from os.learning_outcomes lo join os.curriculum_topics tt on tt.id = lo.topic_id where tt.parent_topic_id = $1`, [topicId]) : [];
  const all = [...outcomes, ...chapterOutcomes];
  return { topic: t.name, chapter: chapter.name, subject: subj.name, stage: subj.stage, board: subj.key, language: subj.content_language, outcomes: all.filter((o) => o.kind !== 'competency' && o.kind !== 'assessment_objective').map((o) => ({ code: o.code, text: o.text })), competencies: all.filter((o) => o.kind === 'competency').map((o) => o.text) };
}

// ---------------------------------------------------------------- uploads & search
export async function addDocument(ctx: Ctx, input: { title: string; kind: string; storage_path: string; mime: string; size_bytes: number; subject_id?: string | null; programme_id?: string | null; text?: string }) {
  need(ctx, 'lesson_planner', 'create');
  if (!input.storage_path.startsWith(`${ctx.orgId}/`)) throw new ForbiddenError('bad_path');
  return run(ctx, async (c, sys) => {
    const doc = await sys(() => insert<{ id: string }>(c, 'os.reference_documents', { org_id: ctx.orgId, branch_id: ctx.branchId, title: input.title, kind: input.kind, storage_path: input.storage_path, mime: input.mime, size_bytes: input.size_bytes, subject_id: input.subject_id ?? null, programme_id: input.programme_id ?? null, status: input.text ? 'parsed' : 'uploaded' }));
    if (input.text) {
      const { enqueue } = await import('../jobs');
      await sys(async () => {
        await c.query(`insert into public.jobs (org_id, branch_id, kind, payload, dedupe_key) values ($1,$2,'embed_document',$3,$4) on conflict do nothing`, [ctx.orgId, ctx.branchId, JSON.stringify({ document_id: doc.id, text: input.text }), `embed:${doc.id}`]);
        void enqueue;
      });
    }
    return { id: doc.id };
  });
}

/** Splits, embeds and stores chunks searchable only within the organisation. */
export async function embedDocument(c: Tx, documentId: string, text: string): Promise<number> {
  const doc = await one<{ org_id: string; branch_id: string | null }>(c, `select org_id, branch_id from os.reference_documents where id = $1`, [documentId]);
  await c.query(`delete from os.document_chunks where document_id = $1`, [documentId]);
  const chunks = chunkText(text);
  let seq = 1;
  for (const ch of chunks) await c.query(`insert into os.document_chunks (org_id, branch_id, document_id, seq, content, embedding) values ($1,$2,$3,$4,$5,$6::vector)`, [doc.org_id, doc.branch_id, documentId, seq++, ch, toVectorLiteral(embed(ch))]);
  await c.query(`update os.reference_documents set status = 'embedded' where id = $1`, [documentId]);
  return chunks.length;
}

export async function searchDocuments(c: Tx, orgId: string, query: string, limit = 5) {
  return q<{ id: string; content: string; title: string; score: number }>(
    c,
    `select dc.id, dc.content, d.title, 1 - (dc.embedding <=> $2::vector) as score from os.document_chunks dc join os.reference_documents d on d.id = dc.document_id
     where dc.org_id = $1 and dc.deleted_at is null and d.deleted_at is null order by dc.embedding <=> $2::vector limit $3`,
    [orgId, toVectorLiteral(embed(query)), limit],
  );
}

export async function search(ctx: Ctx, query: string) {
  needModule(ctx, 'lesson_planner');
  return run(ctx, async (c) => searchDocuments(c, ctx.orgId, query, 10));
}

export async function documents(ctx: Ctx) {
  needModule(ctx, 'lesson_planner');
  return run(ctx, async (c) => q(c, `select d.*, (select count(*)::int from os.document_chunks x where x.document_id = d.id) as chunks from os.reference_documents d where d.org_id = $1 and d.deleted_at is null order by d.created_at desc`, [ctx.orgId]));
}

// ---------------------------------------------------------------- templates
export async function templateFor(c: Tx, orgId: string, wingId: string | null): Promise<{ id: string | null; sections: TemplateSection[]; header: Record<string, unknown>; default_teaching_model: string }> {
  const t =
    (wingId ? await maybe<{ id: string; sections: TemplateSection[]; header: Record<string, unknown>; default_teaching_model: string }>(c, `select id, sections, header, default_teaching_model from os.lesson_plan_templates where org_id = $1 and wing_id = $2 and deleted_at is null limit 1`, [orgId, wingId]) : null) ??
    (await maybe<{ id: string; sections: TemplateSection[]; header: Record<string, unknown>; default_teaching_model: string }>(c, `select id, sections, header, default_teaching_model from os.lesson_plan_templates where org_id = $1 and is_default and deleted_at is null limit 1`, [orgId]));
  return t ?? { id: null, sections: DEFAULT_TEMPLATE_SECTIONS, header: {}, default_teaching_model: '5E' };
}

export async function saveTemplate(ctx: Ctx, input: { id?: string; name: string; wing_id?: string | null; sections: TemplateSection[]; header?: Record<string, unknown>; default_teaching_model: string; is_default?: boolean }) {
  need(ctx, 'lesson_planner', 'configure');
  for (const s of input.sections) if (!PLAN_SECTION_KEYS.includes(s.key)) throw new ValidationError('unknown_section', { key: s.key });
  return run(ctx, async (c) => {
    const row = { org_id: ctx.orgId, name: input.name, wing_id: input.wing_id ?? null, sections: input.sections, header: input.header ?? {}, default_teaching_model: input.default_teaching_model, is_default: !!input.is_default };
    return input.id ? update(c, 'os.lesson_plan_templates', input.id, row) : insert(c, 'os.lesson_plan_templates', row);
  });
}

// ---------------------------------------------------------------- AI daily plan
const PLAN_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['objectives', 'board_elements', 'prior_knowledge', 'materials', 'flow', 'differentiation', 'questions', 'exit_ticket', 'homework', 'links', 'board_work', 'reflection'],
  properties: {
    objectives: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['text', 'bloom', 'outcome_codes'], properties: { text: { type: 'string' }, bloom: { type: 'string', enum: ['remember', 'understand', 'apply', 'analyse', 'evaluate', 'create'] }, outcome_codes: { type: 'array', items: { type: 'string' } } } } },
    board_elements: { type: 'object', additionalProperties: false, required: ['competencies', 'nep_elements', 'key_vocabulary', 'success_criteria', 'assessment_objectives'], properties: { competencies: { type: 'array', items: { type: 'string' } }, nep_elements: { type: 'array', items: { type: 'string' } }, key_vocabulary: { type: 'array', items: { type: 'string' } }, success_criteria: { type: 'array', items: { type: 'string' } }, assessment_objectives: { type: 'array', items: { type: 'string' } } } },
    prior_knowledge: { type: 'array', items: { type: 'string' } },
    materials: { type: 'array', items: { type: 'string' } },
    flow: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['phase', 'minutes', 'teacher_activity', 'student_activity'], properties: { phase: { type: 'string', enum: ['opening', 'teaching', 'guided_practice', 'independent_practice', 'closure'] }, minutes: { type: 'integer' }, teacher_activity: { type: 'string' }, student_activity: { type: 'string' } } } },
    differentiation: { type: 'object', additionalProperties: false, required: ['support', 'core', 'extension'], properties: { support: { type: 'string' }, core: { type: 'string' }, extension: { type: 'string' } } },
    questions: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['text', 'level', 'competency'], properties: { text: { type: 'string' }, level: { type: 'string', enum: ['lower', 'higher'] }, competency: { type: 'boolean' } } } },
    exit_ticket: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['question', 'answer'], properties: { question: { type: 'string' }, answer: { type: 'string' } } } },
    homework: { type: 'object', additionalProperties: false, required: ['description', 'minutes'], properties: { description: { type: 'string' }, minutes: { type: 'integer' } } },
    links: { type: 'array', items: { type: 'string' } },
    board_work: { type: 'string' },
    reflection: { type: 'string' },
  },
};

const MODEL_NAMES: Record<string, string> = { '5E': '5E (Engage, Explore, Explain, Elaborate, Evaluate)', gradual_release: 'Gradual Release (I do, we do, you do)', experiential: 'Experiential Learning Cycle', inquiry: 'Inquiry-based', direct: 'Direct Instruction', flipped: 'Flipped classroom', school: "the school's own format" };
const LANG_NAMES: Record<string, string> = { en: 'English', hi: 'Hindi', te: 'Telugu' };

function planSystemPrompt(board: string, language: string) {
  return [
    'You write daily lesson plans for teachers in Indian K-12 schools.',
    board === 'CBSE'
      ? 'The board is CBSE: include competencies and NEP 2020 elements (experiential learning, art integration, sports integration, life skills) only where they fit naturally.'
      : 'The board is Cambridge: include learning objectives, assessment objectives, key vocabulary and success criteria.',
    'Write original text. Never reproduce textbook passages. Use Indian everyday contexts for examples.',
    'Every objective must list the outcome codes it serves, chosen from the codes provided.',
    'Lesson flow minutes must add up exactly to the total minutes given. Leave "reflection" empty: the teacher fills it after class.',
    'Questions should include higher-order and competency-based questions. Give answers in the exit ticket.',
    `Write the plan in ${LANG_NAMES[language] ?? 'English'}.`,
    'Use LaTeX between $...$ for mathematics and science notation.',
  ].join('\n');
}

export async function generateDailyPlan(ctx: Ctx, input: { section_ids: string[]; subject_id: string; topic_id: string; plan_date: string; period_count: number; period_minutes: number; teaching_model: string; resources: string[]; class_profile: { size?: number; ability_mix: string; medium: string }; notes?: string; language?: 'en' | 'hi' | 'te' }) {
  need(ctx, 'lesson_planner', 'create');
  return run(ctx, async (c, sys) => {
    const sections = await q<{ id: string; wing_id: string; branch_id: string; strength: number; name: string; class_name: string }>(c, `select se.id, cl.wing_id, se.branch_id, se.strength, se.name, cl.name as class_name from core.sections se join core.programmes cl on cl.id = se.programme_id where se.id = any($1)`, [input.section_ids]);
    if (sections.length !== input.section_ids.length) throw new NotFoundError('section');
    const subject = await one<{ id: string; name: string; content_language: string }>(c, `select id, name, content_language from core.subjects where id = $1`, [input.subject_id]);
    const tc = await topicContext(c, input.topic_id);
    const template = await templateFor(c, ctx.orgId, sections[0]!.wing_id);
    // Language subjects are planned in their own language (PRD 6.1 Languages).
    const language = subject.content_language === 'hi' || subject.content_language === 'te' ? subject.content_language : input.language ?? 'en';
    const passages = await searchDocuments(c, ctx.orgId, `${tc.chapter} ${tc.topic}`, 3);
    const lastLog = await maybe<{ topic_text: string | null; classwork: string | null }>(c, `select topic_text, classwork from os.class_logs where section_id = $1 and subject_id = $2 and date < $3 order by date desc, period_seq desc limit 1`, [input.section_ids[0], input.subject_id, input.plan_date]);
    const unit = await maybe<{ content: Record<string, unknown> }>(c, `select content from os.lesson_plans where level = 'unit' and subject_id = $1 and topic_id in (select parent_topic_id from os.curriculum_topics where id = $2) and staff_id = $3 order by created_at desc limit 1`, [input.subject_id, input.topic_id, ctx.staffId]);
    const total = input.period_minutes * input.period_count;
    // Only class, subject and topic context goes to the provider (rule 8).
    const prompt = [
      `Subject: ${subject.name} (${tc.board}, ${tc.stage})`,
      `Chapter: ${tc.chapter}`,
      `Topic: ${tc.topic}`,
      `Learning outcomes (code: text):\n${tc.outcomes.map((o) => `- ${o.code}: ${o.text}`).join('\n') || '- (none listed)'}`,
      tc.competencies.length ? `Competencies: ${tc.competencies.join('; ')}` : '',
      `Periods: ${input.period_count} x ${input.period_minutes} minutes = ${total} minutes total`,
      `Teaching model: ${MODEL_NAMES[input.teaching_model] ?? input.teaching_model}`,
      `Resources available: ${input.resources.join(', ') || 'none'}`,
      `Class profile: ${input.class_profile.size ?? sections[0]!.strength} students, ${input.class_profile.ability_mix} ability mix, medium of instruction ${input.class_profile.medium}`,
      lastLog ? `Covered last period: ${lastLog.topic_text ?? ''} ${lastLog.classwork ?? ''}`.trim() : '',
      unit ? `Unit plan summary: ${JSON.stringify(unit.content).slice(0, 1500)}` : '',
      passages.length ? `Relevant notes from the school's own materials:\n${passages.map((p) => `- ${p.content.slice(0, 600)}`).join('\n')}` : '',
      `Template sections required: ${template.sections.filter((s) => s.mandatory).map((s) => s.name).join(', ')}`,
      input.notes ? `Teacher notes: ${input.notes}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    const outcomeCodes = tc.outcomes.map((o) => o.code);
    const gen = await sys(() =>
      generate<DailyPlan>(c, {
        orgId: ctx.orgId,
        branchId: ctx.branchId,
        staffId: ctx.staffId,
        action: 'daily_plan',
        tier: 'strong',
        system: planSystemPrompt(tc.board, language),
        prompt,
        jsonSchema: PLAN_JSON_SCHEMA,
        zod: dailyPlanSchema,
        mockContext: { ...tc, periodMinutes: input.period_minutes, periodCount: input.period_count, model: input.teaching_model, language, resources: input.resources },
        repair: (p) => fixTimings(p, total),
        validate: (p) => validatePlan(p, { periodMinutes: input.period_minutes, periodCount: input.period_count, outcomeCodes, sections: template.sections }).map((i) => i.code),
        linked: { type: 'lesson_plan' },
        logInput: { subject: subject.name, board: tc.board, stage: tc.stage, chapter: tc.chapter, topic: tc.topic, minutes: total, model: input.teaching_model, language },
      }),
    );
    const plan = await insert<{ id: string }>(c, 'os.lesson_plans', {
      org_id: ctx.orgId,
      branch_id: ctx.branchId,
      level: 'daily',
      staff_id: ctx.staffId,
      section_id: input.section_ids[0],
      section_ids: input.section_ids,
      subject_id: input.subject_id,
      topic_id: input.topic_id,
      plan_date: input.plan_date,
      period_count: input.period_count,
      period_minutes: input.period_minutes,
      teaching_model: input.teaching_model,
      template_id: template.id,
      inputs: input,
      content: gen.output,
      language,
      status: 'draft',
      confirmed_by_teacher: false,
      ai_generation_id: gen.generationId,
      due_at: await planDueAt(c, ctx, input.plan_date),
    });
    await insert(c, 'os.lesson_plan_versions', { org_id: ctx.orgId, branch_id: ctx.branchId, plan_id: plan.id, version: 1, content: gen.output, note: 'ai' });
    await sys(() => c.query(`update core.ai_generations set linked_id = $2 where id = $1`, [gen.generationId, plan.id]));
    return { id: plan.id, credits: gen.credits, attempts: gen.attempts };
  });
}

async function planDueAt(c: Tx, ctx: Ctx, planDate: string): Promise<string | null> {
  const rule = await maybe<{ due_time: string; days_before: number }>(c, `select due_time::text, days_before from os.plan_submission_rules where org_id = $1 and level = 'daily' and active and deleted_at is null limit 1`, [ctx.orgId]);
  if (!rule) return null;
  const cal = await workCalendar(c, ctx.branchId);
  let d = planDate;
  for (let i = 0; i < rule.days_before; i++) {
    d = addDays(d, -1);
    while (!isWorkingDay(d, cal)) d = addDays(d, -1);
  }
  const { fromLocal } = await import('@autoed/shared');
  return fromLocal(d, rule.due_time.slice(0, 5), cal.timeZone).toISOString();
}

const SECTION_SCHEMAS: Record<string, z.ZodTypeAny> = Object.fromEntries(PLAN_SECTION_KEYS.map((k) => [k, (dailyPlanSchema.shape as Record<string, z.ZodTypeAny>)[k]!]));

/** Section-level AI actions (PRD 6.1 step 5). */
export async function sectionAction(ctx: Ctx, planId: string, input: { section: string; action: string; minutes?: number; language?: 'en' | 'hi' | 'te' }) {
  need(ctx, 'lesson_planner', 'edit');
  return run(ctx, async (c, sys) => {
    const plan = await loadEditablePlan(c, ctx, planId);
    if (!PLAN_SECTION_KEYS.includes(input.section as PlanSectionKey)) throw new ValidationError('unknown_section');
    const content = dailyPlanSchema.parse(plan.content);
    let next: DailyPlan;
    if (input.action === 'shorten') {
      // Deterministic: rescale the flow to N minutes; no AI call needed, no credits.
      if (!input.minutes) throw new ValidationError('minutes_required');
      next = rescaleFlow(content, input.minutes);
    } else {
      const tc = plan.topic_id ? await topicContext(c, plan.topic_id) : { topic: '', chapter: '', subject: '', stage: '', board: 'CBSE', language: 'en', outcomes: [], competencies: [] };
      const language = input.action === 'translate' ? input.language ?? 'en' : plan.language;
      const instructions: Record<string, string> = {
        regenerate: 'Rewrite this section with a fresh approach.',
        more_hands_on: 'Make this section more hands-on with concrete activities students do.',
        simplify: 'Simplify the language and steps for this section.',
        add_unplugged_activity: 'Add an activity that needs no technology.',
        add_questions: 'Add more questions, including higher-order and competency-based ones.',
        translate: `Translate this section into ${LANG_NAMES[language]}.`,
      };
      const schema = SECTION_SCHEMAS[input.section]!;
      const gen = await sys(() =>
        generate<{ value?: unknown }>(c, {
          orgId: ctx.orgId,
          branchId: ctx.branchId,
          staffId: ctx.staffId,
          action: 'section_rewrite',
          tier: 'fast',
          system: planSystemPrompt(tc.board, language),
          prompt: `Topic: ${tc.topic} (${tc.subject}, ${tc.stage}). Section "${input.section}" currently is:\n${JSON.stringify(content[input.section as PlanSectionKey])}\n\n${instructions[input.action] ?? instructions.regenerate} Return {"value": <the new section in the same shape>}.${input.section === 'flow' ? ` Keep the total at ${plan.period_minutes * plan.period_count} minutes.` : ''}`,
          jsonSchema: { type: 'object', additionalProperties: false, required: ['value'], properties: { value: (PLAN_JSON_SCHEMA.properties as Record<string, unknown>)[input.section] } },
          zod: z.object({ value: schema }),
          mockContext: { ...tc, section: input.section, op: input.action, current: content, periodMinutes: plan.period_minutes, periodCount: plan.period_count, language },
          linked: { type: 'lesson_plan', id: planId },
          logInput: { section: input.section, action: input.action, topic: tc.topic },
        }),
      );
      next = { ...content, [input.section]: gen.output.value } as DailyPlan;
      if (input.section === 'flow') next = fixTimings(next, plan.period_minutes * plan.period_count);
    }
    await saveVersion(c, ctx, plan, next, `${input.action}:${input.section}`);
    return { content: next };
  });
}

interface PlanRow {
  id: string;
  org_id: string;
  branch_id: string;
  staff_id: string;
  section_id: string | null;
  section_ids: string[];
  subject_id: string;
  topic_id: string | null;
  plan_date: string | null;
  level: string;
  status: string;
  content: Record<string, unknown>;
  language: string;
  period_minutes: number;
  period_count: number;
  current_version: number;
  confirmed_by_teacher: boolean;
  review_seq: number;
  due_at: string | null;
  in_bank: boolean;
  template_id: string | null;
}

async function loadEditablePlan(c: Tx, ctx: Ctx, id: string): Promise<PlanRow> {
  const p = await maybe<PlanRow>(c, `select * from os.lesson_plans where id = $1 and deleted_at is null`, [id]);
  if (!p) throw new NotFoundError();
  if (p.staff_id !== ctx.staffId) throw new ForbiddenError('only_the_teacher_edits');
  if (!['draft', 'returned'].includes(p.status)) throw new ConflictError('plan_locked_in_review');
  return p;
}

async function saveVersion(c: Tx, ctx: Ctx, plan: PlanRow, content: unknown, note: string) {
  const v = plan.current_version + 1;
  await update(c, 'os.lesson_plans', plan.id, { content, current_version: v, confirmed_by_teacher: false });
  await insert(c, 'os.lesson_plan_versions', { org_id: plan.org_id, branch_id: plan.branch_id, plan_id: plan.id, version: v, content, note });
  void ctx;
}

/** The teacher edits anything in the rich editor. */
export async function updatePlan(ctx: Ctx, id: string, input: { content: Record<string, unknown>; note?: string }) {
  need(ctx, 'lesson_planner', 'edit');
  return run(ctx, async (c) => {
    const plan = await loadEditablePlan(c, ctx, id);
    const content = plan.level === 'daily' || plan.level === 'cover' ? dailyPlanSchema.parse({ ...plan.content, ...input.content }) : { ...plan.content, ...input.content };
    await saveVersion(c, ctx, plan, content, input.note ?? 'edit');
    return { ok: true };
  });
}

export async function getPlan(ctx: Ctx, id: string) {
  needModule(ctx, 'lesson_planner');
  return run(ctx, async (c) => {
    const p = await maybe<PlanRow & Record<string, unknown>>(
      c,
      `select lp.*, s.full_name as teacher_name, sb.name as subject_name, t.name as topic_name, cl.name || ' ' || se.name as section_name
       from os.lesson_plans lp join core.staff s on s.id = lp.staff_id join core.subjects sb on sb.id = lp.subject_id left join os.curriculum_topics t on t.id = lp.topic_id
       left join core.sections se on se.id = lp.section_id left join core.programmes cl on cl.id = se.programme_id where lp.id = $1`,
      [id],
    );
    if (!p) throw new NotFoundError();
    const wing = p.section_id ? (await maybe<{ wing_id: string }>(c, `select cl.wing_id from core.sections se join core.programmes cl on cl.id = se.programme_id where se.id = $1`, [p.section_id]))?.wing_id ?? null : null;
    const template = await templateFor(c, p.org_id, wing);
    const reviews = await q(c, `select r.*, s.full_name as reviewer_name from os.lesson_plan_reviews r left join core.staff s on s.id = r.reviewer_id where r.plan_id = $1 order by r.created_at`, [id]);
    const versionsList = await q(c, `select version, note, created_at from os.lesson_plan_versions where plan_id = $1 order by version desc`, [id]);
    const gen = p.ai_generation_id ? await maybe(c, `select credits, model, attempts from core.ai_generations where id = $1`, [p.ai_generation_id]) : null;
    const org = await one<{ name: string; logo_url: string | null; branding: Record<string, unknown> }>(c, `select name, logo_url, branding from core.organizations where id = $1`, [p.org_id]);
    return { ...p, template, reviews, versions: versionsList, generation: gen, org, can_edit: p.staff_id === ctx.staffId && ['draft', 'returned'].includes(p.status), can_review: await isReviewer(c, ctx, p) };
  });
}

async function reviewSteps(c: Tx, orgId: string, level: string): Promise<string[]> {
  const r = await maybe<{ review_steps: string[] }>(c, `select review_steps from os.plan_submission_rules where org_id = $1 and level = $2 and active and deleted_at is null limit 1`, [orgId, level === 'cover' ? 'daily' : level]);
  return r?.review_steps ?? ['hod', 'academic_coordinator'];
}

/** Reviewers for the current step: role holders responsible for this teacher's department / wing. */
async function reviewersFor(c: Tx, p: PlanRow, roleKey: string): Promise<string[]> {
  const teacher = await one<{ department_id: string | null; wing_id: string | null; branch_id: string | null }>(c, `select department_id, wing_id, branch_id from core.staff where id = $1`, [p.staff_id]);
  const holders = await staffWithRole(c, p.org_id, roleKey, p.branch_id);
  if (roleKey === 'hod') {
    const head = await maybe<{ head_staff_id: string | null }>(c, `select head_staff_id from core.departments d join core.subjects s on s.department_id = d.id where s.id = $1`, [p.subject_id]);
    if (head?.head_staff_id && head.head_staff_id !== p.staff_id) return [head.head_staff_id];
    const sameDept = await q<{ id: string }>(c, `select id from core.staff where id = any($1) and department_id = $2`, [holders, teacher.department_id]);
    return sameDept.map((s) => s.id).filter((id) => id !== p.staff_id);
  }
  const sameWing = await q<{ id: string }>(c, `select id from core.staff where id = any($1) and (wing_id = $2 or wing_id is null)`, [holders, teacher.wing_id]);
  return (sameWing.length ? sameWing.map((s) => s.id) : holders).filter((id) => id !== p.staff_id);
}

async function isReviewer(c: Tx, ctx: Ctx, p: PlanRow): Promise<boolean> {
  if (!['submitted', 'in_review'].includes(p.status)) return false;
  const steps = await reviewSteps(c, p.org_id, p.level);
  const role = steps[Math.max(0, p.review_seq - 1)];
  if (!role) return false;
  return (await reviewersFor(c, p, role)).includes(ctx.staffId) || rank(ctx, 'lesson_planner', 'approve') >= 5;
}

/** Draft -> Submitted -> In review -> Approved or Returned -> Delivered -> Reflected. */
export async function planWorkflow(ctx: Ctx, id: string, input: { action: 'confirm' | 'submit' | 'approve' | 'return' | 'deliver' | 'reflect' | 'add_to_bank' | 'rate'; comment?: string; section_comments: { section: string; comment: string }[]; reflection?: string; rating?: number }) {
  needModule(ctx, 'lesson_planner');
  return run(ctx, async (c, sys) => {
    const p = await maybe<PlanRow>(c, `select * from os.lesson_plans where id = $1 and deleted_at is null`, [id]);
    if (!p) throw new NotFoundError();
    const owner = p.staff_id === ctx.staffId;
    const steps = await reviewSteps(c, p.org_id, p.level);
    switch (input.action) {
      case 'confirm':
        if (!owner) throw new ForbiddenError();
        await update(c, 'os.lesson_plans', id, { confirmed_by_teacher: true });
        return { status: p.status, confirmed: true };
      case 'submit': {
        if (!owner) throw new ForbiddenError();
        // A plan cannot be submitted until the teacher has opened and confirmed it (AI output stays a draft until then).
        if (!p.confirmed_by_teacher) throw new ValidationError('confirm_before_submit');
        if (!canMovePlan(p.status, 'submitted')) throw new ConflictError('invalid_transition');
        await update(c, 'os.lesson_plans', id, { status: 'submitted', submitted_at: ctx.now.toISOString(), review_seq: 1 });
        const reviewers = await sys(() => reviewersFor(c, p, steps[0]!));
        await sys(() => notify(c, { orgId: p.org_id, branchId: p.branch_id, staffIds: reviewers, event: 'plan.review', titleKey: 'notif.plan.review', vars: { who: ctx.staff.full_name }, link: `/os/lesson-plans/${id}` }));
        await sys(() => c.query(`update os.tasks set status = 'done', completed_at = now() where system_key like $1 and status = 'todo'`, [`plan:${p.staff_id}:${p.plan_date}%`]));
        return { status: 'submitted' };
      }
      case 'approve':
      case 'return': {
        if (!(await isReviewer(c, ctx, p))) throw new ForbiddenError('not_a_reviewer');
        for (const sc of input.section_comments) await sys(() => insert(c, 'os.lesson_plan_reviews', { org_id: p.org_id, branch_id: p.branch_id, plan_id: id, step_seq: p.review_seq, reviewer_id: ctx.staffId, action: 'comment', section_key: sc.section, comment: sc.comment }));
        await sys(() => insert(c, 'os.lesson_plan_reviews', { org_id: p.org_id, branch_id: p.branch_id, plan_id: id, step_seq: p.review_seq, reviewer_id: ctx.staffId, action: input.action, comment: input.comment ?? null }));
        if (input.action === 'return') {
          await sys(() => update(c, 'os.lesson_plans', id, { status: 'returned', confirmed_by_teacher: false }));
          await sys(() => notify(c, { orgId: p.org_id, branchId: p.branch_id, staffIds: [p.staff_id], event: 'plan.review', titleKey: 'notif.plan.returned', vars: { who: ctx.staff.full_name }, link: `/os/lesson-plans/${id}` }));
          return { status: 'returned' };
        }
        if (p.review_seq < steps.length) {
          await sys(() => update(c, 'os.lesson_plans', id, { status: 'in_review', review_seq: p.review_seq + 1 }));
          const next = await sys(() => reviewersFor(c, p, steps[p.review_seq]!));
          await sys(() => notify(c, { orgId: p.org_id, branchId: p.branch_id, staffIds: next, event: 'plan.review', titleKey: 'notif.plan.review', vars: { who: ctx.staff.full_name }, link: `/os/lesson-plans/${id}` }));
          return { status: 'in_review' };
        }
        // Approved plans go to the searchable plan bank.
        await sys(() => update(c, 'os.lesson_plans', id, { status: 'approved', approved_at: ctx.now.toISOString(), in_bank: true }));
        await sys(() => notify(c, { orgId: p.org_id, branchId: p.branch_id, staffIds: [p.staff_id], event: 'plan.review', titleKey: 'notif.plan.approved', vars: { who: ctx.staff.full_name }, link: `/os/lesson-plans/${id}` }));
        return { status: 'approved' };
      }
      case 'deliver': {
        if (!owner) throw new ForbiddenError();
        if (!canMovePlan(p.status, 'delivered')) throw new ConflictError('invalid_transition');
        await update(c, 'os.lesson_plans', id, { status: 'delivered', delivered_at: ctx.now.toISOString() });
        // Delivering a plan logs the class, which updates coverage.
        if (p.plan_date && p.section_id) {
          const seq = await periodSeqFor(c, p.branch_id, p.section_id, p.subject_id, p.staff_id, p.plan_date);
          for (const sid of p.section_ids.length ? p.section_ids : [p.section_id]) {
            for (let k = 0; k < p.period_count; k++) {
              await c.query(
                `insert into os.class_logs (org_id, branch_id, section_id, subject_id, staff_id, date, period_seq, topic_id, lesson_plan_id, taught_as_planned, topic_text)
                 values ($1,$2,$3,$4,$5,$6,$7,$8,$9,true,$10) on conflict (section_id, date, period_seq) do update set lesson_plan_id = excluded.lesson_plan_id, topic_id = excluded.topic_id`,
                [p.org_id, p.branch_id, sid, p.subject_id, p.staff_id, p.plan_date, seq + k, p.topic_id, id, ctx.t('classLog.taughtAsPlanned')],
              );
            }
          }
        }
        return { status: 'delivered' };
      }
      case 'reflect':
        if (!owner) throw new ForbiddenError();
        if (!input.reflection) throw new ValidationError('reflection_required');
        await update(c, 'os.lesson_plans', id, { status: 'reflected', reflection: input.reflection, content: { ...p.content, reflection: input.reflection } });
        return { status: 'reflected' };
      case 'add_to_bank':
        if (!owner && rank(ctx, 'lesson_planner', 'approve') < 3) throw new ForbiddenError();
        if (!['approved', 'delivered', 'reflected'].includes(p.status)) throw new ValidationError('only_approved_plans');
        await sys(() => update(c, 'os.lesson_plans', id, { in_bank: true }));
        return { status: p.status };
      case 'rate':
        if (!p.in_bank || !input.rating) throw new ValidationError('rating_required');
        await sys(() => c.query(`update os.lesson_plans set rating_sum = rating_sum + $2, rating_count = rating_count + 1 where id = $1`, [id, input.rating]));
        return { status: p.status };
    }
  });
}

async function periodSeqFor(c: Tx, branchId: string, sectionId: string, subjectId: string, staffId: string, date: string): Promise<number> {
  const vid = await currentVersionId(c, branchId, date);
  const e = vid ? await maybe<{ period_seq: number }>(c, `select period_seq from core.timetable_entries where version_id = $1 and day = $2 and section_id = $3 and (subject_id = $4 or staff_id = $5) order by period_seq limit 1`, [vid, isoWeekday(date), sectionId, subjectId, staffId]) : null;
  return e?.period_seq ?? 1;
}

export async function listPlans(ctx: Ctx, opts: { view: 'mine' | 'review' | 'bank' | 'all'; q?: string; subject_id?: string; programme_id?: string; from?: string; to?: string }) {
  needModule(ctx, 'lesson_planner');
  return run(ctx, async (c) => {
    const params: unknown[] = [ctx.staffId];
    const p = (v: unknown) => (params.push(v), `$${params.length}`);
    const where = ['lp.deleted_at is null', `lp.level in ('daily','unit','weekly','cover')`, '$1::uuid is not null'];
    if (opts.view === 'mine') where.push('lp.staff_id = $1');
    if (opts.view === 'review') where.push(`lp.status in ('submitted','in_review') and lp.staff_id <> $1`);
    if (opts.view === 'bank') where.push(`lp.in_bank`);
    if (opts.view === 'all') where.push(`lp.branch_id = ${p(ctx.branchId)}`);
    if (opts.q) where.push(`(t.name ilike ${p(`%${opts.q}%`)} or sb.name ilike $${params.length})`);
    if (opts.subject_id) where.push(`lp.subject_id = ${p(opts.subject_id)}`);
    if (opts.programme_id) where.push(`se.programme_id = ${p(opts.programme_id)}`);
    if (opts.from) where.push(`lp.plan_date >= ${p(opts.from)}`);
    if (opts.to) where.push(`lp.plan_date <= ${p(opts.to)}`);
    const rows = await q<PlanRow & Record<string, unknown>>(
      c,
      `select lp.id, lp.level, lp.status, lp.plan_date, lp.staff_id, lp.subject_id, lp.topic_id, lp.section_id, lp.review_seq, lp.org_id, lp.branch_id, lp.section_ids, lp.content, lp.language, lp.period_minutes, lp.period_count, lp.current_version, lp.confirmed_by_teacher, lp.due_at, lp.in_bank, lp.template_id, lp.submitted_at,
         lp.rating_sum, lp.rating_count, lp.usage_count, s.full_name as teacher_name, sb.name as subject_name, t.name as topic_name, cl.name || ' ' || se.name as section_name
       from os.lesson_plans lp join core.staff s on s.id = lp.staff_id join core.subjects sb on sb.id = lp.subject_id left join os.curriculum_topics t on t.id = lp.topic_id
       left join core.sections se on se.id = lp.section_id left join core.programmes cl on cl.id = se.programme_id
       where ${where.join(' and ')} order by lp.plan_date desc nulls last, lp.created_at desc limit 200`,
      params,
    );
    const out = [];
    for (const r of rows) {
      if (opts.view === 'review' && !(await isReviewer(c, ctx, r))) continue;
      const { content: _content, ...rest } = r;
      out.push(rest);
    }
    return out;
  });
}

/** Reuse a bank plan for another section/date: copy as a new draft. */
export async function reusePlan(ctx: Ctx, id: string, input: { section_ids: string[]; plan_date: string }) {
  need(ctx, 'lesson_planner', 'create');
  return run(ctx, async (c, sys) => {
    const src = await maybe<PlanRow>(c, `select * from os.lesson_plans where id = $1 and in_bank`, [id]);
    if (!src) throw new NotFoundError();
    const copy = await insert<{ id: string }>(c, 'os.lesson_plans', { org_id: ctx.orgId, branch_id: ctx.branchId, level: src.level, staff_id: ctx.staffId, section_id: input.section_ids[0], section_ids: input.section_ids, subject_id: src.subject_id, topic_id: src.topic_id, plan_date: input.plan_date, period_count: src.period_count, period_minutes: src.period_minutes, template_id: src.template_id, content: { ...src.content, reflection: '' }, language: src.language, status: 'draft', source_plan_id: id, due_at: await planDueAt(c, ctx, input.plan_date) });
    await insert(c, 'os.lesson_plan_versions', { org_id: ctx.orgId, branch_id: ctx.branchId, plan_id: copy.id, version: 1, content: src.content, note: `reused:${id}` });
    await sys(() => c.query(`update os.lesson_plans set usage_count = usage_count + 1 where id = $1`, [id]));
    return { id: copy.id };
  });
}

// ---------------------------------------------------------------- companions & cover plans
const COMPANION_SCHEMA = { type: 'object', additionalProperties: false, required: ['title', 'instructions', 'items'], properties: { title: { type: 'string' }, instructions: { type: 'string' }, items: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['question', 'answer'], properties: { question: { type: 'string' }, answer: { type: 'string' } } } } } };
const companionZod = z.object({ title: z.string(), instructions: z.string(), items: z.array(z.object({ question: z.string(), answer: z.string() })).min(1) });

export async function companion(ctx: Ctx, planId: string, kind: string) {
  need(ctx, 'lesson_planner', 'create');
  return run(ctx, async (c, sys) => {
    const p = await maybe<PlanRow>(c, `select * from os.lesson_plans where id = $1`, [planId]);
    if (!p) throw new NotFoundError();
    const tc = p.topic_id ? await topicContext(c, p.topic_id) : null;
    const gen = await sys(() =>
      generate(c, {
        orgId: ctx.orgId,
        branchId: ctx.branchId,
        staffId: ctx.staffId,
        action: 'companion',
        tier: 'strong',
        system: planSystemPrompt(tc?.board ?? 'CBSE', p.language),
        prompt: `Create a ${kind.replace('_', ' ')} for ${tc?.subject ?? ''} (${tc?.stage ?? ''}), topic "${tc?.topic ?? ''}". Base it on these objectives: ${JSON.stringify((p.content as DailyPlan).objectives ?? [])}. Include answers.`,
        jsonSchema: COMPANION_SCHEMA,
        zod: companionZod,
        mockContext: { topic: tc?.topic, kind, language: p.language },
        linked: { type: 'lesson_plan', id: planId },
        logInput: { kind, topic: tc?.topic ?? null },
      }),
    );
    const companions = { ...((p.content.companions as Record<string, unknown>) ?? {}), [kind]: gen.output };
    await sys(() => update(c, 'os.lesson_plans', planId, { content: { ...p.content, companions } }));
    return { kind, companion: gen.output, credits: gen.credits };
  });
}

/** One-period cover plan for a substitute (system context; charged to the branch). */
export async function coverPlan(c: Tx, input: { orgId: string; branchId: string; sectionId: string; subjectId: string | null; date: string; substituteId: string }): Promise<string | null> {
  if (!input.subjectId) return null;
  const last = await maybe<{ topic_id: string | null }>(c, `select topic_id from os.class_logs where section_id = $1 and subject_id = $2 and topic_id is not null order by date desc limit 1`, [input.sectionId, input.subjectId]);
  const subj = await one<{ name: string; content_language: string }>(c, `select name, content_language from core.subjects where id = $1`, [input.subjectId]);
  const tc = last?.topic_id ? await topicContext(c, last.topic_id).catch(() => null) : null;
  try {
    const gen = await generate(c, {
      orgId: input.orgId,
      branchId: input.branchId,
      staffId: null,
      action: 'companion',
      tier: 'fast',
      system: 'You write one-period cover plans a substitute teacher can run with no preparation.',
      prompt: `Subject: ${subj.name}. Recent topic: ${tc?.topic ?? 'revision of recent work'}. Write a 40-minute self-contained revision activity with 5 questions and answers.`,
      jsonSchema: COMPANION_SCHEMA,
      zod: companionZod,
      mockContext: { topic: tc?.topic ?? subj.name, kind: 'cover_plan', language: subj.content_language === 'hi' || subj.content_language === 'te' ? subj.content_language : 'en' },
      linked: { type: 'substitution' },
      logInput: { subject: subj.name, topic: tc?.topic ?? null, kind: 'cover_plan' },
    });
    const plan = await insert<{ id: string }>(c, 'os.lesson_plans', { org_id: input.orgId, branch_id: input.branchId, level: 'cover', staff_id: input.substituteId, section_id: input.sectionId, section_ids: [input.sectionId], subject_id: input.subjectId, topic_id: last?.topic_id ?? null, plan_date: input.date, content: { cover: gen.output }, status: 'approved', confirmed_by_teacher: true, ai_generation_id: gen.generationId });
    return plan.id;
  } catch {
    // Out of credits or AI unavailable: the substitute still gets the task without a cover plan.
    return null;
  }
}

// ---------------------------------------------------------------- annual, unit and weekly plans
/** Teaching dates (one per period) for a class-subject from the timetable and calendar. */
async function periodDates(c: Tx, branchId: string, classId: string, subjectId: string, from: string, to: string): Promise<string[]> {
  const vid = await currentVersionId(c, branchId, from);
  const perDay = new Map<number, number>();
  if (vid) {
    const rows = await q<{ day: number; n: number }>(c, `select e.day, count(*)::int / greatest(1, count(distinct e.section_id))::int as n from core.timetable_entries e join core.sections se on se.id = e.section_id where e.version_id = $1 and se.programme_id = $2 and e.subject_id = $3 group by e.day`, [vid, classId, subjectId]);
    for (const r of rows) perDay.set(r.day, Math.max(1, r.n));
  }
  if (!perDay.size) {
    const cs = await maybe<{ periods_per_week: number }>(c, `select periods_per_week from core.programme_subjects where programme_id = $1 and subject_id = $2`, [classId, subjectId]);
    const ppw = cs?.periods_per_week ?? 5;
    for (let d = 1; d <= 6; d++) perDay.set(d, Math.floor(ppw / 6) + (d <= ppw % 6 ? 1 : 0));
  }
  const cal = await workCalendar(c, branchId, from, to);
  const exams = await q<{ d: string }>(c, `select generate_series(starts_on, ends_on, interval '1 day')::date::text as d from core.calendar_events where (branch_id = $1 or branch_id is null) and layer = 'exam' and deleted_at is null`, [branchId]);
  const examDays = new Set(exams.map((e) => e.d));
  const out: string[] = [];
  for (const d of eachDate(from, to)) {
    if (!isWorkingDay(d, cal) || examDays.has(d)) continue;
    for (let k = 0; k < (perDay.get(isoWeekday(d)) ?? 0); k++) out.push(d);
  }
  return out;
}

export async function generateAnnualPlan(ctx: Ctx, input: { programme_id: string; subject_id: string; curriculum_subject_id: string; use_ai: boolean }) {
  need(ctx, 'lesson_planner', 'create');
  return run(ctx, async (c, sys) => {
    const ay = await one<{ id: string; starts_on: string; ends_on: string }>(c, `select id, starts_on::text, ends_on::text from core.academic_years where branch_id = $1 and is_current`, [ctx.branchId]);
    const chapters = await q<{ id: string; name: string; est_periods: number; weight: number }>(c, `select t.id, t.name, t.est_periods, t.weight from os.curriculum_topics t join os.curriculum_units u on u.id = t.unit_id where u.subject_id = $1 and t.kind = 'chapter' and t.deleted_at is null order by u.seq, t.seq`, [input.curriculum_subject_id]);
    if (!chapters.length) throw new ValidationError('no_chapters');
    let loads = chapters.map((ch) => ({ topicId: ch.id, periods: ch.est_periods }));
    let generationId: string | null = null;
    if (input.use_ai) {
      const gen = await sys(() =>
        generate(c, {
          orgId: ctx.orgId,
          branchId: ctx.branchId,
          staffId: ctx.staffId,
          action: 'annual_plan',
          tier: 'strong',
          system: 'You plan the order and weight of chapters across a school year.',
          prompt: `Chapters with estimated periods:\n${chapters.map((ch) => `- ${ch.id}: ${ch.name} (${ch.est_periods})`).join('\n')}\nReturn the chapters in teaching order with periods each.`,
          jsonSchema: { type: 'object', additionalProperties: false, required: ['chapters'], properties: { chapters: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['topic_id', 'periods'], properties: { topic_id: { type: 'string' }, periods: { type: 'integer' } } } } } },
          zod: z.object({ chapters: z.array(z.object({ topic_id: z.string(), periods: z.number().int().min(1) })) }),
          mockContext: { remaining: chapters.map((ch) => ({ topicId: ch.id, name: ch.name, periods: ch.est_periods })), availablePeriods: 100000 },
          validate: (o) => (o.chapters.every((x) => chapters.some((ch) => ch.id === x.topic_id)) ? [] : ['unknown_topic']),
          logInput: { chapters: chapters.length },
        }).catch(() => null),
      );
      if (gen && Array.isArray((gen.output as { chapters?: unknown[] }).chapters) && (gen.output as { chapters: unknown[] }).chapters.length) {
        loads = (gen.output as { chapters: { topic_id: string; periods: number }[] }).chapters.map((x) => ({ topicId: x.topic_id, periods: x.periods }));
        generationId = gen.generationId;
      }
    }
    const dates = await periodDates(c, ctx.branchId, input.programme_id, input.subject_id, ay.starts_on, ay.ends_on);
    const { placed, compressed } = spreadChapters(loads, dates);
    const plan = await insert<{ id: string }>(c, 'os.annual_plans', { org_id: ctx.orgId, branch_id: ctx.branchId, academic_year_id: ay.id, programme_id: input.programme_id, subject_id: input.subject_id, curriculum_subject_id: input.curriculum_subject_id, staff_id: ctx.staffId, status: 'draft', ai_generation_id: generationId }, { onConflict: '(academic_year_id, programme_id, subject_id) do update set curriculum_subject_id = excluded.curriculum_subject_id, staff_id = excluded.staff_id, status = \'draft\', deleted_at = null' });
    await c.query(`delete from os.annual_plan_items where annual_plan_id = $1`, [plan.id]);
    const terms = await q<{ id: string; starts_on: string; ends_on: string }>(c, `select id, starts_on::text, ends_on::text from core.terms where academic_year_id = $1`, [ay.id]);
    for (const p of placed) await insert(c, 'os.annual_plan_items', { org_id: ctx.orgId, branch_id: ctx.branchId, annual_plan_id: plan.id, topic_id: p.topicId, seq: p.seq, planned_start: p.plannedStart, planned_end: p.plannedEnd, planned_periods: p.plannedPeriods, term_id: terms.find((t) => p.plannedStart >= t.starts_on && p.plannedStart <= t.ends_on)?.id ?? null });
    return { id: plan.id, periods_available: dates.length, compressed };
  });
}

export async function annualPlan(ctx: Ctx, classId: string, subjectId: string) {
  needModule(ctx, 'lesson_planner');
  return run(ctx, async (c) => {
    const plan = await maybe<{ id: string }>(c, `select ap.* from os.annual_plans ap join core.academic_years ay on ay.id = ap.academic_year_id and ay.is_current where ap.programme_id = $1 and ap.subject_id = $2 and ap.deleted_at is null`, [classId, subjectId]);
    if (!plan) return null;
    const items = await q(c, `select i.*, t.name as chapter from os.annual_plan_items i join os.curriculum_topics t on t.id = i.topic_id where i.annual_plan_id = $1 order by i.seq`, [plan.id]);
    return { ...plan, items };
  });
}

export async function editAnnualItem(ctx: Ctx, itemId: string, input: { planned_start: string; planned_end: string; planned_periods: number; seq?: number }) {
  need(ctx, 'lesson_planner', 'edit');
  return run(ctx, async (c) => update(c, 'os.annual_plan_items', itemId, input));
}

export async function publishAnnualPlan(ctx: Ctx, id: string) {
  need(ctx, 'lesson_planner', 'edit');
  return run(ctx, async (c) => update(c, 'os.annual_plans', id, { status: 'published' }));
}

export async function generateUnitPlan(ctx: Ctx, input: { chapter_id: string; subject_id: string; section_id: string }) {
  need(ctx, 'lesson_planner', 'create');
  return run(ctx, async (c, sys) => {
    const ch = await one<{ name: string; est_periods: number }>(c, `select name, est_periods from os.curriculum_topics where id = $1`, [input.chapter_id]);
    const topics = await q<{ id: string; name: string }>(c, `select id, name from os.curriculum_topics where parent_topic_id = $1 order by seq`, [input.chapter_id]);
    const tc = await topicContext(c, input.chapter_id);
    const gen = await sys(() =>
      generate(c, {
        orgId: ctx.orgId,
        branchId: ctx.branchId,
        staffId: ctx.staffId,
        action: 'unit_plan',
        tier: 'strong',
        system: planSystemPrompt(tc.board, tc.language),
        prompt: `Unit plan for chapter "${ch.name}" (${tc.subject}, ${tc.stage}) over ${ch.est_periods} periods. Topics: ${topics.map((t) => t.name).join('; ')}. Outcomes: ${tc.outcomes.map((o) => o.text).join('; ')}. Give objectives, a period-by-period outline and assessments.`,
        jsonSchema: { type: 'object', additionalProperties: false, required: ['objectives', 'periods', 'assessments'], properties: { objectives: { type: 'array', items: { type: 'string' } }, periods: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['period', 'focus', 'activity'], properties: { period: { type: 'integer' }, focus: { type: 'string' }, activity: { type: 'string' } } } }, assessments: { type: 'array', items: { type: 'string' } } } },
        zod: z.object({ objectives: z.array(z.string()), periods: z.array(z.object({ period: z.number(), focus: z.string(), activity: z.string() })), assessments: z.array(z.string()) }),
        mockContext: { topics: topics.map((t) => t.name), topic: ch.name },
        logInput: { chapter: ch.name, subject: tc.subject },
      }),
    );
    const plan = await insert<{ id: string }>(c, 'os.lesson_plans', { org_id: ctx.orgId, branch_id: ctx.branchId, level: 'unit', staff_id: ctx.staffId, section_id: input.section_id, section_ids: [input.section_id], subject_id: input.subject_id, topic_id: input.chapter_id, period_count: ch.est_periods, content: gen.output, status: 'draft', ai_generation_id: gen.generationId, language: tc.language });
    return { id: plan.id, credits: gen.credits };
  });
}

/** Weekly plan: the week's periods for one teacher with topics from annual plans (no AI needed). */
export async function weeklyPlan(ctx: Ctx, weekStart: string) {
  needModule(ctx, 'lesson_planner');
  return run(ctx, async (c) => {
    const vid = await currentVersionId(c, ctx.branchId, weekStart);
    if (!vid) return { week_start: weekStart, periods: [] };
    const cal = await workCalendar(c, ctx.branchId);
    const out: { date: string; period_seq: number; section_id: string; section: string; subject_id: string; subject: string; planned_topic: string | null; plan_id: string | null; plan_status: string | null }[] = [];
    for (let i = 0; i < 7; i++) {
      const d = addDays(weekStart, i);
      if (!isWorkingDay(d, cal)) continue;
      const entries = await q<{ period_seq: number; section_id: string; section: string; subject_id: string; subject: string; programme_id: string }>(
        c,
        `select e.period_seq, e.section_id, cl.name || ' ' || se.name as section, e.subject_id, sb.name as subject, se.programme_id from core.timetable_entries e join core.sections se on se.id = e.section_id join core.programmes cl on cl.id = se.programme_id join core.subjects sb on sb.id = e.subject_id
         where e.version_id = $1 and e.staff_id = $2 and e.day = $3 order by e.period_seq`,
        [vid, ctx.staffId, isoWeekday(d)],
      );
      for (const e of entries) {
        const topic = await maybe<{ name: string }>(c, `select t.name from os.annual_plan_items i join os.annual_plans ap on ap.id = i.annual_plan_id join os.curriculum_topics t on t.id = i.topic_id where ap.programme_id = $1 and ap.subject_id = $2 and $3::date between i.planned_start and i.planned_end limit 1`, [e.programme_id, e.subject_id, d]);
        const plan = await maybe<{ id: string; status: string }>(c, `select id, status from os.lesson_plans where staff_id = $1 and plan_date = $2 and $3 = any(section_ids) and subject_id = $4 and level = 'daily' and deleted_at is null limit 1`, [ctx.staffId, d, e.section_id, e.subject_id]);
        out.push({ date: d, period_seq: e.period_seq, section_id: e.section_id, section: e.section, subject_id: e.subject_id, subject: e.subject, planned_topic: topic?.name ?? null, plan_id: plan?.id ?? null, plan_status: plan?.status ?? null });
      }
    }
    return { week_start: weekStart, periods: out };
  });
}

// ---------------------------------------------------------------- coverage (6.2)
export async function coverageFor(c: Tx, branchId: string, today: string, filter: { staffId?: string; classId?: string; subjectId?: string; wingId?: string } = {}) {
  const b = await branchInfo(c, branchId);
  const atRisk = b.settings.coverage_at_risk ?? 3;
  const critical = b.settings.coverage_critical ?? 8;
  const ay = await maybe<{ ends_on: string }>(c, `select ends_on::text from core.academic_years where branch_id = $1 and is_current`, [branchId]);
  const rows = await q<{ section_id: string; section: string; programme_id: string; wing_id: string; subject_id: string; subject: string; staff_id: string; staff_name: string; annual_plan_id: string | null }>(
    c,
    `select ta.section_id, cl.name || ' ' || se.name as section, se.programme_id, cl.wing_id, ta.subject_id, sb.name as subject, ta.staff_id, s.full_name as staff_name,
       (select ap.id from os.annual_plans ap join core.academic_years ay on ay.id = ap.academic_year_id and ay.is_current where ap.programme_id = se.programme_id and ap.subject_id = ta.subject_id and ap.deleted_at is null limit 1) as annual_plan_id
     from core.teacher_allocations ta join core.sections se on se.id = ta.section_id join core.programmes cl on cl.id = se.programme_id join core.subjects sb on sb.id = ta.subject_id join core.staff s on s.id = ta.staff_id
     where ta.branch_id = $1 and ta.deleted_at is null and sb.is_core and ($2::uuid is null or ta.staff_id = $2) and ($3::uuid is null or se.programme_id = $3) and ($4::uuid is null or ta.subject_id = $4) and ($5::uuid is null or cl.wing_id = $5)
     order by cl.seq, se.name, sb.name`,
    [branchId, filter.staffId ?? null, filter.classId ?? null, filter.subjectId ?? null, filter.wingId ?? null],
  );
  const out = [];
  for (const r of rows) {
    if (!r.annual_plan_id) {
      out.push({ ...r, has_plan: false, pct_covered: null, periods_ahead: null, status: null, projected_completion: null, next_exam: null, days_late_for_exam: null });
      continue;
    }
    const items = await q<{ topic_id: string; planned_start: string; planned_end: string; planned_periods: number; name: string }>(c, `select i.topic_id, i.planned_start::text, i.planned_end::text, i.planned_periods, t.name from os.annual_plan_items i join os.curriculum_topics t on t.id = i.topic_id where i.annual_plan_id = $1 order by i.seq`, [r.annual_plan_id]);
    const total = items.reduce((s, i) => s + i.planned_periods, 0);
    let planned = 0;
    for (const i of items) {
      if (i.planned_end < today) planned += i.planned_periods;
      else if (i.planned_start <= today) {
        const span = eachDate(i.planned_start, i.planned_end).length;
        const done = eachDate(i.planned_start, today).length;
        planned += Math.round((i.planned_periods * done) / span);
      }
    }
    const actual = (await one<{ n: number }>(c, `select count(*)::int as n from os.class_logs where section_id = $1 and subject_id = $2 and deleted_at is null`, [r.section_id, r.subject_id])).n;
    const remainingDates = ay ? await periodDates(c, branchId, r.programme_id, r.subject_id, addDays(today, 1), ay.ends_on) : [];
    const cov = coverage({ plannedPeriodsToDate: planned, actualPeriodsToDate: actual, totalPlannedPeriods: total, remainingTeachingPeriods: remainingDates.length, atRiskBehind: atRisk, criticalBehind: critical });
    const projected = projectedCompletion(Math.max(0, total - actual), remainingDates);
    const exam = await maybe<{ starts_on: string }>(c, `select starts_on::text from core.calendar_events where (branch_id = $1 or branch_id is null) and layer = 'exam' and starts_on > $2 and deleted_at is null order by starts_on limit 1`, [branchId, today]);
    let daysLate: number | null = null;
    if (exam) {
      const before = remainingDates.filter((d) => d < exam.starts_on).length;
      const need = Math.max(0, planned + (items.filter((i) => i.planned_end < exam.starts_on && i.planned_end >= today).reduce((s, i) => s + i.planned_periods, 0)) - actual);
      daysLate = need > before ? new Set(remainingDates.filter((d) => d >= exam.starts_on).slice(0, need - before)).size : 0;
    }
    out.push({ ...r, has_plan: true, pct_covered: cov.pctCovered, periods_ahead: cov.periodsAhead, status: cov.status, projected_completion: projected, next_exam: exam?.starts_on ?? null, days_late_for_exam: daysLate, planned_to_date: planned, actual, total });
  }
  return out;
}

export async function coverageView(ctx: Ctx, filter: { by?: 'teacher' | 'class' | 'subject' | 'wing'; staff_id?: string; programme_id?: string; subject_id?: string; wing_id?: string; branch_id?: string }) {
  need(ctx, 'syllabus_coverage', 'view');
  return run(ctx, async (c) => {
    const own = rank(ctx, 'syllabus_coverage', 'view') <= 1;
    const branches = filter.branch_id === 'all' && rank(ctx, 'syllabus_coverage', 'view') >= 6 ? ctx.branchIds : [filter.branch_id && ctx.branchIds.includes(filter.branch_id) ? filter.branch_id : ctx.branchId];
    const all = [];
    for (const b of branches) {
      const rows = await coverageFor(c, b, localToday(ctx), { staffId: own ? ctx.staffId : filter.staff_id, classId: filter.programme_id, subjectId: filter.subject_id, wingId: filter.wing_id });
      all.push(...rows.map((r) => ({ ...r, branch_id: b })));
    }
    return all;
  });
}

/** "Recovery plan" AI action: re-spread remaining chapters across remaining periods. */
export async function recoveryPlan(ctx: Ctx, input: { section_id: string; subject_id: string }) {
  need(ctx, 'syllabus_coverage', 'view');
  return run(ctx, async (c, sys) => {
    const sec = await one<{ programme_id: string }>(c, `select programme_id from core.sections where id = $1`, [input.section_id]);
    const plan = await maybe<{ id: string }>(c, `select ap.id from os.annual_plans ap join core.academic_years ay on ay.id = ap.academic_year_id and ay.is_current where ap.programme_id = $1 and ap.subject_id = $2`, [sec.programme_id, input.subject_id]);
    if (!plan) throw new ValidationError('no_annual_plan');
    const ay = await one<{ ends_on: string }>(c, `select ends_on::text from core.academic_years where branch_id = $1 and is_current`, [ctx.branchId]);
    const today = localToday(ctx);
    const covered = new Set((await q<{ topic_id: string }>(c, `select distinct coalesce(t.parent_topic_id, t.id) as topic_id from os.class_logs l join os.curriculum_topics t on t.id = l.topic_id where l.section_id = $1 and l.subject_id = $2`, [input.section_id, input.subject_id])).map((r) => r.topic_id));
    const remaining = (await q<{ topic_id: string; name: string; planned_periods: number }>(c, `select i.topic_id, t.name, i.planned_periods from os.annual_plan_items i join os.curriculum_topics t on t.id = i.topic_id where i.annual_plan_id = $1 order by i.seq`, [plan.id])).filter((r) => !covered.has(r.topic_id));
    const dates = await periodDates(c, ctx.branchId, sec.programme_id, input.subject_id, addDays(today, 1), ay.ends_on);
    const deterministic = spreadChapters(remaining.map((r) => ({ topicId: r.topic_id, periods: r.planned_periods })), dates);
    const gen = await sys(() =>
      generate(c, {
        orgId: ctx.orgId,
        branchId: ctx.branchId,
        staffId: ctx.staffId,
        action: 'recovery_plan',
        tier: 'strong',
        system: 'You help teachers recover syllabus coverage. Say plainly what must be compressed and how.',
        prompt: `Remaining chapters (periods planned): ${remaining.map((r) => `${r.topic_id}: ${r.name} (${r.planned_periods})`).join('; ')}. Periods available until year end: ${dates.length}. Suggest periods per chapter and how to compress.`,
        jsonSchema: { type: 'object', additionalProperties: false, required: ['summary', 'chapters'], properties: { summary: { type: 'string' }, chapters: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['topic_id', 'periods', 'compress'], properties: { topic_id: { type: 'string' }, periods: { type: 'integer' }, compress: { type: 'string' } } } } } },
        zod: z.object({ summary: z.string(), chapters: z.array(z.object({ topic_id: z.string(), periods: z.number().int(), compress: z.string() })) }),
        mockContext: { remaining: remaining.map((r) => ({ topicId: r.topic_id, name: r.name, periods: r.planned_periods })), availablePeriods: dates.length },
        logInput: { remaining: remaining.length, available: dates.length },
      }),
    );
    return { ...gen.output as object, schedule: deterministic.placed, compressed: deterministic.compressed, available_periods: dates.length, credits: gen.credits };
  });
}

/** Daily alert sweep: notify teacher, HOD and coordinator when a class moves to at risk. */
export async function coverageAlertSweep(c: Tx, branchId: string, today: string): Promise<number> {
  const rows = await coverageFor(c, branchId, today);
  let n = 0;
  const b = await branchInfo(c, branchId);
  for (const r of rows) {
    if (r.status !== 'at_risk' && r.status !== 'critical') continue;
    const hod = await maybe<{ head_staff_id: string | null }>(c, `select d.head_staff_id from core.subjects s join core.departments d on d.id = s.department_id where s.id = $1`, [r.subject_id]);
    const coords = await staffWithRole(c, b.org_id, 'academic_coordinator', branchId);
    await notify(c, { orgId: b.org_id, branchId, staffIds: [r.staff_id, hod?.head_staff_id, ...coords], event: 'coverage.at_risk', titleKey: `notif.coverage.${r.status}`, vars: { section: r.section, subject: r.subject, behind: Math.abs(r.periods_ahead ?? 0) }, link: '/os/coverage', dedupeKey: `cov:${r.section_id}:${r.subject_id}:${r.status}:${today.slice(0, 7)}` });
    n++;
  }
  return n;
}

// ---------------------------------------------------------------- class log (6.3)
export async function logClass(ctx: Ctx, input: { section_id: string; subject_id: string; date: string; period_seq: number; topic_id?: string | null; lesson_plan_id?: string | null; taught_as_planned: boolean; topic_text?: string | null; classwork?: string | null; remarks?: string | null; homework?: { description: string; due_on: string; est_minutes: number } | null; client_id?: string }) {
  need(ctx, 'class_log', 'create');
  return run(ctx, async (c, sys) => {
    const ex = await maybe<{ id: string; client_id: string | null }>(c, `select id, client_id from os.class_logs where section_id = $1 and date = $2 and period_seq = $3`, [input.section_id, input.date, input.period_seq]);
    if (ex && input.client_id && ex.client_id === input.client_id) return { id: ex.id, status: 'duplicate' };
    const sec = await one<{ branch_id: string }>(c, `select branch_id from core.sections where id = $1`, [input.section_id]);
    let topicText = input.topic_text ?? null;
    let topicId = input.topic_id ?? null;
    if (input.taught_as_planned && input.lesson_plan_id) {
      const plan = await maybe<{ topic_id: string | null; topic: string | null }>(c, `select lp.topic_id, t.name as topic from os.lesson_plans lp left join os.curriculum_topics t on t.id = lp.topic_id where lp.id = $1`, [input.lesson_plan_id]);
      topicId = topicId ?? plan?.topic_id ?? null;
      topicText = topicText ?? plan?.topic ?? null;
    }
    const row = { org_id: ctx.orgId, branch_id: sec.branch_id, section_id: input.section_id, subject_id: input.subject_id, staff_id: ctx.staffId, date: input.date, period_seq: input.period_seq, topic_id: topicId, lesson_plan_id: input.lesson_plan_id ?? null, taught_as_planned: input.taught_as_planned, topic_text: topicText, classwork: input.classwork ?? null, remarks: input.remarks ?? null, client_id: input.client_id ?? null };
    const log = ex ? await sys(() => update<{ id: string }>(c, 'os.class_logs', ex.id, row)) : await insert<{ id: string }>(c, 'os.class_logs', row);
    if (input.homework) await insert(c, 'homework', { org_id: ctx.orgId, branch_id: sec.branch_id, class_log_id: log.id, section_id: input.section_id, subject_id: input.subject_id, staff_id: ctx.staffId, assigned_on: input.date, due_on: input.homework.due_on, description: input.homework.description, est_minutes: input.homework.est_minutes });
    if (input.lesson_plan_id) await sys(() => c.query(`update os.lesson_plans set status = 'delivered', delivered_at = coalesce(delivered_at, now()) where id = $1 and status = 'approved'`, [input.lesson_plan_id]));
    return { id: log.id };
  });
}

export async function sectionLog(ctx: Ctx, sectionId: string, from: string, to: string) {
  needModule(ctx, 'class_log');
  return run(ctx, async (c) => ({
    logs: await q(c, `select l.*, s.full_name as teacher, sb.name as subject from os.class_logs l join core.staff s on s.id = l.staff_id join core.subjects sb on sb.id = l.subject_id where l.section_id = $1 and l.date between $2 and $3 and l.deleted_at is null order by l.date desc, l.period_seq`, [sectionId, from, to]),
    homework: await q(c, `select h.*, sb.name as subject from public.homework h join core.subjects sb on sb.id = h.subject_id where h.section_id = $1 and h.due_on between $2 and $3 and h.deleted_at is null order by h.due_on`, [sectionId, from, to]),
  }));
}

/** Homework load view per section per day with the wing's daily limit. */
export async function homeworkLoadView(ctx: Ctx, from: string, to: string) {
  needModule(ctx, 'class_log');
  return run(ctx, async (c) => {
    const rows = await q<{ section_id: string; section: string; due_on: string; est_minutes: number; limit_minutes: number }>(
      c,
      `select h.section_id, cl.name || ' ' || se.name as section, h.due_on::text, h.est_minutes, w.homework_limit_minutes as limit_minutes from public.homework h join core.sections se on se.id = h.section_id join core.programmes cl on cl.id = se.programme_id join core.wings w on w.id = cl.wing_id
       where h.branch_id = $1 and h.due_on between $2 and $3 and h.deleted_at is null`,
      [ctx.branchId, from, to],
    );
    const names = new Map(rows.map((r) => [r.section_id, { section: r.section, limit: r.limit_minutes }]));
    const bySection = new Map<string, { sectionId: string; dueOn: string; estMinutes: number }[]>();
    for (const r of rows) bySection.set(r.section_id, [...(bySection.get(r.section_id) ?? []), { sectionId: r.section_id, dueOn: r.due_on, estMinutes: r.est_minutes }]);
    const out = [];
    for (const [sid, items] of bySection) out.push(...homeworkLoad(items, names.get(sid)!.limit).map((x) => ({ ...x, section: names.get(sid)!.section, limit: names.get(sid)!.limit })));
    return out;
  });
}

export async function addNotebookCheck(ctx: Ctx, input: { section_id: string; subject_id: string; staff_id: string; kind: 'cycle' | 'spot_check'; checked_on: string; rubric: Record<string, number>; notes?: string }) {
  need(ctx, 'class_log', input.kind === 'spot_check' ? 'verify' : 'create');
  return run(ctx, async (c, sys) => {
    const vals = Object.values(input.rubric);
    const sec = await one<{ branch_id: string }>(c, `select branch_id from core.sections where id = $1`, [input.section_id]);
    return sys(() => insert(c, 'os.notebook_checks', { org_id: ctx.orgId, branch_id: sec.branch_id, ...input, checked_by: ctx.staffId, score: vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null }));
  });
}

export async function notebookChecks(ctx: Ctx, sectionId?: string) {
  needModule(ctx, 'class_log');
  return run(ctx, async (c) => q(c, `select n.*, s.full_name as teacher, cb.full_name as checked_by_name, sb.name as subject, cl.name || ' ' || se.name as section from os.notebook_checks n join core.staff s on s.id = n.staff_id left join core.staff cb on cb.id = n.checked_by join core.subjects sb on sb.id = n.subject_id join core.sections se on se.id = n.section_id join core.programmes cl on cl.id = se.programme_id where n.branch_id = $1 and ($2::uuid is null or n.section_id = $2) order by n.checked_on desc limit 200`, [ctx.branchId, sectionId ?? null]));
}

/** Missing logs at day close create a reminder; repeated misses go to the coordinator. */
export async function missingLogSweep(c: Tx, branchId: string, day: string): Promise<number> {
  const vid = await currentVersionId(c, branchId, day);
  if (!vid) return 0;
  const b = await branchInfo(c, branchId);
  const missing = await q<{ staff_id: string; n: number }>(
    c,
    `select e.staff_id, count(*)::int as n from core.timetable_entries e where e.version_id = $1 and e.day = $2 and e.staff_id is not null
       and not exists (select 1 from os.class_logs l where l.section_id = e.section_id and l.date = $3 and l.period_seq = e.period_seq)
       and not exists (select 1 from core.leave_requests lr where lr.staff_id = e.staff_id and lr.status = 'approved' and $3::date between lr.start_date and lr.end_date)
     group by e.staff_id`,
    [vid, isoWeekday(day), day],
  );
  for (const m of missing) {
    await notify(c, { orgId: b.org_id, branchId, staffIds: [m.staff_id], event: 'task.reminder', titleKey: 'notif.classLog.missing', vars: { count: m.n }, link: '/os/class-log', dedupeKey: `logmiss:${day}` });
  }
  // Repeated misses (3+ days in the last 7) go to the coordinator.
  const repeat = await q<{ staff_id: string; full_name: string }>(
    c,
    `select s.id as staff_id, s.full_name from core.staff s where s.branch_id = $1 and s.is_teaching and
       (select count(*) from core.notifications n where n.staff_id = s.id and n.event_key = 'task.reminder' and n.dedupe_key like 'logmiss:%' and n.created_at > now() - interval '7 days') >= 3`,
    [branchId],
  );
  if (repeat.length) {
    const coords = await staffWithRole(c, b.org_id, 'academic_coordinator', branchId);
    await notify(c, { orgId: b.org_id, branchId, staffIds: coords, event: 'task.escalation', titleKey: 'notif.classLog.repeated', vars: { names: repeat.map((r) => r.full_name).join(', ') }, link: '/os/class-log', dedupeKey: `logrep:${day}` });
  }
  return missing.length;
}

/** Plan deadlines from school rules create system tasks (weekly plans due Friday 4 pm). */
export async function planDeadlineSweep(c: Tx, branchId: string, today: string): Promise<number> {
  const b = await branchInfo(c, branchId);
  const rule = await maybe<{ due_weekday: number; due_time: string }>(c, `select due_weekday, due_time::text from os.plan_submission_rules where org_id = $1 and level = 'weekly' and active and deleted_at is null limit 1`, [b.org_id]);
  if (!rule || isoWeekday(today) !== 1) return 0;
  const due = addDays(today, rule.due_weekday - 1);
  const teachers = await q<{ id: string }>(c, `select distinct ta.staff_id as id from core.teacher_allocations ta join core.staff s on s.id = ta.staff_id where ta.branch_id = $1 and s.status = 'active' and ta.deleted_at is null`, [branchId]);
  const { fromLocal } = await import('@autoed/shared');
  let n = 0;
  for (const t of teachers) {
    const id = await systemTask(c, { orgId: b.org_id, branchId, ownerId: t.id, title: `Submit lesson plans for the week of ${addDays(today, 7)}`, systemKey: `plan:${t.id}:week:${today}`, dueAt: fromLocal(due, rule.due_time.slice(0, 5), b.timezone).toISOString(), categoryKey: 'academic' });
    if (id) n++;
  }
  return n;
}

/** Lesson plan compliance: submitted on time, late, missing, returned; review turnaround. */
export async function planCompliance(c: Tx, branchId: string, from: string, to: string) {
  return q(
    c,
    `select s.id as staff_id, s.full_name, w.name as wing,
       count(lp.id) filter (where lp.submitted_at is not null and (lp.due_at is null or lp.submitted_at <= lp.due_at))::int as on_time,
       count(lp.id) filter (where lp.submitted_at > lp.due_at)::int as late,
       count(lp.id) filter (where lp.submitted_at is null and lp.due_at < now())::int as missing,
       count(lp.id) filter (where exists (select 1 from os.lesson_plan_reviews r where r.plan_id = lp.id and r.action = 'return'))::int as returned,
       round(avg(extract(epoch from (lp.approved_at - lp.submitted_at)) / 3600) filter (where lp.approved_at is not null)::numeric, 1) as review_hours
     from core.staff s left join core.wings w on w.id = s.wing_id
     left join os.lesson_plans lp on lp.staff_id = s.id and lp.level = 'daily' and lp.plan_date between $2 and $3 and lp.deleted_at is null
     where s.branch_id = $1 and s.is_teaching and s.deleted_at is null group by s.id, s.full_name, w.name order by missing desc, late desc, s.full_name`,
    [branchId, from, to],
  );
}

export { now };
