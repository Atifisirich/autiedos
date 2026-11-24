/**
 * AI generation pipeline and credit metering (PRD 8.5, rules 7 and 8).
 * Every call: credit check -> privacy guard -> provider -> schema validation (+ repair,
 * regenerate at most twice) -> ai_generations + ai_credit_ledger rows -> warnings at 80/95/100%.
 */
import { checkCredits, creditCost, containsContactData, crossedThresholds, monthKey, type AiAction, type CostRow } from '@autoed/shared';
import type { ZodType, ZodTypeDef } from 'zod';
import { PaymentRequiredError, ValidationError, asService, insert, maybe, one, q, type Tx } from '../db';
import { getAiProvider, AiRefusalError, type AiModels, type ModelTier } from '../adapters/ai';
import { notify } from '../notify';
import { need, run, now, staffWithRole, type Ctx } from '../core';

/**
 * Calls that end in an error are still recorded (rule 5). The caller's transaction rolls back when we throw,
 * so these rows are written on their own connection and survive it.
 */
async function recordFailed(row: Record<string, unknown>): Promise<void> {
  await asService((cc) => insert(cc, 'ai_generations', row));
}

export async function costTable(c: Tx): Promise<CostRow[]> {
  return (await q<{ action: string; credits: number; included: boolean; daily_fair_use: number | null }>(c, `select action, credits, included, daily_fair_use from public.ai_action_costs where deleted_at is null`)).map((r) => ({ action: r.action, credits: Number(r.credits), included: r.included, dailyFairUse: r.daily_fair_use }));
}

/** Model IDs (and optional USD prices per 1M tokens) are platform_settings rows, never code. */
const UNSET_MODELS: AiModels = { strong: 'PLACEHOLDER_GEMINI_STRONG_MODEL_ID', fast: 'PLACEHOLDER_GEMINI_FAST_MODEL_ID', prices: null };

async function models(c: Tx): Promise<AiModels> {
  const r = await maybe<{ value: AiModels }>(c, `select value from public.platform_settings where key = 'ai_models'`);
  return r?.value ?? UNSET_MODELS;
}

/** Ensures this month's allowance exists (from the branch's plan; carry-forward if the plan allows). */
export async function ensureAllowance(c: Tx, orgId: string, branchId: string, period: string): Promise<void> {
  const has = await maybe(c, `select 1 from public.ai_credit_ledger where branch_id = $1 and period = $2 and kind = 'allowance'`, [branchId, period]);
  if (has) return;
  const sub = await maybe<{ monthly_credits: number; carry_forward: boolean; override: number | null }>(
    c,
    `select p.monthly_credits, p.carry_forward, bs.monthly_credits_override as override from public.branch_subscriptions bs join public.plans p on p.id = bs.plan_id
     where bs.branch_id = $1 and bs.status = 'active' and bs.deleted_at is null order by bs.starts_on desc limit 1`,
    [branchId],
  );
  if (!sub) return;
  let carry = 0;
  if (sub.carry_forward) {
    const prev = await one<{ bal: number }>(c, `select coalesce(sum(credits), 0) as bal from public.ai_credit_ledger where branch_id = $1 and period < $2`, [branchId, period]);
    carry = Math.max(0, Number(prev.bal));
  }
  await c.query(`insert into public.ai_credit_ledger (org_id, branch_id, kind, period, credits, note) values ($1,$2,'allowance',$3,$4,$5) on conflict do nothing`, [orgId, branchId, period, Number(sub.override ?? sub.monthly_credits) + carry, carry ? `Monthly allowance + ${carry} carried forward` : 'Monthly allowance']);
}

