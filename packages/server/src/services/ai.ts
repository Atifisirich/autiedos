/**
 * AI generation pipeline and credit metering (PRD 8.5, rules 7 and 8).
 * Every call: credit check -> privacy guard -> provider -> schema validation (+ repair,
 * regenerate at most twice) -> ai_generations + ai_credit_ledger rows -> warnings at 80/95/100%.
 *
 * Platform layout (docs/adr/os-move.md): generations are core.ai_generations (product 'os'); the wallet is ONE
 * org-level wallet per client (decision 40, OQ-11) in billing, which the OS server reaches only through the
 * app.ai_* security definer functions (os_server has no grant on billing). Ledger rows keep branch and staff for
 * reports and the per-teacher cap.
 */
import { checkCredits, creditCost, containsContactData, crossedThresholds, monthKey, type AiAction, type CostRow } from '@autoed/shared';
import type { ZodType, ZodTypeDef } from 'zod';
import { PaymentRequiredError, ValidationError, asSystem, insert, maybe, one, q, type Tx } from '../db';
import { getAiProvider, AiRefusalError, type AiModels, type ModelTier } from '../adapters/ai';
import { notify } from '../notify';
import { need, run, now, staffWithRole, type Ctx } from '../core';

/**
 * Calls that end in an error are still recorded (rule 5). The caller's transaction rolls back when we throw,
 * so these rows are written on their own connection and survive it.
 */
async function recordFailed(row: Record<string, unknown>): Promise<void> {
  await asSystem(String(row.org_id), (cc) => insert(cc, 'core.ai_generations', row));
}

export async function costTable(c: Tx): Promise<CostRow[]> {
  return (await q<{ action: string; credits: number; included: boolean; daily_fair_use: number | null }>(c, `select action, credits, included, daily_fair_use from app.ai_costs()`)).map((r) => ({ action: r.action, credits: Number(r.credits), included: r.included, dailyFairUse: r.daily_fair_use }));
}

/** Model IDs (and optional USD prices per 1M tokens) are platform_settings rows, never code. */
const UNSET_MODELS: AiModels = { strong: 'PLACEHOLDER_GEMINI_STRONG_MODEL_ID', fast: 'PLACEHOLDER_GEMINI_FAST_MODEL_ID', prices: null };

async function models(c: Tx): Promise<AiModels> {
  const r = await maybe<{ value: AiModels | null }>(c, `select app.platform_setting('ai_models') as value`);
  return r?.value ?? UNSET_MODELS;
}

/** Ensures this month's allowance row of the org's wallet (from billing.ai_allowances; carry-forward if allowed). */
export async function ensureAllowance(c: Tx, period: string): Promise<void> {
  await c.query(`select app.ai_ensure_allowance($1)`, [period]);
}

/** Org wallet for the period; teacher usage and cap for the per-teacher limit. */
export async function creditState(c: Tx, branchId: string, period: string, staffId: string | null) {
  const s = await one<{ granted: number; used: number; teacher_used: number; teacher_cap: number | null }>(
    c,
    `select granted, used, teacher_used, teacher_cap from app.ai_credit_state($1, $2, $3)`,
    [period, staffId, branchId],
  );
  return { granted: Number(s.granted), used: Number(s.used), teacherUsed: Number(s.teacher_used), teacherCap: s.teacher_cap != null ? Number(s.teacher_cap) : null };
}

export interface GenerateOptions<T> {
  orgId: string;
  branchId: string;
  staffId: string | null;
  action: AiAction;
  units?: number;
  tier: ModelTier;
  system: string;
  prompt: string;
  jsonSchema: Record<string, unknown>;
  zod: ZodType<T, ZodTypeDef, unknown>;
  mockContext?: Record<string, unknown>;
  /** Business validation; return issue codes to trigger regeneration. */
  validate?: (out: T) => string[];
  /** Deterministic fixes applied before validation (e.g. exact timings). */
  repair?: (out: T) => T;
  linked?: { type: string; id?: string | null };
  /** Logged input (never includes personal data). */
  logInput: Record<string, unknown>;
}

