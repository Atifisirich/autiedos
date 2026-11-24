/**
 * Organisation export and deletion (data-subject-rights-procedure.md 4.1, 4.2, 5.3, 5.4; decision 42) on real Postgres:
 * export of org A never holds org B rows, the manifest verifies, deletion is dry-run first, refused before the grace
 * period and without a second confirmation token, and keeps what must be kept.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ComplianceError } from '../src/compliance/types';
import { executeOrgDeletion, formatDeletionPlan, listDeletionDue, planOrgDeletion } from '../src/compliance/orgDeletion';
import { createFsSink, runOrgExport, type ExportManifest } from '../src/compliance/orgExport';
import { placeHold, releaseHold } from '../src/compliance/holds';
import { readZip } from '../src/compliance/files';
import { createWorld, endSubscription, type World } from './compliance-support';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const rejects = async (p: Promise<unknown>, code: string) => {
  const e = await p.then(() => null, (x: unknown) => x);
  expect(e, `expected ${code}`).toBeInstanceOf(ComplianceError);
  expect((e as ComplianceError).code).toBe(code);
  return e as ComplianceError;
};

describe('organisation export', () => {
  let w: World;
  let dir: string;
  beforeAll(async () => {
    w = await createWorld();
    dir = await mkdtemp(join(tmpdir(), 'compliance-export-'));
  }, 300000);
  afterAll(async () => {
    await w?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('exports every table of org A with matching row counts, and sha256 that verify', async () => {
    const sink = createFsSink(dir);
    const r = await runOrgExport(w.db, sink, w.u.aAdmin!, { orgId: w.A.id, purpose: 'on_demand' });
    const zip = await sink.get(r.storageKey);
    expect(createHash('sha256').update(zip).digest('hex')).toBe(r.archiveSha256);
    const entries = readZip(zip);
    const byName = new Map(entries.map((e) => [e.name, e.data]));
    const manifest = JSON.parse(byName.get('manifest.json')!.toString('utf8')) as ExportManifest;
    expect(manifest.org_id).toBe(w.A.id);
    expect(manifest.products.sort()).toEqual(['crm', 'erp', 'os']);

    const names = manifest.tables.map((t) => `${t.schema}.${t.table}`);
    for (const must of ['core.org_users', 'core.subscriptions', 'crm.leads', 'erp.fee_receipts', 'billing.invoices', 'audit.log', 'os.harness_probe']) {
      expect(names, must).toContain(must);
    }
    let total = 0;
    for (const t of manifest.tables) {
      const n = Number((await w.q(`select count(*) as n from "${t.schema}"."${t.table}" where org_id = $1`, [w.A.id]))[0]!.n);
      // audit grows by the export's own events after counting; everything else must match exactly
      if (t.schema === 'audit') expect(t.rows).toBeLessThanOrEqual(n);
      else expect(t.rows, `${t.schema}.${t.table}`).toBe(n);
      total += t.rows;
      for (const f of t.files) {
        const data = byName.get(f.path);
        expect(data, f.path).toBeDefined();
        expect(sha(data!), f.path).toBe(f.sha256);
        expect(data!.length).toBe(f.bytes);
      }
    }
    expect(manifest.total_rows).toBe(total);
    const job = (await w.q(`select status, total_rows, archive_sha256, manifest_sha256, expires_at from core.org_export_jobs where id = $1`, [r.jobId]))[0]!;
    expect(job.status).toBe('done');
    expect(Number(job.total_rows)).toBe(total);
    expect(job.archive_sha256).toBe(r.archiveSha256);
    expect(job.manifest_sha256).toBe(sha(byName.get('manifest.json')!));
    expect(new Date(job.expires_at as string).getTime()).toBeGreaterThan(Date.now());

    // CSV and XLSX both present and consistent
    const csv = byName.get('crm/leads.csv')!.toString('utf8');
    expect(csv.split('\r\n').filter(Boolean)).toHaveLength(1 + 4);
    expect(csv).toContain('Lena Lead');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(byName.get('crm/leads.xlsx')! as unknown as ArrayBuffer);
    expect(wb.worksheets[0]!.rowCount).toBe(1 + 4);
  });

  it('never contains a row of org B or org C', async () => {
    const sink = createFsSink(dir);
    const r = await runOrgExport(w.db, sink, w.u.aAdmin!, { orgId: w.A.id });
    const all = readZip(await sink.get(r.storageKey))
      .filter((e) => e.name !== 'manifest.json')
      .map((e) => (e.name.endsWith('.xlsx') ? '' : e.data.toString('utf8')))
      .join('\n');
    for (const bad of [w.B.id, w.C.id, 'Bela Lead', 'Bob Parent', 'billing2@example.test', 'Org org-b', 'Bina Admin', 'Tej Teacher', 'os C planted', 'admin@b.test']) {
      expect(all.includes(bad), bad).toBe(false);
    }
    expect(all).toContain('Org org-a'); // sanity: A's own data is there
  });

  it('exports only the product schemas the org has: org C (crm only) gets no os or erp tables, planted rows stay out', async () => {
    const sink = createFsSink(dir);
    const r = await runOrgExport(w.db, sink, w.u.cAdmin!, { orgId: w.C.id });
    const schemas = new Set(r.manifest.tables.map((t) => t.schema));
    expect(schemas.has('crm')).toBe(true);
    expect(schemas.has('os')).toBe(false);
    expect(schemas.has('erp')).toBe(false);
    const files = readZip(await sink.get(r.storageKey)).map((e) => e.name);
    expect(files.some((f) => f.startsWith('os/') || f.startsWith('erp/'))).toBe(false);
  });

  it('picks up a table created later with no change to the tooling (catalogue-driven)', async () => {
    await w.q(`insert into core.product_modules (product_key, module_key, name) values ('os', 'notes', 'Notes')`);
    await w.q(`create table os.notes (id uuid primary key default gen_random_uuid(), org_id uuid not null references core.organizations(id) on delete cascade, body text not null)`);
    await w.q(`select app.apply_rls('os', 'notes', 'product', 'os', 'notes')`);
    await w.q(`insert into os.notes (org_id, body) values ($1, 'note of A'), ($2, 'note of B')`, [w.A.id, w.B.id]);
    const sink = createFsSink(dir);
    const r = await runOrgExport(w.db, sink, w.u.aAdmin!, { orgId: w.A.id, formats: ['csv'] });
    expect(r.manifest.tables.find((t) => t.table === 'notes')).toMatchObject({ schema: 'os', rows: 1 });
    const csv = readZip(await sink.get(r.storageKey)).find((e) => e.name === 'os/notes.csv')!.data.toString('utf8');
    expect(csv).toContain('note of A');
    expect(csv).not.toContain('note of B');
  });

  it('is allowed for the org own compliance admin and AutoEd platform admins, and for nobody else', async () => {
    const sink = createFsSink(dir);
    await runOrgExport(w.db, sink, w.u.platform!, { orgId: w.A.id, formats: ['csv'] });
    await rejects(runOrgExport(w.db, sink, w.u.bAdmin!, { orgId: w.A.id, formats: ['csv'] }), 'forbidden');
    await rejects(runOrgExport(w.db, sink, w.u.aStaffNoCompliance!, { orgId: w.A.id, formats: ['csv'] }), 'forbidden');
    await rejects(runOrgExport(w.db, sink, w.u.aGuardian!, { orgId: w.A.id, formats: ['csv'] }), 'forbidden');
  });

  it('records a failed export when the sink fails, and leaves nothing marked done', async () => {
    const bad = { put: async () => Promise.reject(new Error('disk full')), get: async () => Buffer.alloc(0) };
    await expect(runOrgExport(w.db, bad, w.u.aAdmin!, { orgId: w.A.id, formats: ['csv'] })).rejects.toThrow('disk full');
    const last = (await w.q(`select status, error from core.org_export_jobs where org_id = $1 order by created_at desc limit 1`, [w.A.id]))[0]!;
    expect(last).toEqual({ status: 'failed', error: 'disk full' });
  });
});

describe('organisation deletion', () => {
  let w: World;
  let dir: string;
  const clientTables = ['crm.leads', 'erp.fee_receipts', 'core.org_users', 'core.branches', 'core.roles', 'core.consent_events', 'os.harness_probe', 'core.learner_links',
    'core.staff', 'core.students', 'core.guardians', 'core.households', 'core.student_sensitive', 'core.notifications', 'core.device_tokens', 'core.tickets', 'core.staff_attendance', 'core.outbox', 'core.files'];
  const count = async (t: string, org: string) => Number((await w.q(`select count(*) as n from ${t} where org_id = $1`, [org]))[0]!.n);

  beforeAll(async () => {
    w = await createWorld();
    dir = await mkdtemp(join(tmpdir(), 'compliance-delete-'));
  }, 300000);
  afterAll(async () => {
    await w?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('is a dry run first: it prints what would be deleted and deletes nothing, even if the org is live', async () => {
    const before = await Promise.all(clientTables.map((t) => count(t, w.A.id)));
    const plan = await planOrgDeletion(w.db, w.u.platform!, { orgId: w.A.id, reason: 'Client asked to leave, ticket 400' });
    expect(plan.dryRun).toBe(true);
    expect(plan.eligible).toBe(false);
    expect(plan.confirmationToken).toBeUndefined();
    expect(plan.blockers.map((b) => b.code)).toContain('org_has_active_product');
    const t = Object.fromEntries(plan.plan.tables.map((x) => [`${x.schema}.${x.table}`, x.rows]));
    expect(t['crm.leads']).toBe(4);
    expect(t['erp.fee_receipts']).toBe(3);
    const text = formatDeletionPlan(plan);
    expect(text).toContain('DRY RUN: nothing has been deleted');
    expect(text).toContain('crm.leads');
    expect(text).toContain('billing.invoices'); // listed under "would keep"
    expect(text).toContain('REFUSED');
    expect(await Promise.all(clientTables.map((x) => count(x, w.A.id)))).toEqual(before);
    // dry-run counts are in the purge log, marked dry_run
    const logs = await w.q(`select status from audit.purge_log where request_id = $1 and table_name = 'leads'`, [plan.requestId]);
    expect(logs).toEqual([{ status: 'dry_run' }]);
  });

  it('only AutoEd platform admins may plan or execute', async () => {
    await rejects(planOrgDeletion(w.db, w.u.aAdmin!, { orgId: w.A.id, reason: 'We want to delete everything now' }), 'forbidden');
    await rejects(planOrgDeletion(w.db, w.u.bAdmin!, { orgId: w.A.id, reason: 'We want to delete everything now' }), 'forbidden');
    await rejects(planOrgDeletion(w.db, w.u.platform!, { orgId: w.A.id, reason: 'short' }), 'invalid');
  });

  it('is refused before the grace period is over, and says when it will be allowed', async () => {
    for (const p of ['crm', 'os', 'erp']) await endSubscription(w, w.A.id, p, 'cancelled', 10);
    const plan = await planOrgDeletion(w.db, w.u.platform!, { orgId: w.A.id, reason: 'Client left 10 days ago, ticket 401' });
    expect(plan.eligible).toBe(false);
    expect(plan.confirmationToken).toBeUndefined();
    const codes = plan.blockers.map((b) => b.code);
    expect(codes).toContain('grace_period_not_elapsed');
    expect(codes).toContain('export_required');
    expect(codes).not.toContain('org_has_active_product');
    const eligibleAt = new Date(plan.eligibleAt!).getTime();
    expect(Math.abs(eligibleAt - (Date.now() + 20 * 86400000))).toBeLessThan(3600000);
    const req = (await w.q(`select status, token_hash from core.compliance_requests where id = $1`, [plan.requestId]))[0]!;
    expect(req).toEqual({ status: 'refused', token_hash: null });
    // nothing can be executed from a refused request
    await rejects(executeOrgDeletion(w.db, w.u.platform!, plan.requestId, 'a'.repeat(64)), 'invalid');
    expect(await count('crm.leads', w.A.id)).toBe(4);
  });

  it('the due list follows entitlements: not due at 10 days, due at 31', async () => {
    const at10 = await listDeletionDue(w.db, w.u.platform!);
    expect(at10.filter((d) => d.orgId === w.A.id).map((d) => [d.product, d.access, d.purgeDue])).toEqual([['crm', 'read_only', false], ['erp', 'read_only', false], ['os', 'read_only', false]]);
    for (const p of ['crm', 'os', 'erp']) await endSubscription(w, w.A.id, p, 'cancelled', 29);
    expect((await listDeletionDue(w.db, w.u.platform!)).filter((d) => d.orgId === w.A.id).every((d) => !d.purgeDue)).toBe(true);
    for (const p of ['crm', 'os', 'erp']) await endSubscription(w, w.A.id, p, 'cancelled', 31);
    const at31 = (await listDeletionDue(w.db, w.u.platform!)).filter((d) => d.orgId === w.A.id);
    expect(at31.every((d) => d.access === 'none' && d.purgeDue)).toBe(true);
    // org B is live: not on the list
    expect((await listDeletionDue(w.db, w.u.platform!)).some((d) => d.orgId === w.B.id)).toBe(false);
  });

  it('after the grace period it still needs the export first (decision 42), then a token', async () => {
    const need = await planOrgDeletion(w.db, w.u.platform!, { orgId: w.A.id, reason: 'Client left 31 days ago, ticket 402' });
    expect(need.blockers.map((b) => b.code)).toEqual(['export_required']);
    expect(need.eligible).toBe(false);
    await runOrgExport(w.db, createFsSink(dir), w.u.platform!, { orgId: w.A.id, purpose: 'exit' });
    const ok = await planOrgDeletion(w.db, w.u.platform!, { orgId: w.A.id, reason: 'Client left 31 days ago, ticket 402' });
    expect(ok.eligible).toBe(true);
    expect(ok.blockers).toEqual([]);
    expect(ok.confirmationToken).toMatch(/^[0-9a-f]{64}$/);
    expect(formatDeletionPlan(ok)).toContain('ALLOWED NOW');
  });

  it('needs the second confirmation token: no token, a wrong token or someone else cannot execute', async () => {
    const plan = await planOrgDeletion(w.db, w.u.platform!, { orgId: w.A.id, reason: 'Client left, export delivered, ticket 403' });
    await rejects(executeOrgDeletion(w.db, w.u.platform!, plan.requestId, ''), 'forbidden');
    await rejects(executeOrgDeletion(w.db, w.u.platform!, plan.requestId, 'b'.repeat(64)), 'forbidden');
    await rejects(executeOrgDeletion(w.db, w.u.aAdmin!, plan.requestId, plan.confirmationToken!), 'forbidden');
    await rejects(executeOrgDeletion(w.db, w.u.bAdmin!, plan.requestId, plan.confirmationToken!), 'forbidden');
    expect(await count('crm.leads', w.A.id)).toBe(4);
    // an expired token is dead
    await w.q(`update core.compliance_requests set token_expires_at = now() - interval '1 second' where id = $1`, [plan.requestId]);
    await rejects(executeOrgDeletion(w.db, w.u.platform!, plan.requestId, plan.confirmationToken!), 'forbidden');
  });

  it('re-checks everything at execution: a legal hold placed after the plan stops it', async () => {
    const plan = await planOrgDeletion(w.db, w.u.platform!, { orgId: w.A.id, reason: 'Client left, export delivered, ticket 404' });
    expect(plan.eligible).toBe(true);
    const hold = await placeHold(w.db, w.u.platform!, { orgId: w.A.id, scope: 'org', reason: 'Court order 2026/12: preserve all records' });
    const e = await rejects(executeOrgDeletion(w.db, w.u.platform!, plan.requestId, plan.confirmationToken!), 'refused');
    expect(e.blockers.map((b) => b.code)).toEqual(['legal_hold']);
    expect(await count('crm.leads', w.A.id)).toBe(4);
    expect((await w.q(`select status from core.compliance_requests where id = $1`, [plan.requestId]))[0]!.status).toBe('refused');
    // and a plan while the hold stands is refused outright
    expect((await planOrgDeletion(w.db, w.u.platform!, { orgId: w.A.id, reason: 'Client left, export delivered, ticket 405' })).blockers.map((b) => b.code)).toEqual(['legal_hold']);
    await releaseHold(w.db, w.u.platform!, hold, 'Order lifted');
  });

  it('re-checks the subscription at execution: a client who came back is not deleted', async () => {
    const plan = await planOrgDeletion(w.db, w.u.platform!, { orgId: w.A.id, reason: 'Client left, export delivered, ticket 406' });
    expect(plan.eligible).toBe(true);
    await w.q(`update core.subscriptions set status = 'active' where org_id = $1 and product_key = 'os'`, [w.A.id]);
    const e = await rejects(executeOrgDeletion(w.db, w.u.platform!, plan.requestId, plan.confirmationToken!), 'refused');
    expect(e.blockers.map((b) => b.code)).toContain('org_has_active_product');
    expect(await count('crm.leads', w.A.id)).toBe(4);
    await endSubscription(w, w.A.id, 'os', 'cancelled', 31);
  });

  it('deletes the org: client data gone, org B untouched, invoices and the contract record kept, no PII left in audit', async () => {
    const bBefore = await Promise.all(clientTables.map((t) => count(t, w.B.id)));
    const auditPii = async () =>
      Number((await w.q(
        `select count(*) as n from audit.log where org_id = $1 and (before::text ~ 'Lena|Tara|Gita|Asha|Old Lead|Gita Guardian|admin@a.test' or after::text ~ 'Lena|Tara|Gita|Asha|Old Lead|Gita Guardian|admin@a.test')`,
        [w.A.id],
      ))[0]!.n);
    expect(await auditPii()).toBeGreaterThan(0); // the triggers did store it

    const plan = await planOrgDeletion(w.db, w.u.platform!, { orgId: w.A.id, reason: 'Client left, export delivered, ticket 407' });
    expect(plan.eligible).toBe(true);
    const done = await executeOrgDeletion(w.db, w.u.platform!, plan.requestId, plan.confirmationToken!);

    for (const t of clientTables) expect(await count(t, w.A.id), t).toBe(0);
    expect(await Promise.all(clientTables.map((t) => count(t, w.B.id)))).toEqual(bBefore);
    expect(await count('crm.leads', w.C.id)).toBe(0); // C never had leads; and C's rows are untouched
    expect(Number((await w.q(`select count(*) as n from os.harness_probe where org_id = $1`, [w.C.id]))[0]!.n)).toBe(1);

    // kept on purpose
    const org = (await w.q(`select status from core.organizations where id = $1`, [w.A.id]))[0]!;
    expect(org.status).toBe('closed');
    expect(await count('core.subscriptions', w.A.id)).toBe(3);
    expect(await count('billing.invoices', w.A.id)).toBe(1);
    expect(await count('billing.accounts', w.A.id)).toBe(1);
    const kept = done.result.retained.map((r) => `${r.schema}.${r.table}`);
    expect(kept).toEqual(expect.arrayContaining(['core.organizations', 'core.subscriptions', 'billing.invoices']));

    // the audit trail remains (who, when, which table) but the data does not
    expect(await auditPii()).toBe(0);
    expect(Number((await w.q(`select count(*) as n from audit.log where org_id = $1`, [w.A.id]))[0]!.n)).toBeGreaterThan(10);
    const ev = await w.q(`select actor_user_id from audit.log where org_id = $1 and action = 'compliance.org_deleted'`, [w.A.id]);
    expect(ev).toEqual([{ actor_user_id: w.u.platform }]);
    const purge = await w.q(`select table_name, status, rows_affected::int as n from audit.purge_log where request_id = $1 and status = 'done' and table_name = 'leads'`, [plan.requestId]);
    expect(purge).toEqual([{ table_name: 'leads', status: 'done', n: 4 }]);
    // the register holds counts, not data
    const reg = (await w.q(`select status, result from core.compliance_requests where id = $1`, [plan.requestId]))[0]!;
    expect(reg.status).toBe('executed');
    expect(JSON.stringify(reg.result)).not.toContain('Lena');
    // what SQL cannot do is handed to the server
    const auth = done.externalActions.find((a) => a.kind === 'auth_user_delete') as unknown as { user_ids: string[] };
    expect(auth.user_ids.sort()).toEqual([w.u.aAdmin, w.u.aTeacher, w.u.aStaffNoCompliance, w.u.aGuardian].sort());
    expect(done.externalActions.find((a) => a.kind === 'storage_prefix_delete')).toMatchObject({ prefix: `${w.A.id}/` });
    // it cannot be run again
    await rejects(executeOrgDeletion(w.db, w.u.platform!, plan.requestId, plan.confirmationToken!), 'invalid');
  });
});

describe('product deletion', () => {
  let w: World;
  let dir: string;
  beforeAll(async () => {
    w = await createWorld();
    dir = await mkdtemp(join(tmpdir(), 'compliance-product-'));
  }, 300000);
  afterAll(async () => {
    await w?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('deletes only that product schema for the org after 30 days read-only and an export', async () => {
    await endSubscription(w, w.B.id, 'crm', 'suspended', 31);
    const p0 = await planOrgDeletion(w.db, w.u.platform!, { orgId: w.B.id, product: 'crm', reason: 'Client stopped paying CRM, ticket 500' });
    expect(p0.blockers.map((b) => b.code)).toEqual(['export_required']);
    await runOrgExport(w.db, createFsSink(dir), w.u.platform!, { orgId: w.B.id, purpose: 'non_payment' });
    const plan = await planOrgDeletion(w.db, w.u.platform!, { orgId: w.B.id, product: 'crm', reason: 'Client stopped paying CRM, ticket 500' });
    expect(plan.eligible).toBe(true);
    expect(plan.plan.tables.every((t) => t.schema === 'crm' || t.schema === 'private')).toBe(true);
    // an org-level request is still refused: OS and ERP are live
    expect((await planOrgDeletion(w.db, w.u.platform!, { orgId: w.B.id, reason: 'Client stopped paying everything, ticket 501' })).blockers.map((b) => b.code)).toContain('org_has_active_product');

    await executeOrgDeletion(w.db, w.u.platform!, plan.requestId, plan.confirmationToken!);
    expect(Number((await w.q(`select count(*) as n from crm.leads where org_id = $1`, [w.B.id]))[0]!.n)).toBe(0);
    expect(Number((await w.q(`select count(*) as n from crm.harness_probe where org_id = $1`, [w.B.id]))[0]!.n)).toBe(0);
    // OS, ERP and core master data of B untouched; org A's CRM untouched; B still open
    expect(Number((await w.q(`select count(*) as n from erp.fee_receipts where org_id = $1`, [w.B.id]))[0]!.n)).toBe(1);
    expect(Number((await w.q(`select count(*) as n from os.harness_probe where org_id = $1`, [w.B.id]))[0]!.n)).toBe(1);
    expect(Number((await w.q(`select count(*) as n from core.org_users where org_id = $1`, [w.B.id]))[0]!.n)).toBe(2);
    expect(Number((await w.q(`select count(*) as n from crm.leads where org_id = $1`, [w.A.id]))[0]!.n)).toBe(4);
    expect((await w.q(`select status from core.organizations where id = $1`, [w.B.id]))[0]!.status).toBe('active');
  });
});
