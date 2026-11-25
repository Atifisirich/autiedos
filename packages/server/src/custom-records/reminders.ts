/**
 * Reminders of custom records (object.schedule.reminder = {date_field, days_before}). Runs as job_runner only:
 *   1. app.custom_records_enqueue_reminders()  one private.jobs row per due record (idempotent per record and date),
 *                                               only for orgs that still have the owning product;
 *   2. private.claim_record_jobs()             claims reminder jobs only (skips + logs orgs that lost the product);
 *   3. app.custom_records_deliver_reminder()   in-app notification to the record owner (deduplicated);
 *   4. private.finish_job()                    done, or retry with backoff.
 * Call runRecordReminders() from the cron tick (apps/web/app/api/cron/tick).
 */
import type { RecordsDb } from './db';

export async function runRecordReminders(db: RecordsDb, opts: { worker?: string; limit?: number } = {}): Promise<{ enqueued: number; delivered: number; failed: number }> {
  const enqueued = await db.run('job_runner', null, async (q) => Number((await q.query<{ n: number }>(`select app.custom_records_enqueue_reminders() as n`)).rows[0]!.n));
  let delivered = 0;
  let failed = 0;
  const jobs = await db.run('job_runner', null, async (q) => (await q.query<{ id: string }>(`select id from private.claim_record_jobs($1, $2)`, [opts.worker ?? 'records', opts.limit ?? 100])).rows);
  for (const j of jobs) {
    try {
      delivered += await db.run('job_runner', null, async (q) => {
        const n = Number((await q.query<{ n: number }>(`select app.custom_records_deliver_reminder($1) as n`, [j.id])).rows[0]!.n);
        await q.query(`select private.finish_job($1, true, null)`, [j.id]);
        return n;
      });
    } catch (e) {
      failed += 1;
      await db.run('job_runner', null, (q) => q.query(`select private.finish_job($1, false, $2)`, [j.id, String((e as Error).message).slice(0, 500)]));
    }
  }
  return { enqueued, delivered, failed };
}
