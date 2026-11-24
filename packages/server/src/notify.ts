/**
 * Notifications (PRD 8.4): in-app inbox, push, WhatsApp. Rules per event decide channels;
 * users can mute optional events; quiet hours hold non-urgent items; low-priority items are
 * batched into a morning and afternoon summary. Text is rendered in each recipient's language.
 */
import { translate, quietHoursRelease, toLocal, fromLocal, addDays, hhmmToMinutes, isLang, type Lang } from '@autoed/shared';
import { maybe, q, withSystem, type Tx } from './db';
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

/**
 * Writes core.notifications rows (product 'os') for staff members. Runs as the org's OS system actor (the
 * recipients are other users), whatever claims the caller's transaction has; callers check permission first.
 */
export async function notify(c: Tx, n: NotifyInput): Promise<number> {
  const ids = [...new Set(n.staffIds.filter((x): x is string => !!x))];
  if (!ids.length) return 0;
  return withSystem(c, n.orgId, () => notifyAsSystem(c, n, ids));
}

async function notifyAsSystem(c: Tx, n: NotifyInput, ids: string[]): Promise<number> {
  const rule = await maybe<{ channels: string[]; optional: boolean; urgent: boolean; enabled: boolean }>(
    c,
    `select channels, coalesce((settings->>'optional')::boolean, true) as optional, coalesce((settings->>'urgent')::boolean, false) as urgent, active as enabled
       from core.notification_rules where org_id = $1 and product_key = 'os' and event_key = $2 and deleted_at is null`,
    [n.orgId, n.event],
  );
  if (rule && !rule.enabled) return 0;
  const channels = rule?.channels ?? ['inapp', 'push'];
  const urgent = n.priority === 'urgent' || !!rule?.urgent;
  const recipients = await q<{ id: string; user_id: string; language: string; branch_id: string | null }>(c, `select id, user_id, language, branch_id from core.staff where id = any($1) and user_id is not null and status = 'active' and deleted_at is null`, [ids]);
  const muted = rule?.optional ? new Set((await q<{ user_id: string }>(c, `select user_id from core.notification_prefs where org_id = $1 and user_id = any($2) and event_key = $3 and muted and deleted_at is null`, [n.orgId, recipients.map((r) => r.user_id), n.event])).map((r) => r.user_id)) : new Set<string>();
  const t = now();
  let count = 0;
  for (const r of recipients) {
    if (muted.has(r.user_id)) continue;
    const branchId = n.branchId ?? r.branch_id;
    let deliverAfter = t;
    if (!urgent && branchId) {
      const b = await maybe<{ settings: { quiet_hours?: { start: string; end: string } }; timezone: string }>(c, `select settings, coalesce(time_zone, 'Asia/Kolkata') as timezone from core.branches where id = $1`, [branchId]);
      const qh = b?.settings?.quiet_hours ?? { start: '20:00', end: '06:30' };
      deliverAfter = quietHoursRelease(t, qh.start, qh.end, b?.timezone ?? 'Asia/Kolkata');
      if (n.priority === 'low') deliverAfter = nextBatch(deliverAfter, b?.timezone ?? 'Asia/Kolkata');
    }
    const lang: Lang = isLang(r.language) ? r.language : 'en';
    // No RETURNING and no ON CONFLICT: the recipient's row is not readable by the system actor (core.notifications is
    // self-only for reads), so a duplicate dedupe key is caught as a unique violation inside a savepoint.
    await c.query('savepoint notify_one');
    const res = await c.query(
      `insert into core.notifications (org_id, user_id, staff_id, product_key, event_key, title, body, link, data, priority, channels, deliver_after, dedupe_key)
       values ($1,$2,$3,'os',$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        n.orgId,
        r.user_id,
        r.id,
        n.event,
        translate(lang, n.titleKey, n.vars),
        n.bodyKey ? translate(lang, n.bodyKey, n.vars) : null,
        n.link ?? null,
        JSON.stringify({ ...(n.data ?? {}), titleKey: n.titleKey, bodyKey: n.bodyKey, vars: n.vars ?? {}, branch_id: branchId }),
        urgent ? 'urgent' : n.priority ?? 'normal',
        channels,
        deliverAfter.toISOString(),
        n.dedupeKey ?? null,
      ],
    ).catch(async (e: { code?: string }) => {
      if (e.code !== '23505') throw e;
      await c.query('rollback to savepoint notify_one');
      return { rowCount: 0 };
    });
    await c.query('release savepoint notify_one');
    if (res.rowCount) count++;
  }
  if (count && channels.some((ch) => ch !== 'inapp')) {
    await enqueue(c, 'deliver_notifications', {}, { dedupeKey: `${n.orgId}:deliver:${Math.floor(t.getTime() / 60000)}` });
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
