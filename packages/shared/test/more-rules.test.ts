import { describe, expect, it } from 'vitest';
import {
  transition,
  countsAsComplete,
  recurrenceDates,
  withinBoundary,
  staffStatus,
  parseBiometricRows,
  mergePunch,
  attendancePct,
  consecutiveAbsences,
  editPolicy,
  coverage,
  spreadChapters,
  homeworkLoad,
  appraisalScore,
  observationPct,
  resolveChain,
  applyApproval,
  rotateDuties,
  assignInvigilators,
  seatingPlan,
  planPaperSlots,
  checkPaper,
  validateBlueprint,
  redact,
  restore,
  containsContactData,
  itemPassed,
  followUps,
  complianceStatus,
  complianceReminderDue,
  validatePlan,
  fixTimings,
  rescaleFlow,
  DEFAULT_TEMPLATE_SECTIONS,
  canMovePlan,
  addWorkingMinutes,
  inQuietHours,
  quietHoursRelease,
  type DailyPlan,
  type RosterStaff,
} from '../src';

describe('task state machine', () => {
  const t = { status: 'todo' as const, proofRequired: 'photo' as const, verificationRequired: true };
  it('requires proof to complete and verification by assigner', () => {
    expect(transition(t, 'complete', ['owner'])).toEqual({ ok: false, error: 'proof_required' });
    expect(transition(t, 'complete', ['owner'], { proofPath: 'x.jpg' })).toEqual({ ok: true, status: 'done' });
    expect(transition({ ...t, status: 'done' }, 'verify', ['owner'])).toEqual({ ok: false, error: 'not_allowed_for_role' });
    expect(transition({ ...t, status: 'done' }, 'verify', ['assigner'])).toEqual({ ok: true, status: 'verified' });
  });
  it('requires reasons for blocked and not done, comment for reopen', () => {
    expect(transition(t, 'block', ['owner'])).toEqual({ ok: false, error: 'reason_required' });
    expect(transition(t, 'not_done', ['system'], { reason: 'no_response' })).toEqual({ ok: true, status: 'not_done' });
    expect(transition({ ...t, status: 'verified' }, 'reopen', ['assigner'])).toEqual({ ok: false, error: 'note_required' });
    expect(transition({ ...t, status: 'verified' }, 'reopen', ['above_assigner'], { note: 'redo' })).toEqual({ ok: true, status: 'reopened' });
  });
  it('requests need acceptance', () => {
    expect(transition({ ...t, status: 'requested' }, 'start', ['owner']).ok).toBe(false);
    expect(transition({ ...t, status: 'requested' }, 'accept', ['owner'])).toEqual({ ok: true, status: 'todo' });
  });
  it('verification-required tasks count only when verified', () => {
    expect(countsAsComplete({ status: 'done', verificationRequired: true })).toBe(false);
    expect(countsAsComplete({ status: 'done', verificationRequired: false })).toBe(true);
  });
});

describe('recurrence', () => {
  const cal = { workingDays: [1, 2, 3, 4, 5, 6], holidays: ['2026-11-18'] };
  it('daily skips holidays and Sundays', () => {
    const d = recurrenceDates({ frequency: 'daily', intervalN: 1, weekdays: [], monthDay: null, customDates: [], startsOn: '2026-11-16', endsOn: null, skipHolidays: true }, '2026-11-16', '2026-11-23', cal);
    expect(d).toEqual(['2026-11-16', '2026-11-17', '2026-11-19', '2026-11-20', '2026-11-21', '2026-11-23']);
  });
  it('weekly on chosen weekdays every 2 weeks', () => {
    const d = recurrenceDates({ frequency: 'weekly', intervalN: 2, weekdays: [1, 5], monthDay: null, customDates: [], startsOn: '2026-11-16', endsOn: null, skipHolidays: true }, '2026-11-16', '2026-12-04', cal);
    expect(d).toEqual(['2026-11-16', '2026-11-20', '2026-11-30', '2026-12-04']);
  });
  it('monthly clamps to month end', () => {
    const d = recurrenceDates({ frequency: 'monthly', intervalN: 1, weekdays: [], monthDay: 31, customDates: [], startsOn: '2026-10-31', endsOn: null, skipHolidays: false }, '2026-10-01', '2026-12-31', cal);
    expect(d).toEqual(['2026-10-31', '2026-11-30', '2026-12-31']);
  });
});

