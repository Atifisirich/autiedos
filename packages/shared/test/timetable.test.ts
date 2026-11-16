import { describe, expect, it } from 'vitest';
import { generateTimetable, detectClashes, type GenAllocation, type GenInput } from '../src';

/** Builds a realistic school: `sections` sections, 8 periods x 6 days, subject teachers shared. */
export function sampleSchool(sectionCount: number): GenInput {
  const days = [1, 2, 3, 4, 5, 6];
  const subjects = [
    { id: 'eng', ppw: 7, core: true },
    { id: 'math', ppw: 8, core: true, dbl: 1 },
    { id: 'sci', ppw: 7, core: true, room: 'lab', dbl: 1 },
    { id: 'sst', ppw: 6, core: true },
    { id: 'hin', ppw: 5, core: true },
    { id: 'comp', ppw: 3, core: false },
    { id: 'art', ppw: 2, core: false },
    { id: 'pe', ppw: 3, core: false },
    { id: 'lib', ppw: 1, core: false },
    { id: 'val', ppw: 1, core: false },
  ]; // 43 periods + assembly slot
  const sections = Array.from({ length: sectionCount }, (_, i) => ({ id: `S${i + 1}`, periodsPerDay: 8, classTeacherId: null as string | null }));
  const allocations: GenAllocation[] = [];
  const teachers: GenInput['teachers'] = {};
  const load = new Map<string, number>();
  for (const subj of subjects) {
    // one teacher per ~5 sections (max 30-36 periods/week)
    const perTeacher = Math.max(1, Math.floor(32 / subj.ppw));
    sections.forEach((s, i) => {
      const tid = `${subj.id}-T${Math.floor(i / perTeacher) + 1}`;
      teachers[tid] = { maxPerDay: 7, maxPerWeek: 36, unavailable: [] };
      load.set(tid, (load.get(tid) ?? 0) + subj.ppw);
      allocations.push({ id: `${s.id}-${subj.id}`, sectionId: s.id, subjectId: subj.id, staffId: tid, periodsPerWeek: subj.ppw, doublePeriods: subj.dbl ?? 0, roomType: subj.room ?? null, isCore: subj.core });
    });
  }
  sections.forEach((s) => (s.classTeacherId = allocations.find((a) => a.sectionId === s.id && a.subjectId === 'eng')!.staffId));
  const labs = Array.from({ length: Math.ceil(sectionCount / 5) + 1 }, (_, i) => ({ id: `LAB${i + 1}`, type: 'lab' }));
  return { days, sections, allocations, teachers, rooms: labs, fixedSlots: [{ sectionId: null, day: 6, periodSeq: 8, label: 'Assembly' }] };
}

describe('timetable generator', () => {
  it('places a small school with zero clashes', () => {
    const input = sampleSchool(6);
    const r = generateTimetable(input);
    expect(r.unplaced).toEqual([]);
    const lessons = r.entries.filter((e) => !e.fixedLabel);
    expect(lessons).toHaveLength(6 * 43);
    const clashes = detectClashes(
      lessons.map((e, i) => ({ id: String(i), day: e.day, periodSeq: e.periodSeq, sectionId: e.sectionId, staffId: e.staffId, roomId: e.roomId, groupKey: e.groupKey, combinedKey: e.combinedKey })),
      Object.fromEntries(Object.entries(input.teachers).map(([k, v]) => [k, { maxPerDay: v.maxPerDay, maxPerWeek: v.maxPerWeek, unavailable: v.unavailable }])),
    );
    expect(clashes).toEqual([]);
    // double periods are adjacent on one day
    const math = lessons.filter((e) => e.sectionId === 'S1' && e.subjectId === 'math');
    const perDay = new Map<number, number[]>();
    math.forEach((e) => perDay.set(e.day, [...(perDay.get(e.day) ?? []), e.periodSeq]));
    const doubles = [...perDay.values()].filter((ps) => ps.length === 2 && Math.abs(ps[0]! - ps[1]!) === 1);
    expect(doubles.length).toBeGreaterThanOrEqual(1);
  });

  it('respects fixed slots, locked cells, unavailable slots and split groups', () => {
    const input = sampleSchool(2);
    input.teachers['eng-T1']!.unavailable = [{ day: 1, periodSeq: 1 }, { day: 2, periodSeq: 1 }];
    input.locked = [{ day: 3, periodSeq: 4, sectionId: 'S1', subjectId: 'math', staffId: 'math-T1', roomId: null, groupKey: null, combinedKey: null }];
    // split language group: Hindi and Telugu at the same time for S2
    input.allocations = input.allocations.filter((a) => !(a.sectionId === 'S2' && a.subjectId === 'hin'));
    input.allocations.push({ id: 'S2-hin', sectionId: 'S2', subjectId: 'hin', staffId: 'hin-T9', periodsPerWeek: 5, groupKey: 'L2' });
    input.allocations.push({ id: 'S2-tel', sectionId: 'S2', subjectId: 'tel', staffId: 'tel-T1', periodsPerWeek: 5, groupKey: 'L2' });
    const r = generateTimetable(input);
    expect(r.unplaced).toEqual([]);
    expect(r.entries.some((e) => e.staffId === 'eng-T1' && e.day === 1 && e.periodSeq === 1)).toBe(false);
    expect(r.entries.filter((e) => e.day === 6 && e.periodSeq === 8).every((e) => e.fixedLabel === 'Assembly')).toBe(true);
    expect(r.entries.filter((e) => e.sectionId === 'S1' && e.subjectId === 'math')).toHaveLength(8);
    const hin = r.entries.filter((e) => e.sectionId === 'S2' && e.subjectId === 'hin').map((e) => `${e.day}:${e.periodSeq}`).sort();
    const tel = r.entries.filter((e) => e.sectionId === 'S2' && e.subjectId === 'tel').map((e) => `${e.day}:${e.periodSeq}`).sort();
    expect(hin).toEqual(tel);
    const clashes = detectClashes(r.entries.filter((e) => !e.fixedLabel).map((e, i) => ({ id: String(i), ...e })));
    expect(clashes).toEqual([]);
  });

  it('reports unplaced periods with a reason and suggestion', () => {
    const input = sampleSchool(1);
    input.teachers['math-T1']!.maxPerWeek = 4;
    const r = generateTimetable(input);
    expect(r.unplaced).toHaveLength(1);
    expect(r.unplaced[0]).toMatchObject({ reason: 'teacher_week_limit', suggestion: 'raise_teacher_limit', periods: 4 });
  });

  it('generates 60 sections within the time budget', () => {
    const input = sampleSchool(60);
    const r = generateTimetable(input);
    expect(r.stats.ms).toBeLessThan(180000);
    const placed = r.entries.filter((e) => !e.fixedLabel).length;
    expect(placed / (60 * 43)).toBeGreaterThan(0.98);
    const clashes = detectClashes(r.entries.filter((e) => !e.fixedLabel).map((e, i) => ({ id: String(i), ...e })));
    expect(clashes).toEqual([]);
  }, 200000);
});