/** Must run with service rights (called inside `sys`). */
export async function generate<T>(c: Tx, o: GenerateOptions<T>): Promise<{ output: T; generationId: string; credits: number; attempts: number; issues: string[] }> {
  const period = monthKey(now());
  await ensureAllowance(c, period);
  const costs = await costTable(c);
  const state = await creditState(c, o.branchId, period, o.staffId);
  const usesToday = o.staffId ? (await one<{ n: number }>(c, `select count(*)::int as n from core.ai_generations where staff_id = $1 and action = $2 and created_at >= current_date`, [o.staffId, o.action])).n : 0;
  const decision = checkCredits(o.action, { ...state, usesToday }, costs, o.units ?? 1);
  const model = await models(c);
  if (!decision.allowed) {
    await recordFailed({ org_id: o.orgId, branch_id: o.branchId, product_key: 'os', staff_id: o.staffId, action: o.action, model: o.tier === 'strong' ? model.strong : model.fast, provider: 'none', input: o.logInput, status: 'blocked', error: decision.reason, credits: 0 });
    throw new PaymentRequiredError(decision.reason === 'fair_use' ? 'fair_use_limit' : decision.reason === 'teacher_cap' ? 'teacher_cap_reached' : 'credits_exhausted');
  }
  if (containsContactData(o.prompt) || containsContactData(o.system)) throw new ValidationError('personal_data_in_prompt');

  const provider = getAiProvider();
  let attempts = 0;
  let lastIssues: string[] = [];
  let tokensIn = 0;
  let tokensOut = 0;
  let cost = 0;
  let usedModel = '';
  let output: T | null = null;
  while (attempts < 3) {
    attempts++;
    let res;
    try {
      res = await provider.generate({ action: o.action, tier: o.tier, system: o.system, prompt: attempts > 1 ? `${o.prompt}\n\nThe previous answer failed these checks: ${lastIssues.join(', ')}. Fix them.` : o.prompt, schema: o.jsonSchema, mockContext: o.mockContext }, model);
    } catch (e) {
      const refusal = e instanceof AiRefusalError;
      await recordFailed({ org_id: o.orgId, branch_id: o.branchId, product_key: 'os', staff_id: o.staffId, action: o.action, model: usedModel || model.strong, provider: provider.name, input: o.logInput, status: 'failed', attempts, error: refusal ? `refused:${(e as AiRefusalError).category}` : (e as Error).message.slice(0, 500), credits: 0 });
      throw refusal ? new ValidationError('ai_refused') : new ValidationError('ai_unavailable');
    }
    tokensIn += res.inputTokens;
    tokensOut += res.outputTokens;
    cost += res.providerCost;
    usedModel = res.model;
    const parsed = o.zod.safeParse(res.output);
    if (!parsed.success) {
      lastIssues = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`);
      continue;
    }
    const repaired = o.repair ? o.repair(parsed.data) : parsed.data;
    lastIssues = o.validate ? o.validate(repaired) : [];
    output = repaired;
    if (!lastIssues.length) break;
  }
  const ok = output !== null && !lastIssues.length;
  const credits = ok ? creditCost(o.action, costs, o.units ?? 1) : 0;
  const genRow = {
    org_id: o.orgId,
    branch_id: o.branchId,
    product_key: 'os',
    user_id: o.staffId ? (await maybe<{ user_id: string | null }>(c, `select user_id from core.staff where id = $1`, [o.staffId]))?.user_id ?? null : null,
    staff_id: o.staffId,
    action: o.action,
    model: usedModel,
    provider: provider.name,
    input: o.logInput,
    output: output ?? null,
    status: ok ? 'ok' : 'invalid',
    attempts,
    input_tokens: tokensIn,
    output_tokens: tokensOut,
    provider_cost: cost,
    credits,
    error: ok ? null : lastIssues.join('; ').slice(0, 1000),
    linked_type: o.linked?.type ?? null,
    linked_id: o.linked?.id ?? null,
  };
  if (!ok || output === null) {
    await recordFailed(genRow);
    throw new ValidationError('ai_output_invalid', { issues: lastIssues });
  }
  const gen = await insert<{ id: string }>(c, 'core.ai_generations', genRow);
  if (credits > 0) {
    // the wallet is charged from the generation row itself (app.ai_charge: once per generation)
    await c.query(`select app.ai_charge($1, $2)`, [gen.id, period]);
    const beforePct = state.granted ? (state.used / state.granted) * 100 : 0;
    const afterPct = state.granted ? ((state.used + credits) / state.granted) * 100 : 100;
    const crossed = crossedThresholds(beforePct, afterPct);
    if (crossed.length) {
      const admins = [...(await staffWithRole(c, o.orgId, 'principal', o.branchId)), ...(await staffWithRole(c, o.orgId, 'admin_officer', o.branchId))];
      await notify(c, { orgId: o.orgId, branchId: o.branchId, staffIds: admins, event: 'credits.warning', titleKey: crossed.includes(100) ? 'notif.credits.exhausted' : 'notif.credits.warning', vars: { pct: Math.max(...crossed) }, link: '/os/ai-credits', dedupeKey: `credits:${period}:${Math.max(...crossed)}` });
    }
  }
  return { output, generationId: gen.id, credits, attempts, issues: lastIssues };
}

/** Shows the cost before running (PRD 6.1 Quality rules). */
export async function quote(ctx: Ctx, action: AiAction, units = 1) {
  return run(ctx, async (c, sys) => {
    const costs = await costTable(c);
    const period = monthKey(now());
    const st = await sys(async () => {
      await ensureAllowance(c, period);
      return creditState(c, ctx.branchId, period, ctx.staffId);
    });
    return { action, credits: creditCost(action, costs, units), balance: Math.round((st.granted - st.used) * 100) / 100, granted: st.granted, used: st.used };
  });
}

export async function creditsSummary(ctx: Ctx, period?: string) {
  need(ctx, 'ai', 'view');
  return run(ctx, async (c, sys) => {
    const p = period ?? monthKey(now());
    // one wallet per org (decision 40): the report covers every branch; app.ai_usage needs ai.view (checked above)
    const { st, usage } = await sys(async () => {
      await ensureAllowance(c, p);
      const st = await creditState(c, ctx.branchId, p, ctx.staffId);
      const usage = (await one<{ u: { by_action: unknown[]; by_teacher: unknown[]; ledger: unknown[]; requests: unknown[] } }>(c, `select app.ai_usage($1) as u`, [p])).u;
      return { st, usage };
    });
    const { by_action: byAction, by_teacher: byTeacher, ledger, requests } = usage;
    return { period: p, granted: st.granted, used: st.used, balance: Math.round((st.granted - st.used) * 100) / 100, pct: st.granted ? Math.round((st.used / st.granted) * 1000) / 10 : 0, teacher_cap: st.teacherCap, my_used: st.teacherUsed, by_action: byAction, by_teacher: byTeacher, ledger, requests };
  });
}

export async function requestTopup(ctx: Ctx, input: { credits: number; note?: string }) {
  need(ctx, 'ai', 'configure');
  return run(ctx, async (c) => one<{ id: string }>(c, `select app.ai_request_topup($1, $2, $3) as id`, [input.credits, input.note ?? null, ctx.branchId]));
}
