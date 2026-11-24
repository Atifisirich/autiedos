/**
 * Route table of the platform admin console, framework free (the Next.js catch-all calls dispatchAdmin()).
 *
 * Every route except /health and the three /auth routes is an admin route: the console session is verified, then the
 * request runs in ONE transaction as database role platform_admin_server with the admin's claims, and the database
 * itself must answer app.is_platform_admin() = true before the handler runs (see db.ts). Writes are audited by the
 * row triggers and by a named admin.* event written through app.admin_log_event.
 */
import { ZodError, type ZodTypeAny } from 'zod';
import { AdminError, fromPg, unauthorized, forbidden } from './errors';
import { resolveDeps, type AdminDeps } from './deps';
import type { Tx } from './db';
import { q } from './db';
import * as S from './schemas';
import * as clients from './clients';
import * as subs from './subscriptions';
import * as users from './users';
import * as support from './support';
import * as billing from './billing';
import * as audit from './audit';
import { needUuid } from './util';

export interface AdminRequest {
  method: string;
  /** Path below /api/admin, e.g. /clients/123 */
  path: string;
  query: Record<string, string>;
  headers: Record<string, string | undefined>;
  body: unknown;
  ip?: string;
}

export interface AdminResponse {
  status: number;
  json?: unknown;
  /** Set (object) or clear (null) the console session cookie. */
  setSession?: { token: string; expires_at: string } | null;
}

interface HandlerArgs {
  c: Tx;
  userId: string;
  p: Record<string, string>;
  b: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  q: Record<string, string>;
  deps: AdminDeps;
}
interface PublicArgs {
  p: Record<string, string>;
  b: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  req: AdminRequest;
  deps: AdminDeps;
}
interface Route {
  method: string;
  path: string;
  pattern: RegExp;
  keys: string[];
  body?: ZodTypeAny;
  query?: ZodTypeAny;
  handler?: (a: HandlerArgs) => Promise<unknown>;
  public?: (a: PublicArgs) => Promise<AdminResponse | unknown>;
}

const routes: Route[] = [];
function compile(path: string) {
  const keys: string[] = [];
  const pattern = new RegExp(`^${path.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)'))}$`);
  return { pattern, keys };
}
const admin = (method: string, path: string, handler: Route['handler'], opts: { body?: ZodTypeAny; query?: ZodTypeAny } = {}) => routes.push({ method, path, ...compile(path), handler, ...opts });
const open = (method: string, path: string, h: Route['public'], body?: ZodTypeAny) => routes.push({ method, path, ...compile(path), public: h, body });

/** Every route, for tests that must prove each one refuses non-admins. */
export function listAdminRoutes(): { method: string; path: string; public: boolean }[] {
  return routes.map((r) => ({ method: r.method, path: r.path, public: !!r.public }));
}

const id = (p: Record<string, string>, k: string) => needUuid(p[k]);

// ---------------------------------------------------------------- public: health and sign-in
const buckets = new Map<string, { tokens: number; at: number }>();
function rateOk(key: string, perMinute: number): boolean {
  const now = Date.now();
  const b = buckets.get(key) ?? { tokens: perMinute, at: now };
  b.tokens = Math.min(perMinute, b.tokens + ((now - b.at) / 60000) * perMinute);
  b.at = now;
  const ok = b.tokens >= 1;
  if (ok) b.tokens -= 1;
  buckets.set(key, b);
  return ok;
}

/** Proves the person is a platform admin (database check) and returns the cookie session. */
async function signIn(deps: AdminDeps, userId: string): Promise<AdminResponse> {
  const name = await deps.db.tx(userId, async (c) => (await q<{ name: string }>(c, `select name from core.platform_admins where user_id = $1`, [userId]))[0]?.name ?? '');
  const session = await deps.auth.issue(userId);
  return { status: 200, json: { user_id: userId, name, expires_at: session.expires_at }, setSession: session };
}

open('GET', '/health', async () => ({ ok: true }));
open(
  'POST',
  '/auth/session',
  async ({ b, req, deps }) => {
    if (!rateOk(`admin-login:${req.ip}`, 20)) return { status: 429, json: { error: 'rate_limited' } };
    return signIn(deps, await deps.auth.verifyProviderToken(b.accessToken));
  },
  S.providerSession,
);
open(
  'POST',
  '/auth/dev-login',
  async ({ b, req, deps }) => {
    if (!deps.auth.devLoginEnabled()) return { status: 404, json: { error: 'not_found' } };
    if (!rateOk(`admin-login:${req.ip}`, 20)) return { status: 429, json: { error: 'rate_limited' } };
    const uid = await deps.db.anon(async (c) => (await c.query(`select app.admin_dev_login_user($1) as id`, [b.email])).rows[0].id as string | null);
    if (!uid) throw unauthorized('unknown_user');
    return signIn(deps, uid);
  },
  S.devLogin,
);
open('POST', '/auth/logout', async () => ({ status: 200, json: { ok: true }, setSession: null }));

