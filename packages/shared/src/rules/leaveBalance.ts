/**
 * Leave rules engine (PRD 5.6): day counting (working days, half days, sandwich rule)
 * and balances (yearly / monthly accrual, carry forward, pending requests).
 */
import { eachDate, isWorkingDay, parseISODate, type ISODate } from '../time';

export interface LeaveTypeRule {
  unit: 'day' | 'hour';
  yearlyQuota: number;
  accrual: 'yearly' | 'monthly';
  carryForward: boolean;
  carryForwardMax: number;
  halfDayAllowed: boolean;
  noticeDays: number;
  docRequiredAfterDays: number | null;
  sandwichRule: boolean;
}

export interface LeaveRequestLite {
  startDate: ISODate;
  endDate: ISODate;
  days: number;
  status: 'pending' | 'approved' | 'rejected' | 'returned' | 'cancelled';
}

export interface DayCountInput {
  startDate: ISODate;
  endDate: ISODate;
  halfDay: 'none' | 'first' | 'second';
  hours?: number;
}

export interface CalendarLite {
  workingDays: number[];
  holidays: ISODate[];
  extraWorkingDays?: ISODate[];
}

export type LeaveValidationError =
  | 'end_before_start'
  | 'half_day_not_allowed'
  | 'half_day_single_day_only'
  | 'notice_too_short'
  | 'document_required'
  | 'no_working_days'
  | 'insufficient_balance'
  | 'hours_required';

/** Number of leave days a request consumes. */
export function countLeaveDays(input: DayCountInput, type: Pick<LeaveTypeRule, 'sandwichRule' | 'unit'>, cal: CalendarLite): number {
  if (type.unit === 'hour') return input.hours ?? 0;
  if (input.endDate < input.startDate) return 0;
  const dates = eachDate(input.startDate, input.endDate);
  const working = dates.map((d) => isWorkingDay(d, cal));
  const first = working.indexOf(true);
  const last = working.lastIndexOf(true);
  if (first === -1) return 0;
  let days: number;
  if (type.sandwichRule) {
    // Every day between the first and last working leave day counts, including holidays.
    days = last - first + 1;
  } else {
    days = working.filter(Boolean).length;
  }
  if (input.halfDay !== 'none' && days === 1) return 0.5;
  return days;
}

export function validateLeave(
  input: DayCountInput,
  type: LeaveTypeRule,
  cal: CalendarLite,
  today: ISODate,
  opts: { hasAttachment: boolean; available: number },
): { days: number; errors: LeaveValidationError[] } {
  const errors: LeaveValidationError[] = [];
  if (input.endDate < input.startDate) return { days: 0, errors: ['end_before_start'] };
  if (type.unit === 'hour' && !(input.hours && input.hours > 0)) errors.push('hours_required');
  if (input.halfDay !== 'none') {
    if (!type.halfDayAllowed) errors.push('half_day_not_allowed');
    if (input.startDate !== input.endDate) errors.push('half_day_single_day_only');
  }
  const days = countLeaveDays(input, type, cal);
  if (type.unit === 'day' && days === 0) errors.push('no_working_days');
  const noticeGiven = Math.round((parseISODate(input.startDate).getTime() - parseISODate(today).getTime()) / 86400000);
  if (type.noticeDays > 0 && noticeGiven < type.noticeDays) errors.push('notice_too_short');
  if (type.docRequiredAfterDays != null && days > type.docRequiredAfterDays && !opts.hasAttachment) errors.push('document_required');
  if (type.yearlyQuota > 0 && days > opts.available) errors.push('insufficient_balance');
  return { days, errors };
}

export interface BalanceInput {
  type: LeaveTypeRule;
  yearStart: ISODate;
  yearEnd: ISODate;
  asOf: ISODate;
  joinedOn?: ISODate | null;
  opening: number;
  adjusted: number;
  requests: LeaveRequestLite[];
}

export interface LeaveBalance {
  entitledYear: number;
  accrued: number;
  used: number;
  pending: number;
  available: number;
  requestable: number;
  carryForwardNext: number;
}

function monthsBetweenStarts(from: ISODate, to: ISODate): number {
  const a = parseISODate(from);
  const b = parseISODate(to);
  return (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth()) + 1;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
/** Round down to the nearest half day. */
const floorHalf = (n: number) => Math.floor(n * 2 + 1e-9) / 2;

export function leaveBalance(i: BalanceInput): LeaveBalance {
  const totalMonths = monthsBetweenStarts(i.yearStart, i.yearEnd);
  const effectiveStart = i.joinedOn && i.joinedOn > i.yearStart ? i.joinedOn : i.yearStart;
  const serviceMonths = Math.max(0, monthsBetweenStarts(effectiveStart, i.yearEnd));
  // Entitlement for the year, pro-rated for joiners by whole months remaining.
  const entitledYear =
    effectiveStart === i.yearStart ? i.type.yearlyQuota : floorHalf((i.type.yearlyQuota * serviceMonths) / totalMonths);

  let accrued: number;
  if (i.asOf < effectiveStart) accrued = 0;
  else if (i.type.accrual === 'yearly') accrued = entitledYear;
  else {
    const asOf = i.asOf > i.yearEnd ? i.yearEnd : i.asOf;
    const monthsElapsed = Math.min(serviceMonths, monthsBetweenStarts(effectiveStart, asOf));
    accrued = round2((i.type.yearlyQuota / totalMonths) * monthsElapsed);
  }

  const inYear = (r: LeaveRequestLite) => r.startDate >= i.yearStart && r.startDate <= i.yearEnd;
  const used = round2(i.requests.filter((r) => r.status === 'approved' && inYear(r)).reduce((s, r) => s + r.days, 0));
  const pending = round2(i.requests.filter((r) => r.status === 'pending' && inYear(r)).reduce((s, r) => s + r.days, 0));
  const available = round2(i.opening + accrued + i.adjusted - used);
  const requestable = round2(available - pending);
  const unusedAtYearEnd = Math.max(0, i.opening + entitledYear + i.adjusted - used);
  const carryForwardNext = i.type.carryForward ? round2(Math.min(unusedAtYearEnd, i.type.carryForwardMax)) : 0;
  return { entitledYear, accrued, used, pending, available, requestable, carryForwardNext };
}
