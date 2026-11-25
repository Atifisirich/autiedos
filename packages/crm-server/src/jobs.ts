/**
 * Cron / job runner (plan 4.10, ADR 004). The CRM's own `jobs` table and the per-tenant tick are gone:
 *   - waiting workflow steps and quiet-hours messages are rows in private.jobs (product crm, queued with
 *     app.enqueue_job by the request that needed them);
 *   - one recurring job per org (kind `crm.sweep`, queued by private.enqueue_tick_jobs) runs the SLA and no-show checks.
 * private.claim_jobs only hands out jobs of orgs that currently have the CRM (the rest are marked `skipped` and logged),
 * and each job then runs as that org's automation user, which asSystem refuses again if the subscription ended meanwhile.
 * The worker logs in as job_runner (JOB_DATABASE_URL); the handlers use the crm_server pool.
 */
import { asJobRunner, asSystem, type Db, type Row } from './db';
import { sendMessage, getEnquiry } from './core';
import { finish, runSteps, sweep } from './workflows';

export interface ClaimedJob {
  id: string;
  org_id: string;
  product_key: string;
  kind: string;
  payload: Row;
  attempts: number;
  max_attempts: number;
}

/** Runs one claimed job inside the org's automation context. Returns a short result for logs and tests. */
export async function handleJob(db: Db, j: ClaimedJob): Promise<string> {
  if (j.kind === 'crm.sweep') {
    await sweep(db);
    return 'swept';
  }
  if (j.kind === 'send_message') {
    const tpl = j.payload.templateId ? await db.one('select * from core.message_templates where id = $1', [j.payload.templateId]) : null;
    const m = { ...j.payload };
    delete m.templateId;
    const r = await sendMessage(db, { ...(m as Parameters<typeof sendMessage>[1]), template: tpl, deferred: true });
    return r.status === 'failed' ? 'not sent: ' + r.reason : 'sent';
  }
  if (j.kind === 'workflow_resume') {
    // AUT-05: if the parent replied or the record left the stage it entered the workflow in, all pending steps are cancelled.
    const run = await db.one('select * from crm.workflow_runs where id = $1', [j.payload.runId]);
    const wf = run && (await db.one('select * from crm.workflows where id = $1', [run.workflow_id]));
    if (!run || !wf || run.status !== 'running') return 'skipped';
    if (wf.status !== 'published') {
      await finish(db, run, 'cancelled', [...run.log, { text: 'Cancelled: the workflow was paused.' }]);
      return 'cancelled';
    }
    const e = await getEnquiry(db, run.enquiry_id);
    const replied = await db.one("select 1 from crm.messages where org_id = $1 and household_id = $2 and direction = 'in' and created_at > $3", [db.requireOrg(), e?.household_id, run.created_at]);
    // Stop rules of the workflow (crm.workflows.stop_rules; both on unless the workflow turns one off).
    const stop = { on_reply: wf.stop_rules?.on_reply !== false, on_stage_change: wf.stop_rules?.on_stage_change !== false };
    if (!e || (stop.on_stage_change && e.stage_id !== run.entry_stage_id)) {
      await finish(db, run, 'cancelled', [...run.log, { text: `Cancelled: the record moved out of the stage it entered in${e ? ` (now "${e.stage_name}")` : ''}.` }]);
      return 'cancelled';
    }
    if (replied && stop.on_reply && wf.trigger !== 'sla_breach') {
      await finish(db, run, 'cancelled', [...run.log, { text: 'Cancelled: the parent replied, so automated follow-ups stopped.' }]);
      return 'cancelled';
    }
    await runSteps(db, run, wf, j.payload.step);
    return 'resumed';
  }
  throw new Error(`no handler for ${j.kind}`);
}

/**
 * One pass of the scheduler: queue the per-org sweep, claim due CRM jobs and run them. Point a scheduler at
 * POST /cron/crm every minute with Authorization: Bearer $CRON_SECRET (api/index.ts).
 */
export async function runDueJobs(opts: { limit?: number; worker?: string } = {}): Promise<{ queued: number; ran: number; failed: number; kinds: Record<string, number> }> {
  const worker = opts.worker ?? 'crm-worker';
  const limit = opts.limit ?? 50;
  const queued = await asJobRunner(async (c) => Number((await c.query(`select private.enqueue_tick_jobs('crm', 'crm.sweep') as n`)).rows[0].n));
  const jobs = await asJobRunner(async (c) => (await c.query('select * from private.claim_jobs($1, $2, $3)', ['crm', worker, limit])).rows as ClaimedJob[]);
  let ran = 0,
    failed = 0;
  const kinds: Record<string, number> = {};
  for (const j of jobs) {
    kinds[j.kind] = (kinds[j.kind] ?? 0) + 1;
    try {
      await asSystem(j.org_id, (db) => handleJob(db, j));
      await asJobRunner((c) => c.query('select private.finish_job($1, true, null)', [j.id]));
      ran++;
    } catch (e) {
      failed++;
      const msg = e instanceof Error ? e.message : String(e);
      await asJobRunner((c) => c.query('select private.finish_job($1, false, $2)', [j.id, msg.slice(0, 2000)]));
    }
  }
  return { queued, ran, failed, kinds };
}
