/**
 * Job handlers and the scheduler tick. `/api/cron/tick` (Vercel cron every minute, or Supabase
 * cron calling the same URL) enqueues due sweeps per branch at their local times, then runs
 * the queue. Dedupe keys make every sweep run once per window.
 */
import { toLocal, hhmmToMinutes, addDays, isWorkingDay, isoWeekday, monthKey } from '@autoed/shared';
import { asService, q, maybe, type Tx } from './db';
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

const svc = <T>(fn: (c: Tx) => Promise<T>) => asService(fn);

registerJob('timetable_generate', async (job) => {
  try {
    return await runGeneration(String(job.payload.version_id));
  } catch (e) {
    await svc((c) => c.query(`update public.timetable_versions set status = 'failed' where id = $1`, [job.payload.version_id]));
    throw e;
  }
});
registerJob('embed_document', (job) => svc((c) => embedDocument(c, String(job.payload.document_id), String(job.payload.text))));
registerJob('escalations', () => svc((c) => escalationSweep(c, now())));
registerJob('approval_escalations', () => svc((c) => approvalEscalationSweep(c, now())));
registerJob('circulars', () => svc((c) => circularSweep(c, now())));
registerJob('report_schedules', () => svc((c) => reportScheduleSweep(c, now())));
registerJob('recurrences', (job) => svc((c) => generateRecurrences(c, String(job.payload.date))));
registerJob('compliance', (job) => svc((c) => complianceSweep(c, String(job.payload.date))));
registerJob('selfie_purge', () => svc((c) => purgeSelfies(c, now())));
registerJob('absence', (job) => svc((c) => absenceSweep(c, String(job.branch_id), now())));
registerJob('unmarked_attendance', (job) => svc((c) => unmarkedSweep(c, String(job.branch_id), now())));
registerJob('checklists', (job) => svc((c) => checklistSweep(c, String(job.branch_id), now())));
registerJob('duties', (job) => svc((c) => dutySweep(c, String(job.branch_id), now())));
registerJob('day_close', (job) => svc(async (c) => ({ reminded: await dayCloseReminder(c, String(job.branch_id), String(job.payload.date), String(job.payload.tz)), logs: await missingLogSweep(c, String(job.branch_id), String(job.payload.date)) })));
registerJob('no_response', (job) => svc((c) => noResponseSweep(c, String(job.branch_id), String(job.payload.date), String(job.payload.tz))));
registerJob('digest', (job) => svc((c) => sendDigest(c, String(job.branch_id))));
registerJob('coverage_alerts', (job) => svc((c) => coverageAlertSweep(c, String(job.branch_id), String(job.payload.date))));
registerJob('plan_deadlines', (job) => svc((c) => planDeadlineSweep(c, String(job.branch_id), String(job.payload.date))));
registerJob('weekly_insight', (job) => svc((c) => weeklyInsight(c, String(job.branch_id))));
registerJob('ai_allowance', (job) => svc((c) => ensureAllowance(c, String(job.org_id), String(job.branch_id), String(job.payload.period))));
registerJob('deliver_notifications', () => deliverNotifications());
registerJob('leave_carry_forward', (job) =>
  svc(async (c) => {
    const staff = await q<{ id: string; org_id: string }>(c, `select id, org_id from public.staff where branch_id = $1 and status = 'active'`, [job.payload.branch_id]);
    const prevYear = await maybe<{ ends_on: string }>(c, `select ends_on::text from public.academic_years where id = $1`, [job.payload.from_year]);
    let n = 0;
    for (const s of staff) {
      const bal = await balances(c, s.id, String(job.payload.branch_id), prevYear?.ends_on ?? new Date().toISOString().slice(0, 10)).catch(() => []);
      for (const b of bal) {
        if (!b.carryForwardNext) continue;
        await c.query(`insert into public.leave_balances (org_id, branch_id, staff_id, leave_type_id, academic_year_id, opening) values ($1,$2,$3,$4,$5,$6) on conflict (staff_id, leave_type_id, academic_year_id) do update set opening = excluded.opening`, [s.org_id, job.payload.branch_id, s.id, b.leave_type_id, job.payload.to_year, b.carryForwardNext]);
        n++;
      }
    }
    return n;
  }),
);

