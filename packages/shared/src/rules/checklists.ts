/**
 * Checklist rules (PRD 5.2): evaluate answers and decide follow-ups.
 */
export interface ChecklistItemDef {
  id: string;
  itemType: 'tick' | 'yesno' | 'number' | 'photo' | 'text';
  minValue?: number | null;
  maxValue?: number | null;
  required: boolean;
  onFail?: { action: 'ticket'; ticketCategoryKey: string } | { action: 'task'; roleKey: string } | null;
}

export type ItemValue = boolean | number | string | null;

export function itemPassed(item: ChecklistItemDef, value: ItemValue): boolean {
  switch (item.itemType) {
    case 'tick':
    case 'yesno':
      return value === true || value === 'yes';
    case 'number': {
      if (typeof value !== 'number' || Number.isNaN(value)) return false;
      if (item.minValue != null && value < item.minValue) return false;
      if (item.maxValue != null && value > item.maxValue) return false;
      return true;
    }
    case 'photo':
    case 'text':
      return !item.required || (typeof value === 'string' && value.trim().length > 0);
  }
}

export function missingRequired(items: ChecklistItemDef[], answers: Record<string, ItemValue>): string[] {
  return items.filter((i) => i.required && (answers[i.id] === undefined || answers[i.id] === null || answers[i.id] === '')).map((i) => i.id);
}

export interface FollowUp {
  itemId: string;
  action: 'ticket' | 'task';
  target: string;
}

export function followUps(items: ChecklistItemDef[], answers: Record<string, ItemValue>): FollowUp[] {
  const out: FollowUp[] = [];
  for (const i of items) {
    if (!i.onFail) continue;
    const v = answers[i.id];
    if (v === undefined) continue;
    if (itemPassed(i, v ?? null)) continue;
    if (i.onFail.action === 'ticket') out.push({ itemId: i.id, action: 'ticket', target: i.onFail.ticketCategoryKey });
    else out.push({ itemId: i.id, action: 'task', target: i.onFail.roleKey });
  }
  return out;
}

/** Compliance item status from expiry and reminder schedule (PRD 7.8): 60, 30, 7 days. */
export const COMPLIANCE_REMINDER_DAYS = [60, 30, 7] as const;

export function complianceStatus(expiresOn: string | null, today: string): { status: 'valid' | 'expiring' | 'overdue' | 'missing'; daysLeft: number | null } {
  if (!expiresOn) return { status: 'missing', daysLeft: null };
  const days = Math.round((Date.parse(`${expiresOn}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);
  if (days < 0) return { status: 'overdue', daysLeft: days };
  if (days <= 60) return { status: 'expiring', daysLeft: days };
  return { status: 'valid', daysLeft: days };
}

/** Which reminder (60/30/7) is due today and not yet sent. */
export function complianceReminderDue(daysLeft: number | null, sent: number[]): number | null {
  if (daysLeft == null || daysLeft < 0) return null;
  const due = COMPLIANCE_REMINDER_DAYS.filter((d) => daysLeft <= d && !sent.includes(d));
  return due.length ? Math.min(...due) : null;
}

export function readinessPct(items: { status: string }[]): number {
  if (!items.length) return 100;
  return Math.round((items.filter((i) => i.status === 'valid' || i.status === 'expiring').length / items.length) * 1000) / 10;
}
