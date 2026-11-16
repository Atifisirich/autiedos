/**
 * Timetable generator (PRD 3.1, 5.3): greedy placement with backtracking repair,
 * most-constrained lessons first. Returns the best timetable found plus unplaced periods
 * with reasons and suggested fixes. Pure and deterministic, so it runs in a background job,
 * in tests and on the client alike.
 */

export interface GenSection {
  id: string;
  /** teaching periods per day; a number applies to every day */
  periodsPerDay: number | Record<number, number>;
  classTeacherId?: string | null;
}

export interface GenAllocation {
  id: string;
  sectionId: string;
  subjectId: string;
  staffId: string;
  periodsPerWeek: number;
  doublePeriods?: number;
  groupKey?: string | null;
  combinedKey?: string | null;
  coTeacherId?: string | null;
  roomType?: string | null;
  isCore?: boolean;
}

export interface GenTeacher {
  maxPerDay: number;
  maxPerWeek: number;
  unavailable: { day: number; periodSeq: number }[];
}

export interface GenInput {
  days: number[];
  sections: GenSection[];
  allocations: GenAllocation[];
  teachers: Record<string, GenTeacher>;
  rooms?: { id: string; type: string }[];
  /** sectionId null = every section (e.g. assembly) */
  fixedSlots?: { sectionId: string | null; day: number; periodSeq: number; label: string }[];
  locked?: GenEntry[];
  maxRepairs?: number;
}

export interface GenEntry {
  day: number;
  periodSeq: number;
  sectionId: string;
  subjectId: string | null;
  staffId: string | null;
  roomId: string | null;
  groupKey: string | null;
  combinedKey: string | null;
  fixedLabel?: string | null;
  locked?: boolean;
}

export type UnplacedReason = 'teacher_week_limit' | 'teacher_day_limit' | 'no_common_free_slot' | 'no_room_of_type' | 'section_full';
export type FixSuggestion = 'raise_teacher_limit' | 'assign_another_teacher' | 'add_room' | 'reduce_periods' | 'free_teacher_slots';

export interface Unplaced {
  allocationIds: string[];
  sectionIds: string[];
  subjectIds: string[];
  staffIds: string[];
  periods: number;
  reason: UnplacedReason;
  suggestion: FixSuggestion;
}

export interface GenResult {
  entries: GenEntry[];
  unplaced: Unplaced[];
  score: number;
  stats: { units: number; placed: number; repairs: number; ms: number };
}

interface Part {
  sectionId: string;
  subjectId: string;
  staffId: string;
  groupKey: string | null;
  combinedKey: string | null;
}

interface Unit {
  key: string;
  allocIds: string[];
  sections: string[];
  staff: string[];
  parts: Part[];
  len: 1 | 2;
  roomType: string | null;
  isCore: boolean;
  subjects: string[];
}

interface Placement {
  day: number;
  p: number;
  roomId: string | null;
}

