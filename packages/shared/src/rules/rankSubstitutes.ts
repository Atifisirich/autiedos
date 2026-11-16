/**
 * Substitute ranking (PRD 5.4): same subject and wing first, then teaches that section,
 * then fewest substitutions this week, then this month, then lowest teaching load today.
 * Teachers busy, on duty, in exams, absent or at their daily limit are excluded.
 */
export interface SubSlot {
  sectionId: string;
  subjectId: string | null;
  wingId: string | null;
}

export interface SubCandidate {
  staffId: string;
  name: string;
  subjectIds: string[];
  wingId: string | null;
  sectionIds: string[];
  busy: boolean;
  onDuty: boolean;
  inExamDuty: boolean;
  absent: boolean;
  periodsToday: number;
  maxPeriodsDay: number;
  subsThisWeek: number;
  subsThisMonth: number;
}

export type ExclusionReason = 'busy' | 'on_duty' | 'exam_duty' | 'absent' | 'daily_limit';

export interface RankedSubstitute {
  staffId: string;
  name: string;
  rank: number;
  sameSubjectAndWing: boolean;
  teachesSection: boolean;
  subsThisWeek: number;
  subsThisMonth: number;
  periodsToday: number;
}

export function exclusionReason(c: SubCandidate): ExclusionReason | null {
  if (c.absent) return 'absent';
  if (c.busy) return 'busy';
  if (c.onDuty) return 'on_duty';
  if (c.inExamDuty) return 'exam_duty';
  if (c.periodsToday >= c.maxPeriodsDay) return 'daily_limit';
  return null;
}

export function rankSubstitutes(slot: SubSlot, candidates: SubCandidate[]): { ranked: RankedSubstitute[]; excluded: { staffId: string; reason: ExclusionReason }[] } {
  const excluded: { staffId: string; reason: ExclusionReason }[] = [];
  const eligible: (RankedSubstitute & { _k: number[] })[] = [];
  for (const c of candidates) {
    const reason = exclusionReason(c);
    if (reason) {
      excluded.push({ staffId: c.staffId, reason });
      continue;
    }
    const sameSubjectAndWing = !!slot.subjectId && c.subjectIds.includes(slot.subjectId) && !!slot.wingId && c.wingId === slot.wingId;
    const teachesSection = c.sectionIds.includes(slot.sectionId);
    eligible.push({
      staffId: c.staffId,
      name: c.name,
      rank: 0,
      sameSubjectAndWing,
      teachesSection,
      subsThisWeek: c.subsThisWeek,
      subsThisMonth: c.subsThisMonth,
      periodsToday: c.periodsToday,
      _k: [sameSubjectAndWing ? 0 : 1, teachesSection ? 0 : 1, c.subsThisWeek, c.subsThisMonth, c.periodsToday],
    });
  }
  eligible.sort((a, b) => {
    for (let i = 0; i < a._k.length; i++) {
      const d = a._k[i]! - b._k[i]!;
      if (d !== 0) return d;
    }
    return a.name.localeCompare(b.name) || a.staffId.localeCompare(b.staffId);
  });
  const ranked = eligible.map(({ _k, ...r }, i) => ({ ...r, rank: i + 1 }));
  return { ranked, excluded };
}
