/**
 * Notifications (PRD 8.4): in-app inbox, push, WhatsApp. Rules per event decide channels;
 * users can mute optional events; quiet hours hold non-urgent items; low-priority items are
 * batched into a morning and afternoon summary. Text is rendered in each recipient's language.
 */
import { translate, quietHoursRelease, toLocal, fromLocal, addDays, hhmmToMinutes, isLang, type Lang } from '@autoed/shared';
import { insert, maybe, q, type Tx } from './db';
import { now } from './core';
import { enqueue } from './jobs';

export interface NotifyInput {
  orgId: string;
  branchId: string | null;
  staffIds: (string | null | undefined)[];
  event: string;
  titleKey: string;
  bodyKey?: string;
  vars?: Record<string, string | number>;
  link?: string;
  data?: Record<string, unknown>;
  priority?: 'low' | 'normal' | 'urgent';
  dedupeKey?: string;
  /** Force WhatsApp for this message (e.g. escalations) when the rule allows it. */
}

export async function notify(c: Tx, n: NotifyInput): Promise<number> {
  const ids = [...new Set(n.staffIds.filter((x): x is string => !!x))];
  if (!ids.length) return 0;
  const rule = await maybe<{ channels: string[]; optional: boolean; urgent: boolean; enabled: boolean }>(c, `select channels, optional, urgent, enabled from public.notification_rules where org_id = $1 and event_key = $2 and deleted_at is null`, [n.orgId, n.event]);
  if (rule && !rule.enabled) return 0;
  const channels = rule?.channels ?? ['inapp', 'push'];
  const urgent = n.priority === 'urgent' || !!rule?.urgent;
  const recipients = await q<{ id: string; language: string; branch_id: string | null }>(c, `select id, language, branch_id from public.staff where id = any($1) and status = 'active' and deleted_at is null`, [ids]);
  const muted = rule?.optional ? new Set((await q<{ staff_id: string }>(c, `select staff_id from public.notification_prefs where staff_id = any($1) and event_key = $2 and muted and deleted_at is null`, [ids, n.event])).map((r) => r.staff_id)) : new Set<string>();
  const t = now();
  let count = 0;
  for (const r of recipients) {
    if (muted.has(r.id)) continue;
    const branchId = n.branchId ?? r.branch_id;
    let deliverAfter = t;
    if (!urgent && branchId) {
      const b = await maybe<{ settings: { quiet_hours?: { start: string; end: string } }; timezone: string }>(c, `select settings, timezone from public.branches where id = $1`, [branchId]);
      const qh = b?.settings?.quiet_hours ?? { start: '20:00', end: '06:30' };
      deliverAfter = quietHoursRelease(t, qh.start, qh.end, b?.timezone ?? 'Asia/Kolkata');
      if (n.priority === 'low') deliverAfter = nextBatch(deliverAfter, b?.timezone ?? 'Asia/Kolkata');
    }
    const lang: Lang = isLang(r.language) ? r.language : 'en';
    const row = await insert<{ id: string } | undefined>(
      c,
      'notifications',
      {
        org_id: n.orgId,
        branch_id: branchId,
        staff_id: r.id,
        event_key: n.event,
        title: translate(lang, n.titleKey, n.vars),
        body: n.bodyKey ? translate(lang, n.bodyKey, n.vars) : null,
        link: n.link ?? null,
        data: { ...(n.data ?? {}), titleKey: n.titleKey, bodyKey: n.bodyKey, vars: n.vars ?? {} },
        priority: urgent ? 'urgent' : n.priority ?? 'normal',
        channels,
        deliver_after: deliverAfter.toISOString(),
        dedupe_key: n.dedupeKey ?? null,
      },
      { onConflict: n.dedupeKey ? '(staff_id, dedupe_key) where dedupe_key is not null do nothing' : undefined },
    );
    if (row) count++;
  }
  if (count && channels.some((ch) => ch !== 'inapp')) {
    await enqueue(c, 'deliver_notifications', {}, { dedupeKey: `deliver:${Math.floor(t.getTime() / 60000)}` });
  }
  return count;
}

/** Morning (07:00) and afternoon (13:00) batch windows for low-priority items. */
function nextBatch(after: Date, tz: string): Date {
  const { date, minutes } = toLocal(after, tz);
  if (minutes <= hhmmToMinutes('07:00')) return fromLocal(date, '07:00', tz);
  if (minutes <= hhmmToMinutes('13:00')) return fromLocal(date, '13:00', tz);
  return fromLocal(addDays(date, 1), '07:00', tz);
}
