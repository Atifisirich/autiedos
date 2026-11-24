/**
 * The small framework-free router every CRM route module registers on. `handle(req)` is what the host (Next route
 * handler, mobile gateway, tests) calls. Route modules: index.ts (public, v1 keys, original staff routes), staff.ts
 * (the working screens), admin.ts (the admin console), data.ts (reports, export, search, import, DSR).
 */
import { asSystem, asUser, type Db, ForbiddenError, NotFoundError, OrgInactiveError, UnauthorizedError, ValidationError } from '../db';
import { requireCtx, verifySession, type Ctx, type Session } from '../auth';
import type { Actor } from '../core';

export interface ApiRequest {
  method: string;
  path: string; // e.g. /leads/123/stage (without the mount prefix)
  query: Record<string, string>;
  headers: Record<string, string | undefined>;
  body: unknown;
  rawBody?: string;
  ip?: string;
}
export interface ApiResponse {
  status: number;
  json?: unknown;
  /** Plain text, CSV or JSON files: `filename` makes the host send it as a download. */
  text?: { body: string; contentType: string; filename?: string };
  /** Set (token) or clear (null) the platform session cookie. */
  setSession?: { token: string; expires_at: string } | null;
}

export type Handler = (a: { req: ApiRequest; p: Record<string, string>; b: any }) => Promise<ApiResponse | unknown>;
interface Route { method: string; pattern: RegExp; keys: string[]; handler: Handler }
const routes: Route[] = [];
export function on(method: string, path: string, handler: Handler) {
  const keys: string[] = [];
  const pattern = new RegExp(`^${path.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)'))}$`);
  routes.push({ method, pattern, keys, handler });
}
export const bearer = (req: ApiRequest) => (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim();
export const ok = (json: unknown, status = 200): ApiResponse => ({ status, json });
export const str = (v: unknown) => String(v ?? '').trim();
export const num = (v: unknown, d = 0) => (Number.isFinite(Number(v)) && String(v ?? '').trim() !== '' ? Number(v) : d);
export const bool = (v: unknown) => v === true || v === 'true' || v === 'on' || v === '1' || v === 1;

export class ApiError extends Error {
  constructor(public status: number, message: string, public extra: Record<string, unknown> = {}) {
    super(message);
  }
}
/** A readable 4xx: the message is shown to the person. */
export const fail = (message: string, status = 422): never => {
  throw new ApiError(status, message);
};

/** The signed-in person and their CRM context. The year and branch pickers travel as headers x-crm-year / x-crm-branch. */
export async function who(req: ApiRequest): Promise<{ s: Session; ctx: Ctx; actor: NonNullable<Actor> }> {
  const s = await verifySession(bearer(req));
  const ctx = await requireCtx(s.userId, { yearId: req.headers['x-crm-year'] || req.query.yearId, branchId: req.headers['x-crm-branch'] || req.query.branchId });
  return { s, ctx, actor: { id: ctx.user.id, name: ctx.user.name } };
}
/** Runs fn as the signed-in person (their role and scope decide what they see and change). */
export async function asMe<T>(req: ApiRequest, fn: (db: Db, ctx: Ctx, actor: NonNullable<Actor>) => Promise<T>): Promise<T> {
  const { s, ctx, actor } = await who(req);
  return asUser(s.userId, ctx.orgId, (db) => fn(db, ctx, actor));
}
/** Runs fn as the org's automation user, after the person's own permission was checked by the caller. */
export async function asOrg<T>(req: ApiRequest, fn: (db: Db, ctx: Ctx, actor: NonNullable<Actor>) => Promise<T>): Promise<T> {
  const { ctx, actor } = await who(req);
  return asSystem(ctx.orgId, (db) => fn(db, ctx, actor));
}
export function need(allowed: boolean, message = 'Your role does not allow this action.'): void {
  if (!allowed) throw new ForbiddenError(message);
}

export async function handle(req: ApiRequest): Promise<ApiResponse> {
  try {
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.pattern.exec(req.path);
      if (!m) continue;
      const p: Record<string, string> = {};
      r.keys.forEach((k, i) => (p[k] = decodeURIComponent(m[i + 1]!)));
      const out = (await r.handler({ req, p, b: (req.body ?? {}) as any })) as ApiResponse | unknown;
      if (out && typeof out === 'object' && 'status' in out && ('json' in out || 'text' in out || 'setSession' in out)) return out as ApiResponse;
      return { status: 200, json: out };
    }
    return { status: 404, json: { error: 'not_found' } };
  } catch (e) {
    const err = e as { status?: number; message?: string; code?: string };
    if (e instanceof OrgInactiveError) return { status: 403, json: { error: 'crm_not_active' } };
    if (e instanceof ApiError) return { status: e.status, json: { error: e.message, ...e.extra } };
    if (err.code === '42501') return { status: 403, json: { error: 'Your role does not allow this action.' } };
    if (err.code === '23505') return { status: 409, json: { error: 'That already exists.' } };
    if (err.code === '22023') return { status: 422, json: { error: err.message ?? 'invalid' } };
    const known = e instanceof ValidationError || e instanceof ForbiddenError || e instanceof NotFoundError || e instanceof UnauthorizedError;
    const status = known ? err.status! : (err.status ?? 500);
    if (status >= 500) console.error('crm api error', e);
    return { status, json: { error: status >= 500 ? 'server_error' : (err.message ?? 'error') } };
  }
}
