/**
 * Framework-free route table for the compliance tools: dispatchCompliance(req) takes a plain request object and
 * returns a plain response, so Vercel, Express, a test or a CLI can all call it. The caller authenticates the user and
 * passes `actorUserId`; the database functions authorise that user for the org (platform admin, or an org member
 * holding compliance.<action>). Nothing here trusts the body about who is calling.
 */
import { z } from 'zod';
import { poolDbFromEnv, type ComplianceDb } from './db';
import { consentHistory, consentStatus, maySend, recordConsent, type ConsentRole } from './consent';
import { executeOrgDeletion, formatDeletionPlan, listDeletionDue, planOrgDeletion } from './orgDeletion';
import { createFsSink, runOrgExport, type ExportSink } from './orgExport';
import { executePersonErasure, exportPerson, planPersonErasure } from './person';
import { enqueueRetentionJobs, purgeOrgProduct } from './retention';
import { listHolds, placeHold, releaseHold } from './holds';
import { getDataMap } from './dataMap';
import { ComplianceError, CONSENT_CHANNELS, PERSON_TYPES, PRODUCT_KEYS } from './types';

export interface ComplianceRequest {
  method: string;
  /** Path such as /compliance/people/export (a leading /api is ignored). */
  path: string;
  query?: Record<string, string | undefined>;
  body?: unknown;
  /** The authenticated user. Required for every route. */
  actorUserId?: string | null;
  /** Which database role may serve consent routes for this caller. Default crm_server. */
  productRole?: ConsentRole;
}

export interface ComplianceResponse {
  status: number;
  headers: Record<string, string>;
  /** A Buffer for downloads, otherwise JSON-serialisable (or a string for text/plain). */
  body: unknown;
}

export interface ComplianceContext {
  db: ComplianceDb;
  sink: ExportSink;
  now?: () => Date;
}

let defaultCtx: ComplianceContext | null = null;
function defaultContext(): ComplianceContext {
  defaultCtx ??= { db: poolDbFromEnv(), sink: createFsSink(process.env.COMPLIANCE_EXPORT_DIR ?? '/tmp/autoed-compliance-exports') };
  return defaultCtx;
}

const uuid = z.string().uuid();
const personType = z.enum(PERSON_TYPES);
const product = z.enum(PRODUCT_KEYS);
const channel = z.enum(CONSENT_CHANNELS);
const person = z.object({ orgId: uuid, personType, personId: uuid, identifiers: z.array(z.string().min(1).max(200)).max(20).optional() });

type Handler = (req: ComplianceRequest, ctx: ComplianceContext, params: Record<string, string>, actor: string) => Promise<ComplianceResponse>;

const json = (status: number, body: unknown): ComplianceResponse => ({ status, headers: { 'content-type': 'application/json' }, body });

interface Route {
  method: string;
  pattern: string;
  handler: Handler;
  /** Documentation for the route listing. */
  summary: string;
}

