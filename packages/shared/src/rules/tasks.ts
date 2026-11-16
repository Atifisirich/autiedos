/**
 * Task state machine (PRD 5.1 Statuses / Actions / Rules) and recurrence expansion.
 */
import { addDays, isoWeekday, isWorkingDay, parseISODate, type ISODate, type WorkCalendar } from '../time';

export type CalendarLiteLike = Pick<WorkCalendar, 'workingDays' | 'holidays' | 'extraWorkingDays'>;

export const TASK_STATUSES = ['requested', 'declined', 'todo', 'in_progress', 'blocked', 'done', 'verified', 'reopened', 'not_done', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const FINAL_STATUSES: TaskStatus[] = ['verified', 'not_done', 'cancelled', 'declined'];
export const OPEN_STATUSES: TaskStatus[] = ['todo', 'in_progress', 'blocked', 'reopened'];

export type TaskAction =
  | 'accept'
  | 'decline'
  | 'start'
  | 'block'
  | 'unblock'
  | 'complete'
  | 'not_done'
  | 'verify'
  | 'reopen'
  | 'cancel'
  | 'carry_forward';

export type ActorRole = 'owner' | 'assigner' | 'above_assigner' | 'system';

export interface TaskLike {
  status: TaskStatus;
  proofRequired: 'none' | 'note' | 'photo' | 'file';
  verificationRequired: boolean;
}

export interface ActionInput {
  reason?: string | null;
  note?: string | null;
  proofPath?: string | null;
}

export type TransitionError =
  | 'not_allowed_for_role'
  | 'invalid_from_status'
  | 'reason_required'
  | 'proof_required'
  | 'note_required';

const ACTION_RULES: Record<TaskAction, { from: TaskStatus[]; roles: ActorRole[] }> = {
  accept: { from: ['requested'], roles: ['owner'] },
  decline: { from: ['requested'], roles: ['owner'] },
  start: { from: ['todo', 'reopened', 'blocked'], roles: ['owner'] },
  block: { from: ['todo', 'in_progress', 'reopened'], roles: ['owner'] },
  unblock: { from: ['blocked'], roles: ['owner'] },
  complete: { from: ['todo', 'in_progress', 'reopened', 'blocked'], roles: ['owner'] },
  not_done: { from: ['todo', 'in_progress', 'reopened', 'blocked'], roles: ['owner', 'system'] },
  verify: { from: ['done'], roles: ['assigner', 'above_assigner'] },
  reopen: { from: ['done', 'verified', 'not_done'], roles: ['assigner', 'above_assigner'] },
  cancel: { from: ['requested', 'todo', 'in_progress', 'blocked', 'reopened', 'done'], roles: ['assigner', 'above_assigner'] },
  carry_forward: { from: ['todo', 'in_progress', 'reopened', 'blocked'], roles: ['owner'] },
};

/** Applies an action. Returns the next status or a validation error. */
export function transition(task: TaskLike, action: TaskAction, actor: ActorRole[], input: ActionInput = {}): { ok: true; status: TaskStatus } | { ok: false; error: TransitionError } {
  const rule = ACTION_RULES[action];
  if (!actor.some((r) => rule.roles.includes(r))) return { ok: false, error: 'not_allowed_for_role' };
  if (!rule.from.includes(task.status)) return { ok: false, error: 'invalid_from_status' };
  switch (action) {
    case 'accept':
      return { ok: true, status: 'todo' };
    case 'decline':
      if (!input.reason) return { ok: false, error: 'reason_required' };
      return { ok: true, status: 'declined' };
    case 'start':
    case 'unblock':
      return { ok: true, status: 'in_progress' };
    case 'block':
      if (!input.reason) return { ok: false, error: 'reason_required' };
      return { ok: true, status: 'blocked' };
    case 'complete':
      if ((task.proofRequired === 'photo' || task.proofRequired === 'file') && !input.proofPath) return { ok: false, error: 'proof_required' };
      if (task.proofRequired === 'note' && !input.note) return { ok: false, error: 'note_required' };
      return { ok: true, status: 'done' };
    case 'not_done':
      if (!input.reason) return { ok: false, error: 'reason_required' };
      return { ok: true, status: 'not_done' };
    case 'verify':
      return { ok: true, status: 'verified' };
    case 'reopen':
      if (!input.note) return { ok: false, error: 'note_required' };
      return { ok: true, status: 'reopened' };
    case 'cancel':
      return { ok: true, status: 'cancelled' };
    case 'carry_forward':
      return { ok: true, status: task.status };
  }
}

/** A task counts as complete in reports only after verification when verification is required. */
export function countsAsComplete(task: Pick<TaskLike, 'status' | 'verificationRequired'>): boolean {
  return task.verificationRequired ? task.status === 'verified' : task.status === 'done' || task.status === 'verified';
}

/** Editing after completion is blocked; reopening is the only route. */
export function isEditable(status: TaskStatus): boolean {
  return !['done', 'verified', 'not_done', 'cancelled', 'declined'].includes(status);
}

/** Only the assigner or someone above them can change the due date or cancel. */
export function canChangeDueOrCancel(actor: ActorRole[]): boolean {
  return actor.includes('assigner') || actor.includes('above_assigner');
}

// ---------------------------------------------------------------- recurrence
export interface Recurrence {
  frequency: 'daily' | 'weekly' | 'monthly' | 'term' | 'custom';
  intervalN: number;
  weekdays: number[];
  monthDay: number | null;
  customDates: ISODate[];
  startsOn: ISODate;
  endsOn: ISODate | null;
  skipHolidays: boolean;
  /** term start dates, used when frequency = 'term' */
  termStarts?: ISODate[];
}

/** Dates in [from, to] on which the recurrence creates a task. Holidays are skipped. */
export function recurrenceDates(r: Recurrence, from: ISODate, to: ISODate, cal: CalendarLiteLike): ISODate[] {
  const out: ISODate[] = [];
  const start = from > r.startsOn ? from : r.startsOn;
  const end = r.endsOn && r.endsOn < to ? r.endsOn : to;
  const n = Math.max(1, r.intervalN);
  for (let d = start; d <= end; d = addDays(d, 1)) {
    let hit = false;
    const daysFromStart = Math.round((parseISODate(d).getTime() - parseISODate(r.startsOn).getTime()) / 86400000);
    switch (r.frequency) {
      case 'daily':
        hit = daysFromStart % n === 0;
        break;
      case 'weekly': {
        const week = Math.floor(daysFromStart / 7);
        const days = r.weekdays.length ? r.weekdays : [isoWeekday(r.startsOn)];
        hit = week % n === 0 && days.includes(isoWeekday(d));
        break;
      }
      case 'monthly': {
        const sd = parseISODate(r.startsOn);
        const cd = parseISODate(d);
        const months = (cd.getUTCFullYear() - sd.getUTCFullYear()) * 12 + cd.getUTCMonth() - sd.getUTCMonth();
        const md = r.monthDay ?? sd.getUTCDate();
        const lastDay = new Date(Date.UTC(cd.getUTCFullYear(), cd.getUTCMonth() + 1, 0)).getUTCDate();
        hit = months % n === 0 && cd.getUTCDate() === Math.min(md, lastDay);
        break;
      }
      case 'term':
        hit = (r.termStarts ?? []).includes(d);
        break;
      case 'custom':
        hit = r.customDates.includes(d);
        break;
    }
    if (!hit) continue;
    if (r.skipHolidays && !isWorkingDay(d, cal)) continue;
    out.push(d);
  }
  return out;
}
