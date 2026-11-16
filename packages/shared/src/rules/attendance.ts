/**
 * Attendance rules (PRD 5.5): geofence check, staff status from shift rules, biometric merge,
 * student attendance summaries.
 */
import { hhmmToMinutes, type ISODate } from '../time';

// ---------------------------------------------------------------- geofence
const EARTH_RADIUS_M = 6371000;

export function distanceMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function withinBoundary(
  point: { lat: number; lng: number; accuracyM?: number },
  branch: { lat: number | null; lng: number | null; radiusM: number },
): { ok: boolean; distanceM: number | null; reason?: 'no_branch_location' | 'outside_boundary' } {
  if (branch.lat == null || branch.lng == null) return { ok: false, distanceM: null, reason: 'no_branch_location' };
  const d = Math.round(distanceMeters(point, { lat: branch.lat, lng: branch.lng }));
  return d <= branch.radiusM ? { ok: true, distanceM: d } : { ok: false, distanceM: d, reason: 'outside_boundary' };
}

// ---------------------------------------------------------------- staff status
export interface ShiftRule {
  shiftStart: string;
  shiftEnd: string;
  graceMinutes: number;
  halfDayAfterMinutes: number;
  earlyExitMinutes: number;
}

export type StaffDayStatus = 'present' | 'late' | 'half_day' | 'absent';

/** Status from local check-in / check-out minutes-of-day. */
export function staffStatus(rule: ShiftRule, checkInMin: number | null, checkOutMin: number | null): { status: StaffDayStatus; lateMinutes: number; earlyExit: boolean } {
  if (checkInMin == null) return { status: 'absent', lateMinutes: 0, earlyExit: false };
  const start = hhmmToMinutes(rule.shiftStart);
  const end = hhmmToMinutes(rule.shiftEnd);
  const lateBy = Math.max(0, checkInMin - start);
  const earlyBy = checkOutMin == null ? 0 : Math.max(0, end - checkOutMin);
  const earlyExit = checkOutMin != null && earlyBy > rule.earlyExitMinutes;
  if (lateBy > rule.halfDayAfterMinutes || earlyBy > rule.halfDayAfterMinutes) {
    return { status: 'half_day', lateMinutes: lateBy, earlyExit };
  }
  if (lateBy > rule.graceMinutes) return { status: 'late', lateMinutes: lateBy, earlyExit };
  return { status: 'present', lateMinutes: 0, earlyExit };
}

// ---------------------------------------------------------------- biometric import
export interface ColumnMapping {
  employeeCode: string;
  date: string;
  checkIn: string;
  checkOut?: string;
  /** e.g. 'DD-MM-YYYY', 'YYYY-MM-DD', 'DD/MM/YYYY', 'MM/DD/YYYY' */
  dateFormat: string;
}

export interface ParsedPunch {
  row: number;
  employeeCode: string;
  date: ISODate;
  checkIn: string | null;
  checkOut: string | null;
}

export interface RowError {
  row: number;
  error: 'missing_employee_code' | 'bad_date' | 'bad_time';
  value?: string;
}

export function parseDate(v: string, format: string): ISODate | null {
  const s = v.trim();
  const parts = s.split(/[-/.]/);
  if (parts.length !== 3) return null;
  const f = format.toUpperCase().split(/[-/.]/);
  const get = (k: string) => {
    const i = f.indexOf(k);
    return i >= 0 ? parts[i] : undefined;
  };
  const y = Number(get('YYYY'));
  const m = Number(get('MM'));
  const d = Number(get('DD'));
  if (!y || !m || !d || m > 12 || d > 31) return null;
  const iso = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const check = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(check.getTime()) || check.toISOString().slice(0, 10) !== iso) return null;
  return iso;
}

export function parseTime(v: string | undefined): string | null | 'bad' {
  if (v == null || v.trim() === '') return null;
  const m = v.trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?$/i);
  if (!m) return 'bad';
  let h = Number(m[1]);
  const min = Number(m[2]);
  if (m[3]) {
    const pm = m[3].toUpperCase() === 'PM';
    if (h === 12) h = pm ? 12 : 0;
    else if (pm) h += 12;
  }
  if (h > 23 || min > 59) return 'bad';
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

