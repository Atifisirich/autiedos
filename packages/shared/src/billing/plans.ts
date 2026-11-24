/**
 * Plan pricing model (pure). Prices are per PRODUCT (decision #45: whole products only), stored
 * ex-GST in paise. A plan is either per-student (price x billable students) or flat (price with
 * included seats and an optional per-extra-seat price).
 *
 * Mid-cycle start (monthly plans): the first, partial month is charged pro rata by calendar days
 * (inclusive of the start day) and recurring billing then runs on the 1st of each month. Yearly
 * plans run from the start date for 12 months with no proration. In Razorpay terms the pro-rata
 * stub is a one-off add-on on the first charge and the subscription's start_at is the first of the
 * next month (see adapters/payments.ts; Razorpay behaviour for add-ons is UNVERIFIED).
 */
import { parseISODate, toLocal } from '../time';
import { divRoundHalfUp } from './money';

export const PRODUCT_KEYS = ['crm', 'os', 'erp'] as const;
export type ProductKey = (typeof PRODUCT_KEYS)[number];

export type BillingInterval = 'monthly' | 'yearly';

export type PlanPricing =
  | {
      model: 'per_student';
      /** Price per billable student per interval, ex-GST paise. */
      unitPricePaise: number;
      /** Minimum students billed even if fewer are enrolled. */
      minBillableStudents?: number;
    }
  | {
      model: 'flat';
      /** Flat price per interval, ex-GST paise. */
      flatPricePaise: number;
      /** Seats (staff logins) covered by the flat price. */
      includedSeats: number;
      /** Price per extra seat per interval; when absent, going over includedSeats is refused. */
      extraSeatPricePaise?: number;
    };

export interface Plan {
  key: string;
  productKey: ProductKey;
  name: string;
  interval: BillingInterval;
  pricing: PlanPricing;
  /** Free trial length in days; 0 = none. */
  trialDays: number;
  currency: 'INR';
}

export interface CyclePrice {
  /** Seats actually billed (after minimums). */
  billedSeats: number;
  /** Ex-GST amount for one full billing interval. */
  amountPaise: number;
  /** Itemised lines ex-GST: [{ label, quantity, unitPricePaise }] summing to amountPaise. */
  lines: { label: string; quantity: number; unitPricePaise: number }[];
}

function assertPos(name: string, v: number, min: number): void {
  if (!Number.isSafeInteger(v) || v < min) throw new RangeError(`${name} must be an integer >= ${min} (got ${v})`);
}

/** Ex-GST price of one full interval for `seats` (students for per_student plans, staff seats for flat). */
export function priceForCycle(plan: Plan, seats: number): CyclePrice {
  assertPos('seats', seats, 0);
  const p = plan.pricing;
  if (p.model === 'per_student') {
    const billedSeats = Math.max(seats, p.minBillableStudents ?? 0);
    return {
      billedSeats,
      amountPaise: billedSeats * p.unitPricePaise,
      lines: [{ label: `${plan.name} - per student`, quantity: billedSeats, unitPricePaise: p.unitPricePaise }],
    };
  }
  const extra = Math.max(0, seats - p.includedSeats);
  if (extra > 0 && p.extraSeatPricePaise === undefined) {
    throw new RangeError(`Plan ${plan.key} includes ${p.includedSeats} seats; ${seats} requested`);
  }
  const lines = [{ label: `${plan.name} - flat`, quantity: 1, unitPricePaise: p.flatPricePaise }];
  if (extra > 0) lines.push({ label: `${plan.name} - extra seat`, quantity: extra, unitPricePaise: p.extraSeatPricePaise! });
  return {
    billedSeats: Math.max(seats, p.includedSeats),
    amountPaise: p.flatPricePaise + extra * (p.extraSeatPricePaise ?? 0),
    lines,
  };
}

export function daysInMonth(year: number, month1to12: number): number {
  return new Date(Date.UTC(year, month1to12, 0)).getUTCDate();
}

/** First day of the month after `isoDate`. */
export function firstOfNextMonth(isoDate: string): string {
  const [y, m] = isoDate.split('-').map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
}

/** Same calendar day one year later (29 Feb clamps to 28 Feb). */
export function plusOneYear(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number];
  const dd = m === 2 && d === 29 ? 28 : d;
  return `${y + 1}-${String(m).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}

/** Pro-rata amount: full * daysCharged / daysInPeriod, rounded half-up to the paisa. */
export function prorate(fullAmountPaise: number, daysCharged: number, daysInPeriod: number): number {
  assertPos('fullAmountPaise', fullAmountPaise, 0);
  assertPos('daysInPeriod', daysInPeriod, 1);
  assertPos('daysCharged', daysCharged, 0);
  if (daysCharged > daysInPeriod) throw new RangeError('daysCharged exceeds daysInPeriod');
  return divRoundHalfUp(fullAmountPaise * daysCharged, daysInPeriod);
}

export interface FirstCycle {
  /** End of the free trial (instant), or null when the plan has no trial. */
  trialEndsAt: Date | null;
  /** IST date on which billing starts (trial end date, or the start date). */
  billingStartsOn: string;
  /** Exclusive end of the first billing period ("YYYY-MM-DD"). Next period starts here. */
  firstPeriodEndsOn: string;
  daysCharged: number;
  daysInPeriod: number;
  /** Ex-GST price of a full interval at these seats. */
  fullCyclePaise: number;
  /** Ex-GST amount for the first (possibly partial) period. */
  firstChargePaise: number;
  prorated: boolean;
}

/** What a client owes for their first period when they start (or their trial ends) at `startedAt`. */
export function firstCycle(plan: Plan, seats: number, startedAt: Date): FirstCycle {
  assertPos('trialDays', plan.trialDays, 0);
  const trialEndsAt = plan.trialDays > 0 ? new Date(startedAt.getTime() + plan.trialDays * 86400000) : null;
  const billingStartsOn = toLocal(trialEndsAt ?? startedAt, 'Asia/Kolkata').date;
  const fullCyclePaise = priceForCycle(plan, seats).amountPaise;

  if (plan.interval === 'yearly') {
    const end = plusOneYear(billingStartsOn);
    const days = Math.round((parseISODate(end).getTime() - parseISODate(billingStartsOn).getTime()) / 86400000);
    return { trialEndsAt, billingStartsOn, firstPeriodEndsOn: end, daysCharged: days, daysInPeriod: days, fullCyclePaise, firstChargePaise: fullCyclePaise, prorated: false };
  }

  const [y, m, d] = billingStartsOn.split('-').map(Number) as [number, number, number];
  const dim = daysInMonth(y, m);
  const daysCharged = dim - d + 1;
  return {
    trialEndsAt,
    billingStartsOn,
    firstPeriodEndsOn: firstOfNextMonth(billingStartsOn),
    daysCharged,
    daysInPeriod: dim,
    fullCyclePaise,
    firstChargePaise: prorate(fullCyclePaise, daysCharged, dim),
    prorated: daysCharged !== dim,
  };
}

/** End (exclusive) of the billing period that starts on `periodStart`, after the first stub. */
export function nextPeriodEnd(plan: Pick<Plan, 'interval'>, periodStart: string): string {
  return plan.interval === 'yearly' ? plusOneYear(periodStart) : firstOfNextMonth(periodStart);
}
