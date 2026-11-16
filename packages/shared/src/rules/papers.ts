/**
 * Question paper blueprint engine (PRD 6.4). A paper is first laid out as slots that satisfy
 * the blueprint exactly (types, counts, marks, chapter marks, difficulty mix); content is then
 * filled from the question bank or AI. `checkPaper` verifies a finished paper.
 */
export interface BlueprintSection {
  name: string;
  questionType: string;
  count: number;
  marksEach: number;
}

export interface Blueprint {
  totalMarks: number;
  sections: BlueprintSection[];
  /** topicId -> marks */
  chapterWeightage: Record<string, number>;
  /** percentages of marks */
  difficulty: { easy: number; medium: number; hard: number };
}

export type Difficulty = 'easy' | 'medium' | 'hard';

export interface PaperSlot {
  no: number;
  section: string;
  questionType: string;
  marks: number;
  topicId: string;
  difficulty: Difficulty;
}

export type BlueprintError =
  | 'sections_total_mismatch'
  | 'weightage_total_mismatch'
  | 'difficulty_not_100'
  | 'weightage_unsatisfiable'
  | 'difficulty_unsatisfiable';

export function blueprintTotal(sections: BlueprintSection[]): number {
  return sections.reduce((s, x) => s + x.count * x.marksEach, 0);
}

export function validateBlueprint(bp: Blueprint): BlueprintError[] {
  const errs: BlueprintError[] = [];
  if (blueprintTotal(bp.sections) !== bp.totalMarks) errs.push('sections_total_mismatch');
  const w = Object.values(bp.chapterWeightage).reduce((s, x) => s + x, 0);
  if (Object.keys(bp.chapterWeightage).length && w !== bp.totalMarks) errs.push('weightage_total_mismatch');
  if (bp.difficulty.easy + bp.difficulty.medium + bp.difficulty.hard !== 100) errs.push('difficulty_not_100');
  return errs;
}

/** Assign each question (by marks) to a topic so topic marks match exactly. Backtracking search. */
function assignTopics(marks: number[], targets: [string, number][]): string[] | null {
  const order = marks.map((m, i) => ({ m, i })).sort((a, b) => b.m - a.m);
  const remaining = targets.map(([, v]) => v);
  const result: string[] = new Array(marks.length);
  let steps = 0;
  const dfs = (k: number): boolean => {
    if (++steps > 200000) return false;
    if (k === order.length) return remaining.every((r) => r === 0);
    const { m, i } = order[k]!;
    const tried = new Set<number>();
    // prefer topics with most remaining marks
    const idx = remaining.map((r, j) => ({ r, j })).sort((a, b) => b.r - a.r);
    for (const { r, j } of idx) {
      if (r < m || tried.has(r)) continue;
      tried.add(r);
      remaining[j] = r - m;
      result[i] = targets[j]![0];
      if (dfs(k + 1)) return true;
      remaining[j] = r;
    }
    return false;
  };
  return dfs(0) ? result : null;
}

/** Choose difficulty per question so marks per level match the target as closely as exact sums allow. */
function assignDifficulty(marks: number[], total: number, mix: Blueprint['difficulty']): Difficulty[] | null {
  const target = { easy: Math.round((total * mix.easy) / 100), hard: Math.round((total * mix.hard) / 100) };
  const out: Difficulty[] = new Array(marks.length).fill('medium');
  const order = marks.map((m, i) => ({ m, i })).sort((a, b) => b.m - a.m);
  // subset-sum DP to pick exactly target.easy marks, then target.hard from the rest
  const pick = (avail: { m: number; i: number }[], goal: number): number[] | null => {
    if (goal === 0) return [];
    const reach = new Map<number, number[]>([[0, []]]);
    for (const q of avail) {
      for (const [sum, items] of [...reach.entries()]) {
        const n = sum + q.m;
        if (n <= goal && !reach.has(n)) reach.set(n, [...items, q.i]);
      }
      if (reach.has(goal)) return reach.get(goal)!;
    }
    return reach.get(goal) ?? null;
  };
  const easy = pick(order, target.easy);
  if (!easy) return null;
  const rest = order.filter((q) => !easy.includes(q.i));
  const hard = pick(rest, target.hard);
  if (!hard) return null;
  easy.forEach((i) => (out[i] = 'easy'));
  hard.forEach((i) => (out[i] = 'hard'));
  return out;
}

