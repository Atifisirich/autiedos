/** Working-day rules as pure functions (ADO-01): weekends and holidays are never counted as misses. Port of the pure part of the ERP's calendar.ts. */
export type Holiday = { start_date: string; end_date: string | null };
/** core.branches.working_days is an integer[] on the platform; the ERP used the text "1,2,3". Both are accepted. */
export type WorkingDays = readonly number[] | string | null | undefined;

/** ISO weekday 1 (Mon) to 7 (Sun) for a YYYY-MM-DD date. */
export const weekday = (d: string) => { const n = new Date(d + 'T00:00:00Z').getUTCDay(); return n === 0 ? 7 : n; };
export const DAYS = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;
export const addDays = (d: string, n: number) => new Date(new Date(d + 'T00:00:00Z').getTime() + n * 86400000).toISOString().slice(0, 10);

const toDays = (w: WorkingDays): number[] => (w == null ? [1, 2, 3, 4, 5, 6] : typeof w === 'string' ? w.split(',').map((s) => Number(s.trim())) : [...w]);

/** A date is a working day when its weekday is in the branch's list and no holiday covers it. */
export function isWorking(date: string, workingDays: WorkingDays, holidays: Holiday[]) {
  if (!toDays(workingDays).includes(weekday(date))) return false;
  return !holidays.some((h) => date >= h.start_date && date <= (h.end_date ?? h.start_date));
}

/** Working days between two dates inclusive. */
export function countWorking(from: string, to: string, workingDays: WorkingDays, holidays: Holiday[]) {
  let n = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) if (isWorking(d, workingDays, holidays)) n++;
  return n;
}

/** core.calendar_events rows (layer 'holiday') as holidays. */
export const holidaysFrom = (events: { layer: string; starts_on: string; ends_on: string | null }[]): Holiday[] =>
  events.filter((e) => e.layer === 'holiday').map((e) => ({ start_date: e.starts_on, end_date: e.ends_on }));
