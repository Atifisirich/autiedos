import { describe, expect, it } from 'vitest';
import {
  canAssign,
  isBelow,
  escalationSchedule,
  nextEscalation,
  dueEscalation,
  DEFAULT_ESCALATION,
  countLeaveDays,
  leaveBalance,
  validateLeave,
  rankSubstitutes,
  detectClashes,
  clashesForMove,
  creditCost,
  checkCredits,
  crossedThresholds,
  type LeaveTypeRule,
  type SubCandidate,
  type WorkCalendar,
} from '../src';

const cal: WorkCalendar = { workingDays: [1, 2, 3, 4, 5, 6], holidays: ['2026-11-18'], dayStart: '08:00', dayEnd: '16:00', timeZone: 'Asia/Kolkata' };
const ist = (s: string) => new Date(`${s}+05:30`);

describe('canAssign', () => {
  const graph = {
    reportsTo: { principal: null, coord: 'principal', hod: 'coord', teacher: 'hod', teacher2: 'hod', admin: 'principal' },
    secondary: { teacher3: ['hod'] },
    roles: { principal: ['r_pr'], coord: ['r_co'], hod: ['r_hod'], teacher: ['r_t'], teacher2: ['r_t'], teacher3: ['r_t'], admin: ['r_admin'] },
  };
  it('lets a manager assign to anyone below in the tree', () => {
    expect(canAssign('principal', 'teacher', graph, [])).toEqual({ mode: 'assign', reason: 'below_in_tree' });
    expect(canAssign('hod', 'teacher3', graph, [])).toEqual({ mode: 'assign', reason: 'below_in_tree' });
  });
  it('makes peers and upward a request', () => {
    expect(canAssign('teacher', 'teacher2', graph, []).mode).toBe('request');
    expect(canAssign('teacher', 'principal', graph, []).mode).toBe('request');
  });
  it('self is always assign', () => {
    expect(canAssign('teacher', 'teacher', graph, []).reason).toBe('self');
  });
  it('explicit rules override the tree, most permissive wins', () => {
    const rules = [
      { fromRoleId: 'r_admin', toRoleId: 'r_t', rule: 'assign' as const },
      { fromRoleId: 'r_t', toRoleId: 'r_t', rule: 'none' as const },
    ];
    expect(canAssign('admin', 'teacher', graph, rules)).toEqual({ mode: 'assign', reason: 'explicit_rule' });
    expect(canAssign('teacher', 'teacher2', graph, rules).mode).toBe('none');
    const multi = { ...graph, roles: { ...graph.roles, teacher: ['r_t', 'r_hod'] } };
    expect(canAssign('teacher', 'teacher2', multi, [...rules, { fromRoleId: 'r_hod', toRoleId: 'r_t', rule: 'request' }]).mode).toBe('request');
  });
  it('handles cycles without hanging', () => {
    expect(isBelow('a', 'z', { reportsTo: { a: 'b', b: 'a' }, roles: {} })).toBe(false);
  });
});

