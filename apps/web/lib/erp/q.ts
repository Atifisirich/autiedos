/** Small shared queries used by many screens. All run as the signed-in user through the Data API. */
import { core, erp } from './db';
import type { Ctx } from './ctx';

export const NO_ID = '00000000-0000-0000-0000-000000000000';
export type Section = { id: string; name: string; programme_id: string; class_teacher_id: string | null; capacity: number | null; programme: { id: string; name: string; branch_id: string | null } | null };

/** Sections of the selected academic year (and branch, through the programme), in class order. */
export async function sectionsFor(ctx: Ctx): Promise<Section[]> {
  const { data } = await core(ctx.sb).from('sections').select('id, name, programme_id, class_teacher_id, capacity, seq, programme:programmes(id, name, branch_id)').eq('academic_year_id', ctx.year?.id ?? NO_ID).is('deleted_at', null).order('seq');
  const rows = (data ?? []) as unknown as Section[];
  return ctx.branchId ? rows.filter((s) => !s.programme?.branch_id || s.programme.branch_id === ctx.branchId) : rows;
}

/** Dropdown masters of one type (houses, categories, concern types ...), in their sort order. */
export async function masters(ctx: Ctx, type: string) {
  const { data } = await erp(ctx.sb).from('masters').select('name, color, meta').eq('type', type).eq('active', true).is('deleted_at', null).order('sort');
  return (data ?? []) as { name: string; color: string | null; meta: unknown }[];
}

/** Next number of a series (core.number_series); when the school has not set the series up a time-based number is used so nothing blocks. */
export async function nextNo(ctx: Ctx, key: string, prefix: string) {
  const r = await core(ctx.sb).rpc('next_number', { p_key: key, p_branch: ctx.branchId ?? null, p_year: ctx.year?.id ?? null });
  return r.error ? `${prefix}${Date.now().toString().slice(-7)}` : (r.data as string);
}

export const fullNameOf =(p: { first_name?: string | null; last_name?: string | null } | null | undefined) => (p ? `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim() : '');

/** Scope a query to the selected branch (rows without a branch are visible to every branch). */
export const scopeBranch = <T extends { or: (f: string) => T }>(q: T, ctx: Ctx) => (ctx.branchId ? q.or(`branch_id.eq.${ctx.branchId},branch_id.is.null`) : q);
