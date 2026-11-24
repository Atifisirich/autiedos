import { describe, expect, it } from 'vitest';
import { firstCycle, firstOfNextMonth, nextPeriodEnd, planSchema, plusOneYear, priceForCycle, prorate, type Plan } from '../src';

const perStudent: Plan = {
  key: 'os-student',
  productKey: 'os',
  name: 'AutoEd OS',
  interval: 'monthly',
  pricing: { model: 'per_student', unitPricePaise: 5000, minBillableStudents: 100 },
  trialDays: 0,
  currency: 'INR',
};
const flat: Plan = {
  key: 'crm-flat',
  productKey: 'crm',
  name: 'AutoEd CRM',
  interval: 'monthly',
  pricing: { model: 'flat', flatPricePaise: 300000, includedSeats: 5, extraSeatPricePaise: 40000 },
  trialDays: 14,
  currency: 'INR',
};
const ist = (s: string) => new Date(`${s}+05:30`);

describe('priceForCycle', () => {
  it('per-student multiplies and honours the minimum', () => {
    expect(priceForCycle(perStudent, 200)).toMatchObject({ billedSeats: 200, amountPaise: 1000000 });
    expect(priceForCycle(perStudent, 40)).toMatchObject({ billedSeats: 100, amountPaise: 500000 });
    expect(priceForCycle(perStudent, 0).amountPaise).toBe(500000);
  });
  it('flat covers included seats, charges extras, or refuses', () => {
    expect(priceForCycle(flat, 3)).toMatchObject({ billedSeats: 5, amountPaise: 300000 });
    const eight = priceForCycle(flat, 8);
    expect(eight.amountPaise).toBe(300000 + 3 * 40000);
    expect(eight.lines.reduce((a, l) => a + l.quantity * l.unitPricePaise, 0)).toBe(eight.amountPaise);
    const capped: Plan = { ...flat, pricing: { model: 'flat', flatPricePaise: 300000, includedSeats: 5 } };
    expect(() => priceForCycle(capped, 6)).toThrow(/includes 5 seats/);
    expect(() => priceForCycle(flat, -1)).toThrow();
  });
});

describe('proration', () => {
  it('rounds half up and validates', () => {
    expect(prorate(5, 1, 2)).toBe(3);
    expect(prorate(1000000, 15, 30)).toBe(500000);
    expect(prorate(10001, 10, 31)).toBe(3226); // 3226.45
    expect(() => prorate(100, 32, 31)).toThrow();
  });
  it('mid-month start charges the remaining days inclusive of the start day', () => {
    const c = firstCycle(perStudent, 200, ist('2026-11-16T10:00:00')); // November has 30 days: 16..30 = 15 days
    expect(c).toMatchObject({ billingStartsOn: '2026-11-16', firstPeriodEndsOn: '2026-12-01', daysCharged: 15, daysInPeriod: 30, fullCyclePaise: 1000000, firstChargePaise: 500000, prorated: true, trialEndsAt: null });
  });
  it('start on the 1st is a full month; last day is one day', () => {
    expect(firstCycle(perStudent, 200, ist('2026-11-01T00:00:00'))).toMatchObject({ daysCharged: 30, firstChargePaise: 1000000, prorated: false });
    expect(firstCycle(perStudent, 200, ist('2026-12-31T23:00:00'))).toMatchObject({ daysCharged: 1, firstPeriodEndsOn: '2027-01-01', firstChargePaise: Math.round(1000000 / 31) });
  });
  it('uses the IST date, not the UTC date', () => {
    // 2026-11-30T20:00Z is 1 Dec 01:30 IST
    expect(firstCycle(perStudent, 200, new Date('2026-11-30T20:00:00Z')).billingStartsOn).toBe('2026-12-01');
  });
  it('February in a non-leap and leap year', () => {
    expect(firstCycle(perStudent, 100, ist('2027-02-15T09:00:00'))).toMatchObject({ daysCharged: 14, daysInPeriod: 28 });
    expect(firstCycle(perStudent, 100, ist('2028-02-15T09:00:00'))).toMatchObject({ daysCharged: 15, daysInPeriod: 29 });
  });
  it('billing starts after the trial', () => {
    const c = firstCycle(flat, 5, ist('2026-11-24T10:00:00')); // trial 14 days -> ends 8 Dec 10:00 IST
    expect(c.trialEndsAt?.toISOString()).toBe(ist('2026-12-08T10:00:00').toISOString());
    expect(c).toMatchObject({ billingStartsOn: '2026-12-08', daysCharged: 24, daysInPeriod: 31, fullCyclePaise: 300000, firstChargePaise: prorate(300000, 24, 31) });
  });
  it('yearly plans are not prorated', () => {
    const yearly: Plan = { ...flat, interval: 'yearly', trialDays: 0, pricing: { model: 'flat', flatPricePaise: 3000000, includedSeats: 5 } };
    expect(firstCycle(yearly, 5, ist('2026-11-24T10:00:00'))).toMatchObject({ billingStartsOn: '2026-11-24', firstPeriodEndsOn: '2027-11-24', firstChargePaise: 3000000, prorated: false });
    expect(plusOneYear('2028-02-29')).toBe('2029-02-28');
  });
  it('calendar helpers', () => {
    expect(firstOfNextMonth('2026-12-15')).toBe('2027-01-01');
    expect(firstOfNextMonth('2026-02-28')).toBe('2026-03-01');
    expect(nextPeriodEnd({ interval: 'monthly' }, '2026-12-01')).toBe('2027-01-01');
    expect(nextPeriodEnd({ interval: 'yearly' }, '2026-12-01')).toBe('2027-12-01');
  });
});

describe('planSchema', () => {
  it('accepts valid plans and rejects fractional paise or unknown products', () => {
    expect(planSchema.safeParse(perStudent).success).toBe(true);
    expect(planSchema.safeParse(flat).success).toBe(true);
    expect(planSchema.safeParse({ ...perStudent, productKey: 'hr' }).success).toBe(false);
    expect(planSchema.safeParse({ ...perStudent, pricing: { model: 'per_student', unitPricePaise: 50.5 } }).success).toBe(false);
    expect(planSchema.safeParse({ ...perStudent, currency: 'USD' }).success).toBe(false);
  });
});
