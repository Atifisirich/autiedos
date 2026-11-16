/**
 * Academic rules: syllabus coverage, annual plan spreading, recovery plans, homework load,
 * appraisal scoring.
 */
import type { ISODate } from '../time';

// ---------------------------------------------------------------- coverage (6.2)
export type CoverageStatus = 'on_track' | 'at_risk' | 'critical';

export interface CoverageInput {
  plannedPeriodsToDate: number;
  actualPeriodsToDate: number;
  totalPlannedPeriods: number;
  remainingTeachingPeriods: number;
  atRiskBehind: number;
  criticalBehind: number;
}

export interface CoverageResult {
  pctCovered: number;
  periodsAhead: number;
  status: CoverageStatus;
  projectedFinishWithinYear: boolean;
  periodsShort: number;
}

export function coverage(i: CoverageInput): CoverageResult {
  const pctCovered = i.totalPlannedPeriods > 0 ? Math.round((Math.min(i.actualPeriodsToDate, i.totalPlannedPeriods) / i.totalPlannedPeriods) * 1000) / 10 : 0;
  const periodsAhead = i.actualPeriodsToDate - i.plannedPeriodsToDate;
  const behind = -periodsAhead;
  const status: CoverageStatus = behind > i.criticalBehind ? 'critical' : behind > i.atRiskBehind ? 'at_risk' : 'on_track';
  const remainingWork = Math.max(0, i.totalPlannedPeriods - i.actualPeriodsToDate);
  const periodsShort = Math.max(0, remainingWork - i.remainingTeachingPeriods);
  return { pctCovered, periodsAhead, status, projectedFinishWithinYear: periodsShort === 0, periodsShort };
}

/**
 * Projected completion: walks the list of remaining teaching dates (one entry per period)
 * and returns the date the last remaining period falls on, or null if it does not fit.
 */
export function projectedCompletion(remainingWork: number, teachingPeriodDates: ISODate[]): ISODate | null {
  if (remainingWork <= 0) return teachingPeriodDates[0] ?? null;
  return teachingPeriodDates[remainingWork - 1] ?? null;
}

/** Working days late against an exam date: positive = misses by N teaching days. */
export function daysLateForExam(projected: ISODate | null, examDate: ISODate, workingDatesAfterExam: ISODate[], remainingAfter: number): number {
  if (projected && projected <= examDate) return 0;
  return projected ? workingDatesAfterExam.filter((d) => d <= projected).length : remainingAfter;
}

// ---------------------------------------------------------------- annual plan spreading
export interface ChapterLoad {
  topicId: string;
  periods: number;
}

export interface PlacedChapter {
  topicId: string;
  seq: number;
  plannedStart: ISODate;
  plannedEnd: ISODate;
  plannedPeriods: number;
}

/**
 * Places chapters in order over the available teaching period dates (one date per period).
 * When the chapters need more periods than are available, every chapter is compressed
 * proportionally (minimum 1 period) and `compressed` lists what was cut.
 */