/** Push and WhatsApp delivery for notifications that are due (quiet hours and batching respected). */
export async function deliverNotifications(): Promise<{ push: number; whatsapp: number }> {
  return svc(async (c) => {
    const due = await q<{ id: string; org_id: string; branch_id: string | null; staff_id: string; title: string; body: string | null; link: string | null; channels: string[]; push_status: string | null; whatsapp_status: string | null; priority: string; event_key: string; data: Record<string, unknown> }>(
      c,
      `select n.* from public.notifications n where n.deliver_after <= now() and ((n.push_status is null and 'push' = any(n.channels)) or (n.whatsapp_status is null and 'whatsapp' = any(n.channels))) order by n.created_at limit 500`,
    );
    let pushed = 0;
    let wa = 0;
    const push = getPush();
    const whatsapp = getWhatsApp();
    // Low-priority items for one person are summarised into a single push.
    const lowByStaff = new Map<string, typeof due>();
    for (const n of due) if (n.priority === 'low' && n.channels.includes('push') && !n.push_status) lowByStaff.set(n.staff_id, [...(lowByStaff.get(n.staff_id) ?? []), n]);
    for (const n of due) {
      if (n.channels.includes('push') && !n.push_status) {
        const tokens = await q<{ token: string }>(c, `select token from public.device_tokens where staff_id = $1 and revoked_at is null and token not like 'session:%'`, [n.staff_id]);
        const batch = n.priority === 'low' ? lowByStaff.get(n.staff_id) ?? [n] : [n];
        if (n.priority === 'low' && batch[0]!.id !== n.id) {
          await c.query(`update public.notifications set push_status = 'batched' where id = $1`, [n.id]);
        } else {
          const title = batch.length > 1 ? `${batch.length} updates` : n.title;
          const body = batch.length > 1 ? batch.map((b) => b.title).join(' · ').slice(0, 180) : n.body ?? '';
          const res = tokens.length ? await push.send(tokens.map((t) => ({ token: t.token, title, body, data: { link: n.link, notification_id: n.id } }))) : [];
          await c.query(`update public.notifications set push_status = $2 where id = $1`, [n.id, tokens.length ? (res.every((r) => r.ok) ? 'sent' : 'partial') : 'no_device']);
          for (const r of res.filter((x) => !x.ok && x.error?.includes('DeviceNotRegistered'))) await c.query(`update public.device_tokens set revoked_at = now() where token = $1`, [r.token]);
          pushed++;
        }
      }
      if (n.channels.includes('whatsapp') && !n.whatsapp_status) {
        const rule = await maybe<{ whatsapp_template: string | null }>(c, `select whatsapp_template from public.notification_rules where org_id = $1 and event_key = $2`, [n.org_id, n.event_key]);
        const staff = await maybe<{ phone: string | null; language: string }>(c, `select phone, language from public.staff where id = $1`, [n.staff_id]);
        if (!rule?.whatsapp_template || !staff?.phone) {
          await c.query(`update public.notifications set whatsapp_status = 'skipped' where id = $1`, [n.id]);
          continue;
        }
        const appUrl = process.env.APP_URL ?? '';
        const r = await whatsapp.send({ to: staff.phone, template: rule.whatsapp_template, language: staff.language, variables: [n.title, `${appUrl}${n.link ?? '/os'}`] });
        await c.query(`update public.notifications set whatsapp_status = $2 where id = $1`, [n.id, r.ok ? 'sent' : 'failed']);
        // Each send is metered per branch and billed to the school.
        await c.query(`insert into public.message_usage (org_id, branch_id, channel, template_key, notification_id, status, units, provider_ref) values ($1,$2,'whatsapp',$3,$4,$5,1,$6)`, [n.org_id, n.branch_id, rule.whatsapp_template, n.id, r.ok ? 'sent' : 'failed', r.ref ?? null]);
        wa++;
      }
    }
    return { push: pushed, whatsapp: wa };
  });
}

