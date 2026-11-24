/**
 * Retention purge (data-retention-schedule.md section 3, plan 4.10, harness T11 for the purge job):
 * periods are rows, rules start disabled and unconfirmed, the job loops only over orgs that have the product,
 * every purge is logged without the data, legal holds pause it, org overrides can only shorten.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enqueueRetentionJobs, purgeOrgProduct, retentionPurgeHandler, runJobsOnce, RETENTION_JOB_KIND } from '../src/compliance/retention';
import { placeHold, releaseHold } from '../src/compliance/holds';
import { createWorld, type World } from './compliance-support';

let w: World;
beforeAll(async () => {
  w = await createWorld();
}, 300000);
afterAll(async () => {
  await w?.close();
});

const leads = async (org: string) => (await w.q<{ full_name: string }>(`select full_name from crm.leads where org_id = $1 order by full_name`, [org])).map((r) => r.full_name);
const logs = async (org: string, where = 'true') => w.q<{ data_type: string | null; status: string; rows_affected: number; rows_before: number | null; dry_run: boolean; source: string }>(
  `select data_type, status, rows_affected::int as rows_affected, rows_before::int as rows_before, dry_run, source from audit.purge_log where org_id = $1 and ${where} order by id`, [org]);
type Res = Awaited<ReturnType<typeof purgeOrgProduct>>;
const rule = (r: Res, dt: string) => r.rules.find((x) => x.data_type === dt);
const confirmLeadRule = () => w.q(`update core.retention_policies set enabled = true, legal_status = 'confirmed' where org_id is null and data_type = 'crm_leads_not_admitted'`);

describe('retention rules are data, off until counsel confirms', () => {
  it('seeds the schedule as disabled draft rows with periods as numbers in rows', async () => {
    const rules = await w.q<{ data_type: string; period_value: number; period_unit: string; enabled: boolean; legal_status: string }>(
      `select data_type, period_value, period_unit, enabled, legal_status from core.retention_policies where org_id is null and scope = 'table' and schema_name in ('audit','core') order by data_type`);
    expect(rules).toEqual([
      { data_type: 'audit_config_history', period_value: 36, period_unit: 'months', enabled: false, legal_status: 'draft' },
      { data_type: 'audit_log', period_value: 36, period_unit: 'months', enabled: false, legal_status: 'draft' },
      { data_type: 'login_events', period_value: 12, period_unit: 'months', enabled: false, legal_status: 'draft' },
      { data_type: 'support_sessions', period_value: 36, period_unit: 'months', enabled: false, legal_status: 'draft' },
    ]);
    const life = await w.q<{ data_type: string; period_value: number }>(`select data_type, period_value from core.retention_policies where scope = 'lifecycle' and data_type in ('product_read_only_days','org_exit_deletion_days') order by 1`);
    expect(life).toEqual([{ data_type: 'org_exit_deletion_days', period_value: 30 }, { data_type: 'product_read_only_days', period_value: 30 }]);
  });

  it('a draft rule cannot be switched on without counsel confirmation or a stated reason', async () => {
    await expect(w.q(`update core.retention_policies set enabled = true where org_id is null and data_type = 'crm_leads_not_admitted'`)).rejects.toMatchObject({ code: '23514' });
    await expect(w.q(`update core.retention_policies set enabled = true, enabled_override_reason = 'short' where org_id is null and data_type = 'crm_leads_not_admitted'`)).rejects.toMatchObject({ code: '23514' });
  });

  it('a dry run counts what would go and changes nothing, even for a disabled rule', async () => {
    const r = await purgeOrgProduct(w.db, { orgId: w.A.id, product: 'crm', dryRun: true });
    expect(r).toMatchObject({ skipped: false, dry_run: true, rows: 0 });
    expect(rule(r, 'crm_leads_not_admitted')).toMatchObject({ status: 'dry_run', would_affect: 1, enabled: false });
    expect(r.rules).toHaveLength(5); // the four platform rules for core data run with A's first product (crm)
    expect(await leads(w.A.id)).toHaveLength(4);
    expect(await logs(w.A.id, `source = 'retention' and data_type = 'crm_leads_not_admitted'`)).toEqual([{ data_type: 'crm_leads_not_admitted', status: 'dry_run', rows_affected: 0, rows_before: 1, dry_run: true, source: 'retention' }]);
  });

  it('a real run with the rule disabled skips it and says so', async () => {
    const r = await purgeOrgProduct(w.db, { orgId: w.A.id, product: 'crm', dryRun: false });
    expect(rule(r, 'crm_leads_not_admitted')).toEqual({ data_type: 'crm_leads_not_admitted', status: 'skipped_disabled' });
    expect(await leads(w.A.id)).toHaveLength(4);
    expect((await logs(w.A.id, `data_type = 'crm_leads_not_admitted'`)).at(-1)).toMatchObject({ status: 'skipped_disabled', rows_affected: 0 });
  });
});

describe('the purge', () => {
  it('purges what the confirmed rule says, for the org it was asked about only, and logs it without the data', async () => {
    await confirmLeadRule();
    const piiBefore = await w.q(`select count(*)::int as n from audit.log where org_id = $1 and (before::text like '%Old Lead A1%' or after::text like '%Old Lead A1%')`, [w.A.id]);
    expect(piiBefore[0]!.n).toBeGreaterThan(0);
    const r = await purgeOrgProduct(w.db, { orgId: w.A.id, product: 'crm', dryRun: false });
    expect(rule(r, 'crm_leads_not_admitted')).toMatchObject({ status: 'done', affected: 1 });
    expect(await leads(w.A.id)).toEqual(['Lena Lead', 'Old Lead A2 admitted', 'Recent Lead A']); // admitted and recent leads stay
    expect(await leads(w.B.id)).toEqual(['Bela Lead']); // B's equally old lead is not touched by A's run
    const log = (await logs(w.A.id, `status = 'done' and data_type = 'crm_leads_not_admitted'`)).at(-1)!;
    expect(log).toMatchObject({ data_type: 'crm_leads_not_admitted', status: 'done', rows_affected: 1, rows_before: 1, dry_run: false, source: 'retention' });
    const cutoff = (await w.q<{ cutoff: string }>(`select cutoff from audit.purge_log where org_id = $1 and status = 'done' order by id desc limit 1`, [w.A.id]))[0]!.cutoff;
    expect(Math.abs(Date.now() - new Date(cutoff).getTime() - 24 * 30 * 86400000)).toBeLessThan(40 * 86400000);
    // the purged lead's data does not survive in the audit images
    expect((await w.q(`select count(*)::int as n from audit.log where org_id = $1 and (before::text like '%Old Lead A1%' or after::text like '%Old Lead A1%' or before::text like '%old1@example.test%')`, [w.A.id]))[0]!.n).toBe(0);
    // ...but the fact of the deletion is in the audit log
    expect((await w.q(`select count(*)::int as n from audit.log where org_id = $1 and action = 'compliance.retention_purge'`, [w.A.id]))[0]!.n).toBeGreaterThan(0);
    // the log row itself holds no personal data
    const raw = JSON.stringify(await w.q(`select * from audit.purge_log where org_id = $1`, [w.A.id]));
    expect(raw).not.toMatch(/Old Lead|old1@example|\+9198765/);
  });

  it('is repeatable: a second run finds nothing', async () => {
    const r = await purgeOrgProduct(w.db, { orgId: w.A.id, product: 'crm', dryRun: false });
    expect(rule(r, 'crm_leads_not_admitted')).toMatchObject({ status: 'done', affected: 0 });
    expect(await leads(w.A.id)).toHaveLength(3);
  });

  it('works in batches until the rule is satisfied', async () => {
    for (let i = 0; i < 5; i++) {
      await w.q(`insert into crm.leads (org_id, branch_id, full_name, status, last_activity_at) values ($1, $2, $3, 'lost', now() - interval '1000 days')`, [w.A.id, w.A.branches.a1, `Batch Lead ${i}`]);
    }
    const r = await purgeOrgProduct(w.db, { orgId: w.A.id, product: 'crm', dryRun: false, batch: 2 });
    expect(rule(r, 'crm_leads_not_admitted')).toMatchObject({ status: 'done', affected: 5 });
    expect(await leads(w.A.id)).toHaveLength(3);
  });

  it('skips an org that does not have the product (T11): no rule runs, the skip is logged and audited', async () => {
    // org C has crm only; give it old data in a table of a product it does not hold and ask for that product's purge
    const r = await purgeOrgProduct(w.db, { orgId: w.C.id, product: 'os', dryRun: false });
    expect(r).toMatchObject({ skipped: true, reason: 'no_product', rows: 0, rules: [] });
    expect(await logs(w.C.id, `product_key = 'os'`)).toEqual([expect.objectContaining({ status: 'skipped_no_product', rows_affected: 0 })]);
    expect((await w.q(`select count(*)::int as n from audit.log where org_id = $1 and action = 'compliance.purge_skipped'`, [w.C.id]))[0]!.n).toBe(1);
    // a product that was suspended is skipped too
    await w.q(`update core.subscriptions set status = 'suspended' where org_id = $1 and product_key = 'crm'`, [w.B.id]);
    const b = await purgeOrgProduct(w.db, { orgId: w.B.id, product: 'crm', dryRun: false });
    expect(b.skipped).toBe(true);
    expect(await leads(w.B.id)).toEqual(['Bela Lead']);
    await w.q(`update core.subscriptions set status = 'active' where org_id = $1 and product_key = 'crm'`, [w.B.id]);
  });

  it('cron + job runner: one job per org that has the product and an enabled rule; handler purges; claim_jobs skips the rest', async () => {
    await w.q(`delete from private.jobs`);
    // org C stops paying for crm: no job for it
    await w.q(`update core.subscriptions set status = 'cancelled' where org_id = $1 and product_key = 'crm'`, [w.C.id]);
    const n = await enqueueRetentionJobs(w.db);
    expect(n).toBe(2); // A and B, crm only (no enabled rule exists for os or erp)
    expect(await enqueueRetentionJobs(w.db)).toBe(0); // idempotent while queued
    const jobs = await w.q<{ org_id: string; product_key: string; kind: string }>(`select org_id, product_key, kind from private.jobs order by org_id`);
    expect(jobs.every((j) => j.kind === RETENTION_JOB_KIND && j.product_key === 'crm')).toBe(true);
    expect(jobs.map((j) => j.org_id).sort()).toEqual([w.A.id, w.B.id].sort());

    // a stale job for the org without the product is skipped by claim_jobs before any handler sees it
    await w.q(`insert into private.jobs (org_id, product_key, kind) values ($1, 'crm', $2)`, [w.C.id, RETENTION_JOB_KIND]);
    const seen: string[] = [];
    const handler = retentionPurgeHandler(w.db);
    const res = await runJobsOnce(w.db, { product: 'crm', worker: 't', handlers: { [RETENTION_JOB_KIND]: async (j) => { seen.push(j.org_id); return handler(j); } } });
    expect(res).toEqual({ ran: 2, failed: 0 });
    expect(seen.sort()).toEqual([w.A.id, w.B.id].sort());
    expect(await leads(w.B.id)).toEqual([]); // B's old lead is purged by its own job
    const skipped = await w.q<{ status: string; skip_reason: string }>(`select status, skip_reason from private.jobs where org_id = $1 and kind = $2`, [w.C.id, RETENTION_JOB_KIND]);
    expect(skipped[0]).toMatchObject({ status: 'skipped' });
    await w.q(`update core.subscriptions set status = 'active' where org_id = $1 and product_key = 'crm'`, [w.C.id]);
  });
});

describe('legal holds and overrides', () => {
  const oldLead = (org: string, branch: string, name: string, days: number) =>
    w.q(`insert into crm.leads (org_id, branch_id, full_name, status, last_activity_at) values ($1, $2, $3, 'new', now() - make_interval(days => $4))`, [org, branch, name, days]);

  it('a legal hold pauses the purge for the org (and a table hold for that table); releasing resumes it', async () => {
    await oldLead(w.A.id, w.A.branches.a1!, 'Held Lead', 1000);
    const orgHold = await placeHold(w.db, w.u.platform!, { orgId: w.A.id, scope: 'org', reason: 'Court order 2026/12: preserve all records' });
    const r = await purgeOrgProduct(w.db, { orgId: w.A.id, product: 'crm', dryRun: false });
    expect(rule(r, 'crm_leads_not_admitted')).toEqual({ data_type: 'crm_leads_not_admitted', status: 'skipped_legal_hold' });
    expect(await leads(w.A.id)).toContain('Held Lead');
    await releaseHold(w.db, w.u.platform!, orgHold, 'Order lifted');

    const tableHold = await placeHold(w.db, w.u.aAdmin!, { orgId: w.A.id, scope: 'table', schema: 'crm', table: 'leads', reason: 'Investigation open on the leads table' });
    expect(rule(await purgeOrgProduct(w.db, { orgId: w.A.id, product: 'crm', dryRun: false }), 'crm_leads_not_admitted')!.status).toBe('skipped_legal_hold');
    await releaseHold(w.db, w.u.aAdmin!, tableHold, 'Closed');
    const r2 = await purgeOrgProduct(w.db, { orgId: w.A.id, product: 'crm', dryRun: false });
    expect(rule(r2, 'crm_leads_not_admitted')).toMatchObject({ status: 'done', affected: 1 });
    expect(await leads(w.A.id)).not.toContain('Held Lead');
  });

  it('an org may shorten a period but never lengthen it, and only for an existing rule', async () => {
    await oldLead(w.A.id, w.A.branches.a1!, 'Fourteen Months Old', 420);
    // longer than the default: ignored
    await w.db.run('platform_admin_server', { actorUserId: w.u.aAdmin! }, (q) =>
      q.query(`insert into core.retention_policies (org_id, scope, data_type, schema_name, table_name, date_column, action, period_value, period_unit, enabled, legal_status)
               values ($1, 'table', 'crm_leads_not_admitted', 'crm', 'leads', 'last_activity_at', 'delete', 60, 'months', true, 'confirmed')`, [w.A.id]));
    await purgeOrgProduct(w.db, { orgId: w.A.id, product: 'crm', dryRun: false });
    expect(await leads(w.A.id)).toContain('Fourteen Months Old');
    // shorter: applied
    await w.db.run('platform_admin_server', { actorUserId: w.u.aAdmin! }, (q) =>
      q.query(`update core.retention_policies set period_value = 12 where org_id = $1 and data_type = 'crm_leads_not_admitted'`, [w.A.id]));
    await purgeOrgProduct(w.db, { orgId: w.A.id, product: 'crm', dryRun: false });
    expect(await leads(w.A.id)).not.toContain('Fourteen Months Old');
    // the default (24 months) still governs org B
    // an org row cannot point the rule at another table, nor invent a rule, nor belong to another org
    await expect(w.db.run('platform_admin_server', { actorUserId: w.u.aAdmin! }, (q) =>
      q.query(`insert into core.retention_policies (org_id, scope, data_type, schema_name, table_name, date_column, action, period_value, period_unit, enabled, legal_status)
               values ($1, 'table', 'my_own_rule', 'core', 'org_users', 'created_at', 'delete', 1, 'days', true, 'confirmed')`, [w.A.id]))).rejects.toMatchObject({ code: '42501' });
    await expect(w.db.run('platform_admin_server', { actorUserId: w.u.bAdmin! }, (q) =>
      q.query(`insert into core.retention_policies (org_id, scope, data_type, schema_name, table_name, date_column, action, period_value, period_unit, enabled, legal_status)
               values ($1, 'table', 'crm_leads_not_admitted', 'crm', 'leads', 'last_activity_at', 'delete', 1, 'days', true, 'confirmed')`, [w.A.id]))).rejects.toMatchObject({ code: '42501' });
    await expect(w.db.run('platform_admin_server', { actorUserId: w.u.aStaffNoCompliance! }, (q) =>
      q.query(`insert into core.retention_policies (org_id, scope, data_type, schema_name, table_name, date_column, action, period_value, period_unit, enabled, legal_status)
               values ($1, 'table', 'crm_leads_not_admitted', 'crm', 'leads', 'last_activity_at', 'delete', 1, 'days', true, 'confirmed')`, [w.B.id]))).rejects.toMatchObject({ code: '42501' });
  });

  it('the client\'s own rule in core.retention_rules (keep_years) shortens the period too, never lengthens it', async () => {
    await oldLead(w.B.id, w.B.branches.b1!, 'Fourteen Months B', 420);
    // a longer client rule and a soft-deleted shorter one change nothing
    await w.q(`insert into core.retention_rules (org_id, data_type, keep_years, action, product_key) values ($1, 'crm_leads_not_admitted', 5, 'delete', 'crm')`, [w.B.id]);
    await purgeOrgProduct(w.db, { orgId: w.B.id, product: 'crm', dryRun: false });
    expect(await leads(w.B.id)).toContain('Fourteen Months B');
    await w.q(`update core.retention_rules set keep_years = 1, deleted_at = now() where org_id = $1`, [w.B.id]);
    await purgeOrgProduct(w.db, { orgId: w.B.id, product: 'crm', dryRun: false });
    expect(await leads(w.B.id)).toContain('Fourteen Months B');
    // the live shorter rule applies (and the data map shows the override)
    await w.q(`update core.retention_rules set deleted_at = null where org_id = $1`, [w.B.id]);
    const r = await purgeOrgProduct(w.db, { orgId: w.B.id, product: 'crm', dryRun: false });
    expect(rule(r, 'crm_leads_not_admitted')).toMatchObject({ status: 'done', affected: 1 });
    expect(await leads(w.B.id)).not.toContain('Fourteen Months B');
    const eff = await w.q<{ period_value: number; period_unit: string; org_override: boolean }>(
      `select period_value, period_unit, org_override from app._compliance_effective_rules($1) where data_type = 'crm_leads_not_admitted'`, [w.B.id]);
    expect(eff).toEqual([{ period_value: 12, period_unit: 'months', org_override: true }]);
  });

  it('platform rules for core data run once per org, with its first product, and honour a table filter', async () => {
    // login events of A older than 12 months, plus fresh ones
    await w.q(`insert into core.login_events (org_id, user_id, method, success, created_at) values ($1, $2, 'password', true, now() - interval '400 days'), ($1, $2, 'password', true, now() - interval '400 days')`, [w.A.id, w.u.aAdmin]);
    await w.q(`update core.retention_policies set enabled = true, legal_status = 'confirmed' where org_id is null and data_type = 'login_events'`);
    const count = async () => Number((await w.q(`select count(*) as n from core.login_events where org_id = $1 and created_at < now() - interval '12 months'`, [w.A.id]))[0]!.n);
    expect(await count()).toBe(2);
    const os = await purgeOrgProduct(w.db, { orgId: w.A.id, product: 'os', dryRun: false });
    expect(os.rules.map((x) => x.data_type)).not.toContain('login_events'); // crm is A's first product
    expect(await count()).toBe(2);
    const crm = await purgeOrgProduct(w.db, { orgId: w.A.id, product: 'crm', dryRun: false });
    expect(crm.rules.find((x) => x.data_type === 'login_events')).toMatchObject({ status: 'done', affected: 2 });
    expect(await count()).toBe(0);
    // recent events stay
    expect(Number((await w.q(`select count(*) as n from core.login_events where org_id = $1`, [w.A.id]))[0]!.n)).toBeGreaterThan(0);
  });

  it('an anonymise rule removes the personal columns, keeps the row, and does not repeat itself', async () => {
    await w.q(
      `insert into core.retention_policies (scope, data_type, product_key, schema_name, table_name, date_column, filter_column, filter_values, action, anonymise_columns, anonymise_values, period_value, period_unit, enabled, legal_status)
       values ('table', 'crm_leads_admitted_old', 'crm', 'crm', 'leads', 'last_activity_at', 'status', array['admitted'], 'anonymise', array['phone','email'], '{"full_name":"Former lead"}', 24, 'months', true, 'confirmed')`);
    const first = await purgeOrgProduct(w.db, { orgId: w.A.id, product: 'crm', dryRun: false });
    expect(first.rules.find((x) => x.data_type === 'crm_leads_admitted_old')).toMatchObject({ status: 'done', affected: 1 });
    const row = (await w.q<{ full_name: string; phone: string | null; email: string | null }>(`select full_name, phone, email from crm.leads where org_id = $1 and status = 'admitted'`, [w.A.id]))[0]!;
    expect(row).toEqual({ full_name: 'Former lead', phone: null, email: null });
    const second = await purgeOrgProduct(w.db, { orgId: w.A.id, product: 'crm', dryRun: false });
    expect(second.rules.find((x) => x.data_type === 'crm_leads_admitted_old')).toMatchObject({ affected: 0 });
    expect((await w.q(`select count(*)::int as n from audit.log where org_id = $1 and table_name = 'leads' and (before::text like '%old2@example.test%' or after::text like '%old2@example.test%' or before::text like '%Old Lead A2%')`, [w.A.id]))[0]!.n).toBe(0);
  });

  it('a rule for a table that does not exist yet is skipped and logged, not an error', async () => {
    await w.q(`insert into core.retention_policies (scope, data_type, product_key, schema_name, table_name, date_column, action, period_value, period_unit, enabled, legal_status)
               values ('table', 'future_table', 'os', 'os', 'not_built_yet', 'created_at', 'delete', 1, 'months', true, 'confirmed')`);
    const r = await purgeOrgProduct(w.db, { orgId: w.A.id, product: 'os', dryRun: false });
    expect(rule(r, 'future_table')).toEqual({ data_type: 'future_table', status: 'skipped_table_missing' });
  });
});

describe('who may run it', () => {
  const denied = async (role: 'crm_server' | 'os_server' | 'erp_server' | 'job_runner', sql: string, params: unknown[] = []) => {
    const e = await w.db.run(role, {}, (q) => q.query(sql, params)).then(() => null, (x: unknown) => x as { code?: string });
    return e?.code ?? '';
  };
  it('product roles cannot run, enqueue or read the purge machinery; the job role reaches it only through functions', async () => {
    for (const role of ['crm_server', 'os_server', 'erp_server'] as const) {
      expect(await denied(role, `select app.compliance_retention_purge($1, 'crm')`, [w.A.id]), role).toBe('42501');
      expect(await denied(role, `select app.compliance_enqueue_purge_jobs()`), role).toBe('42501');
      expect(await denied(role, `select app.compliance_person_export($1, 'staff', $2, '{}')`, [w.A.id, w.p.teacher]), role).toBe('42501');
      expect(await denied(role, `select app.compliance_org_deletion_plan($1, null, 'a long enough reason')`, [w.A.id]), role).toBe('42501');
      expect(await denied(role, `select count(*) from audit.purge_log`), role).toBe('42501');
    }
    expect(await denied('job_runner', `select count(*) from core.pii_registry`)).toBe('42501');
    expect(await denied('job_runner', `select count(*) from crm.leads`)).toBe('42501');
    expect(await denied('job_runner', `select app.compliance_org_deletion_plan($1, null, 'a long enough reason')`, [w.A.id])).toBe('42501');
    expect(await denied('job_runner', `select app.compliance_person_export($1, 'staff', $2, '{}')`, [w.A.id, w.p.teacher])).toBe('42501');
  });
});
