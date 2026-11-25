/**
 * Framework-free route table of the custom records engine: dispatchRecords(req) takes a plain request and returns a plain
 * response (Next.js route apps/web/app/api/records/[...path], tests, a CLI). The caller passes the headers; the platform
 * session (Bearer token or the os_session cookie copied into it) is verified here and every query runs as a product role
 * with that person's claims. Paths are relative to /api/records.
 *
 *   GET    /objects                           visible objects with my access (?archived=1 for management)
 *   POST   /objects                           create (management)
 *   GET    /objects/:key                      definition + access
 *   PATCH  /objects/:key                      change definition / archive (management)
 *   DELETE /objects/:key                      delete an object without records (management)
 *   GET    /objects/:key/records              list: q, state, mine, sort, dir, page, pageSize, f.<field>[.from|.to]
 *   POST   /objects/:key/records              create {data, branch_id?}
 *   GET    /objects/:key/records/:id          record + history + allowed transitions
 *   PATCH  /objects/:key/records/:id          change {data, branch_id?}
 *   DELETE /objects/:key/records/:id          soft delete (POST .../restore to undo)
 *   POST   /objects/:key/records/:id/transition {to, note}
 *   GET    /objects/:key/export.csv           CSV of the filtered list (audited)
 *   GET    /approvals                         custom-record approvals I can decide
 *   POST   /approvals/:id/decide              {ok, comment}
 *   GET    /lookup/:type?q=                   options for person / learner / section / branch / file fields
 *   GET    /meta                              products I manage objects for, roles for permission rules
 */
import { z } from 'zod';
import { verifySession } from '../auth';
import { defaultRecordsDb, type RecordsDb } from './db';
import {
  createObject, createRecord, decideApproval, deleteObject, deleteRecord, exportCsv, getObject, getRecord, listApprovals, listObjects, listRecords,
  listRoles, lookup, managedProducts, transitionRecord, updateObject, updateRecord, type RecordsCtx,
} from './service';
import { RecordsError, type ListQuery, type ProductKey } from './types';

export interface RecordsRequest {
  method: string;
  path: string;
  query?: Record<string, string | undefined>;
  headers?: Record<string, string | undefined>;
  body?: unknown;
}

export interface RecordsResponse {
  status: number;
  json?: unknown;
  text?: { body: string; contentType: string; filename?: string };
}

export interface Principal {
  userId: string;
  products: ProductKey[];
  mustChangePassword?: boolean;
}

export interface RecordsDeps {
  db?: RecordsDb;
  /** Resolves the bearer token to a person (default: the platform session, verifySession). */
  authenticate?: (token: string | null) => Promise<Principal>;
}

async function defaultAuthenticate(token: string | null): Promise<Principal> {
  try {
    const s = await verifySession(token);
    return { userId: s.userId, products: (s.products ?? []).filter((p): p is ProductKey => p === 'crm' || p === 'os' || p === 'erp'), mustChangePassword: s.mustChangePassword };
  } catch {
    throw new RecordsError('unauthorized');
  }
}

type Handler = (ctx: RecordsCtx, p: Record<string, string>, req: RecordsRequest) => Promise<RecordsResponse>;
const ok = (json: unknown, status = 200): RecordsResponse => ({ status, json });
const uuid = z.string().uuid();
const key = z.string().regex(/^[a-z][a-z0-9_]{1,39}$/);

function listQuery(q: Record<string, string | undefined> = {}): ListQuery {
  const filters: Record<string, string> = {};
  for (const [k, v] of Object.entries(q)) if (k.startsWith('f.') && v !== undefined) filters[k.slice(2)] = v;
  return {
    q: q.q, state: q.state || undefined, mine: q.mine === '1' || q.mine === 'true', sort: q.sort || undefined, dir: q.dir === 'asc' ? 'asc' : 'desc',
    page: q.page ? Number(q.page) : undefined, pageSize: q.pageSize ? Number(q.pageSize) : undefined, filters, includeDeleted: q.deleted === '1',
  };
}

const recordBody = z.object({ data: z.record(z.unknown()).optional(), branch_id: uuid.nullable().optional() });