const routes: Route[] = [
  {
    method: 'POST',
    pattern: '/compliance/people/export',
    summary: 'Per-person export (zip of JSON + CSV). Add ?format=json for the data without the archive.',
    async handler(req, ctx, _p, actor) {
      const b = person.parse(req.body);
      const f = await exportPerson(ctx.db, actor, b);
      if (req.query?.format === 'json') return json(200, { ...f.data, sha256: f.sha256 });
      return { status: 200, headers: { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="${f.filename}"`, 'x-content-sha256': f.sha256 }, body: f.zip };
    },
  },
  {
    method: 'POST',
    pattern: '/compliance/people/erasure/plan',
    summary: 'Step 1 of person erasure: dry run and confirmation token.',
    async handler(req, ctx, _p, actor) {
      const b = person.extend({ reason: z.string().min(10).max(500), identityVerified: z.boolean().optional() }).parse(req.body);
      return json(200, await planPersonErasure(ctx.db, actor, b, { reason: b.reason, identityVerified: b.identityVerified }));
    },
  },
  {
    method: 'POST',
    pattern: '/compliance/people/erasure/execute',
    summary: 'Step 2 of person erasure: needs the request id and token from the plan.',
    async handler(req, ctx, _p, actor) {
      const b = z.object({ requestId: uuid, token: z.string().min(16).max(200) }).parse(req.body);
      return json(200, await executePersonErasure(ctx.db, actor, b.requestId, b.token));
    },
  },
  {
    method: 'POST',
    pattern: '/compliance/orgs/:orgId/exports',
    summary: 'Run a whole-organisation export now (CSV + XLSX per table + manifest).',
    async handler(req, ctx, p, actor) {
      const b = z
        .object({ products: z.array(product).optional(), purpose: z.enum(['on_demand', 'exit', 'non_payment']).optional(), formats: z.array(z.enum(['csv', 'xlsx'])).min(1).optional(), includeAudit: z.boolean().optional() })
        .parse(req.body ?? {});
      const r = await runOrgExport(ctx.db, ctx.sink, actor, { orgId: uuid.parse(p.orgId), ...b, now: ctx.now });
      return json(201, { jobId: r.jobId, archiveSha256: r.archiveSha256, archiveBytes: r.archiveBytes, manifestSha256: r.manifestSha256, totalRows: r.manifest.total_rows, tables: r.manifest.tables.length });
    },
  },
  {
    method: 'GET',
    pattern: '/compliance/orgs/:orgId/exports',
    summary: 'List export jobs of an organisation.',
    async handler(_req, ctx, p, actor) {
      const rows = await ctx.db.run('platform_admin_server', { actorUserId: actor }, async (q) =>
        (await q.query(`select id, purpose, product_keys, status, total_rows, archive_sha256, archive_bytes, created_at, finished_at, expires_at from core.org_export_jobs where org_id = $1 order by created_at desc limit 50`, [uuid.parse(p.orgId)])).rows,
      );
      return json(200, rows);
    },
  },
  {
    method: 'GET',
    pattern: '/compliance/exports/:jobId/download',
    summary: 'Download a finished export (not after it expires).',
    async handler(_req, ctx, p, actor) {
      const job = await ctx.db.run('platform_admin_server', { actorUserId: actor }, async (q) =>
        (await q.query<{ storage_key: string | null; archive_sha256: string | null; status: string; expires_at: string | null }>(
          `select storage_key, archive_sha256, status, expires_at from core.org_export_jobs where id = $1`, [uuid.parse(p.jobId)])).rows[0],
      );
      if (!job) throw new ComplianceError('not_found', 'unknown export');
      if (job.status !== 'done' || !job.storage_key) throw new ComplianceError('refused', `export is ${job.status}`);
      if (job.expires_at && new Date(job.expires_at) < (ctx.now?.() ?? new Date())) throw new ComplianceError('refused', 'export link expired');
      const data = await ctx.sink.get(job.storage_key);
      return { status: 200, headers: { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="org-export-${p.jobId}.zip"`, 'x-content-sha256': job.archive_sha256 ?? '' }, body: data };
    },
  },
  {
    method: 'POST',
    pattern: '/compliance/orgs/:orgId/deletion/plan',
    summary: 'Dry run of an org (or product) deletion. ?format=text prints the plan.',
    async handler(req, ctx, p, actor) {
      const b = z.object({ product: product.nullish(), reason: z.string().min(10).max(500) }).parse(req.body);
      const r = await planOrgDeletion(ctx.db, actor, { orgId: uuid.parse(p.orgId), product: b.product ?? null, reason: b.reason });
      if (req.query?.format === 'text') return { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: formatDeletionPlan(r) };
      return json(200, r);
    },
  },
  {
    method: 'POST',
    pattern: '/compliance/deletion/execute',
    summary: 'Execute a planned deletion: needs the request id and confirmation token.',
    async handler(req, ctx, _p, actor) {
      const b = z.object({ requestId: uuid, token: z.string().min(16).max(200) }).parse(req.body);
      return json(200, await executeOrgDeletion(ctx.db, actor, b.requestId, b.token));
    },
  },
  {
    method: 'GET',
    pattern: '/compliance/deletion/due',
    summary: 'Products whose read-only window is over (platform admins).',
    async handler(_req, ctx, _p, actor) {
      return json(200, await listDeletionDue(ctx.db, actor, ctx.now?.() ?? new Date()));
    },
  },
  {
    method: 'POST',
    pattern: '/compliance/retention/purge',
    summary: 'Run (or dry-run) the retention purge for one org and product.',
    async handler(req, ctx, _p, _actor) {
      const b = z.object({ orgId: uuid, product, dryRun: z.boolean().default(true) }).parse(req.body);
      return json(200, await purgeOrgProduct(ctx.db, b));
    },
  },
  {
    method: 'POST',
    pattern: '/compliance/retention/enqueue',
    summary: 'Cron: enqueue retention jobs for orgs that have the product and an enabled rule.',
    async handler(req, ctx) {
      const b = z.object({ product: product.optional() }).parse(req.body ?? {});
      return json(200, { enqueued: await enqueueRetentionJobs(ctx.db, b.product) });
    },
  },
  {
    method: 'GET',
    pattern: '/compliance/orgs/:orgId/holds',
    summary: 'Legal holds of an organisation (open ones unless ?all=1).',
    async handler(req, ctx, p, actor) {
      return json(200, await listHolds(ctx.db, actor, uuid.parse(p.orgId), req.query?.all !== '1'));
    },
  },
  {
    method: 'POST',
    pattern: '/compliance/orgs/:orgId/holds',
    summary: 'Place a legal hold (scope org, person or table).',
    async handler(req, ctx, p, actor) {
      const b = z
        .object({ scope: z.enum(['org', 'person', 'table']), reason: z.string().min(10).max(500), personType: personType.optional(), personId: uuid.optional(), schema: z.string().optional(), table: z.string().optional() })
        .parse(req.body);
      return json(201, { id: await placeHold(ctx.db, actor, { orgId: uuid.parse(p.orgId), ...b }) });
    },
  },
  {
    method: 'POST',
    pattern: '/compliance/holds/:holdId/release',
    summary: 'Release a legal hold.',
    async handler(req, ctx, p, actor) {
      const b = z.object({ reason: z.string().min(3).max(500) }).parse(req.body);
      await releaseHold(ctx.db, actor, uuid.parse(p.holdId), b.reason);
      return json(200, { released: true });
    },
  },
  {
    method: 'POST',
    pattern: '/compliance/consents',
    summary: 'Record a consent change (opt-in, opt-out, unknown) for a contact and channel.',
    async handler(req, ctx, _p, actor) {
      const b = z
        .object({
          orgId: uuid, channel, contact: z.string().min(3).max(200), purpose: z.enum(['service', 'promotional', 'both']), status: z.enum(['opted_in', 'opted_out', 'unknown']),
          source: z.string().min(2).max(100), personType: personType.optional(), personId: uuid.optional(), proof: z.record(z.unknown()).optional(), guardianId: uuid.optional(), guardianRelation: z.string().max(50).optional(),
        })
        .parse(req.body);
      return json(201, await recordConsent(ctx.db, req.productRole ?? 'crm_server', actor, b));
    },
  },
  {
    method: 'GET',
    pattern: '/compliance/consents/check',
    summary: 'May we send? ?orgId&channel&contact&purpose. Also returns the current status.',
    async handler(req, ctx, _p, actor) {
      const q = z.object({ orgId: uuid, channel, contact: z.string().min(3), purpose: z.enum(['service', 'promotional']) }).parse(req.query ?? {});
      const role = req.productRole ?? 'crm_server';
      return json(200, { may_send: await maySend(ctx.db, role, actor, q), status: await consentStatus(ctx.db, role, actor, q) });
    },
  },
  {
    method: 'GET',
    pattern: '/compliance/consents/history',
    summary: 'Consent history for a contact. ?orgId&channel&contact',
    async handler(req, ctx, _p, actor) {
      const q = z.object({ orgId: uuid, channel, contact: z.string().min(3) }).parse(req.query ?? {});
      return json(200, await consentHistory(ctx.db, req.productRole ?? 'crm_server', actor, q));
    },
  },
  {
    method: 'GET',
    pattern: '/compliance/orgs/:orgId/data-map',
    summary: 'What is held about people, what an erasure does to each table, and the retention periods that apply.',
    async handler(_req, ctx, p, actor) {
      return json(200, await getDataMap(ctx.db, actor, uuid.parse(p.orgId)));
    },
  },
  {
    method: 'GET',
    pattern: '/compliance/routes',
    summary: 'This list.',
    async handler() {
      return json(200, routes.map((r) => ({ method: r.method, path: r.pattern, summary: r.summary })));
    },
  },
];

