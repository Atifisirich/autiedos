/**
 * AI credit metering (PRD 8.5).
 */
export const AI_ACTIONS = [
  'daily_plan',
  'section_rewrite',
  'companion',
  'unit_plan',
  'annual_plan',
  'question_paper',
  'recovery_plan',
  'weekly_insight',
  'ask_question',
  'help_bot',
] as const;
export type AiAction = (typeof AI_ACTIONS)[number];

export interface CostRow {
  action: string;
  credits: number;
  included: boolean;
  dailyFairUse: number | null;
}

export const DEFAULT_COSTS: CostRow[] = [
  { action: 'daily_plan', credits: 1, included: false, dailyFairUse: null },
  { action: 'section_rewrite', credits: 0.2, included: false, dailyFairUse: null },
  { action: 'companion', credits: 1, included: false, dailyFairUse: null },
  { action: 'unit_plan', credits: 3, included: false, dailyFairUse: null },
  { action: 'annual_plan', credits: 5, included: false, dailyFairUse: null },
  { action: 'question_paper', credits: 5, included: false, dailyFairUse: null },
  { action: 'recovery_plan', credits: 2, included: false, dailyFairUse: null },
  { action: 'weekly_insight', credits: 0, included: true, dailyFairUse: null },
  { action: 'ask_question', credits: 0, included: true, dailyFairUse: 30 },
  { action: 'help_bot', credits: 0, included: true, dailyFairUse: 50 },
];

/** Credits for an action. `units` multiplies per-unit actions (e.g. paper sets, periods in a double plan count once). */
export function creditCost(action: AiAction, costs: CostRow[] = DEFAULT_COSTS, units = 1): number {
  const row = costs.find((c) => c.action === action);
  if (!row) throw new Error(`No cost configured for ${action}`);
  if (row.included) return 0;
  return Math.round(row.credits * Math.max(1, units) * 100) / 100;
}

export interface CreditState {
  /** Allowance + top-ups + adjustments for the period. */
  granted: number;
  /** Credits consumed this period (positive number). */
  used: number;
  /** Per-teacher monthly cap, if set, and what this teacher used. */
  teacherCap?: number | null;
  teacherUsed?: number;
  /** Included actions: today's uses by this user for fair-use. */
  usesToday?: number;
}

export type CreditDecision =
  | { allowed: true; cost: number; warn: 80 | 95 | null; usedPct: number }
  | { allowed: false; cost: number; reason: 'branch_exhausted' | 'teacher_cap' | 'fair_use'; usedPct: number };

export function checkCredits(action: AiAction, state: CreditState, costs: CostRow[] = DEFAULT_COSTS, units = 1): CreditDecision {
  const cost = creditCost(action, costs, units);
  const row = costs.find((c) => c.action === action)!;
  const usedPct = state.granted > 0 ? Math.round((state.used / state.granted) * 1000) / 10 : state.used > 0 ? 100 : 0;
  if (row.included) {
    if (row.dailyFairUse != null && (state.usesToday ?? 0) >= row.dailyFairUse) return { allowed: false, cost, reason: 'fair_use', usedPct };
    return { allowed: true, cost, warn: null, usedPct };
  }
  if (state.used + cost > state.granted + 1e-9) return { allowed: false, cost, reason: 'branch_exhausted', usedPct };
  if (state.teacherCap != null && (state.teacherUsed ?? 0) + cost > state.teacherCap + 1e-9) return { allowed: false, cost, reason: 'teacher_cap', usedPct };
  const after = state.granted > 0 ? ((state.used + cost) / state.granted) * 100 : 100;
  const warn = after >= 95 ? 95 : after >= 80 ? 80 : null;
  return { allowed: true, cost, warn, usedPct };
}

/** Warning thresholds crossed by moving from `before` to `after` usage percent. */
export function crossedThresholds(beforePct: number, afterPct: number, levels: number[] = [80, 95, 100]): number[] {
  return levels.filter((l) => beforePct < l && afterPct >= l);
}