const routes: { method: string; pattern: string; handler: Handler }[] = [
  { method: 'GET', pattern: '/meta', handler: async (ctx) => {
    const manage = await managedProducts(ctx);
    return ok({ products: ctx.products, manage, roles: manage.length ? await listRoles(ctx) : [] });
  } },
  { method: 'GET', pattern: '/objects', handler: async (ctx, _p, req) => ok({ objects: await listObjects(ctx, { includeArchived: req.query?.archived === '1' }) }) },
  { method: 'POST', pattern: '/objects', handler: async (ctx, _p, req) => ok({ object: await createObject(ctx, req.body as never) }, 201) },
  { method: 'GET', pattern: '/objects/:key', handler: async (ctx, p) => ok({ object: await getObject(ctx, key.parse(p.key)) }) },
  { method: 'PATCH', pattern: '/objects/:key', handler: async (ctx, p, req) => ok({ object: await updateObject(ctx, key.parse(p.key), (req.body ?? {}) as never) }) },
  { method: 'DELETE', pattern: '/objects/:key', handler: async (ctx, p) => {
    await deleteObject(ctx, key.parse(p.key));
    return ok({ ok: true });
  } },
  { method: 'GET', pattern: '/objects/:key/records', handler: async (ctx, p, req) => ok(await listRecords(ctx, key.parse(p.key), listQuery(req.query))) },
  { method: 'POST', pattern: '/objects/:key/records', handler: async (ctx, p, req) => {
    const b = recordBody.parse(req.body ?? {});
    return ok({ record: await createRecord(ctx, key.parse(p.key), { data: b.data ?? {}, branch_id: b.branch_id }) }, 201);
  } },
  { method: 'GET', pattern: '/objects/:key/export.csv', handler: async (ctx, p, req) => {
    const f = await exportCsv(ctx, key.parse(p.key), listQuery(req.query));
    return { status: 200, text: { body: f.csv, contentType: 'text/csv; charset=utf-8', filename: f.filename } };
  } },
  { method: 'GET', pattern: '/objects/:key/records/:id', handler: async (ctx, p) => ok(await getRecord(ctx, key.parse(p.key), uuid.parse(p.id))) },
  { method: 'PATCH', pattern: '/objects/:key/records/:id', handler: async (ctx, p, req) => {
    const b = recordBody.parse(req.body ?? {});
    return ok({ record: await updateRecord(ctx, key.parse(p.key), uuid.parse(p.id), b) });
  } },
  { method: 'DELETE', pattern: '/objects/:key/records/:id', handler: async (ctx, p) => {
    await deleteRecord(ctx, key.parse(p.key), uuid.parse(p.id));
    return ok({ ok: true });
  } },
  { method: 'POST', pattern: '/objects/:key/records/:id/restore', handler: async (ctx, p) => {
    await deleteRecord(ctx, key.parse(p.key), uuid.parse(p.id), true);
    return ok({ ok: true });
  } },
  { method: 'POST', pattern: '/objects/:key/records/:id/transition', handler: async (ctx, p, req) => {
    const b = z.object({ to: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/), note: z.string().max(1000).nullable().optional() }).parse(req.body ?? {});
    return ok(await transitionRecord(ctx, key.parse(p.key), uuid.parse(p.id), b.to, b.note));
  } },
  { method: 'GET', pattern: '/approvals', handler: async (ctx) => ok({ approvals: await listApprovals(ctx) }) },
  { method: 'POST', pattern: '/approvals/:id/decide', handler: async (ctx, p, req) => {
    const b = z.object({ ok: z.boolean(), comment: z.string().max(1000).nullable().optional() }).parse(req.body ?? {});
    return ok(await decideApproval(ctx, uuid.parse(p.id), b.ok, b.comment));
  } },
  { method: 'GET', pattern: '/lookup/:type', handler: async (ctx, p, req) => ok({ options: await lookup(ctx, p.type!, req.query?.q ?? '', Number(req.query?.limit ?? 20)) }) },
];

function match(pattern: string, path: string): Record<string, string> | null {
  const a = pattern.split('/').filter(Boolean);
  const b = path.split('/').filter(Boolean);
  if (a.length !== b.length) return null;
  const out: Record<string, string> = {};
  for (let i = 0; i < a.length; i += 1) {
    if (a[i]!.startsWith(':')) out[a[i]!.slice(1)] = decodeURIComponent(b[i]!);
    else if (a[i] !== b[i]) return null;
  }
  return out;
}

export async function dispatchRecords(req: RecordsRequest, deps: RecordsDeps = {}): Promise<RecordsResponse> {
  const path = req.path.replace(/^\/api/, '').replace(/^\/records/, '') || '/';
  let found: { handler: Handler; params: Record<string, string> } | null = null;
  let pathKnown = false;
  for (const r of routes) {
    const p = match(r.pattern, path);
    if (!p) continue;
    pathKnown = true;
    if (r.method === req.method.toUpperCase()) {
      found = { handler: r.handler, params: p };
      break;
    }
  }
  if (!found) return { status: pathKnown ? 405 : 404, json: { error: pathKnown ? 'method_not_allowed' : 'not_found' } };
  try {
    const auth = req.headers?.authorization ?? req.headers?.Authorization;
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
    const who = await (deps.authenticate ?? defaultAuthenticate)(token);
    if (who.mustChangePassword) throw new RecordsError('password_change_required');
    const ctx: RecordsCtx = { db: deps.db ?? defaultRecordsDb(), userId: who.userId, products: who.products };
    return await found.handler(ctx, found.params, req);
  } catch (e) {
    if (e instanceof RecordsError) return { status: e.status, json: { error: e.code, message: e.message, details: e.details } };
    if (e instanceof z.ZodError) return { status: 422, json: { error: 'invalid', details: e.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) } };
    console.error('records route failed', e);
    return { status: 500, json: { error: 'internal' } };
  }
}