export function parseBiometricRows(rows: Record<string, string>[], map: ColumnMapping): { punches: ParsedPunch[]; errors: RowError[] } {
  const punches: ParsedPunch[] = [];
  const errors: RowError[] = [];
  rows.forEach((r, idx) => {
    const row = idx + 2; // header is row 1
    const code = (r[map.employeeCode] ?? '').trim();
    if (!code) return errors.push({ row, error: 'missing_employee_code' });
    const date = parseDate(r[map.date] ?? '', map.dateFormat);
    if (!date) return errors.push({ row, error: 'bad_date', value: r[map.date] });
    const ci = parseTime(r[map.checkIn]);
    const co = map.checkOut ? parseTime(r[map.checkOut]) : null;
    if (ci === 'bad' || co === 'bad') return errors.push({ row, error: 'bad_time', value: `${r[map.checkIn]} ${map.checkOut ? r[map.checkOut] : ''}` });
    punches.push({ row, employeeCode: code, date, checkIn: ci, checkOut: co });
  });
  // Several punches for one person-day collapse to earliest in / latest out.
  const merged = new Map<string, ParsedPunch>();
  for (const p of punches) {
    const k = `${p.employeeCode}|${p.date}`;
    const prev = merged.get(k);
    if (!prev) merged.set(k, { ...p });
    else {
      if (p.checkIn && (!prev.checkIn || p.checkIn < prev.checkIn)) prev.checkIn = p.checkIn;
      if (p.checkOut && (!prev.checkOut || p.checkOut > prev.checkOut)) prev.checkOut = p.checkOut;
    }
  }
  return { punches: [...merged.values()], errors };
}

export interface ExistingDay {
  checkIn: string | null;
  checkOut: string | null;
  source: 'app' | 'biometric' | 'merged' | 'manual' | 'regularised';
}

/** Conflict threshold: app and device times further apart than this are listed for the admin. */
export const MERGE_CONFLICT_MINUTES = 15;

/**
 * Merge an imported punch with an existing app record. Earliest check-in and latest check-out
 * win; a difference beyond the threshold is reported as a conflict (both values kept).
 */
export function mergePunch(existing: ExistingDay | null, punch: ParsedPunch): { checkIn: string | null; checkOut: string | null; source: ExistingDay['source']; conflict: { field: 'check_in' | 'check_out'; app: string; device: string }[] } {
  if (!existing) return { checkIn: punch.checkIn, checkOut: punch.checkOut, source: 'biometric', conflict: [] };
  if (existing.source === 'manual' || existing.source === 'regularised') {
    return { checkIn: existing.checkIn, checkOut: existing.checkOut, source: existing.source, conflict: [] };
  }
  const conflict: { field: 'check_in' | 'check_out'; app: string; device: string }[] = [];
  const diff = (a: string, b: string) => Math.abs(hhmmToMinutes(a) - hhmmToMinutes(b));
  if (existing.checkIn && punch.checkIn && diff(existing.checkIn, punch.checkIn) > MERGE_CONFLICT_MINUTES) conflict.push({ field: 'check_in', app: existing.checkIn, device: punch.checkIn });
  if (existing.checkOut && punch.checkOut && diff(existing.checkOut, punch.checkOut) > MERGE_CONFLICT_MINUTES) conflict.push({ field: 'check_out', app: existing.checkOut, device: punch.checkOut });
  const min = (a: string | null, b: string | null) => (a && b ? (a < b ? a : b) : a ?? b);
  const max = (a: string | null, b: string | null) => (a && b ? (a > b ? a : b) : a ?? b);
  return { checkIn: min(existing.checkIn, punch.checkIn), checkOut: max(existing.checkOut, punch.checkOut), source: 'merged', conflict };
}

// ---------------------------------------------------------------- student attendance
export type StudentMark = 'present' | 'absent' | 'late' | 'half_day' | 'on_duty' | 'leave';

/** Attendance value of a mark for percentage calculations. */
export function markValue(m: StudentMark): number {
  switch (m) {
    case 'present':
    case 'late':
    case 'on_duty':
      return 1;
    case 'half_day':
      return 0.5;
    default:
      return 0;
  }
}

export function attendancePct(marks: StudentMark[]): number {
  if (!marks.length) return 100;
  return Math.round((marks.reduce((s, m) => s + markValue(m), 0) / marks.length) * 1000) / 10;
}

/** Longest current run of consecutive absences (marks ordered oldest -> newest). */
export function consecutiveAbsences(marks: StudentMark[]): number {
  let n = 0;
  for (let i = marks.length - 1; i >= 0; i--) {
    if (marks[i] === 'absent') n++;
    else break;
  }
  return n;
}

export function daySummary(marks: StudentMark[]): Record<StudentMark | 'total', number> {
  const s: Record<StudentMark | 'total', number> = { present: 0, absent: 0, late: 0, half_day: 0, on_duty: 0, leave: 0, total: marks.length };
  for (const m of marks) s[m]++;
  return s;
}

/** Sessions required per day for a wing mode. */
export function sessionKeysFor(mode: 'daily_once' | 'daily_twice' | 'period', teachingPeriods: number): string[] {
  if (mode === 'daily_once') return ['day'];
  if (mode === 'daily_twice') return ['am', 'pm'];
  return Array.from({ length: teachingPeriods }, (_, i) => `p${i + 1}`);
}

/** Can a submitted session be edited directly, or does it need approval? */
export function editPolicy(submittedAt: Date, now: Date, windowMinutes: number): 'reason_required' | 'approval_required' {
  return now.getTime() - submittedAt.getTime() <= windowMinutes * 60000 ? 'reason_required' : 'approval_required';
}