export function generateTimetable(input: GenInput): GenResult {
  const t0 = Date.now();
  const sectionMap = new Map(input.sections.map((s) => [s.id, s]));
  const ppd = (sec: string, day: number): number => {
    const s = sectionMap.get(sec);
    if (!s) return 0;
    return typeof s.periodsPerDay === 'number' ? s.periodsPerDay : s.periodsPerDay[day] ?? 0;
  };
  const maxP = Math.max(1, ...input.sections.flatMap((s) => input.days.map((d) => ppd(s.id, d))));
  const teacher = (id: string): GenTeacher => input.teachers[id] ?? { maxPerDay: 99, maxPerWeek: 999, unavailable: [] };
  const rooms = input.rooms ?? [];

  // ---------------------------------------------------------------- occupancy state
  const secBusy = new Map<string, string>();
  const staffBusy = new Map<string, string>();
  const roomBusy = new Map<string, string>();
  const staffDay = new Map<string, number>();
  const staffWeek = new Map<string, number>();
  const secDaySubj = new Map<string, number>();
  const fixed = new Set<string>();
  const unavailable = new Set<string>();
  for (const [id, t] of Object.entries(input.teachers)) for (const u of t.unavailable) unavailable.add(`${id}|${u.day}|${u.periodSeq}`);
  for (const f of input.fixedSlots ?? []) {
    const secs = f.sectionId ? [f.sectionId] : input.sections.map((s) => s.id);
    for (const s of secs) fixed.add(`${s}|${f.day}|${f.periodSeq}`);
  }

  const entries: GenEntry[] = [];
  for (const f of input.fixedSlots ?? []) {
    const secs = f.sectionId ? [f.sectionId] : input.sections.map((s) => s.id);
    for (const s of secs) {
      if (f.periodSeq <= ppd(s, f.day)) entries.push({ day: f.day, periodSeq: f.periodSeq, sectionId: s, subjectId: null, staffId: null, roomId: null, groupKey: null, combinedKey: null, fixedLabel: f.label, locked: true });
    }
  }

  // Locked entries are kept and consume allocation periods.
  const lockedCount = new Map<string, number>();
  for (const e of input.locked ?? []) {
    entries.push({ ...e, locked: true });
    secBusy.set(`${e.sectionId}|${e.day}|${e.periodSeq}`, 'locked');
    if (e.staffId) {
      staffBusy.set(`${e.staffId}|${e.day}|${e.periodSeq}`, 'locked');
      staffDay.set(`${e.staffId}|${e.day}`, (staffDay.get(`${e.staffId}|${e.day}`) ?? 0) + 1);
      staffWeek.set(e.staffId, (staffWeek.get(e.staffId) ?? 0) + 1);
    }
    if (e.roomId) roomBusy.set(`${e.roomId}|${e.day}|${e.periodSeq}`, 'locked');
    if (e.subjectId) {
      const k = `${e.sectionId}|${e.day}|${e.subjectId}`;
      secDaySubj.set(k, (secDaySubj.get(k) ?? 0) + 1);
      const ak = `${e.sectionId}|${e.subjectId}|${e.staffId}`;
      lockedCount.set(ak, (lockedCount.get(ak) ?? 0) + 1);
    }
  }

  // ---------------------------------------------------------------- build units
  const units: Unit[] = [];
  const used = new Set<string>();
  const groups: GenAllocation[][] = [];
  const byCombined = new Map<string, GenAllocation[]>();
  const bySplit = new Map<string, GenAllocation[]>();
  for (const a of input.allocations) {
    if (a.combinedKey) byCombined.set(a.combinedKey, [...(byCombined.get(a.combinedKey) ?? []), a]);
    else if (a.groupKey) bySplit.set(`${a.sectionId}|${a.groupKey}`, [...(bySplit.get(`${a.sectionId}|${a.groupKey}`) ?? []), a]);
  }
  for (const g of byCombined.values()) {
    groups.push(g);
    g.forEach((a) => used.add(a.id));
  }
  for (const g of bySplit.values()) {
    groups.push(g);
    g.forEach((a) => used.add(a.id));
  }
  for (const a of input.allocations) if (!used.has(a.id)) groups.push([a]);

  let ukey = 0;
  for (const g of groups) {
    const first = g[0]!;
    const remaining = Math.max(
      0,
      Math.max(...g.map((a) => a.periodsPerWeek)) - Math.min(...g.map((a) => lockedCount.get(`${a.sectionId}|${a.subjectId}|${a.staffId}`) ?? 0)),
    );
    const doubles = Math.min(Math.floor(remaining / 2), Math.max(...g.map((a) => a.doublePeriods ?? 0)));
    const parts: Part[] = [];
    const isSplit = !first.combinedKey && !!first.groupKey;
    for (const a of g) {
      const gk = isSplit ? `split:${a.sectionId}:${a.groupKey}` : a.coTeacherId ? `co:${a.id}` : null;
      parts.push({ sectionId: a.sectionId, subjectId: a.subjectId, staffId: a.staffId, groupKey: gk, combinedKey: a.combinedKey ?? null });
      if (a.coTeacherId) parts.push({ sectionId: a.sectionId, subjectId: a.subjectId, staffId: a.coTeacherId, groupKey: gk, combinedKey: a.combinedKey ?? null });
    }
    const base = {
      allocIds: g.map((a) => a.id),
      sections: [...new Set(g.map((a) => a.sectionId))],
      staff: [...new Set(parts.map((p) => p.staffId))],
      parts,
      roomType: g.find((a) => a.roomType)?.roomType ?? null,
      isCore: g.some((a) => a.isCore !== false),
      subjects: [...new Set(g.map((a) => a.subjectId))],
    };
    for (let i = 0; i < doubles; i++) units.push({ ...base, key: `u${ukey++}`, len: 2 });
    for (let i = 0; i < remaining - doubles * 2; i++) units.push({ ...base, key: `u${ukey++}`, len: 1 });
  }

  // ---------------------------------------------------------------- feasibility & scoring
  const roomsOfType = (type: string) => rooms.filter((r) => r.type === type);

  function blockers(u: Unit, day: number, p: number): { ok: boolean; hard: boolean; conflicts: Set<string>; limit: boolean } {
    const conflicts = new Set<string>();
    let hard = false;
    let limit = false;
    for (let i = 0; i < u.len; i++) {
      const pp = p + i;
      for (const s of u.sections) {
        if (pp > ppd(s, day)) return { ok: false, hard: true, conflicts, limit };
        if (fixed.has(`${s}|${day}|${pp}`)) hard = true;
        const occ = secBusy.get(`${s}|${day}|${pp}`);
        if (occ === 'locked') hard = true;
        else if (occ) conflicts.add(occ);
      }
      for (const st of u.staff) {
        if (unavailable.has(`${st}|${day}|${pp}`)) hard = true;
        const occ = staffBusy.get(`${st}|${day}|${pp}`);
        if (occ === 'locked') hard = true;
        else if (occ) conflicts.add(occ);
      }
    }
    for (const st of u.staff) {
      const t = teacher(st);
      if ((staffDay.get(`${st}|${day}`) ?? 0) + u.len > t.maxPerDay) limit = true;
      if ((staffWeek.get(st) ?? 0) + u.len > t.maxPerWeek) limit = true;
    }
    return { ok: !hard && !limit && conflicts.size === 0, hard, conflicts, limit };
  }

  function pickRoom(u: Unit, day: number, p: number): string | null | undefined {
    if (!u.roomType) return null;
    for (const r of roomsOfType(u.roomType)) {
      let free = true;
      for (let i = 0; i < u.len; i++) if (roomBusy.has(`${r.id}|${day}|${p + i}`)) free = false;
      if (free) return r.id;
    }
    return undefined;
  }

  function score(u: Unit, day: number, p: number): number {
    let sc = 0;
    sc += u.isCore ? p * 2 : (maxP - p) * 0.5;
    for (const s of u.sections) {
      for (const subj of u.subjects) {
        const already = secDaySubj.get(`${s}|${day}|${subj}`) ?? 0;
        if (already > 0) sc += u.len === 2 ? 80 : 50;
      }
      const ct = sectionMap.get(s)?.classTeacherId;
      if (p === 1 && ct) sc += u.staff.includes(ct) ? -20 : 5;
    }
    for (const st of u.staff) sc += (staffDay.get(`${st}|${day}`) ?? 0) * 3;
    return sc;
  }

  const placement = new Map<string, Placement>();
  const unitByKey = new Map(units.map((u) => [u.key, u]));

  function place(u: Unit, day: number, p: number, roomId: string | null) {
    for (let i = 0; i < u.len; i++) {
      for (const s of u.sections) secBusy.set(`${s}|${day}|${p + i}`, u.key);
      for (const st of u.staff) staffBusy.set(`${st}|${day}|${p + i}`, u.key);
      if (roomId) roomBusy.set(`${roomId}|${day}|${p + i}`, u.key);
    }
    for (const st of u.staff) {
      staffDay.set(`${st}|${day}`, (staffDay.get(`${st}|${day}`) ?? 0) + u.len);
      staffWeek.set(st, (staffWeek.get(st) ?? 0) + u.len);
    }
    for (const s of u.sections) for (const subj of u.subjects) secDaySubj.set(`${s}|${day}|${subj}`, (secDaySubj.get(`${s}|${day}|${subj}`) ?? 0) + 1);
    placement.set(u.key, { day, p, roomId });
  }

  function unplace(u: Unit) {
    const pl = placement.get(u.key);
    if (!pl) return;
    for (let i = 0; i < u.len; i++) {
      for (const s of u.sections) secBusy.delete(`${s}|${pl.day}|${pl.p + i}`);
      for (const st of u.staff) staffBusy.delete(`${st}|${pl.day}|${pl.p + i}`);
      if (pl.roomId) roomBusy.delete(`${pl.roomId}|${pl.day}|${pl.p + i}`);
    }
    for (const st of u.staff) {
      staffDay.set(`${st}|${pl.day}`, (staffDay.get(`${st}|${pl.day}`) ?? 0) - u.len);
      staffWeek.set(st, (staffWeek.get(st) ?? 0) - u.len);
    }
    for (const s of u.sections) for (const subj of u.subjects) secDaySubj.set(`${s}|${pl.day}|${subj}`, (secDaySubj.get(`${s}|${pl.day}|${subj}`) ?? 0) - 1);
    placement.delete(u.key);
  }

  function bestSlot(u: Unit): { day: number; p: number; roomId: string | null } | null {
    let best: { day: number; p: number; roomId: string | null; sc: number } | null = null;
    for (const day of input.days) {
      for (let p = 1; p <= maxP; p++) {
        if (!blockers(u, day, p).ok) continue;
        const roomId = pickRoom(u, day, p);
        if (roomId === undefined) continue;
        const sc = score(u, day, p);
        if (!best || sc < best.sc) best = { day, p, roomId, sc };
      }
    }
    return best;
  }

  function domainSize(u: Unit): number {
    let n = 0;
    for (const day of input.days) for (let p = 1; p <= maxP; p++) if (blockers(u, day, p).ok) n++;
    return n;
  }

  // Most constrained first: smallest domain, double periods, busiest teachers.
  const teacherLoad = new Map<string, number>();
  for (const u of units) for (const st of u.staff) teacherLoad.set(st, (teacherLoad.get(st) ?? 0) + u.len);
  const order = units
    .map((u) => ({ u, d: domainSize(u), l: Math.max(...u.staff.map((s) => teacherLoad.get(s) ?? 0)) }))
    .sort((a, b) => a.d - b.d || b.u.len - a.u.len || b.u.sections.length - a.u.sections.length || b.l - a.l || a.u.key.localeCompare(b.u.key))
    .map((x) => x.u);

  const failed: Unit[] = [];
  let repairs = 0;
  const maxRepairs = input.maxRepairs ?? 4000;

  for (const u of order) {
    const slot = bestSlot(u);
    if (slot) {
      place(u, slot.day, slot.p, slot.roomId);
      continue;
    }
    // Backtracking repair: displace up to two unlocked lessons, place u, re-place them.
    let fixedIt = false;
    outer: for (const day of input.days) {
      for (let p = 1; p <= maxP; p++) {
        if (repairs >= maxRepairs) break outer;
        const b = blockers(u, day, p);
        if (b.hard || b.limit || b.conflicts.size === 0 || b.conflicts.size > 2) continue;
        repairs++;
        const displaced = [...b.conflicts].map((k) => unitByKey.get(k)!).filter(Boolean);
        const prev = displaced.map((d) => ({ d, pl: placement.get(d.key)! }));
        displaced.forEach(unplace);
        const roomId = pickRoom(u, day, p);
        if (roomId === undefined || !blockers(u, day, p).ok) {
          prev.forEach(({ d, pl }) => place(d, pl.day, pl.p, pl.roomId));
          continue;
        }
        place(u, day, p, roomId);
        const replaced: Unit[] = [];
        let all = true;
        for (const d of displaced) {
          const s2 = bestSlot(d);
          if (!s2) {
            all = false;
            break;
          }
          place(d, s2.day, s2.p, s2.roomId);
          replaced.push(d);
        }
        if (all) {
          fixedIt = true;
          break outer;
        }
        replaced.forEach(unplace);
        unplace(u);
        prev.forEach(({ d, pl }) => place(d, pl.day, pl.p, pl.roomId));
      }
    }
    if (!fixedIt) failed.push(u);
  }

  // ---------------------------------------------------------------- output
  for (const u of units) {
    const pl = placement.get(u.key);
    if (!pl) continue;
    for (let i = 0; i < u.len; i++) {
      for (const part of u.parts) {
        entries.push({ day: pl.day, periodSeq: pl.p + i, sectionId: part.sectionId, subjectId: part.subjectId, staffId: part.staffId, roomId: pl.roomId, groupKey: part.groupKey, combinedKey: part.combinedKey });
      }
    }
  }

  const unplacedMap = new Map<string, Unplaced>();
  for (const u of failed) {
    const reason = diagnose(u);
    const k = `${u.allocIds.join(',')}|${reason}`;
    const prev = unplacedMap.get(k);
    if (prev) prev.periods += u.len;
    else
      unplacedMap.set(k, {
        allocationIds: u.allocIds,
        sectionIds: u.sections,
        subjectIds: u.subjects,
        staffIds: u.staff,
        periods: u.len,
        reason,
        suggestion: SUGGEST[reason],
      });
  }

  function diagnose(u: Unit): UnplacedReason {
    for (const st of u.staff) if ((staffWeek.get(st) ?? 0) + u.len > teacher(st).maxPerWeek) return 'teacher_week_limit';
    if (u.roomType && roomsOfType(u.roomType).length === 0) return 'no_room_of_type';
    let sectionFree = false;
    let commonFree = false;
    let dayLimited = false;
    for (const day of input.days)
      for (let p = 1; p <= maxP; p++) {
        const b = blockers(u, day, p);
        const secOk = u.sections.every((s) => {
          for (let i = 0; i < u.len; i++) if (p + i > ppd(s, day) || secBusy.has(`${s}|${day}|${p + i}`) || fixed.has(`${s}|${day}|${p + i}`)) return false;
          return true;
        });
        if (secOk) sectionFree = true;
        if (secOk && b.conflicts.size === 0 && !b.hard) {
          if (b.limit) dayLimited = true;
          else commonFree = true;
        }
      }
    if (!sectionFree) return 'section_full';
    if (dayLimited && !commonFree) return 'teacher_day_limit';
    if (commonFree && u.roomType) return 'no_room_of_type';
    return 'no_common_free_slot';
  }

  const unplaced = [...unplacedMap.values()];
  const placedUnits = units.filter((u) => placement.has(u.key));
  const totalScore = placedUnits.reduce((s, u) => {
    const pl = placement.get(u.key)!;
    return s + score(u, pl.day, pl.p);
  }, 0);
  return {
    entries,
    unplaced,
    score: Math.round(totalScore + unplaced.reduce((s, x) => s + x.periods * 1000, 0)),
    stats: { units: units.length, placed: placedUnits.length, repairs, ms: Date.now() - t0 },
  };
}

const SUGGEST: Record<UnplacedReason, FixSuggestion> = {
  teacher_week_limit: 'raise_teacher_limit',
  teacher_day_limit: 'raise_teacher_limit',
  no_common_free_slot: 'assign_another_teacher',
  no_room_of_type: 'add_room',
  section_full: 'reduce_periods',
};
