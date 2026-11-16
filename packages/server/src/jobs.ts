/**
 * Background jobs (PRD 3): a `jobs` table processed by a scheduled function
 * (Vercel cron -> /api/cron/tick, or Supabase cron calling the same endpoint).
 * Jobs are retried with backoff and are idempotent via dedupe keys.
 */
import { asService, q, type Tx } from './db';

export interface JobRow {
  id: string;
  org_id: string | null;
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

export async function enqueue(
  c: Tx,
  kind: string,
  payload: Record<string, unknown>,
  opts: { runAt?: Date; dedupeKey?: string; orgId?: string | null; branchId?: string | null; maxAttempts?: number } = {},
): Promise<string | null> {
  const rows = await q<{ id: string }>(
    c,
    `insert into public.jobs (org_id, branch_id, kind, payload, run_at, dedupe_key, max_attempts) values ($1,$2,$3,$4,$5,$6,$7)
     on conflict (dedupe_key) do nothing returning id`,
    [opts.orgId ?? null, opts.branchId ?? null, kind, JSON.stringify(payload), (opts.runAt ?? new Date(0)).toISOString(), opts.dedupeKey ?? null, opts.maxAttempts ?? 5],
  );
  return rows[0]?.id ?? null;
}

/** Runs due jobs until none are left or `limit` is reached. Returns a summary. */
export async function runDueJobs(limit = 50, workerId = 'worker'): Promise<{ ran: number; failed: number; kinds: Record<string, number> }> {
  let ran = 0;
  let failed = 0;
  const kinds: Record<string, number> = {};
  await asService((c) => c.query(`update public.jobs set status = 'queued', locked_at = null where status = 'running' and locked_at < now() - interval '10 minutes'`));
  for (let i = 0; i < limit; i++) {
    const job = await asService(async (c) => {
      const rows = await q<JobRow>(
        c,
        `update public.jobs set status = 'running', locked_at = now(), attempts = attempts + 1
         where id = (select id from public.jobs where status = 'queued' and run_at <= now() order by run_at, created_at limit 1 for update skip locked)
         returning id, org_id, branch_id, kind, payload, attempts, max_attempts`,
      );
      return rows[0] ?? null;
    });
    if (!job) break;
    kinds[job.kind] = (kinds[job.kind] ?? 0) + 1;
    const handler = handlers.get(job.kind);
    try {
      if (!handler) throw new Error(`no handler for ${job.kind}`);
      const result = await handler(job);
      await asService((c) => c.query(`update public.jobs set status = 'done', finished_at = now(), result = $2, last_error = null where id = $1`, [job.id, JSON.stringify(result ?? null)]));
      ran++;
    } catch (e) {
      failed++;
      const msg = e instanceof Error ? `${e.message}` : String(e);
      const dead = job.attempts >= job.max_attempts;
      await asService((c) =>
        c.query(`update public.jobs set status = $2, last_error = $3, run_at = now() + ($4 || ' minutes')::interval, locked_at = null where id = $1`, [job.id, dead ? 'dead' : 'queued', msg.slice(0, 2000), String(2 ** job.attempts)]),
      );
      if (process.env.NODE_ENV !== 'test') console.error(`[jobs] ${job.kind} ${job.id} failed (attempt ${job.attempts}): ${msg} [worker ${workerId}]`);
    }
  }
  return { ran, failed, kinds };
}