describe('attendance', () => {
  it('geofence', () => {
    const branch = { lat: 17.385, lng: 78.4867, radiusM: 200 };
    expect(withinBoundary({ lat: 17.3851, lng: 78.4868 }, branch).ok).toBe(true);
    expect(withinBoundary({ lat: 17.4, lng: 78.5 }, branch)).toMatchObject({ ok: false, reason: 'outside_boundary' });
    expect(withinBoundary({ lat: 1, lng: 1 }, { lat: null, lng: null, radiusM: 1 }).reason).toBe('no_branch_location');
  });
  it('status from shift rules', () => {
    const r = { shiftStart: '08:00', shiftEnd: '15:30', graceMinutes: 10, halfDayAfterMinutes: 120, earlyExitMinutes: 30 };
    expect(staffStatus(r, 8 * 60 + 5, 15 * 60 + 30).status).toBe('present');
    expect(staffStatus(r, 8 * 60 + 20, null)).toMatchObject({ status: 'late', lateMinutes: 20 });
    expect(staffStatus(r, 10 * 60 + 30, null).status).toBe('half_day');
    expect(staffStatus(r, 8 * 60, 14 * 60 + 30)).toMatchObject({ status: 'present', earlyExit: true });
    expect(staffStatus(r, null, null).status).toBe('absent');
  });
  it('parses biometric rows with mapping and reports row errors', () => {
    const { punches, errors } = parseBiometricRows(
      [
        { Emp: 'E1', Day: '16/11/2026', In: '7:55 AM', Out: '4:10 PM' },
        { Emp: 'E1', Day: '16/11/2026', In: '08:30', Out: '' },
        { Emp: '', Day: '16/11/2026', In: '08:00', Out: '' },
        { Emp: 'E2', Day: '31/02/2026', In: '08:00', Out: '' },
        { Emp: 'E3', Day: '16/11/2026', In: '25:00', Out: '' },
      ],
      { employeeCode: 'Emp', date: 'Day', checkIn: 'In', checkOut: 'Out', dateFormat: 'DD/MM/YYYY' },
    );
    expect(punches).toEqual([{ row: 2, employeeCode: 'E1', date: '2026-11-16', checkIn: '07:55', checkOut: '16:10' }]);
    expect(errors.map((e) => [e.row, e.error])).toEqual([[4, 'missing_employee_code'], [5, 'bad_date'], [6, 'bad_time']]);
  });
  it('merges app and device records and lists conflicts', () => {
    const m = mergePunch({ checkIn: '08:20', checkOut: null, source: 'app' }, { row: 2, employeeCode: 'E', date: '2026-11-16', checkIn: '07:58', checkOut: '15:40' });
    expect(m).toMatchObject({ checkIn: '07:58', checkOut: '15:40', source: 'merged' });
    expect(m.conflict).toHaveLength(1);
    expect(mergePunch({ checkIn: '09:00', checkOut: null, source: 'regularised' }, { row: 2, employeeCode: 'E', date: '2026-11-16', checkIn: '07:58', checkOut: null }).checkIn).toBe('09:00');
  });
  it('student summaries', () => {
    expect(attendancePct(['present', 'absent', 'half_day', 'late'])).toBe(62.5);
    expect(consecutiveAbsences(['present', 'absent', 'absent'])).toBe(2);
    const sub = new Date('2026-11-16T03:30:00Z');
    expect(editPolicy(sub, new Date('2026-11-16T04:30:00Z'), 120)).toBe('reason_required');
    expect(editPolicy(sub, new Date('2026-11-16T06:00:00Z'), 120)).toBe('approval_required');
  });
});