describe('nextEscalation', () => {
  const task = { dueAt: ist('2026-11-16T12:00:00'), priority: 'normal' as const, status: 'todo', lastEscalationLevel: 0 };
  it('builds the default schedule in working time', () => {
    const s = escalationSchedule(task, DEFAULT_ESCALATION, cal);
    expect(s.map((x) => x.kind)).toEqual(['reminder', 'due', 'overdue_assigner', 'overdue_manager']);
    expect(s[0]!.at).toEqual(ist('2026-11-16T10:00:00'));
    expect(s[1]!.at).toEqual(ist('2026-11-16T12:00:00'));
    // 4 working hours after 12:00 = 16:00 same day
    expect(s[2]!.at).toEqual(ist('2026-11-16T16:00:00'));
    // 1 working day (480 min) after Mon 12:00 = Tue 12:00
    expect(s[3]!.at).toEqual(ist('2026-11-17T12:00:00'));
  });
  it('skips holidays and out-of-hours', () => {
    const t = { ...task, dueAt: ist('2026-11-17T14:00:00') }; // Tue; Wed 18 is a holiday
    const s = escalationSchedule(t, DEFAULT_ESCALATION, cal);
    // 240 working minutes from Tue 14:00: 120 on Tue, then Thu 08:00 + 120 = 10:00
    expect(s[2]!.at).toEqual(ist('2026-11-19T10:00:00'));
    expect(s[3]!.at).toEqual(ist('2026-11-19T14:00:00'));
  });
  it('urgent tasks escalate at half the intervals', () => {
    const s = escalationSchedule({ ...task, priority: 'urgent' }, DEFAULT_ESCALATION, cal);
    expect(s[0]!.at).toEqual(ist('2026-11-16T11:00:00'));
    expect(s[2]!.at).toEqual(ist('2026-11-16T14:00:00'));
    expect(s[3]!.at).toEqual(ist('2026-11-16T16:00:00'));
  });
  it('returns the next unfired step and whether it is due', () => {
    const n = nextEscalation({ ...task, lastEscalationLevel: 1 }, DEFAULT_ESCALATION, cal, ist('2026-11-16T12:30:00'));
    expect(n?.level).toBe(2);
    expect(n?.due).toBe(true);
    expect(nextEscalation({ ...task, status: 'done' }, DEFAULT_ESCALATION, cal, ist('2026-11-16T12:30:00'))).toBeNull();
  });
  it('fires only the latest due step after a delay', () => {
    const d = dueEscalation(task, DEFAULT_ESCALATION, cal, ist('2026-11-16T16:30:00'));
    expect(d?.level).toBe(3);
  });
});

describe('leave', () => {
  const casual: LeaveTypeRule = { unit: 'day', yearlyQuota: 12, accrual: 'monthly', carryForward: false, carryForwardMax: 0, halfDayAllowed: true, noticeDays: 0, docRequiredAfterDays: null, sandwichRule: false };
  const lcal = { workingDays: [1, 2, 3, 4, 5, 6], holidays: ['2026-11-18'] };
  it('counts working days excluding Sundays and holidays', () => {
    // Mon 16 .. Mon 23: 8 days, minus Wed 18 holiday, minus Sun 22 = 6
    expect(countLeaveDays({ startDate: '2026-11-16', endDate: '2026-11-23', halfDay: 'none' }, casual, lcal)).toBe(6);
  });
  it('applies the sandwich rule', () => {
    // Sat 21 .. Mon 23 with sandwich: Sunday counts
    expect(countLeaveDays({ startDate: '2026-11-21', endDate: '2026-11-23', halfDay: 'none' }, { ...casual, sandwichRule: true }, lcal)).toBe(3);
    expect(countLeaveDays({ startDate: '2026-11-21', endDate: '2026-11-23', halfDay: 'none' }, casual, lcal)).toBe(2);
    // leading/trailing non-working days are not counted even with sandwich rule
    expect(countLeaveDays({ startDate: '2026-11-22', endDate: '2026-11-23', halfDay: 'none' }, { ...casual, sandwichRule: true }, lcal)).toBe(1);
  });
  it('half day only for single days', () => {
    expect(countLeaveDays({ startDate: '2026-11-16', endDate: '2026-11-16', halfDay: 'first' }, casual, lcal)).toBe(0.5);
    const v = validateLeave({ startDate: '2026-11-16', endDate: '2026-11-17', halfDay: 'first' }, casual, lcal, '2026-11-10', { hasAttachment: false, available: 10 });
    expect(v.errors).toContain('half_day_single_day_only');
  });
  it('validates notice, documents and balance', () => {
    const sick: LeaveTypeRule = { ...casual, noticeDays: 2, docRequiredAfterDays: 2 };
    const v = validateLeave({ startDate: '2026-11-16', endDate: '2026-11-20', halfDay: 'none' }, sick, lcal, '2026-11-15', { hasAttachment: false, available: 3 });
    expect(v.days).toBe(4);
    expect(v.errors).toEqual(expect.arrayContaining(['notice_too_short', 'document_required', 'insufficient_balance']));
  });
  const year = { yearStart: '2026-04-01', yearEnd: '2027-03-31' };
  it('monthly accrual counts started months', () => {
    const b = leaveBalance({ type: casual, ...year, asOf: '2026-11-16', opening: 0, adjusted: 0, requests: [] });
    expect(b.accrued).toBe(8); // Apr..Nov = 8 months
    expect(b.entitledYear).toBe(12);
  });
  it('yearly accrual grants the full quota and pro-rates joiners', () => {
    const earned: LeaveTypeRule = { ...casual, accrual: 'yearly', yearlyQuota: 15, carryForward: true, carryForwardMax: 10 };
    const b = leaveBalance({ type: earned, ...year, asOf: '2026-04-01', opening: 3, adjusted: 0, requests: [{ startDate: '2026-05-04', endDate: '2026-05-05', days: 2, status: 'approved' }, { startDate: '2026-06-01', endDate: '2026-06-01', days: 1, status: 'pending' }] });
    expect(b).toMatchObject({ accrued: 15, used: 2, pending: 1, available: 16, requestable: 15, carryForwardNext: 10 });
    const joiner = leaveBalance({ type: earned, ...year, asOf: '2026-11-16', joinedOn: '2026-10-01', opening: 0, adjusted: 0, requests: [] });
    expect(joiner.entitledYear).toBe(7.5); // 6 of 12 months
    const beforeJoin = leaveBalance({ type: earned, ...year, asOf: '2026-09-01', joinedOn: '2026-10-01', opening: 0, adjusted: 0, requests: [] });
    expect(beforeJoin.accrued).toBe(0);
  });
  it('ignores requests from other years and cancelled ones', () => {
    const b = leaveBalance({ type: casual, ...year, asOf: '2027-03-31', opening: 0, adjusted: 1, requests: [{ startDate: '2026-03-30', endDate: '2026-03-30', days: 1, status: 'approved' }, { startDate: '2026-12-01', endDate: '2026-12-01', days: 1, status: 'cancelled' }] });
    expect(b).toMatchObject({ accrued: 12, used: 0, available: 13, carryForwardNext: 0 });
  });
});

