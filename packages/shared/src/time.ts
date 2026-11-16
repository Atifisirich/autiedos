/**
 * Date and working-time helpers shared by web, mobile and jobs.
 * Dates are ISO strings "YYYY-MM-DD"; wall-clock times are "HH:MM" in the branch timezone.
 */

export type ISODate = string;

export interface WorkCalendar {
  /** ISO weekdays that are working days (1 = Monday … 7 = Sunday). */
  workingDays: number[];
  /** Non-working dates from the school calendar (holidays). */
  holidays: ISODate[];
  /** Extra working dates (e.g. a working Saturday) overriding workingDays. */
  extraWorkingDays?: ISODate[];
  /** Working hours, "HH:MM". */
  dayStart: string;
  dayEnd: string;
  /** IANA timezone, default Asia/Kolkata. */
  timeZone?: string;
}

export function parseISODate(d: ISODate): Date {
  const [y, m, day] = d.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, day!));
}

export function toISODate(d: Date): ISODate {
  return d.toISOString().slice(0, 10);
}

export function addDays(d: ISODate, n: number): ISODate {
  const x = parseISODate(d);
  x.setUTCDate(x.getUTCDate() + n);
  return toISODate(x);
}

/** ISO weekday 1..7 (Mon..Sun). */
export function isoWeekday(d: ISODate): number {
  const w = parseISODate(d).getUTCDay();
  return w === 0 ? 7 : w;
}

export function daysBetweenInclusive(a: ISODate, b: ISODate): number {
  return Math.round((parseISODate(b).getTime() - parseISODate(a).getTime()) / 86400000) + 1;
}

export function eachDate(a: ISODate, b: ISODate): ISODate[] {
  const out: ISODate[] = [];
  for (let d = a; d <= b; d = addDays(d, 1)) out.push(d);
  return out;
}

export function isWorkingDay(d: ISODate, cal: Pick<WorkCalendar, 'workingDays' | 'holidays' | 'extraWorkingDays'>): boolean {
  if (cal.extraWorkingDays?.includes(d)) return true;
  if (cal.holidays.includes(d)) return false;
  return cal.workingDays.includes(isoWeekday(d));
}

export function workingDaysBetween(a: ISODate, b: ISODate, cal: Pick<WorkCalendar, 'workingDays' | 'holidays' | 'extraWorkingDays'>): ISODate[] {
  return eachDate(a, b).filter((d) => isWorkingDay(d, cal));
}

export function hhmmToMinutes(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return h! * 60 + (m ?? 0);
}

export function minutesToHHMM(m: number): string {
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/** Offset of `timeZone` from UTC in minutes at instant `at` (e.g. +330 for Asia/Kolkata). */
export function tzOffsetMinutes(timeZone: string, at: Date): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = Object.fromEntries(fmt.formatToParts(at).map((p) => [p.type, p.value]));
  const asUTC = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return Math.round((asUTC - Math.floor(at.getTime() / 1000) * 1000) / 60000);
}

/** Local date + minutes-of-day in timeZone for an instant. */
export function toLocal(at: Date, timeZone = 'Asia/Kolkata'): { date: ISODate; minutes: number } {
  const off = tzOffsetMinutes(timeZone, at);
  const local = new Date(at.getTime() + off * 60000);
  return { date: toISODate(local), minutes: local.getUTCHours() * 60 + local.getUTCMinutes() };
}

/** Instant for a local date and "HH:MM" (or minutes) in timeZone. */
export function fromLocal(date: ISODate, time: string | number, timeZone = 'Asia/Kolkata'): Date {
  const mins = typeof time === 'number' ? time : hhmmToMinutes(time);
  const guess = new Date(parseISODate(date).getTime() + mins * 60000);
  const off = tzOffsetMinutes(timeZone, guess);
  return new Date(guess.getTime() - off * 60000);
}

/** Length of the working day in minutes. */
export function workingDayMinutes(cal: WorkCalendar): number {
  return hhmmToMinutes(cal.dayEnd) - hhmmToMinutes(cal.dayStart);
}

/**
 * Adds working minutes to an instant, skipping non-working days and out-of-hours time.
 * A start outside working hours is moved to the next working-hours boundary first.
 */
export function addWorkingMinutes(start: Date, minutes: number, cal: WorkCalendar): Date {
  const tz = cal.timeZone ?? 'Asia/Kolkata';
  const ds = hhmmToMinutes(cal.dayStart);
  const de = hhmmToMinutes(cal.dayEnd);
  let { date, minutes: cur } = toLocal(start, tz);
  let remaining = Math.max(0, minutes);
  for (let guard = 0; guard < 3660; guard++) {
    if (!isWorkingDay(date, cal) || cur >= de) {
      date = addDays(date, 1);
      cur = ds;
      continue;
    }
    if (cur < ds) cur = ds;
    const available = de - cur;
    if (remaining <= available) return fromLocal(date, cur + remaining, tz);
    remaining -= available;
    date = addDays(date, 1);
    cur = ds;
  }
  throw new Error('addWorkingMinutes: calendar has no working days');
}

/** Working minutes elapsed between two instants (0 if b <= a). */
export function workingMinutesBetween(a: Date, b: Date, cal: WorkCalendar): number {
  if (b <= a) return 0;
  const tz = cal.timeZone ?? 'Asia/Kolkata';
  const ds = hhmmToMinutes(cal.dayStart);
  const de = hhmmToMinutes(cal.dayEnd);
  const la = toLocal(a, tz);
  const lb = toLocal(b, tz);
  let total = 0;
  for (const d of eachDate(la.date, lb.date)) {
    if (!isWorkingDay(d, cal)) continue;
    const from = d === la.date ? Math.max(ds, la.minutes) : ds;
    const to = d === lb.date ? Math.min(de, lb.minutes) : de;
    if (to > from) total += to - from;
  }
  return total;
}

/** Is `at` inside quiet hours [start, end) which may wrap midnight. */
export function inQuietHours(at: Date, quietStart: string, quietEnd: string, timeZone = 'Asia/Kolkata'): boolean {
  const { minutes } = toLocal(at, timeZone);
  const s = hhmmToMinutes(quietStart);
  const e = hhmmToMinutes(quietEnd);
  return s <= e ? minutes >= s && minutes < e : minutes >= s || minutes < e;
}

/** Next instant quiet hours end (returns `at` if not in quiet hours). */
export function quietHoursRelease(at: Date, quietStart: string, quietEnd: string, timeZone = 'Asia/Kolkata'): Date {
  if (!inQuietHours(at, quietStart, quietEnd, timeZone)) return at;
  const { date, minutes } = toLocal(at, timeZone);
  const e = hhmmToMinutes(quietEnd);
  const releaseDate = minutes >= e ? addDays(date, 1) : date;
  return fromLocal(releaseDate, e, timeZone);
}

export function monthKey(d: ISODate | Date): string {
  const s = typeof d === 'string' ? d : toISODate(d);
  return s.slice(0, 7);
}
