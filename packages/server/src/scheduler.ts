/**
 * Job handlers and the scheduler tick. `/api/cron/tick` (Vercel cron every minute, or Supabase
 * cron calling the same URL) enqueues due sweeps per branch at their local times, then runs
 * the queue. Dedupe keys make every sweep run once per window.
 *
 * Only orgs that have the OS product are visited (os.active_orgs() uses app.org_has_product), and every
 * sweep and job handler runs as that org's OS system actor, so RLS keeps each run inside one org. The queue
 * itself is claimed by job_runner, which skips jobs of orgs that lost the product (jobs.ts).
 */
import { toLocal, hhmmToMinutes, addDays, isWorkingDay, isoWeekday, monthKey } from '@autoed/shared';
import { asAnonymousServer, asSystem, q, maybe, type Tx } from './db';
import { enqueue, registerJob, runDueJobs } from './jobs';
import { now, workCalendar } from './core';
import { getPush, getWhatsApp } from './adapters/channels';
import { escalationSweep, generateRecurrences, noResponseSweep, dayCloseReminder } from './services/tasks';
import { approvalEscalationSweep } from './services/approvals';
import { absenceSweep, unmarkedSweep, purgeSelfies, balances } from './services/attendance';
import { runGeneration } from './services/timetable';
import { checklistSweep, circularSweep, complianceSweep, dutySweep } from './services/admin';
import { coverageAlertSweep, missingLogSweep, planDeadlineSweep, embedDocument } from './services/planning';
import { sendDigest, reportScheduleSweep, weeklyInsight } from './services/reports';
import { ensureAllowance } from './services/ai';

/** Runs fn as the org's OS system actor. */
const svc = <T>(orgId: string, fn: (c: Tx) => Promise<T>) => asSystem(orgId, fn);

registerJob('timetable_generate', async (job) => {
  try {
    return await runGeneration(job.org_id, String(job.payload.version_id));
  } catch (e) {
    await svc(job.org_id, (c) => c.query(`update core.timetable_versions set status = 'failed' where id = $1`, [job.payload.version_id]));
    throw e;
  }
});
registerJob('embed_document', (job) => svc(job.org_id, (c) => embedDocument(c, String(job.payload.document_id), String(job.payload.text))));
registerJob('escalations', (job) => svc(job.org_id, (c) => escalationSweep(c, now())));
registerJob('approval_escalations', (job) => svc(job.org_id, (c) => approvalEscalationSweep(c, now())));
registerJob('circulars', (job) => svc(job.org_id, (c) => circularSweep(c, now())));
registerJob('report_schedules', (job) => svc(job.org_id, (c) => reportScheduleSweep(c, now())));
registerJob('recurrences', (job) => svc(job.org_id, (c) => generateRecurrences(c, String(job.payload.date))));
registerJob('compliance', (job) => svc(job.org_id, (c) => complianceSweep(c, String(job.payload.date))));
registerJob('selfie_purge', (job) => svc(job.org_id, (c) => purgeSelfies(c, now())));
registerJob('absence', (job) => svc(job.org_id, (c) => absenceSweep(c, String(job.branch_id), now())));
registerJob('unmarked_attendance', (job) => svc(job.org_id, (c) => unmarkedSweep(c, String(job.branch_id), now())));
registerJob('checklists', (job) => svc(job.org_id, (c) => checklistSweep(c, String(job.branch_id), now())));
registerJob('duties', (job) => svc(job.org_id, (c) => dutySweep(c, String(job.branch_id), now())));
registerJob('day_close', (job) =>
  svc(job.org_id, async (c) => ({ reminded: await dayCloseReminder(c, String(job.branch_id), String(job.payload.date), String(job.payload.tz)), logs: await missingLogSweep(c, String(job.branch_id), String(job.payload.date)) })),
);
registerJob('no_response', (job) => svc(job.org_id, (c) => noResponseSweep(c, String(job.branch_id), String(job.payload.date), String(job.payload.tz))));
registerJob('digest', (job) => svc(job.org_id, (c) => sendDigest(c, String(job.branch_id))));
registerJob('coverage_alerts', (job) => svc(job.org_id, (c) => coverageAlertSweep(c, String(job.branch_id), String(job.payload.date))));
registerJob('plan_deadlines', (job) => svc(job.org_id, (c) => planDeadlineSweep(c, String(job.branch_id), String(job.payload.date))));
registerJob('weekly_insight', (job) => svc(job.org_id, (c) => weeklyInsight(c, String(job.branch_id))));
registerJob('ai_allowance', (job) => svc(job.org_id, (c) => ensureAllowance(c, String(job.payload.period))));
registerJob('deliver_notifications', (job) => deliverNotifications(job.org_id));
registerJob('leave_carry_forward', (job) =>
  svc(job.org_id, async (c) => {
    const staff = await q<{ id: string; org_id: string }>(c, `select id, org_id from core.staff where branch_id = $1 and status = 'active'`, [job.payload.branch_id]);
    const prevYear = await maybe<{ ends_on: string }>(c, `select ends_on::text from core.academic_years where id = $1`, [job.payload.from_year]);
    let n = 0;
    for (const s of staff) {
      const bal = await balances(c, s.id, String(job.payload.branch_id), prevYear?.ends_on ?? new Date().toISOString().slice(0, 10)).catch(() => []);
      for (const b of bal) {
        if (!b.carryForwardNext) continue;
        const upd = await c.query(`update core.leave_balances set opening = $5 where org_id = $1 and staff_id = $2 and leave_type_id = $3 and academic_year_id = $4 and deleted_at is null`, [s.org_id, s.id, b.leave_type_id, job.payload.to_year, b.carryForwardNext]);
        if (!upd.rowCount) await c.query(`insert into core.leave_balances (org_id, staff_id, leave_type_id, academic_year_id, opening) values ($1,$2,$3,$4,$5)`, [s.org_id, s.id, b.leave_type_id, job.payload.to_year, b.carryForwardNext]);
        n++;
      }
    }
    return n;
  }),
);