/** Enqueues everything that is due now. Safe to call every minute. */
export async function tick(at: Date = now()): Promise<{ enqueued: number; ran: Awaited<ReturnType<typeof runDueJobs>> }> {
  let enqueued = 0;
  const bucket = (mins: number) => Math.floor(at.getTime() / (mins * 60000));
  await svc(async (c) => {
    const e = async (kind: string, key: string, payload: Record<string, unknown> = {}, orgId?: string, branchId?: string) => {
      if (await enqueue(c, kind, payload, { dedupeKey: key, orgId, branchId })) enqueued++;
    };
    await e('escalations', `esc:${bucket(5)}`);
    await e('approval_escalations', `apesc:${bucket(15)}`);
    await e('circulars', `circ:${bucket(5)}`);
    await e('report_schedules', `rs:${bucket(5)}`);
    await e('deliver_notifications', `deliver:${bucket(1)}`);
    const branches = await q<{ id: string; org_id: string; timezone: string; settings: { day_close_time?: string; digest_time?: string } }>(c, `select id, org_id, timezone, settings from public.branches where active and deleted_at is null`);
    for (const b of branches) {
      const local = toLocal(at, b.timezone);
      const cal = await workCalendar(c, b.id);
      const working = isWorkingDay(local.date, cal);
      const after = (hhmm: string) => local.minutes >= hhmmToMinutes(hhmm);
      const flags = new Map((await q<{ module_key: string; enabled: boolean }>(c, `select module_key, enabled from public.module_flags where branch_id = $1`, [b.id])).map((f) => [f.module_key, f.enabled]));
      const on = (m: string) => flags.get(m) !== false;
      if (after('00:30')) {
        await e('recurrences', `rec:${b.id}:${local.date}`, { date: local.date }, b.org_id, b.id);
        await e('compliance', `comp:${local.date}`, { date: local.date });
        await e('selfie_purge', `selfie:${local.date}`);
        await e('ai_allowance', `allow:${b.id}:${monthKey(local.date)}`, { period: monthKey(local.date) }, b.org_id, b.id);
        if (on('lesson_planner')) await e('plan_deadlines', `pd:${b.id}:${local.date}`, { date: local.date }, b.org_id, b.id);
        if (on('syllabus_coverage')) await e('coverage_alerts', `cov:${b.id}:${local.date}`, { date: local.date }, b.org_id, b.id);
      }
      if (after('06:00') && on('tasks')) {
        let prev = addDays(local.date, -1);
        for (let i = 0; i < 7 && !isWorkingDay(prev, cal); i++) prev = addDays(prev, -1);
        await e('no_response', `nr:${b.id}:${prev}`, { date: prev, tz: b.timezone }, b.org_id, b.id);
      }
      if (!working) continue;
      if (on('checklists')) await e('checklists', `chk:${b.id}:${bucket(15)}`, {}, b.org_id, b.id);
      if (on('duty_roster')) await e('duties', `duty:${b.id}:${bucket(5)}`, {}, b.org_id, b.id);
      if (on('staff_attendance') && on('substitution')) await e('absence', `abs:${b.id}:${bucket(15)}`, {}, b.org_id, b.id);
      if (on('student_attendance')) await e('unmarked_attendance', `unm:${b.id}:${bucket(15)}`, {}, b.org_id, b.id);
      if (after(b.settings.day_close_time ?? '17:30')) await e('day_close', `dc:${b.id}:${local.date}`, { date: local.date, tz: b.timezone }, b.org_id, b.id);
      if (after(b.settings.digest_time ?? '07:30') && on('reports')) await e('digest', `dg:${b.id}:${local.date}`, {}, b.org_id, b.id);
      if (isoWeekday(local.date) === 1 && after('07:00') && on('reports')) await e('weekly_insight', `wi:${b.id}:${local.date}`, {}, b.org_id, b.id);
    }
  });
  const ran = await runDueJobs(100, 'tick');
  return { enqueued, ran };
}