describe('academic', () => {
  it('coverage status', () => {
    expect(coverage({ plannedPeriodsToDate: 40, actualPeriodsToDate: 31, totalPlannedPeriods: 100, remainingTeachingPeriods: 60, atRiskBehind: 3, criticalBehind: 8 })).toMatchObject({ status: 'critical', periodsAhead: -9, pctCovered: 31, periodsShort: 9 });
    expect(coverage({ plannedPeriodsToDate: 40, actualPeriodsToDate: 36, totalPlannedPeriods: 100, remainingTeachingPeriods: 70, atRiskBehind: 3, criticalBehind: 8 }).status).toBe('at_risk');
    expect(coverage({ plannedPeriodsToDate: 40, actualPeriodsToDate: 41, totalPlannedPeriods: 100, remainingTeachingPeriods: 70, atRiskBehind: 3, criticalBehind: 8 }).status).toBe('on_track');
  });
  it('spreads chapters and compresses when short', () => {
    const dates = Array.from({ length: 10 }, (_, i) => `2026-11-${String(i + 10).padStart(2, '0')}`);
    const ok = spreadChapters([{ topicId: 'a', periods: 4 }, { topicId: 'b', periods: 6 }], dates);
    expect(ok.placed.map((p) => [p.topicId, p.plannedStart, p.plannedEnd, p.plannedPeriods])).toEqual([['a', '2026-11-10', '2026-11-13', 4], ['b', '2026-11-14', '2026-11-19', 6]]);
    const short = spreadChapters([{ topicId: 'a', periods: 10 }, { topicId: 'b', periods: 10 }], dates);
    expect(short.placed.reduce((s, p) => s + p.plannedPeriods, 0)).toBe(10);
    expect(short.compressed).toHaveLength(2);
  });
  it('homework load per section-day', () => {
    const l = homeworkLoad([{ sectionId: 's', dueOn: '2026-11-17', estMinutes: 40 }, { sectionId: 's', dueOn: '2026-11-17', estMinutes: 60 }], 90);
    expect(l).toEqual([{ sectionId: 's', date: '2026-11-17', minutes: 100, over: true }]);
  });
  it('appraisal reflects changed weights', () => {
    const values = { observation: 80, task_on_time: 60 };
    expect(appraisalScore({ observation: 50, task_on_time: 50 }, values).total).toBe(70);
    expect(appraisalScore({ observation: 75, task_on_time: 25 }, values).total).toBe(75);
    expect(appraisalScore({ observation: 50, punctuality: 50 }, values).total).toBe(80);
  });
  it('observation percentage on rubric scale', () => {
    const domains = [{ key: 'd1', weight: 1, indicators: [{ key: 'a' }, { key: 'b' }] }];
    expect(observationPct(domains, { 'd1.a': 4, 'd1.b': 2 }, { min: 1, max: 4 })).toBe(66.7);
  });
});