export function spreadChapters(chapters: ChapterLoad[], periodDates: ISODate[]): { placed: PlacedChapter[]; compressed: { topicId: string; from: number; to: number }[] } {
  const need = chapters.reduce((s, c) => s + c.periods, 0);
  const avail = periodDates.length;
  const compressed: { topicId: string; from: number; to: number }[] = [];
  let loads = chapters.map((c) => c.periods);
  if (need > avail && avail > 0) {
    const ratio = avail / need;
    loads = chapters.map((c) => Math.max(1, Math.floor(c.periods * ratio)));
    // distribute leftover periods to the largest chapters
    let left = avail - loads.reduce((s, x) => s + x, 0);
    const order = chapters.map((c, i) => ({ i, p: c.periods })).sort((a, b) => b.p - a.p);
    for (let k = 0; left > 0 && order.length; k++, left--) loads[order[k % order.length]!.i]! += 1;
    // if minimum-1 rule overshot, trim from largest
    let over = loads.reduce((s, x) => s + x, 0) - avail;
    for (let k = 0; over > 0 && k < 10000; k++) {
      const j = loads.indexOf(Math.max(...loads));
      if (loads[j]! <= 1) break;
      loads[j]! -= 1;
      over--;
    }
    chapters.forEach((c, i) => {
      if (loads[i]! < c.periods) compressed.push({ topicId: c.topicId, from: c.periods, to: loads[i]! });
    });
  }
  const placed: PlacedChapter[] = [];
  let cursor = 0;
  chapters.forEach((c, i) => {
    const n = loads[i]!;
    if (n <= 0 || cursor >= avail) return;
    const startIdx = cursor;
    const endIdx = Math.min(avail - 1, cursor + n - 1);
    placed.push({ topicId: c.topicId, seq: i + 1, plannedStart: periodDates[startIdx]!, plannedEnd: periodDates[endIdx]!, plannedPeriods: endIdx - startIdx + 1 });
    cursor = endIdx + 1;
  });
  return { placed, compressed };
}

// ---------------------------------------------------------------- homework load (6.3)
export function homeworkLoad(items: { sectionId: string; dueOn: ISODate; estMinutes: number }[], limitMinutes: number): { sectionId: string; date: ISODate; minutes: number; over: boolean }[] {
  const m = new Map<string, number>();
  for (const h of items) {
    const k = `${h.sectionId}|${h.dueOn}`;
    m.set(k, (m.get(k) ?? 0) + h.estMinutes);
  }
  return [...m.entries()]
    .map(([k, minutes]) => {
      const [sectionId, date] = k.split('|') as [string, string];
      return { sectionId, date, minutes, over: minutes > limitMinutes };
    })
    .sort((a, b) => a.date.localeCompare(b.date) || a.sectionId.localeCompare(b.sectionId));
}

// ---------------------------------------------------------------- appraisal (6.5)
export const APPRAISAL_COMPONENTS = [
  'observation',
  'task_on_time',
  'plan_timeliness',
  'syllabus_coverage',
  'class_log_compliance',
  'punctuality',
  'training_hours',
  'self_appraisal',
  'manager_rating',
] as const;
export type AppraisalComponent = (typeof APPRAISAL_COMPONENTS)[number];

/**
 * Weighted score out of 100. Component values are percentages (0..100). Missing components
 * are excluded and the remaining weights are re-normalised.
 */
export function appraisalScore(weights: Partial<Record<AppraisalComponent, number>>, values: Partial<Record<AppraisalComponent, number | null>>): { total: number; usedWeight: number; breakdown: Record<string, number> } {
  let sumW = 0;
  let sum = 0;
  const breakdown: Record<string, number> = {};
  for (const k of APPRAISAL_COMPONENTS) {
    const w = weights[k] ?? 0;
    const v = values[k];
    if (w <= 0 || v == null || Number.isNaN(v)) continue;
    const clamped = Math.max(0, Math.min(100, v));
    sumW += w;
    sum += w * clamped;
    breakdown[k] = clamped;
  }
  return { total: sumW > 0 ? Math.round((sum / sumW) * 10) / 10 : 0, usedWeight: sumW, breakdown };
}

/** Observation score as a percentage of the rubric scale, weighted by domain. */
export function observationPct(domains: { key: string; weight: number; indicators: { key: string }[] }[], scores: Record<string, number>, scale: { min: number; max: number }): number | null {
  let wSum = 0;
  let acc = 0;
  for (const d of domains) {
    const vals = d.indicators.map((i) => scores[`${d.key}.${i.key}`]).filter((v): v is number => typeof v === 'number');
    if (!vals.length) continue;
    const avg = vals.reduce((s, v) => s + v, 0) / vals.length;
    const pct = ((avg - scale.min) / (scale.max - scale.min)) * 100;
    acc += pct * d.weight;
    wSum += d.weight;
  }
  return wSum ? Math.round((acc / wSum) * 10) / 10 : null;
}
