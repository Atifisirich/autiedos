import { isWorking, holidaysFrom, weekday, DAYS, addDays, countWorking, type Holiday } from '@autoed/shared/erp';
import { core } from './db';
import type { Ctx } from './ctx';

export { weekday, DAYS, addDays, countWorking, isWorking };

/** Holidays of the school calendar (core.calendar_events, layer holiday) that apply to a branch. */
export async function holidays(ctx: Ctx, branchId?: string | null): Promise<Holiday[]> {
  const b = branchId ?? ctx.branchId;
  let q = core(ctx.sb).from('calendar_events').select('layer, starts_on, ends_on, title, branch_id').eq('layer', 'holiday').is('deleted_at', null).limit(1000);
  if (b) q = q.or(`branch_id.eq.${b},branch_id.is.null`);
  const { data } = await q;
  return holidaysFrom((data ?? []) as { layer: string; starts_on: string; ends_on: string | null }[]);
}

/** Calendar-aware check used by every monitor so weekends and holidays are never counted as misses (ADO-01). */
export async function workingDay(ctx: Ctx, date: string, branchId?: string | null) {
  const b = ctx.branches.find((x) => x.id === (branchId ?? ctx.branchId)) ?? ctx.branches[0];
  let q = core(ctx.sb).from('calendar_events').select('title, layer, starts_on, ends_on, branch_id').eq('layer', 'holiday').lte('starts_on', date).is('deleted_at', null);
  if (b) q = q.or(`branch_id.eq.${b.id},branch_id.is.null`);
  const { data } = await q;
  const rows = (data ?? []) as { title: string; layer: string; starts_on: string; ends_on: string | null }[];
  const hit = rows.find((h) => date >= h.starts_on && date <= (h.ends_on ?? h.starts_on));
  const working = isWorking(date, b?.working_days, holidaysFrom(rows));
  return { working, reason: hit ? hit.title : working ? null : `${DAYS[weekday(date)]} is not a working day` };
}
