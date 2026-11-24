/**
 * Retention purge (data-retention-schedule.md section 3, plan 4.10).
 *
 * The rules are rows in core.retention_rules (periods are configuration, all marked CONFIRM and disabled until counsel
 * confirms them). A cron tick calls enqueueRetentionJobs(): it creates one `compliance.retention_purge` job in
 * private.jobs for every (org, product) that has the product and an enabled rule. The handler runs as `job_runner`
 * and calls app.compliance_retention_purge, which re-checks the subscription, honours legal holds, purges in
 * batches, strips the purged data from audit images and writes audit.purge_log for every rule it touches.
 * An org without the product is skipped and logged (private.claim_jobs does the same before a job even starts).
 */
import { guarded, type ComplianceDb } from './db';
import { ComplianceError, PRODUCT_KEYS, type ProductKey } from './types';

export const RETENTION_JOB_KIND = 'compliance.retention_purge';

export interface PlatformJob {
  id: string;
  org_id: string;
  product_key: ProductKey;
  kind: string;
  payload: Record<string, unknown>;
  attempts: number;
}

export interface PurgeRuleResult {
  data_type: string;
  status: string;
  affected?: number;
  would_affect?: number;
  cutoff?: string;
}

export interface PurgeResult {
  org_id: string;
  product: ProductKey;
  dry_run?: boolean;
  skipped: boolean;
  reason?: string;
  rules: PurgeRuleResult[];
  rows: number;
}

/** Runs one org and product. dryRun (default true) counts only. */
export async function purgeOrgProduct(db: ComplianceDb, input: { orgId: string; product: ProductKey; dryRun?: boolean; batch?: number }): Promise<PurgeResult> {
  if (!PRODUCT_KEYS.includes(input.product)) throw new ComplianceError('invalid', `unknown product ${String(input.product)}`);
  return guarded(() =>
    db.run('job_runner', { statementTimeoutMs: 900_000 }, async (q) => {
      const r = await q.query<{ r: PurgeResult }>(`select app.compliance_retention_purge($1, $2, $3, $4) as r`, [input.orgId, input.product, input.dryRun ?? true, input.batch ?? 5000]);
      return r.rows[0]!.r;
    }),
  );
}

/** Cron entry point. Returns the number of jobs created. */
export async function enqueueRetentionJobs(db: ComplianceDb, product?: ProductKey): Promise<number> {
  return db.run('job_runner', {}, async (q) => Number((await q.query<{ n: number }>(`select app.compliance_enqueue_purge_jobs($1) as n`, [product ?? null])).rows[0]!.n));
}

/** The handler to register with the platform job loop for kind `compliance.retention_purge`. */
export function retentionPurgeHandler(db: ComplianceDb): (job: PlatformJob) => Promise<PurgeResult> {
  return (job) => purgeOrgProduct(db, { orgId: job.org_id, product: job.product_key, dryRun: job.payload?.dry_run === true });
}

export type JobHandler = (job: PlatformJob) => Promise<unknown>;

/**
 * Claims due jobs of one product with private.claim_jobs (which already skips and logs jobs of orgs without the
 * product), runs the handler registered for each kind and reports back with private.finish_job.
 * A claimed job with no handler is failed (and retried with backoff by finish_job): run this loop with one handler
 * per kind of the product, or use it only for compliance work.
 */
export async function runJobsOnce(db: ComplianceDb, input: { product: ProductKey; worker: string; limit?: number; handlers: Record<string, JobHandler> }): Promise<{ ran: number; failed: number }> {
  const jobs = await db.run('job_runner', {}, async (q) => (await q.query<PlatformJob>(`select * from private.claim_jobs($1, $2, $3)`, [input.product, input.worker, input.limit ?? 10])).rows);
  let ran = 0;
  let failed = 0;
  for (const job of jobs) {
    let ok = true;
    let error: string | null = null;
    try {
      const h = input.handlers[job.kind];
      if (!h) throw new Error(`no handler for ${job.kind}`);
      await h(job);
    } catch (e) {
      ok = false;
      error = e instanceof Error ? e.message : String(e);
    }
    await db.run('job_runner', {}, (q) => q.query(`select private.finish_job($1, $2, $3)`, [job.id, ok, error]));
    if (ok) ran++;
    else failed++;
  }
  return { ran, failed };
}