export async function creditState(c: Tx, branchId: string, period: string, staffId: string | null) {
  const s = await one<{ granted: number; used: number; teacher_used: number }>(
    c,
    `select coalesce(sum(credits) filter (where credits > 0), 0) as granted, coalesce(-sum(credits) filter (where credits < 0), 0) as used,
            coalesce(-sum(credits) filter (where credits < 0 and staff_id = $3), 0) as teacher_used
     from public.ai_credit_ledger where branch_id = $1 and period = $2 and deleted_at is null`,
    [branchId, period, staffId],
  );
  const cap = await maybe<{ teacher_monthly_cap: number | null }>(c, `select teacher_monthly_cap from public.branch_subscriptions where branch_id = $1 and status = 'active' and deleted_at is null order by starts_on desc limit 1`, [branchId]);
  return { granted: Number(s.granted), used: Number(s.used), teacherUsed: Number(s.teacher_used), teacherCap: cap?.teacher_monthly_cap != null ? Number(cap.teacher_monthly_cap) : null };
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
  await ensureAllowance(c, o.orgId, o.branchId, period);
  const costs = await costTable(c);
  const state = await creditState(c, o.branchId, period, o.staffId);
  const usesToday = o.staffId ? (await one<{ n: number }>(c, `select count(*)::int as n from public.ai_generations where staff_id = $1 and action = $2 and created_at >= current_date`, [o.staffId, o.action])).n : 0;
  const decision = checkCredits(o.action, { ...state, usesToday }, costs, o.units ?? 1);
  const model = await models(c);
  if (!decision.allowed) {
    await recordFailed({ org_id: o.orgId, branch_id: o.branchId, staff_id: o.staffId, action: o.action, model: o.tier === 'strong' ? model.strong : model.fast, provider: 'none', input: o.logInput, status: 'blocked', error: decision.reason, credits: 0 });
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
      await recordFailed({ org_id: o.orgId, branch_id: o.branchId, staff_id: o.staffId, action: o.action, model: usedModel || model.strong, provider: provider.name, input: o.logInput, status: 'failed', attempts, error: refusal ? `refused:${(e as AiRefusalError).category}` : (e as Error).message.slice(0, 500), credits: 0 });
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
  const gen = await insert<{ id: string }>(c, 'ai_generations', genRow);
  if (credits > 0) {
    await insert(c, 'ai_credit_ledger', { org_id: o.orgId, branch_id: o.branchId, staff_id: o.staffId, kind: 'usage', action: o.action, period, credits: -credits, generation_id: gen.id, tokens: tokensIn + tokensOut, provider_cost: cost });
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
      await ensureAllowance(c, ctx.orgId, ctx.branchId, period);
      return creditState(c, ctx.branchId, period, ctx.staffId);
    });
    return { action, credits: creditCost(action, costs, units), balance: Math.round((st.granted - st.used) * 100) / 100, granted: st.granted, used: st.used };
  });
}

export async function creditsSummary(ctx: Ctx, period?: string) {
  need(ctx, 'ai', 'view');
  return run(ctx, async (c, sys) => {
    const p = period ?? monthKey(now());
    const st = await sys(async () => {
      await ensureAllowance(c, ctx.orgId, ctx.branchId, p);
      return creditState(c, ctx.branchId, p, ctx.staffId);
    });
    const byAction = await q(c, `select action, -sum(credits) as credits, count(*)::int as uses from public.ai_credit_ledger where branch_id = $1 and period = $2 and kind = 'usage' group by action order by credits desc`, [ctx.branchId, p]);
    const byTeacher = await q(c, `select s.full_name, -sum(l.credits) as credits from public.ai_credit_ledger l join public.staff s on s.id = l.staff_id where l.branch_id = $1 and l.period = $2 and l.kind = 'usage' group by s.full_name order by credits desc limit 50`, [ctx.branchId, p]);
    const ledger = await q(c, `select l.created_at, l.kind, l.action, l.credits, l.note, s.full_name from public.ai_credit_ledger l left join public.staff s on s.id = l.staff_id where l.branch_id = $1 and l.period = $2 order by l.created_at desc limit 200`, [ctx.branchId, p]);
    const requests = await q(c, `select * from public.credit_topup_requests where branch_id = $1 order by created_at desc limit 20`, [ctx.branchId]);
    return { period: p, granted: st.granted, used: st.used, balance: Math.round((st.granted - st.used) * 100) / 100, pct: st.granted ? Math.round((st.used / st.granted) * 1000) / 10 : 0, teacher_cap: st.teacherCap, my_used: st.teacherUsed, by_action: byAction, by_teacher: byTeacher, ledger, requests };
  });
}

export async function requestTopup(ctx: Ctx, input: { credits: number; note?: string }) {
  need(ctx, 'ai', 'configure');
  return run(ctx, async (c) => insert(c, 'credit_topup_requests', { org_id: ctx.orgId, branch_id: ctx.branchId, requested_by: ctx.staffId, credits: input.credits, note: input.note ?? null }));
}