describe('approvals', () => {
  const ctx = { applicantId: 't1', data: { amount: 15000 }, reportsTo: { t1: 'hod' }, roleHolders: { principal: ['p1'], director: ['d1'] }, delegates: {} as Record<string, string> };
  const steps = [
    { seq: 1, approverKind: 'manager_of_applicant' as const, timeLimitHours: 24 },
    { seq: 2, approverKind: 'role' as const, approverRoleId: 'principal', timeLimitHours: 24 },
    { seq: 3, approverKind: 'role' as const, approverRoleId: 'director', condition: { field: 'amount', op: '>' as const, value: 10000 }, timeLimitHours: 48 },
  ];
  it('resolves conditional and delegated chains', () => {
    expect(resolveChain(steps, ctx).map((s) => s.approverIds)).toEqual([['hod'], ['p1'], ['d1']]);
    expect(resolveChain(steps, { ...ctx, data: { amount: 500 } })).toHaveLength(2);
    expect(resolveChain(steps, { ...ctx, delegates: { p1: 'vp' } })[1]!.approverIds).toEqual(['vp']);
    expect(resolveChain(steps, { ...ctx, applicantId: 'p1', reportsTo: { p1: 'd1' } }).map((s) => s.approverIds)).toEqual([['d1'], ['d1']]);
  });
  it('moves through stages and stops on reject', () => {
    const stages = resolveChain(steps, ctx);
    let r = applyApproval({ status: 'pending', stageIndex: 0, approvedBy: [] }, stages, 'hod', 'approve');
    expect(r.state.stageIndex).toBe(1);
    expect(applyApproval(r.state, r.stages, 'hod', 'approve').error).toBe('not_an_approver');
    r = applyApproval(r.state, r.stages, 'p1', 'forward', { forwardTo: 'vp' });
    expect(r.state.stageIndex).toBe(2);
    expect(r.stages[2]!.approverIds).toEqual(['vp']);
    r = applyApproval(r.state, r.stages, 'vp', 'approve');
    r = applyApproval(r.state, r.stages, 'd1', 'approve');
    expect(r.state.status).toBe('approved');
    expect(applyApproval({ status: 'pending', stageIndex: 0, approvedBy: [] }, stages, 'hod', 'reject').state.status).toBe('rejected');
  });
});

describe('rosters', () => {
  const staff = (): RosterStaff[] => [
    { id: 'a', name: 'A', busy: new Set(['2026-11-16|1']), load: 0 },
    { id: 'b', name: 'B', busy: new Set(), load: 0 },
    { id: 'c', name: 'C', busy: new Set(['2026-11-17']), load: 2 },
  ];
  it('rotates duties fairly respecting the timetable', () => {
    const slots = ['2026-11-16', '2026-11-17', '2026-11-18'].map((d) => ({ key: `gate|${d}`, dutyTypeId: 'gate', date: d, busyKey: `${d}|1`, needed: 1 }));
    const r = rotateDuties(slots, staff());
    expect(r.assignments.map((x) => x.staffId)).toEqual(['b', 'a', 'a']); // c is busy on 17th and most loaded; a/b tie on 18th -> name order
    expect(r.unfilled).toEqual([]);
  });
  it('invigilators are never the subject teacher', () => {
    const r = assignInvigilators(
      [
        { key: 's1|r1', date: '2026-11-16', subjectTeacherIds: ['b'], windowKey: '2026-11-16|09' },
        { key: 's1|r2', date: '2026-11-16', subjectTeacherIds: ['b'], windowKey: '2026-11-16|09' },
      ],
      staff(),
      1,
    );
    expect(r.assignments.map((x) => x.staffId)).toEqual(['a', 'c']);
  });
  it('seating mixes classes and respects capacity', () => {
    const students = [...Array(3)].map((_, i) => ({ id: `x${i}`, classId: 'X', rollNo: i })).concat([...Array(3)].map((_, i) => ({ id: `y${i}`, classId: 'Y', rollNo: i })));
    const p = seatingPlan(students, [{ id: 'r1', capacity: 4 }, { id: 'r2', capacity: 1 }]);
    expect(p.rooms[0]!.seats.map((s) => s.classId)).toEqual(['X', 'Y', 'X', 'Y']);
    expect(p.unseated).toHaveLength(1);
  });
});

