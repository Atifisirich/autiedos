/**
 * The framework-free route table: dispatchCompliance(req) answers plain objects. Covers the whole path
 * request -> service -> database role -> SQL function -> response, including who is refused and what status they get.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dispatchCompliance, complianceRoutes, type ComplianceContext, type ComplianceRequest } from '../src/compliance/routes';
import { createFsSink } from '../src/compliance/orgExport';
import { readZip } from '../src/compliance/files';
import { createWorld, endSubscription, type World } from './compliance-support';

let w: World;
let ctx: ComplianceContext;
let dir: string;
beforeAll(async () => {
  w = await createWorld();
  dir = await mkdtemp(join(tmpdir(), 'compliance-routes-'));
  ctx = { db: w.db, sink: createFsSink(dir) };
}, 300000);
afterAll(async () => {
  await w?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

const call = (as: string | null, method: string, path: string, body?: unknown, query?: Record<string, string>, extra: Partial<ComplianceRequest> = {}) =>
  dispatchCompliance({ method, path, body, query, actorUserId: as, ...extra }, ctx);
const json = (r: { body: unknown }) => r.body as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe('routing', () => {
  it('answers 401 without a user, 404 for unknown paths, 405 for the wrong method, 400 for a bad body', async () => {
    expect((await call(null, 'POST', '/compliance/people/export', {})).status).toBe(401);
    expect((await call(w.u.aAdmin!, 'GET', '/compliance/nope')).status).toBe(404);
    expect((await call(w.u.aAdmin!, 'GET', '/compliance/people/export')).status).toBe(405);
    const bad = await call(w.u.aAdmin!, 'POST', '/compliance/people/export', { orgId: 'not-a-uuid' });
    expect(bad.status).toBe(400);
    expect(json(bad).error).toBe('invalid_request');
    expect((await call(w.u.aAdmin!, 'POST', '/api/compliance/people/export', { orgId: w.A.id, personType: 'staff', personId: w.p.teacher })).status).toBe(200); // /api prefix tolerated
  });

  it('lists its routes', async () => {
    const r = await call(w.u.aAdmin!, 'GET', '/compliance/routes');
    expect(r.status).toBe(200);
    expect(json(r).length).toBe(complianceRoutes.length);
    expect(complianceRoutes.map((x) => `${x.method} ${x.path}`)).toEqual(expect.arrayContaining(['POST /compliance/people/export', 'POST /compliance/deletion/execute', 'POST /compliance/retention/purge']));
  });
});

describe('data map', () => {
  it('shows a client what is held and for how long, without exposing the platform default rows', async () => {
    const r = await call(w.u.aAdmin!, 'GET', `/compliance/orgs/${w.A.id}/data-map`);
    expect(r.status).toBe(200);
    const m = json(r);
    const pd = m.personal_data.map((x: { schema: string; table: string; on_erasure: string }) => `${x.schema}.${x.table}:${x.on_erasure}`);
    expect(pd).toEqual(expect.arrayContaining(['core.org_users:delete', 'core.login_events:anonymise', 'core.consents:retain', 'erp.fee_receipts:anonymise', 'crm.leads:delete']));
    expect(m.kept_when_org_deleted.map((x: { schema: string; table: string }) => `${x.schema}.${x.table}`)).toEqual(expect.arrayContaining(['billing.invoices', 'core.organizations']));
    expect(m.retention.find((x: { data_type: string }) => x.data_type === 'crm_leads_not_admitted')).toMatchObject({ period_value: 24, period_unit: 'months', enabled: false, legal_status: 'draft' });
    expect(m.lifecycle_days).toEqual({ product_read_only_days: 30, org_exit_deletion_days: 30 });
    expect((await call(w.u.bAdmin!, 'GET', `/compliance/orgs/${w.A.id}/data-map`)).status).toBe(403);
    expect((await call(w.u.aStaffNoCompliance!, 'GET', `/compliance/orgs/${w.A.id}/data-map`)).status).toBe(403);
    // the default rows themselves are not readable by a client, whichever role it goes through
    for (const role of ['crm_server', 'platform_admin_server'] as const) {
      const n = await w.db.run(role, { actorUserId: w.u.aAdmin! }, async (q) =>
        Number((await q.query(`select (select count(*) from core.pii_registry) + (select count(*) from core.table_policy) + (select count(*) from core.retention_rules) as n`)).rows[0]!.n));
      expect(n, role).toBe(0);
    }
  });
});

describe('person export and erasure over the routes', () => {
  it('returns a zip with a checksum header, or JSON with ?format=json', async () => {
    const r = await call(w.u.aAdmin!, 'POST', '/compliance/people/export', { orgId: w.A.id, personType: 'lead', personId: w.p.leadA, identifiers: ['9876500001'] });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('application/zip');
    expect(r.headers['content-disposition']).toContain('person-export-lead-');
    const names = readZip(r.body as Buffer).map((e) => e.name);
    expect(names).toEqual(expect.arrayContaining(['data.json', 'manifest.json']));
    const j = await call(w.u.aAdmin!, 'POST', '/compliance/people/export', { orgId: w.A.id, personType: 'lead', personId: w.p.leadA }, { format: 'json' });
    expect(json(j).tables.find((t: { table: string }) => t.table === 'leads').rows).toHaveLength(1);
  });

  it('refuses a user without compliance rights (403) and a user of another org (403)', async () => {
    expect((await call(w.u.aStaffNoCompliance!, 'POST', '/compliance/people/export', { orgId: w.A.id, personType: 'staff', personId: w.p.teacher })).status).toBe(403);
    expect((await call(w.u.bAdmin!, 'POST', '/compliance/people/export', { orgId: w.A.id, personType: 'staff', personId: w.p.teacher })).status).toBe(403);
  });

  it('erasure is two calls: plan, then execute with the token; a wrong token is 403', async () => {
    const plan = await call(w.u.aAdmin!, 'POST', '/compliance/people/erasure/plan', { orgId: w.A.id, personType: 'student', personId: w.p.learnerA, reason: 'Parent request verified in person', identityVerified: true });
    expect(plan.status).toBe(200);
    const { requestId, confirmationToken } = json(plan);
    expect((await call(w.u.aAdmin!, 'POST', '/compliance/people/erasure/execute', { requestId, token: 'a'.repeat(64) })).status).toBe(403);
    expect((await call(w.u.aAdmin!, 'POST', '/compliance/people/erasure/execute', { requestId })).status).toBe(400);
    const ok = await call(w.u.aAdmin!, 'POST', '/compliance/people/erasure/execute', { requestId, token: confirmationToken });
    expect(ok.status).toBe(200);
    expect(json(ok).result.anonymised).toBeGreaterThan(0);
    // the same request again: 422 (not planned any more)
    expect((await call(w.u.aAdmin!, 'POST', '/compliance/people/erasure/execute', { requestId, token: confirmationToken })).status).toBe(422);
  });

  it('an unverified identity is a 409 with the blocker', async () => {
    const plan = await call(w.u.aAdmin!, 'POST', '/compliance/people/erasure/plan', { orgId: w.A.id, personType: 'guardian', personId: w.p.guardian, reason: 'Email request, identity not checked yet' });
    const r = await call(w.u.aAdmin!, 'POST', '/compliance/people/erasure/execute', { requestId: json(plan).requestId, token: json(plan).confirmationToken });
    expect(r.status).toBe(409);
    expect(json(r).blockers).toEqual([{ code: 'identity_not_verified' }]);
  });
});

describe('org export, deletion and holds over the routes', () => {
  it('exports, lists and downloads an org archive; the checksum header matches; an expired link is refused', async () => {
    const r = await call(w.u.platform!, 'POST', `/compliance/orgs/${w.A.id}/exports`, { purpose: 'exit', formats: ['csv'] });
    expect(r.status).toBe(201);
    const { jobId, archiveSha256 } = json(r);
    const list = await call(w.u.platform!, 'GET', `/compliance/orgs/${w.A.id}/exports`);
    expect(json(list).map((x: { id: string }) => x.id)).toContain(jobId);
    const dl = await call(w.u.platform!, 'GET', `/compliance/exports/${jobId}/download`);
    expect(dl.status).toBe(200);
    expect(dl.headers['x-content-sha256']).toBe(archiveSha256);
    expect(readZip(dl.body as Buffer).some((e) => e.name === 'manifest.json')).toBe(true);
    expect((await call(w.u.bAdmin!, 'GET', `/compliance/exports/${jobId}/download`)).status).toBe(404); // B cannot even see A's job
    await w.q(`update core.org_export_jobs set expires_at = now() - interval '1 hour' where id = $1`, [jobId]);
    expect((await call(w.u.platform!, 'GET', `/compliance/exports/${jobId}/download`)).status).toBe(409);
  });

  it('deletion: dry run prints text; a live org is refused; after 31 days and an export it is allowed; execute needs the token', async () => {
    const live = await call(w.u.platform!, 'POST', `/compliance/orgs/${w.A.id}/deletion/plan`, { reason: 'Client asked to leave, ticket 900' }, { format: 'text' });
    expect(live.status).toBe(200);
    expect(live.headers['content-type']).toContain('text/plain');
    expect(String(live.body)).toContain('DRY RUN: nothing has been deleted');
    expect(String(live.body)).toContain('REFUSED');
    expect((await call(w.u.aAdmin!, 'POST', `/compliance/orgs/${w.A.id}/deletion/plan`, { reason: 'Client asked to leave, ticket 900' })).status).toBe(403);

    for (const p of ['crm', 'os', 'erp']) await endSubscription(w, w.A.id, p, 'cancelled', 31);
    const due = await call(w.u.platform!, 'GET', '/compliance/deletion/due');
    expect(json(due).filter((d: { orgId: string; purgeDue: boolean }) => d.orgId === w.A.id).every((d: { purgeDue: boolean }) => d.purgeDue)).toBe(true);
    expect((await call(w.u.aAdmin!, 'GET', '/compliance/deletion/due')).status).toBe(403);

    await call(w.u.platform!, 'POST', `/compliance/orgs/${w.A.id}/exports`, { purpose: 'exit' });
    const plan = await call(w.u.platform!, 'POST', `/compliance/orgs/${w.A.id}/deletion/plan`, { reason: 'Client left, export delivered, ticket 901' });
    expect(json(plan).eligible).toBe(true);
    const { requestId, confirmationToken } = json(plan);
    expect((await call(w.u.platform!, 'POST', '/compliance/deletion/execute', { requestId, token: 'c'.repeat(64) })).status).toBe(403);
    // a hold placed through the route stops it with a 409 and the blocker
    const hold = await call(w.u.platform!, 'POST', `/compliance/orgs/${w.A.id}/holds`, { scope: 'org', reason: 'Court order, preserve everything' });
    expect(hold.status).toBe(201);
    const refused = await call(w.u.platform!, 'POST', '/compliance/deletion/execute', { requestId, token: confirmationToken });
    expect(refused.status).toBe(409);
    expect(json(refused).blockers.map((b: { code: string }) => b.code)).toEqual(['legal_hold']);
    expect(json(await call(w.u.platform!, 'GET', `/compliance/orgs/${w.A.id}/holds`)).length).toBe(1);
    expect((await call(w.u.platform!, 'POST', `/compliance/holds/${json(hold).id}/release`, { reason: 'Order lifted' })).status).toBe(200);
    const plan2 = await call(w.u.platform!, 'POST', `/compliance/orgs/${w.A.id}/deletion/plan`, { reason: 'Client left, export delivered, ticket 902' });
    const done = await call(w.u.platform!, 'POST', '/compliance/deletion/execute', { requestId: json(plan2).requestId, token: json(plan2).confirmationToken });
    expect(done.status).toBe(200);
    expect(json(done).externalActions.map((a: { kind: string }) => a.kind)).toEqual(['auth_user_delete', 'storage_prefix_delete']);
    expect(Number((await w.q(`select count(*) as n from crm.leads where org_id = $1`, [w.A.id]))[0]!.n)).toBe(0);
    expect(Number((await w.q(`select count(*) as n from crm.leads where org_id = $1`, [w.B.id]))[0]!.n)).toBe(1);
  });
});

describe('retention and consent over the routes', () => {
  it('purge defaults to a dry run; a product the org does not have is skipped', async () => {
    const r = await call(w.u.platform!, 'POST', '/compliance/retention/purge', { orgId: w.B.id, product: 'crm' });
    expect(r.status).toBe(200);
    expect(json(r).dry_run).toBe(true);
    const c = await call(w.u.platform!, 'POST', '/compliance/retention/purge', { orgId: w.C.id, product: 'erp', dryRun: false });
    expect(json(c)).toMatchObject({ skipped: true, reason: 'no_product' });
    expect((await call(w.u.platform!, 'POST', '/compliance/retention/purge', { orgId: w.C.id, product: 'banana' })).status).toBe(400);
    expect(json(await call(w.u.platform!, 'POST', '/compliance/retention/enqueue', {})).enqueued).toBe(0); // nothing enabled
  });

  it('records consent through the caller product role and gates sends', async () => {
    const rec = await call(w.u.bAdmin!, 'POST', '/compliance/consents', { orgId: w.B.id, channel: 'whatsapp', contact: '98200 00001', purpose: 'promotional', status: 'opted_in', source: 'form' }, undefined, { productRole: 'erp_server' });
    expect(rec.status).toBe(201);
    const q = { orgId: w.B.id, channel: 'whatsapp', contact: '+919820000001', purpose: 'promotional' };
    const check = await call(w.u.bAdmin!, 'GET', '/compliance/consents/check', undefined, q);
    expect(json(check)).toEqual({ may_send: true, status: 'opted_in' });
    await call(w.u.bAdmin!, 'POST', '/compliance/consents', { orgId: w.B.id, channel: 'whatsapp', contact: '+919820000001', purpose: 'both', status: 'opted_out', source: 'inbound_message' });
    expect(json(await call(w.u.bAdmin!, 'GET', '/compliance/consents/check', undefined, q))).toEqual({ may_send: false, status: 'opted_out' });
    expect((await call(w.u.aAdmin!, 'GET', '/compliance/consents/check', undefined, q)).status).toBe(403); // another org
    const h = await call(w.u.bAdmin!, 'GET', '/compliance/consents/history', undefined, { orgId: w.B.id, channel: 'whatsapp', contact: '9820000001' });
    expect(json(h).length).toBe(3);
  });
});
