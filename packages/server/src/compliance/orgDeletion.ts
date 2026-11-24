/**
 * Organisation and product deletion (data-subject-rights-procedure.md 4.2 and 5.4, decision 42).
 *
 *   plan     dry run. Prints what would be deleted and what is retained, says whether deletion is allowed now
 *            (grace period over, product not live, export delivered, no legal hold) and, only if it is, returns a
 *            confirmation token.
 *   execute  needs the request id and that token. Re-checks everything; refuses if anything changed.
 *
 * The database does the deleting in security definer functions (platform_admin_server only). Anything SQL cannot
 * reach (Supabase Auth users, storage objects) is returned as external actions for the server to perform.
 */
import { computeEntitlements, DEFAULT_BILLING_POLICY, type SubscriptionState } from '@autoed/shared';
import { guarded, type ComplianceDb } from './db';
import { ComplianceError, type Blocker, type DeletionPlan, type ProductKey } from './types';

export interface DeletionPlanResult {
  requestId: string;
  dryRun: true;
  eligible: boolean;
  blockers: Blocker[];
  eligibleAt: string | null;
  graceDays: number;
  confirmationToken?: string;
  tokenExpiresAt?: string;
  plan: DeletionPlan;
}

export async function planOrgDeletion(db: ComplianceDb, actorUserId: string, input: { orgId: string; product?: ProductKey | null; reason: string }): Promise<DeletionPlanResult> {
  const r = await guarded(() =>
    db.run('platform_admin_server', { actorUserId, statementTimeoutMs: 300_000 }, async (q) => {
      const res = await q.query<{ r: Record<string, unknown> }>(`select app.compliance_org_deletion_plan($1, $2, $3) as r`, [input.orgId, input.product ?? null, input.reason]);
      return res.rows[0]!.r;
    }),
  );
  return {
    requestId: r.request_id as string,
    dryRun: true,
    eligible: Boolean(r.eligible),
    blockers: (r.blockers as Blocker[]) ?? [],
    eligibleAt: (r.eligible_at as string | null) ?? null,
    graceDays: Number(r.grace_days),
    confirmationToken: (r.confirmation_token as string | null) ?? undefined,
    tokenExpiresAt: (r.token_expires_at as string | null) ?? undefined,
    plan: r.plan as DeletionPlan,
  };
}

export interface DeletionResult {
  requestId: string;
  result: DeletionPlan;
  externalActions: { kind: string; [k: string]: unknown }[];
}

export async function executeOrgDeletion(db: ComplianceDb, actorUserId: string, requestId: string, token: string): Promise<DeletionResult> {
  const r = await guarded(() =>
    db.run('platform_admin_server', { actorUserId, statementTimeoutMs: 1_800_000 }, async (q) => {
      const res = await q.query<{ r: Record<string, unknown> }>(`select app.compliance_org_deletion_execute($1, $2) as r`, [requestId, token]);
      return res.rows[0]!.r;
    }),
  );
  if (!r.ok) throw new ComplianceError('refused', 'deletion refused', (r.blockers as Blocker[]) ?? []);
  return { requestId: r.request_id as string, result: r.result as DeletionPlan, externalActions: r.external_actions as DeletionResult['externalActions'] };
}

