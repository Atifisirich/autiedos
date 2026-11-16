/**
 * Daily lesson plan structure (PRD 6.1 Content of a daily plan) and validation used by the
 * generation pipeline (step 3): timings sum to the period length, every objective maps to an
 * outcome, all mandatory template sections are filled.
 */
import { z } from 'zod';

export const BLOOM_LEVELS = ['remember', 'understand', 'apply', 'analyse', 'evaluate', 'create'] as const;
export const FLOW_PHASES = ['opening', 'teaching', 'guided_practice', 'independent_practice', 'closure'] as const;
export const TEACHING_MODELS = ['5E', 'gradual_release', 'experiential', 'inquiry', 'direct', 'flipped', 'school'] as const;
export type TeachingModel = (typeof TEACHING_MODELS)[number];

export const dailyPlanSchema = z.object({
  objectives: z
    .array(z.object({ text: z.string().min(3), bloom: z.enum(BLOOM_LEVELS), outcome_codes: z.array(z.string()).default([]) }))
    .min(1),
  board_elements: z
    .object({
      competencies: z.array(z.string()).default([]),
      nep_elements: z.array(z.string()).default([]),
      key_vocabulary: z.array(z.string()).default([]),
      success_criteria: z.array(z.string()).default([]),
      assessment_objectives: z.array(z.string()).default([]),
    })
    .default({}),
  prior_knowledge: z.array(z.string()).default([]),
  materials: z.array(z.string()).default([]),
  flow: z
    .array(
      z.object({
        phase: z.enum(FLOW_PHASES),
        minutes: z.number().int().min(1),
        teacher_activity: z.string(),
        student_activity: z.string(),
      }),
    )
    .min(1),
  differentiation: z.object({ support: z.string(), core: z.string(), extension: z.string() }),
  questions: z.array(z.object({ text: z.string(), level: z.enum(['lower', 'higher']), competency: z.boolean().default(false) })).default([]),
  exit_ticket: z.array(z.object({ question: z.string(), answer: z.string() })).default([]),
  homework: z.object({ description: z.string(), minutes: z.number().int().min(0) }).nullable().default(null),
  links: z.array(z.string()).default([]),
  board_work: z.string().default(''),
  bilingual_notes: z.string().optional(),
  reflection: z.string().default(''),
});
export type DailyPlan = z.infer<typeof dailyPlanSchema>;

/** Template sections map to plan keys. */
export const PLAN_SECTION_KEYS = [
  'objectives',
  'board_elements',
  'prior_knowledge',
  'materials',
  'flow',
  'differentiation',
  'questions',
  'exit_ticket',
  'homework',
  'links',
  'board_work',
  'reflection',
] as const;
export type PlanSectionKey = (typeof PLAN_SECTION_KEYS)[number];

export interface TemplateSection {
  key: PlanSectionKey;
  name: string;
  mandatory: boolean;
  seq: number;
}

export type PlanIssue =
  | { code: 'timing_mismatch'; expected: number; actual: number }
  | { code: 'objective_unmapped'; index: number }
  | { code: 'unknown_outcome'; index: number; outcome: string }
  | { code: 'mandatory_missing'; section: PlanSectionKey };

function isFilled(plan: DailyPlan, key: PlanSectionKey): boolean {
  const v = plan[key];
  if (v == null) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'string') return v.trim().length > 0;
  if (key === 'board_elements') return Object.values(v as Record<string, string[]>).some((a) => a.length > 0);
  if (key === 'differentiation') {
    const d = v as DailyPlan['differentiation'];
    return !!(d.support && d.core && d.extension);
  }
  return true;
}

export function validatePlan(
  plan: DailyPlan,
  opts: { periodMinutes: number; periodCount: number; outcomeCodes: string[]; sections: TemplateSection[]; skipReflection?: boolean },
): PlanIssue[] {
  const issues: PlanIssue[] = [];
  const expected = opts.periodMinutes * opts.periodCount;
  const actual = plan.flow.reduce((s, f) => s + f.minutes, 0);
  if (actual !== expected) issues.push({ code: 'timing_mismatch', expected, actual });
  plan.objectives.forEach((o, index) => {
    if (!o.outcome_codes.length) issues.push({ code: 'objective_unmapped', index });
    for (const c of o.outcome_codes) if (opts.outcomeCodes.length && !opts.outcomeCodes.includes(c)) issues.push({ code: 'unknown_outcome', index, outcome: c });
  });
  for (const s of opts.sections) {
    if (!s.mandatory) continue;
    if (s.key === 'reflection' && opts.skipReflection !== false) continue; // filled after class
    if (!isFilled(plan, s.key)) issues.push({ code: 'mandatory_missing', section: s.key });
  }
  return issues;
}

/** Repairs small timing drift by adjusting the longest phase so the flow sums exactly. */
export function fixTimings(plan: DailyPlan, totalMinutes: number): DailyPlan {
  const actual = plan.flow.reduce((s, f) => s + f.minutes, 0);
  const diff = totalMinutes - actual;
  if (diff === 0 || !plan.flow.length) return plan;
  const flow = plan.flow.map((f) => ({ ...f }));
  const idx = flow.reduce((best, f, i) => (f.minutes > flow[best]!.minutes ? i : best), 0);
  flow[idx]!.minutes = Math.max(1, flow[idx]!.minutes + diff);
  return { ...plan, flow };
}

/** Proportionally rescales the flow to a new total (the "shorten to N minutes" action). */
export function rescaleFlow(plan: DailyPlan, totalMinutes: number): DailyPlan {
  const actual = plan.flow.reduce((s, f) => s + f.minutes, 0) || 1;
  const flow = plan.flow.map((f) => ({ ...f, minutes: Math.max(1, Math.floor((f.minutes * totalMinutes) / actual)) }));
  return fixTimings({ ...plan, flow }, totalMinutes);
}

export const DEFAULT_TEMPLATE_SECTIONS: TemplateSection[] = [
  { key: 'objectives', name: 'Learning objectives', mandatory: true, seq: 1 },
  { key: 'board_elements', name: 'Board elements', mandatory: false, seq: 2 },
  { key: 'prior_knowledge', name: 'Prior knowledge check', mandatory: true, seq: 3 },
  { key: 'materials', name: 'Teaching aids and materials', mandatory: true, seq: 4 },
  { key: 'flow', name: 'Lesson flow', mandatory: true, seq: 5 },
  { key: 'differentiation', name: 'Differentiation', mandatory: true, seq: 6 },
  { key: 'questions', name: 'Questions to ask', mandatory: true, seq: 7 },
  { key: 'exit_ticket', name: 'Exit ticket', mandatory: true, seq: 8 },
  { key: 'homework', name: 'Homework', mandatory: false, seq: 9 },
  { key: 'links', name: 'Cross-curricular and real-life links', mandatory: false, seq: 10 },
  { key: 'board_work', name: 'Board-work summary', mandatory: false, seq: 11 },
  { key: 'reflection', name: 'Teacher reflection', mandatory: true, seq: 12 },
];

/** Lesson plan workflow (PRD 6.1 Workflow). */
export const PLAN_TRANSITIONS: Record<string, string[]> = {
  draft: ['submitted'],
  submitted: ['in_review', 'approved', 'returned'],
  in_review: ['approved', 'returned', 'in_review'],
  returned: ['submitted'],
  approved: ['delivered'],
  delivered: ['reflected'],
  reflected: [],
};

export function canMovePlan(from: string, to: string): boolean {
  return (PLAN_TRANSITIONS[from] ?? []).includes(to);
}
