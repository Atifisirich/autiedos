/** Timetable data on core.timetable_versions / timetable_entries / bell_schedules / periods (MAP B.11). */
import { core } from './db';
import type { Ctx } from './ctx';
import { NO_ID } from './q';

export type Period = { seq: number; label: string; kind: string; starts_at: string; ends_at: string };
export type Cell = { id: string; section_id: string | null; day: number; period_seq: number; subject_id: string | null; staff_id: string | null; room_id: string | null };

/** The published timetable version of the year (and branch) the user is working in, if any. */
export async function activeVersion(ctx: Ctx) {
  let q = core(ctx.sb).from('timetable_versions').select('id, name, branch_id, status').eq('status', 'published').eq('academic_year_id', ctx.year?.id ?? NO_ID).is('deleted_at', null).order('created_at', { ascending: false }).limit(5);
  if (ctx.branchId) q = q.or(`branch_id.eq.${ctx.branchId},branch_id.is.null`);
  const { data } = await q;
  const rows = (data ?? []) as { id: string; name: string; branch_id: string | null }[];
  return rows[0] ?? null;
}

/** Bell schedule periods of the first active schedule (teaching periods and breaks), in order. */
export async function periods(ctx: Ctx): Promise<Period[]> {
  const { data: bells } = await core(ctx.sb).from('bell_schedules').select('id').eq('active', true).is('deleted_at', null).order('created_at').limit(1);
  const bell = (bells ?? [])[0] as { id: string } | undefined;
  if (!bell) return [];
  const { data } = await core(ctx.sb).from('periods').select('seq, label, kind, starts_at, ends_at').eq('bell_schedule_id', bell.id).is('deleted_at', null).order('seq');
  return (data ?? []) as Period[];
}

export async function entries(ctx: Ctx, versionId: string): Promise<Cell[]> {
  const { data } = await core(ctx.sb).from('timetable_entries').select('id, section_id, day, period_seq, subject_id, staff_id, room_id').eq('version_id', versionId).is('deleted_at', null).limit(20000);
  return (data ?? []) as Cell[];
}

export const workingDays = (ctx: Ctx): number[] => (ctx.branches.find((b) => b.id === ctx.branchId) ?? ctx.branches[0])?.working_days ?? [1, 2, 3, 4, 5, 6];