describe('rankSubstitutes', () => {
  const base: Omit<SubCandidate, 'staffId' | 'name'> = { subjectIds: [], wingId: 'w1', sectionIds: [], busy: false, onDuty: false, inExamDuty: false, absent: false, periodsToday: 3, maxPeriodsDay: 6, subsThisWeek: 0, subsThisMonth: 0 };
  const slot = { sectionId: 's1', subjectId: 'math', wingId: 'w1' };
  it('orders by subject+wing, section, week subs, month subs, load', () => {
    const c: SubCandidate[] = [
      { ...base, staffId: 'a', name: 'A', subsThisWeek: 2 },
      { ...base, staffId: 'b', name: 'B', sectionIds: ['s1'] },
      { ...base, staffId: 'c', name: 'C', subjectIds: ['math'], subsThisWeek: 3 },
      { ...base, staffId: 'd', name: 'D', subjectIds: ['math'], wingId: 'w2' },
      { ...base, staffId: 'e', name: 'E', subsThisWeek: 2, subsThisMonth: 1 },
      { ...base, staffId: 'f', name: 'F', subsThisWeek: 2, periodsToday: 1 },
    ];
    const r = rankSubstitutes(slot, c).ranked.map((x) => x.staffId);
    expect(r).toEqual(['c', 'b', 'd', 'f', 'a', 'e']);
  });
  it('excludes busy, on duty, exams, absent and limit', () => {
    const c: SubCandidate[] = [
      { ...base, staffId: 'busy', name: '1', busy: true },
      { ...base, staffId: 'duty', name: '2', onDuty: true },
      { ...base, staffId: 'exam', name: '3', inExamDuty: true },
      { ...base, staffId: 'abs', name: '4', absent: true },
      { ...base, staffId: 'full', name: '5', periodsToday: 6 },
      { ...base, staffId: 'ok', name: '6' },
    ];
    const r = rankSubstitutes(slot, c);
    expect(r.ranked.map((x) => x.staffId)).toEqual(['ok']);
    expect(r.excluded.map((x) => x.reason)).toEqual(['busy', 'on_duty', 'exam_duty', 'absent', 'daily_limit']);
  });
});