/** Push and WhatsApp delivery for notifications that are due (quiet hours and batching respected). */
export async function deliverNotifications(orgId: string): Promise<{ push: number; whatsapp: number }> {
  return svc(orgId, async (c) => {
    const due = await q<{ id: string; org_id: string; user_id: string; staff_id: string | null; title: string; body: string | null; link: string | null; channels: string[]; push_status: string | null; whatsapp_status: string | null; priority: string; event_key: string; data: Record<string, unknown> }>(
      c,
      `select n.* from core.notifications n where n.org_id = $1 and n.product_key = 'os' and n.deliver_after <= now()
         and ((n.push_status is null and 'push' = any(n.channels)) or (n.whatsapp_status is null and 'whatsapp' = any(n.channels))) order by n.created_at limit 500`,
      [orgId],
    );
    let pushed = 0;
    let wa = 0;
    const push = getPush();
    const whatsapp = getWhatsApp();
    // Low-priority items for one person are summarised into a single push.
    const lowByUser = new Map<string, typeof due>();
    for (const n of due) if (n.priority === 'low' && n.channels.includes('push') && !n.push_status) lowByUser.set(n.user_id, [...(lowByUser.get(n.user_id) ?? []), n]);
    for (const n of due) {
      if (n.channels.includes('push') && !n.push_status) {
        const tokens = await q<{ token: string }>(c, `select token from core.device_tokens where user_id = $1 and revoked_at is null and token not like 'session:%'`, [n.user_id]);
        const batch = n.priority === 'low' ? lowByUser.get(n.user_id) ?? [n] : [n];
        if (n.priority === 'low' && batch[0]!.id !== n.id) {
          await c.query(`update core.notifications set push_status = 'batched' where id = $1`, [n.id]);
        } else {
          const title = batch.length > 1 ? `${batch.length} updates` : n.title;
          const body = batch.length > 1 ? batch.map((b) => b.title).join(' · ').slice(0, 180) : n.body ?? '';
          const res = tokens.length ? await push.send(tokens.map((t) => ({ token: t.token, title, body, data: { link: n.link, notification_id: n.id } }))) : [];
          await c.query(`update core.notifications set push_status = $2 where id = $1`, [n.id, tokens.length ? (res.every((r) => r.ok) ? 'sent' : 'partial') : 'no_device']);
          for (const r of res.filter((x) => !x.ok && x.error?.includes('DeviceNotRegistered'))) await c.query(`update core.device_tokens set revoked_at = now() where token = $1`, [r.token]);
          pushed++;
        }
      }
      if (n.channels.includes('whatsapp') && !n.whatsapp_status) {
        const rule = await maybe<{ whatsapp_template: string | null }>(c, `select settings->>'whatsapp_template' as whatsapp_template from core.notification_rules where org_id = $1 and product_key = 'os' and event_key = $2 and deleted_at is null`, [n.org_id, n.event_key]);
        const staff = n.staff_id ? await maybe<{ phone: string | null; language: string; branch_id: string | null }>(c, `select phone, language, branch_id from core.staff where id = $1`, [n.staff_id]) : null;
        if (!rule?.whatsapp_template || !staff?.phone) {
          await c.query(`update core.notifications set whatsapp_status = 'skipped' where id = $1`, [n.id]);
          continue;
        }
        const appUrl = process.env.APP_URL ?? '';
        const r = await whatsapp.send({ to: staff.phone, template: rule.whatsapp_template, language: staff.language, variables: [n.title, `${appUrl}${n.link ?? '/os'}`] });
        await c.query(`update core.notifications set whatsapp_status = $2 where id = $1`, [n.id, r.ok ? 'sent' : 'failed']);
        // Each send is metered in the one channel layer (core.outbox) and billed to the school.
        await c.query(
          `insert into core.outbox (org_id, branch_id, product_key, channel, to_address, event_key, provider, notification_id, status, units, provider_ref, sent_at)
           values ($1,$2,'os','whatsapp',$3,$4,$5,$6,$7,1,$8, now())`,
          [n.org_id, staff.branch_id, staff.phone, n.event_key, rule.whatsapp_template, n.id, r.ok ? 'sent' : 'failed', r.ref ?? null],
        );
        wa++;
      }
    }
    return { push: pushed, whatsapp: wa };
  });
}