// ---------------------------------------------------------------- me, overview
admin('GET', '/me', async ({ c, userId }) => {
  const me = (await q<{ name: string }>(c, `select name from core.platform_admins where user_id = $1`, [userId]))[0];
  return { user_id: userId, name: me?.name ?? '', view_as: await support.currentViewAs(c) };
});
admin('GET', '/overview', ({ c, deps }) => clients.overview(c, deps));

// ---------------------------------------------------------------- clients
admin('GET', '/clients', ({ c, deps, q: query }) => clients.listClients(c, deps, S.clientsQuery.parse(query)));
admin('POST', '/clients', ({ c, deps, b }) => clients.createClient(c, deps, b), { body: S.clientCreate });
admin('GET', '/clients/:id', ({ c, deps, p }) => clients.getClient(c, deps, id(p, 'id')));
admin('PATCH', '/clients/:id', ({ c, p, b }) => clients.patchClient(c, id(p, 'id'), b), { body: S.clientPatch });
admin('POST', '/clients/:id/suspend', ({ c, p, b }) => clients.suspendClient(c, id(p, 'id'), b.reason), { body: S.reasonOnly });
admin('POST', '/clients/:id/reactivate', ({ c, p, b }) => clients.reactivateClient(c, id(p, 'id'), b.reason), { body: S.reasonOnly });
admin('POST', '/clients/:id/branches', ({ c, p, b }) => clients.saveBranch(c, id(p, 'id'), null, b), { body: S.branchSave });
admin('PATCH', '/clients/:id/branches/:branchId', ({ c, p, b }) => clients.saveBranch(c, id(p, 'id'), id(p, 'branchId'), b), { body: S.branchSave });
admin('PUT', '/clients/:id/branch-products', ({ c, p, b }) => subs.setBranchProduct(c, id(p, 'id'), b), { body: S.branchProduct });

// ---------------------------------------------------------------- subscriptions
admin('GET', '/clients/:id/subscriptions', ({ c, p }) => subs.listSubscriptions(c, id(p, 'id')));
admin('POST', '/clients/:id/subscriptions', ({ c, deps, p, b }) => subs.addSubscription(c, deps, id(p, 'id'), b), { body: S.subscriptionCreate });
admin('PATCH', '/clients/:id/subscriptions/:product', ({ c, p, b }) => subs.patchSubscription(c, id(p, 'id'), p.product!, b), { body: S.subscriptionPatch });
admin('POST', '/clients/:id/subscriptions/:product/transition', ({ c, deps, p, b }) => subs.transition(c, deps, id(p, 'id'), p.product!, b), { body: S.subscriptionTransition });
admin('POST', '/clients/:id/subscriptions/:product/restart', ({ c, deps, p, b }) => subs.restart(c, deps, id(p, 'id'), p.product!, b), { body: S.subscriptionRestart });
admin('POST', '/billing/tick', ({ c, deps }) => subs.tickAll(c, deps));

// ---------------------------------------------------------------- users, product access, preview
admin('GET', '/clients/:id/users', ({ c, p }) => users.listUsers(c, id(p, 'id')));
admin('GET', '/clients/:id/roles', ({ c, p }) => users.listRoles(c, id(p, 'id')));
admin('POST', '/clients/:id/users', ({ c, deps, p, b }) => users.inviteUser(c, deps, id(p, 'id'), b), { body: S.userInvite });
admin('POST', '/clients/:id/users/:uid/lock', ({ c, p, b }) => users.setLock(c, id(p, 'id'), id(p, 'uid'), b), { body: S.userLock });
admin('POST', '/clients/:id/users/:uid/force-password-reset', ({ c, p, b }) => users.setForceReset(c, id(p, 'id'), id(p, 'uid'), b), { body: S.userForceReset });
admin('POST', '/clients/:id/users/:uid/status', ({ c, p, b }) => users.setStatus(c, id(p, 'id'), id(p, 'uid'), b), { body: S.userStatus });
admin('PUT', '/clients/:id/users/:uid/access', ({ c, p, b }) => users.setAccess(c, id(p, 'id'), id(p, 'uid'), b), { body: S.userAccess });
admin('DELETE', '/clients/:id/users/:uid/access/:product', ({ c, p }) => users.revokeAccess(c, id(p, 'id'), id(p, 'uid'), p.product!));
admin('GET', '/clients/:id/users/:uid/preview', ({ c, deps, p }) => users.entitlementPreview(c, deps, id(p, 'id'), id(p, 'uid')));

