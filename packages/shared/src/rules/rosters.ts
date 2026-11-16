/**
 * Fair allocation engines: duty rotation (7.6), invigilation (6.4), exam seating (6.4).
 */
import type { ISODate } from '../time';

export interface RosterStaff {
  id: string;
  name: string;
  /** dates (or date|slot keys) when unavailable: on leave, teaching at that time, etc. */
  busy: Set<string>;
  /** duties already held in the period (for fairness) */
  load: number;
}

export interface DutySlot {
  key: string; // dutyTypeId|date
  dutyTypeId: string;
  date: ISODate;
  busyKey: string; // key to check in staff.busy (e.g. date|periodSeq or date)
  needed: number;
}

/**
 * Assigns staff to duty slots, always choosing the least-loaded free person (ties by name),
 * never twice for the same slot and at most `maxPerDay` duties per person per day.
 */
export function rotateDuties(slots: DutySlot[], staff: RosterStaff[], maxPerDay = 1): { assignments: { slotKey: string; staffId: string }[]; unfilled: { slotKey: string; missing: number }[] } {
  const load = new Map(staff.map((s) => [s.id, s.load]));
  const perDay = new Map<string, number>();
  const assignments: { slotKey: string; staffId: string }[] = [];
  const unfilled: { slotKey: string; missing: number }[] = [];
  for (const slot of [...slots].sort((a, b) => a.date.localeCompare(b.date) || a.key.localeCompare(b.key))) {
    const chosen = new Set<string>();
    for (let k = 0; k < slot.needed; k++) {
      const free = staff
        .filter((s) => !chosen.has(s.id) && !s.busy.has(slot.busyKey) && !s.busy.has(slot.date) && (perDay.get(`${s.id}|${slot.date}`) ?? 0) < maxPerDay)
        .sort((a, b) => load.get(a.id)! - load.get(b.id)! || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
      const pick = free[0];
      if (!pick) {
        unfilled.push({ slotKey: slot.key, missing: slot.needed - k });
        break;
      }
      chosen.add(pick.id);
      load.set(pick.id, load.get(pick.id)! + 1);
      perDay.set(`${pick.id}|${slot.date}`, (perDay.get(`${pick.id}|${slot.date}`) ?? 0) + 1);
      assignments.push({ slotKey: slot.key, staffId: pick.id });
    }
  }
  return { assignments, unfilled };
}

export interface InvigilationSlot {
  key: string; // scheduleId|roomId
  date: ISODate;
  /** subject teachers of the paper are excluded */
  subjectTeacherIds: string[];
  /** time window key used for clash checks, e.g. date|09:00-12:00 */
  windowKey: string;
}

/** Invigilation: not the subject teacher, max duties per day, fair spread, no time clash. */
export function assignInvigilators(slots: InvigilationSlot[], staff: RosterStaff[], maxPerDay: number): { assignments: { slotKey: string; staffId: string }[]; unfilled: string[] } {
  const load = new Map(staff.map((s) => [s.id, s.load]));
  const perDay = new Map<string, number>();
  const windows = new Set<string>();
  const assignments: { slotKey: string; staffId: string }[] = [];
  const unfilled: string[] = [];
  for (const slot of [...slots].sort((a, b) => a.date.localeCompare(b.date) || a.key.localeCompare(b.key))) {
    const pick = staff
      .filter(
        (s) =>
          !slot.subjectTeacherIds.includes(s.id) &&
          !s.busy.has(slot.date) &&
          !s.busy.has(slot.windowKey) &&
          !windows.has(`${s.id}|${slot.windowKey}`) &&
          (perDay.get(`${s.id}|${slot.date}`) ?? 0) < maxPerDay,
      )
      .sort((a, b) => load.get(a.id)! - load.get(b.id)! || a.name.localeCompare(b.name) || a.id.localeCompare(b.id))[0];
    if (!pick) {
      unfilled.push(slot.key);
      continue;
    }
    load.set(pick.id, load.get(pick.id)! + 1);
    perDay.set(`${pick.id}|${slot.date}`, (perDay.get(`${pick.id}|${slot.date}`) ?? 0) + 1);
    windows.add(`${pick.id}|${slot.windowKey}`);
    assignments.push({ slotKey: slot.key, staffId: pick.id });
  }
  return { assignments, unfilled };
}

export interface SeatStudent {
  id: string;
  classId: string;
  rollNo: number;
}

/**
 * Seating plan by room capacity, interleaving classes so neighbours come from different
 * classes wherever possible.
 */
export function seatingPlan(students: SeatStudent[], rooms: { id: string; capacity: number }[]): { rooms: { roomId: string; seats: { seat: number; studentId: string; classId: string }[] }[]; unseated: string[] } {
  const byClass = new Map<string, SeatStudent[]>();
  for (const s of [...students].sort((a, b) => a.classId.localeCompare(b.classId) || a.rollNo - b.rollNo)) {
    byClass.set(s.classId, [...(byClass.get(s.classId) ?? []), s]);
  }
  // round-robin across classes
  const queues = [...byClass.values()];
  const order: SeatStudent[] = [];
  while (queues.some((q) => q.length)) {
    for (const q of queues) {
      const s = q.shift();
      if (s) order.push(s);
    }
  }
  const out: { roomId: string; seats: { seat: number; studentId: string; classId: string }[] }[] = [];
  let i = 0;
  for (const r of rooms) {
    const seats: { seat: number; studentId: string; classId: string }[] = [];
    for (let seat = 1; seat <= r.capacity && i < order.length; seat++, i++) seats.push({ seat, studentId: order[i]!.id, classId: order[i]!.classId });
    out.push({ roomId: r.id, seats });
  }
  return { rooms: out, unseated: order.slice(i).map((s) => s.id) };
}