describe('detectClashes', () => {
  it('finds teacher, section and room clashes', () => {
    const c = detectClashes([
      { id: '1', day: 1, periodSeq: 1, sectionId: 'A', staffId: 't1', roomId: 'r1' },
      { id: '2', day: 1, periodSeq: 1, sectionId: 'B', staffId: 't1', roomId: 'r1' },
      { id: '3', day: 1, periodSeq: 1, sectionId: 'A', staffId: 't2', roomId: null },
    ]);
    expect(c.map((x) => x.type).sort()).toEqual(['room', 'section', 'teacher']);
  });
  it('allows split groups and combined sections', () => {
    const c = detectClashes([
      { id: '1', day: 1, periodSeq: 2, sectionId: 'A', staffId: 'hindi', roomId: null, groupKey: 'L2' },
      { id: '2', day: 1, periodSeq: 2, sectionId: 'A', staffId: 'telugu', roomId: null, groupKey: 'L2' },
      { id: '3', day: 1, periodSeq: 3, sectionId: 'A', staffId: 'pe', roomId: 'ground', combinedKey: 'games' },
      { id: '4', day: 1, periodSeq: 3, sectionId: 'B', staffId: 'pe', roomId: 'ground', combinedKey: 'games' },
    ]);
    expect(c).toEqual([]);
  });
  it('checks limits and unavailable slots', () => {
    const es = [1, 2, 3].map((p) => ({ id: `e${p}`, day: 1, periodSeq: p, sectionId: `S${p}`, staffId: 't', roomId: null }));
    const c = detectClashes(es, { t: { maxPerDay: 2, maxPerWeek: 2, unavailable: [{ day: 1, periodSeq: 3 }] } });
    expect(c.map((x) => x.type).sort()).toEqual(['teacher_day_limit', 'teacher_unavailable', 'teacher_week_limit']);
  });
  it('reports clashes for a proposed move', () => {
    const es = [
      { id: '1', day: 1, periodSeq: 1, sectionId: 'A', staffId: 't1', roomId: null },
      { id: '2', day: 1, periodSeq: 2, sectionId: 'B', staffId: 't1', roomId: null },
    ];
    expect(clashesForMove(es, { ...es[1]!, periodSeq: 1 })).toHaveLength(1);
    expect(clashesForMove(es, { ...es[1]!, periodSeq: 3 })).toHaveLength(0);
  });
});

describe('credits', () => {
  it('uses the default cost table', () => {
    expect(creditCost('daily_plan')).toBe(1);
    expect(creditCost('section_rewrite')).toBe(0.2);
    expect(creditCost('question_paper', undefined, 3)).toBe(15);
    expect(creditCost('help_bot')).toBe(0);
  });
  it('stops at 100% and warns at 80/95', () => {
    expect(checkCredits('daily_plan', { granted: 10, used: 10 })).toMatchObject({ allowed: false, reason: 'branch_exhausted' });
    expect(checkCredits('daily_plan', { granted: 10, used: 7 })).toMatchObject({ allowed: true, warn: 80 });
    expect(checkCredits('daily_plan', { granted: 20, used: 18 })).toMatchObject({ allowed: true, warn: 95 });
    expect(checkCredits('daily_plan', { granted: 100, used: 10 })).toMatchObject({ allowed: true, warn: null });
  });
  it('enforces per-teacher caps and fair use', () => {
    expect(checkCredits('unit_plan', { granted: 100, used: 0, teacherCap: 5, teacherUsed: 3 })).toMatchObject({ allowed: false, reason: 'teacher_cap' });
    expect(checkCredits('help_bot', { granted: 0, used: 0, usesToday: 50 })).toMatchObject({ allowed: false, reason: 'fair_use' });
    expect(checkCredits('help_bot', { granted: 0, used: 0, usesToday: 3 })).toMatchObject({ allowed: true, cost: 0 });
  });
  it('lists thresholds crossed', () => {
    expect(crossedThresholds(70, 96)).toEqual([80, 95]);
    expect(crossedThresholds(96, 100)).toEqual([100]);
  });
});