/** What the dry run prints. One line per table, retained tables with the reason, then the verdict. */
export function formatDeletionPlan(p: DeletionPlanResult): string {
  const lines: string[] = [];
  lines.push(`DRY RUN: nothing has been deleted (request ${p.requestId})`);
  lines.push('');
  lines.push('Would delete:');
  for (const t of p.plan.tables) lines.push(`  ${`${t.schema}.${t.table}`.padEnd(44)} ${String(t.rows).padStart(10)} rows`);
  lines.push(`  ${'TOTAL'.padEnd(44)} ${String(p.plan.total_rows).padStart(10)} rows`);
  lines.push('');
  lines.push('Would keep:');
  if (p.plan.retained.length === 0) lines.push('  (nothing)');
  for (const t of p.plan.retained) lines.push(`  ${`${t.schema}.${t.table}`.padEnd(44)} ${String(t.rows).padStart(10)} rows  ${t.reason ?? ''}`);
  lines.push('');
  if (p.plan.auth_user_ids.length) lines.push(`Auth users to delete afterwards through the admin API: ${p.plan.auth_user_ids.length}`);
  if (p.eligible) {
    lines.push(`ALLOWED NOW. To run it, confirm with request id ${p.requestId} and token ${p.confirmationToken} (valid until ${p.tokenExpiresAt}).`);
  } else {
    lines.push('REFUSED. Not allowed now:');
    for (const b of p.blockers) lines.push(`  - ${b.code}${b.product ? ` (${String(b.product)})` : ''}${b.eligible_at ? ` until ${String(b.eligible_at)}` : ''}`);
  }
  return lines.join('\n');
}

export interface DueItem {
  orgId: string;
  product: ProductKey;
  access: 'full' | 'read_only' | 'none';
  endedAt: string | null;
  readOnlyUntil: string | null;
  /** Read-only window over: the export-and-delete job should run (entitlements.ts purgeDue). */
  purgeDue: boolean;
}

interface StateRow {
  org_id: string;
  product_key: ProductKey;
  status: 'trial' | 'active' | 'past_due' | 'suspended' | 'cancelled';
  ended_at: string | null;
  has_product: boolean;
  read_only_days: number;
}

function toState(r: StateRow): SubscriptionState {
  const ended = r.ended_at ? new Date(r.ended_at) : null;
  const base: SubscriptionState = { status: 'active', trialEndsAt: null, currentPeriodEnd: null, pastDueSince: null, suspendedAt: null, cancelledAt: null, cancelAtPeriodEnd: false, lastEventAt: null };
  if (r.status === 'suspended') return { ...base, status: 'suspended', suspendedAt: ended };
  if (r.status === 'cancelled' || (ended && !r.has_product)) return { ...base, status: 'cancelled', cancelledAt: ended };
  if (r.status === 'trial') return { ...base, status: 'trial' };
  if (r.status === 'past_due') return { ...base, status: 'past_due', pastDueSince: new Date(0) };
  return base;
}

/**
 * Products whose read-only window is over, per organisation, using the same rule the app uses for access
 * (packages/shared entitlements.ts computeEntitlements, with the period from core.retention_rules). Only a list:
 * the database refuses the deletion itself unless all conditions hold.
 */
export async function listDeletionDue(db: ComplianceDb, actorUserId: string, now: Date = new Date()): Promise<DueItem[]> {
  const rows = await guarded(() =>
    db.run('platform_admin_server', { actorUserId }, async (q) => (await q.query<{ r: StateRow[] }>(`select app.compliance_subscription_states() as r`)).rows[0]!.r),
  );
  const byOrg = new Map<string, StateRow[]>();
  for (const r of rows) byOrg.set(r.org_id, [...(byOrg.get(r.org_id) ?? []), r]);
  const out: DueItem[] = [];
  for (const [orgId, subs] of byOrg) {
    const readOnlyDays = Math.min(...subs.map((s) => s.read_only_days), DEFAULT_BILLING_POLICY.readOnlyDays);
    const res = computeEntitlements(
      subs.map((s) => ({ productKey: s.product_key, state: toState(s) })),
      now,
      { ...DEFAULT_BILLING_POLICY, readOnlyDays },
    );
    for (const s of subs) {
      const e = res.products[s.product_key];
      if (e.access === 'full') continue;
      out.push({ orgId, product: s.product_key, access: e.access, endedAt: s.ended_at, readOnlyUntil: e.readOnlyUntil?.toISOString() ?? null, purgeDue: res.purgeDue.includes(s.product_key) });
    }
  }
  return out.sort((a, b) => a.orgId.localeCompare(b.orgId) || a.product.localeCompare(b.product));
}