describe('question papers', () => {
  const bp = {
    totalMarks: 40,
    sections: [
      { name: 'A', questionType: 'mcq', count: 10, marksEach: 1 },
      { name: 'B', questionType: 'short', count: 5, marksEach: 2 },
      { name: 'C', questionType: 'long', count: 4, marksEach: 5 },
    ],
    chapterWeightage: { ch1: 15, ch2: 15, ch3: 10 },
    difficulty: { easy: 30, medium: 50, hard: 20 },
  };
  it('plans slots that match the blueprint exactly', () => {
    const { slots, errors } = planPaperSlots(bp);
    expect(errors).toEqual([]);
    expect(slots).toHaveLength(19);
    expect(checkPaper(slots, bp)).toMatchObject({ ok: true, totalMarks: 40 });
  });
  it('detects mismatches', () => {
    const { slots } = planPaperSlots(bp);
    const broken = slots.map((s, i) => (i === 0 ? { ...s, marks: 2 } : s));
    expect(checkPaper(broken, bp).ok).toBe(false);
    expect(validateBlueprint({ ...bp, totalMarks: 50 })).toContain('sections_total_mismatch');
    expect(planPaperSlots({ ...bp, chapterWeightage: { ch1: 39, ch2: 1 } }).errors).toEqual([]);
    expect(planPaperSlots({ ...bp, sections: [{ name: 'C', questionType: 'long', count: 8, marksEach: 5 }], chapterWeightage: { ch1: 22, ch2: 18 } }).errors).toEqual(['weightage_unsatisfiable']);
  });
});

describe('privacy', () => {
  it('redacts contact data and names and restores tokens', () => {
    const r = redact('Call Ravi Kumar on +91 98765 43210 or ravi@x.com. Ask Mrs Rao.', { students: [{ id: 'abcdef123456', name: 'Ravi Kumar' }], staff: [{ id: 's1', name: 'Mrs Rao' }] });
    expect(r.text).toBe('Call S-abcdef12 on [phone] or [email]. Ask T-1.');
    expect(restore(r.text, r.map)).toContain('Ravi Kumar');
    expect(containsContactData({ a: '9876543210' })).toBe(true);
    expect(containsContactData({ a: 'Class 8 Science' })).toBe(false);
  });

  it('catches Indian mobile numbers in every common spelling, +91 without a separator included', () => {
    for (const n of ['+919876543210', '919876543210', '+91 9876543210', '+91-98765-43210', '+91 98765 43210', '0091 9876543210', '09876543210', '9876543210', '98765-43210', '98765 43210']) {
      expect(redact(`call ${n} today`).text, n).toBe('call [phone] today');
      expect(containsContactData({ note: `parent: ${n}` }), n).toBe(true);
    }
    // the whole number goes, not just its last ten digits
    expect(redact('ring +919876543210.').text).toBe('ring [phone].');
    // not phone numbers: amounts, dates, ids, landline-length or 11+ digit runs that are not a prefixed mobile
    for (const s of ['Rs 25,000 above 10%', '2026-11-25', 'Class 10 Section B', 'order 123456', '5123456789', '98765432101234']) {
      expect(containsContactData({ s }), s).toBe(false);
    }
  });
});

describe('checklists & compliance', () => {
  it('evaluates items and follow-ups', () => {
    const items = [
      { id: 'n', itemType: 'number' as const, minValue: 2, maxValue: 8, required: true, onFail: { action: 'ticket' as const, ticketCategoryKey: 'plumbing' } },
      { id: 'y', itemType: 'yesno' as const, required: true, onFail: { action: 'task' as const, roleKey: 'admin_officer' } },
    ];
    expect(itemPassed(items[0]!, 9)).toBe(false);
    expect(followUps(items, { n: 9, y: 'no' })).toEqual([{ itemId: 'n', action: 'ticket', target: 'plumbing' }, { itemId: 'y', action: 'task', target: 'admin_officer' }]);
    expect(followUps(items, { n: 5, y: 'yes' })).toEqual([]);
  });
  it('compliance reminders at 60, 30 and 7 days', () => {
    expect(complianceStatus('2027-01-15', '2026-11-16')).toEqual({ status: 'expiring', daysLeft: 60 });
    expect(complianceReminderDue(60, [])).toBe(60);
    expect(complianceReminderDue(29, [60])).toBe(30);
    expect(complianceReminderDue(29, [60, 30])).toBeNull();
    expect(complianceReminderDue(7, [60, 30])).toBe(7);
    expect(complianceStatus('2026-11-01', '2026-11-16').status).toBe('overdue');
  });
});