/** Enqueues everything that is due now, for every org that has the OS product. Safe to call every minute. */
export async function tick(at: Date = now()): Promise<{ enqueued: number; ran: Awaited<ReturnType<typeof runDueJobs>> }> {
  let enqueued = 0;
  const bucket = (mins: number) => Math.floor(at.getTime() / (mins * 60000));
  const orgs = await asAnonymousServer((c) => q<{ org_id: string }>(c, `select org_id from os.active_orgs()`));
  for (const { org_id: orgId } of orgs) {
    await svc(orgId, async (c) => {
      const e = async (kind: string, key: string, payload: Record<string, unknown> = {}, branchId?: string) => {
        if (await enqueue(c, kind, payload, { dedupeKey: `${orgId}:${key}`, branchId })) enqueued++;
      };
      await e('escalations', `esc:${bucket(5)}`);
      await e('approval_escalations', `apesc:${bucket(15)}`);
      await e('circulars', `circ:${bucket(5)}`);
      await e('report_schedules', `rs:${bucket(5)}`);
      await e('deliver_notifications', `deliver:${bucket(1)}`);
      const branches = await q<{ id: string; timezone: string; settings: { day_close_time?: string; digest_time?: string } }>(c, `select id, time_zone as timezone, settings from core.branches where active and org_id = $1`, [orgId]);
      let orgDaily = false;
      for (const b of branches) {
        const local = toLocal(at, b.timezone);
        const cal = await workCalendar(c, b.id);
        const working = isWorkingDay(local.date, cal);
        const after = (hhmm: string) => local.minutes >= hhmmToMinutes(hhmm);
        const flags = new Map((await q<{ module_key: string; enabled: boolean }>(c, `select module_key, enabled from os.module_flags where branch_id = $1`, [b.id])).map((f) => [f.module_key, f.enabled]));
        const on = (m: string) => flags.get(m) !== false;
        if (after('00:30')) {
          await e('recurrences', `rec:${b.id}:${local.date}`, { date: local.date }, b.id);
          if (!orgDaily) {
            orgDaily = true;
            await e('compliance', `comp:${local.date}`, { date: local.date });
            await e('selfie_purge', `selfie:${local.date}`);
            await e('ai_allowance', `allow:${monthKey(local.date)}`, { period: monthKey(local.date) });
          }
          if (on('lesson_planner')) await e('plan_deadlines', `pd:${b.id}:${local.date}`, { date: local.date }, b.id);
          if (on('syllabus_coverage')) await e('coverage_alerts', `cov:${b.id}:${local.date}`, { date: local.date }, b.id);
        }
        if (after('06:00') && on('tasks')) {
          let prev = addDays(local.date, -1);
          for (let i = 0; i < 7 && !isWorkingDay(prev, cal); i++) prev = addDays(prev, -1);
          await e('no_response', `nr:${b.id}:${prev}`, { date: prev, tz: b.timezone }, b.id);
        }
        if (!working) continue;
        if (on('checklists')) await e('checklists', `chk:${b.id}:${bucket(15)}`, {}, b.id);
        if (on('duty_roster')) await e('duties', `duty:${b.id}:${bucket(5)}`, {}, b.id);
        if (on('staff_attendance') && on('substitution')) await e('absence', `abs:${b.id}:${bucket(15)}`, {}, b.id);
        if (on('student_attendance')) await e('unmarked_attendance', `unm:${b.id}:${bucket(15)}`, {}, b.id);
        if (after(b.settings.day_close_time ?? '17:30')) await e('day_close', `dc:${b.id}:${local.date}`, { date: local.date, tz: b.timezone }, b.id);
        if (after(b.settings.digest_time ?? '07:30') && on('reports')) await e('digest', `dg:${b.id}:${local.date}`, {}, b.id);
        if (isoWeekday(local.date) === 1 && after('07:00') && on('reports')) await e('weekly_insight', `wi:${b.id}:${local.date}`, {}, b.id);
      }
    });
  }
  const ran = await runDueJobs(100, 'tick');
  return { enqueued, ran };
}