export function planPaperSlots(bp: Blueprint): { slots: PaperSlot[]; errors: BlueprintError[] } {
  const errors = validateBlueprint(bp);
  if (errors.length) return { slots: [], errors };
  const flat: { section: string; questionType: string; marks: number }[] = [];
  for (const s of bp.sections) for (let k = 0; k < s.count; k++) flat.push({ section: s.name, questionType: s.questionType, marks: s.marksEach });
  const marks = flat.map((f) => f.marks);
  const targets = Object.entries(bp.chapterWeightage);
  const topics = targets.length ? assignTopics(marks, targets) : flat.map(() => '');
  if (!topics) return { slots: [], errors: ['weightage_unsatisfiable'] };
  const diff = assignDifficulty(marks, bp.totalMarks, bp.difficulty);
  if (!diff) return { slots: [], errors: ['difficulty_unsatisfiable'] };
  return {
    slots: flat.map((f, i) => ({ no: i + 1, section: f.section, questionType: f.questionType, marks: f.marks, topicId: topics[i]!, difficulty: diff[i]! })),
    errors: [],
  };
}

export interface PaperQuestion {
  no: number;
  section: string;
  questionType: string;
  marks: number;
  topicId: string;
  difficulty: Difficulty;
}

export interface PaperCheck {
  ok: boolean;
  totalMarks: number;
  problems: string[];
}

/** Verifies a paper against its blueprint: total, per-section type/count/marks, chapter marks, difficulty marks. */
export function checkPaper(questions: PaperQuestion[], bp: Blueprint): PaperCheck {
  const problems: string[] = [];
  const total = questions.reduce((s, q) => s + q.marks, 0);
  if (total !== bp.totalMarks) problems.push(`total ${total} != ${bp.totalMarks}`);
  for (const s of bp.sections) {
    const qs = questions.filter((q) => q.section === s.name);
    if (qs.length !== s.count) problems.push(`section ${s.name}: ${qs.length} questions != ${s.count}`);
    for (const q of qs) {
      if (q.questionType !== s.questionType) problems.push(`Q${q.no}: type ${q.questionType} != ${s.questionType}`);
      if (q.marks !== s.marksEach) problems.push(`Q${q.no}: marks ${q.marks} != ${s.marksEach}`);
    }
  }
  for (const [topic, m] of Object.entries(bp.chapterWeightage)) {
    const got = questions.filter((q) => q.topicId === topic).reduce((s, q) => s + q.marks, 0);
    if (got !== m) problems.push(`chapter ${topic}: ${got} marks != ${m}`);
  }
  for (const lvl of ['easy', 'hard'] as const) {
    const target = Math.round((bp.totalMarks * bp.difficulty[lvl]) / 100);
    const got = questions.filter((q) => q.difficulty === lvl).reduce((s, q) => s + q.marks, 0);
    if (got !== target) problems.push(`${lvl}: ${got} marks != ${target}`);
  }
  return { ok: problems.length === 0, totalMarks: total, problems };
}

/** Blueprint table: one row per question with chapter, type, level and marks. */
export function blueprintTable(questions: PaperQuestion[], topicNames: Record<string, string>) {
  return questions.map((q) => ({ no: q.no, section: q.section, chapter: topicNames[q.topicId] ?? q.topicId, type: q.questionType, level: q.difficulty, marks: q.marks }));
}

/** Watermark text for downloads: user name and time. */
export function paperWatermark(name: string, at: Date): string {
  return `${name} · ${at.toISOString().replace('T', ' ').slice(0, 16)} UTC · CONFIDENTIAL`;
}