describe('lesson plan validation', () => {
  const plan: DailyPlan = {
    objectives: [{ text: 'Explain photosynthesis', bloom: 'understand', outcome_codes: ['SC8.1'] }],
    board_elements: { competencies: ['c'], nep_elements: [], key_vocabulary: [], success_criteria: [], assessment_objectives: [] },
    prior_knowledge: ['plants need light'],
    materials: ['leaf'],
    flow: [
      { phase: 'opening', minutes: 5, teacher_activity: 'a', student_activity: 'b' },
      { phase: 'teaching', minutes: 15, teacher_activity: 'a', student_activity: 'b' },
      { phase: 'guided_practice', minutes: 10, teacher_activity: 'a', student_activity: 'b' },
      { phase: 'closure', minutes: 5, teacher_activity: 'a', student_activity: 'b' },
    ],
    differentiation: { support: 's', core: 'c', extension: 'e' },
    questions: [{ text: 'q', level: 'higher', competency: true }],
    exit_ticket: [{ question: 'q', answer: 'a' }],
    homework: { description: 'h', minutes: 10 },
    links: [],
    board_work: '',
    reflection: '',
  };
  it('detects timing mismatch and unmapped objectives', () => {
    const issues = validatePlan({ ...plan, objectives: [{ ...plan.objectives[0]!, outcome_codes: [] }] }, { periodMinutes: 40, periodCount: 1, outcomeCodes: ['SC8.1'], sections: DEFAULT_TEMPLATE_SECTIONS });
    expect(issues.map((i) => i.code).sort()).toEqual(['objective_unmapped', 'timing_mismatch']);
  });
  it('fixes timings exactly and rescales', () => {
    const fixed = fixTimings(plan, 40);
    expect(fixed.flow.reduce((s, f) => s + f.minutes, 0)).toBe(40);
    expect(validatePlan(fixed, { periodMinutes: 40, periodCount: 1, outcomeCodes: ['SC8.1'], sections: DEFAULT_TEMPLATE_SECTIONS })).toEqual([]);
    expect(rescaleFlow(plan, 80).flow.reduce((s, f) => s + f.minutes, 0)).toBe(80);
  });
  it('workflow transitions', () => {
    expect(canMovePlan('draft', 'submitted')).toBe(true);
    expect(canMovePlan('draft', 'approved')).toBe(false);
    expect(canMovePlan('returned', 'submitted')).toBe(true);
  });
});

describe('time', () => {
  const cal = { workingDays: [1, 2, 3, 4, 5], holidays: [], dayStart: '09:00', dayEnd: '17:00' };
  it('adds working minutes across a weekend', () => {
    expect(addWorkingMinutes(new Date('2026-11-20T16:00:00+05:30'), 120, cal)).toEqual(new Date('2026-11-23T10:00:00+05:30'));
    expect(addWorkingMinutes(new Date('2026-11-21T10:00:00+05:30'), 30, cal)).toEqual(new Date('2026-11-23T09:30:00+05:30'));
  });
  it('quiet hours wrap midnight', () => {
    expect(inQuietHours(new Date('2026-11-16T21:00:00+05:30'), '20:00', '06:30')).toBe(true);
    expect(inQuietHours(new Date('2026-11-16T07:00:00+05:30'), '20:00', '06:30')).toBe(false);
    expect(quietHoursRelease(new Date('2026-11-16T21:00:00+05:30'), '20:00', '06:30')).toEqual(new Date('2026-11-17T06:30:00+05:30'));
    expect(quietHoursRelease(new Date('2026-11-17T02:00:00+05:30'), '20:00', '06:30')).toEqual(new Date('2026-11-17T06:30:00+05:30'));
  });
});
