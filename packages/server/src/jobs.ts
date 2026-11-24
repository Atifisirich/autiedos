/**
 * Background jobs (PRD 3, plan 4.10) on the platform queue `private.jobs`:
 *   enqueue  -> os.enqueue_job() for the caller's org (the user, or the org's OS system actor), product 'os';
 *   claim    -> private.claim_jobs('os', ...) as the database role job_runner: jobs of orgs that lost the OS
 *               product are skipped and logged in audit.log instead of running (harness T11);
 *   run      -> the handler runs as the job's org OS system actor (os_server, RLS applies);
 *   finish   -> private.finish_job() (retry with backoff up to max_attempts).
 * Jobs are idempotent via dedupe keys (one escalation sweep per window, ...).
 */
import pg from 'pg';
import { getJobPool, q, type Tx } from './db';

export interface JobRow {
  id: string;
  org_id: string;
  /** payload.branch_id, for branch sweeps */
  branch_id: string | null;
  kind: string;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
}

export type JobHandler = (job: JobRow) => Promise<unknown>;
const handlers = new Map<string, JobHandler>();

export function registerJob(kind: string, fn: JobHandler) {
  handlers.set(kind, fn);
}

/** Enqueues a job for the org of the current claims. Returns null when the dedupe key already exists. */
export async function enqueue(
  c: Tx,
  kind: string,
  payload: Record<string, unknown>,
  opts: { runAt?: Date; dedupeKey?: string; branchId?: string | null; maxAttempts?: number } = {},
): Promise<string | null> {
  const rows = await q<{ id: string | null }>(c, `select os.enqueue_job($1, $2, $3, $4, $5) as id`, [
    kind,
    JSON.stringify({ ...payload, ...(opts.branchId ? { branch_id: opts.branchId } : {}) }),
    (opts.runAt ?? new Date(0)).toISOString(),
    opts.dedupeKey ?? null,
    opts.maxAttempts ?? 5,
  ]);
  return rows[0]?.id ?? null;
}

async function asJobRunner<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await getJobPool().connect();
  try {
    return await fn(c);
  } finally {
    c.release();
  }
}

/** Runs due jobs until none are left or `limit` is reached. Returns a summary. */
export async function runDueJobs(limit = 50, workerId = 'worker'): Promise<{ ran: number; failed: number; kinds: Record<string, number> }> {
  let ran = 0;
  let failed = 0;
  const kinds: Record<string, number> = {};
  while (ran + failed < limit) {
    const batch = await asJobRunner((c) =>
      c.query<{ id: string; org_id: string; kind: string; payload: Record<string, unknown>; attempts: number; max_attempts: number }>(
        `select id, org_id, kind, payload, attempts, max_attempts from private.claim_jobs('os', $1, $2)`,
        [workerId, Math.min(10, limit - ran - failed)],
      ),
    );
    if (!batch.rows.length) break;
    for (const r of batch.rows) {
      const job: JobRow = { ...r, branch_id: typeof r.payload.branch_id === 'string' ? r.payload.branch_id : null };
      kinds[job.kind] = (kinds[job.kind] ?? 0) + 1;
      const handler = handlers.get(job.kind);
      try {
        if (!handler) throw new Error(`no handler for ${job.kind}`);
        await handler(job);
        await asJobRunner((c) => c.query(`select private.finish_job($1, true, null)`, [job.id]));
        ran++;
      } catch (e) {
        failed++;
        const msg = e instanceof Error ? `${e.message}` : String(e);
        await asJobRunner((c) => c.query(`select private.finish_job($1, false, $2)`, [job.id, msg.slice(0, 2000)]));
        if (process.env.NODE_ENV !== 'test') console.error(`[jobs] ${job.kind} ${job.id} failed (attempt ${job.attempts}): ${msg} [worker ${workerId}]`);
      }
    }
  }
  return { ran, failed, kinds };
}
