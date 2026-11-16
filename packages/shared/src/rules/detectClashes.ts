/**
 * Timetable clash detection (PRD 5.3): hard constraints — no teacher, section or room clash,
 * teacher limits respected, unavailable slots respected.
 * Split groups (same section, same non-null groupKey) and combined sections (same staff,
 * same non-null combinedKey) are not clashes.
 */
export interface TTEntry {
  id: string;
  day: number;
  periodSeq: number;
  sectionId: string;
  staffId: string | null;
  roomId: string | null;
  subjectId?: string | null;
  groupKey?: string | null;
  combinedKey?: string | null;
}

export interface TeacherLimits {
  maxPerDay: number;
  maxPerWeek: number;
  unavailable: { day: number; periodSeq: number }[];
}

export type ClashType = 'teacher' | 'section' | 'room' | 'teacher_day_limit' | 'teacher_week_limit' | 'teacher_unavailable';

export interface Clash {
  type: ClashType;
  day?: number;
  periodSeq?: number;
  entryIds: string[];
  staffId?: string;
  sectionId?: string;
  roomId?: string;
}

const slotKey = (e: TTEntry) => `${e.day}:${e.periodSeq}`;

export function detectClashes(entries: TTEntry[], limits: Record<string, TeacherLimits> = {}): Clash[] {
  const clashes: Clash[] = [];
  const bySlot = new Map<string, TTEntry[]>();
  for (const e of entries) {
    const k = slotKey(e);
    const list = bySlot.get(k);
    if (list) list.push(e);
    else bySlot.set(k, [e]);
  }

  for (const list of bySlot.values()) {
    const day = list[0]!.day;
    const periodSeq = list[0]!.periodSeq;
    // Teacher: a teacher may appear several times in a slot only for one combined lesson.
    const byStaff = groupBy(list.filter((e) => e.staffId), (e) => e.staffId!);
    for (const [staffId, es] of byStaff) {
      if (es.length < 2) continue;
      const keys = new Set(es.map((e) => e.combinedKey ?? `solo:${e.id}`));
      if (keys.size > 1) clashes.push({ type: 'teacher', day, periodSeq, staffId, entryIds: es.map((e) => e.id) });
    }
    // Section: several entries only when they are all the same split group / co-teaching group.
    const bySection = groupBy(list, (e) => e.sectionId);
    for (const [sectionId, es] of bySection) {
      if (es.length < 2) continue;
      const keys = new Set(es.map((e) => e.groupKey ?? `solo:${e.id}`));
      if (keys.size > 1) clashes.push({ type: 'section', day, periodSeq, sectionId, entryIds: es.map((e) => e.id) });
    }
    // Room: shared only by one combined lesson.
    const byRoom = groupBy(list.filter((e) => e.roomId), (e) => e.roomId!);
    for (const [roomId, es] of byRoom) {
      if (es.length < 2) continue;
      const keys = new Set(es.map((e) => e.combinedKey ?? `solo:${e.id}`));
      if (keys.size > 1) clashes.push({ type: 'room', day, periodSeq, roomId, entryIds: es.map((e) => e.id) });
    }
  }

  // Limits: count distinct teaching slots per teacher (a combined lesson counts once).
  const byTeacher = groupBy(entries.filter((e) => e.staffId), (e) => e.staffId!);
  for (const [staffId, es] of byTeacher) {
    const lim = limits[staffId];
    if (!lim) continue;
    const slots = new Map<string, TTEntry[]>();
    for (const e of es) {
      const k = slotKey(e);
      slots.set(k, [...(slots.get(k) ?? []), e]);
    }
    const perDay = new Map<number, string[]>();
    for (const [k, list] of slots) {
      const d = Number(k.split(':')[0]);
      perDay.set(d, [...(perDay.get(d) ?? []), ...list.map((x) => x.id)]);
      const [day, seq] = k.split(':').map(Number);
      if (lim.unavailable.some((u) => u.day === day && u.periodSeq === seq)) {
        clashes.push({ type: 'teacher_unavailable', day, periodSeq: seq, staffId, entryIds: list.map((x) => x.id) });
      }
    }
    for (const [day, ids] of perDay) {
      const count = new Set(es.filter((e) => e.day === day).map(slotKey)).size;
      if (count > lim.maxPerDay) clashes.push({ type: 'teacher_day_limit', day, staffId, entryIds: ids });
    }
    if (slots.size > lim.maxPerWeek) clashes.push({ type: 'teacher_week_limit', staffId, entryIds: es.map((e) => e.id) });
  }
  return clashes;
}

/** Clashes a proposed move would introduce (for live warnings while dragging). */
export function clashesForMove(entries: TTEntry[], moved: TTEntry, limits: Record<string, TeacherLimits> = {}): Clash[] {
  const next = entries.filter((e) => e.id !== moved.id).concat(moved);
  return detectClashes(next, limits).filter((c) => c.entryIds.includes(moved.id));
}

function groupBy<T>(xs: T[], key: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of xs) {
    const k = key(x);
    const l = m.get(k);
    if (l) l.push(x);
    else m.set(k, [x]);
  }
  return m;
}
