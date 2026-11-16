/**
 * Task escalation engine (PRD 5.1 Escalation).
 * Default: reminder 2h before due; at due notify owner; 4 working hours overdue notify assigner;
 * 1 working day overdue notify the assigner's manager. Urgent tasks use half those intervals.
 */
import { addWorkingMinutes, workingDayMinutes, type WorkCalendar } from '../time';

export interface EscalationRule {
  remindBeforeMinutes: number;
  notifyOwnerAtDue: boolean;
  notifyAssignerAfterWorkingMinutes: number;
  notifyManagerAfterWorkingDays: number;
  urgentFactor: number;
}

export const DEFAULT_ESCALATION: EscalationRule = {
  remindBeforeMinutes: 120,
  notifyOwnerAtDue: true,
  notifyAssignerAfterWorkingMinutes: 240,
  notifyManagerAfterWorkingDays: 1,
  urgentFactor: 0.5,
};

export type EscalationTarget = 'owner' | 'assigner' | 'manager';

export interface EscalationStep {
  level: 1 | 2 | 3 | 4;
  at: Date;
  notify: EscalationTarget;
  kind: 'reminder' | 'due' | 'overdue_assigner' | 'overdue_manager';
}

export interface EscalatableTask {
  dueAt: Date | null;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  status: string;
  lastEscalationLevel: number;
}

const OPEN = new Set(['todo', 'in_progress', 'blocked', 'reopened']);

/** All escalation steps for a task, in order. */
export function escalationSchedule(task: Pick<EscalatableTask, 'dueAt' | 'priority'>, rule: EscalationRule, cal: WorkCalendar): EscalationStep[] {
  if (!task.dueAt) return [];
  const f = task.priority === 'urgent' ? rule.urgentFactor : 1;
  const due = task.dueAt;
  const steps: EscalationStep[] = [];
  steps.push({ level: 1, at: new Date(due.getTime() - Math.round(rule.remindBeforeMinutes * f) * 60000), notify: 'owner', kind: 'reminder' });
  if (rule.notifyOwnerAtDue) steps.push({ level: 2, at: due, notify: 'owner', kind: 'due' });
  steps.push({ level: 3, at: addWorkingMinutes(due, Math.round(rule.notifyAssignerAfterWorkingMinutes * f), cal), notify: 'assigner', kind: 'overdue_assigner' });
  steps.push({
    level: 4,
    at: addWorkingMinutes(due, Math.round(rule.notifyManagerAfterWorkingDays * workingDayMinutes(cal) * f), cal),
    notify: 'manager',
    kind: 'overdue_manager',
  });
  return steps;
}

/**
 * The next escalation step that has not fired yet, or null when the task is closed or all
 * steps fired. `due` tells the caller whether it should fire now.
 */
export function nextEscalation(task: EscalatableTask, rule: EscalationRule, cal: WorkCalendar, now: Date): (EscalationStep & { due: boolean }) | null {
  if (!OPEN.has(task.status)) return null;
  const next = escalationSchedule(task, rule, cal).find((s) => s.level > task.lastEscalationLevel);
  if (!next) return null;
  return { ...next, due: next.at.getTime() <= now.getTime() };
}

/**
 * Steps that are due now. When a job was delayed, earlier unfired steps are skipped except the
 * latest due one, so people are not flooded with stale reminders.
 */
export function dueEscalation(task: EscalatableTask, rule: EscalationRule, cal: WorkCalendar, now: Date): EscalationStep | null {
  if (!OPEN.has(task.status)) return null;
  const due = escalationSchedule(task, rule, cal).filter((s) => s.level > task.lastEscalationLevel && s.at.getTime() <= now.getTime());
  return due.length ? due[due.length - 1]! : null;
}

/** Overdue is a derived flag, not a status. */
export function isOverdue(task: Pick<EscalatableTask, 'dueAt' | 'status'>, now: Date): boolean {
  return !!task.dueAt && OPEN.has(task.status) && task.dueAt.getTime() < now.getTime();
}