function match(pattern: string, path: string): Record<string, string> | null {
  const a = pattern.split('/');
  const b = path.split('/');
  if (a.length !== b.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.startsWith(':')) params[a[i]!.slice(1)] = decodeURIComponent(b[i]!);
    else if (a[i] !== b[i]) return null;
  }
  return params;
}

export async function dispatchCompliance(req: ComplianceRequest, ctx: ComplianceContext = defaultContext()): Promise<ComplianceResponse> {
  const path = (req.path.split('?')[0] ?? '').replace(/^\/api(?=\/)/, '').replace(/\/+$/, '');
  const method = req.method.toUpperCase();
  let pathMatched = false;
  for (const r of routes) {
    const params = match(r.pattern, path);
    if (!params) continue;
    pathMatched = true;
    if (r.method !== method) continue;
    if (!req.actorUserId) return json(401, { error: 'unauthenticated' });
    try {
      return await r.handler(req, ctx, params, req.actorUserId);
    } catch (e) {
      return errorResponse(e);
    }
  }
  return pathMatched ? json(405, { error: 'method_not_allowed' }) : json(404, { error: 'not_found' });
}

function errorResponse(e: unknown): ComplianceResponse {
  if (e instanceof ComplianceError) return json(e.status, { error: e.code, message: e.message, blockers: e.blockers });
  if (e instanceof z.ZodError) return json(400, { error: 'invalid_request', issues: e.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
  const err = e as { code?: string; message?: string };
  if (err.code === '42501') return json(403, { error: 'forbidden', message: String(err.message ?? '') });
  if (err.code === '22023') return json(422, { error: 'invalid', message: String(err.message ?? '') });
  console.error('[compliance] unexpected error', e);
  return json(500, { error: 'internal' });
}

/** The route list, for documentation and tests. */
export const complianceRoutes = routes.map((r) => ({ method: r.method, path: r.pattern, summary: r.summary }));