// ---------------------------------------------------------------- support ("view as")
admin('POST', '/clients/:id/view-as', ({ c, deps, p, b }) => support.startViewAs(c, deps, id(p, 'id'), b), { body: S.viewAsStart });
admin('POST', '/view-as/end', ({ c }) => support.endViewAs(c));
admin('GET', '/view-as/current', ({ c }) => support.currentViewAs(c));
admin('GET', '/clients/:id/support-sessions', ({ c, p }) => support.listSupportSessions(c, id(p, 'id')));
admin('GET', '/support-sessions', ({ c }) => support.listSupportSessions(c, null));

// ---------------------------------------------------------------- billing
admin('GET', '/plans', ({ c }) => billing.listPlans(c));
admin('PUT', '/plans/:key', ({ c, p, b }) => billing.upsertPlan(c, p.key!, b), { body: S.planUpsert });
admin('GET', '/clients/:id/billing', ({ c, deps, p }) => billing.clientBilling(c, deps, id(p, 'id')));
admin('PUT', '/clients/:id/billing-account', ({ c, p, b }) => billing.saveBillingAccount(c, id(p, 'id'), b), { body: S.billingAccountInput });
admin('GET', '/clients/:id/invoice-suggestion', ({ c, p }) => billing.invoiceSuggestion(c, id(p, 'id')));
admin('POST', '/clients/:id/invoices', ({ c, deps, p, b }) => billing.createInvoice(c, deps, id(p, 'id'), b), { body: S.invoiceCreate });
admin('GET', '/invoices/:invoiceId', ({ c, p }) => billing.getInvoice(c, id(p, 'invoiceId')));
admin('POST', '/invoices/:invoiceId/void', ({ c, p, b }) => billing.voidDraft(c, id(p, 'invoiceId'), b.reason), { body: S.reasonOnly });

// ---------------------------------------------------------------- audit
admin('GET', '/audit', ({ c, q: query }) => audit.queryAudit(c, S.auditQuery.parse(query)));

// ---------------------------------------------------------------- dispatch
function bearer(req: AdminRequest): string | null {
  const a = req.headers.authorization;
  if (a?.startsWith('Bearer ')) return a.slice(7);
  return null;
}

function errorResponse(e: unknown): AdminResponse {
  if (e instanceof ZodError) return { status: 422, json: { error: 'validation_failed', details: e.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) } };
  if (e instanceof AdminError) return { status: e.status, json: { error: e.code, details: e.details } };
  const mapped = fromPg(e as { code?: string; message?: string; constraint?: string });
  if (mapped) return { status: mapped.status, json: { error: mapped.code, details: mapped.details } };
  console.error('[admin] unhandled', e);
  return { status: 500, json: { error: 'internal_error' } };
}

/** Handles one console request. `deps` is for tests; the web route uses the environment defaults. */
export async function dispatchAdmin(req: AdminRequest, over?: Partial<AdminDeps>): Promise<AdminResponse> {
  const method = req.method.toUpperCase();
  const path = req.path.replace(/\/+$/, '') || '/';
  let hit: { route: Route; p: Record<string, string> } | null = null;
  for (const route of routes) {
    if (route.method !== method) continue;
    const m = path.match(route.pattern);
    if (!m) continue;
    const p: Record<string, string> = {};
    route.keys.forEach((k, i) => (p[k] = decodeURIComponent(m[i + 1]!)));
    hit = { route, p };
    break;
  }
  if (!hit) return { status: 404, json: { error: 'not_found' } };
  const { route, p } = hit;
  try {
    const deps = resolveDeps(over);
    if (route.public) {
      const body = route.body ? route.body.parse(req.body ?? {}) : req.body;
      const res = await route.public({ p, b: body, req, deps });
      if (res && typeof res === 'object' && 'status' in res && typeof (res as AdminResponse).status === 'number') return res as AdminResponse;
      return { status: 200, json: res };
    }
    const session = await deps.auth.verify(bearer(req));
    // Cookie sessions are SameSite=Lax; this header makes a cross-site form post fail even if that ever changes.
    if (method !== 'GET' && req.headers['x-admin-client'] !== '1') throw forbidden('missing_client_header');
    // The admin check happens inside tx() before the callback runs, so a non-admin never reaches validation either.
    const out = await deps.db.tx(session.userId, (c) => route.handler!({ c, userId: session.userId, p, b: route.body ? route.body.parse(req.body ?? {}) : req.body, q: req.query, deps }));
    return { status: 200, json: out === undefined ? { ok: true } : out };
  } catch (e) {
    return errorResponse(e);
  }
}
