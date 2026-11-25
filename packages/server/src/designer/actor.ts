/**
 * Who is using the designer (DECISIONS 57):
 *
 *   org_admin             the school's management: a staff member holding setup.configure at branch scope or wider
 *                         (the same people as the setup wizard). Runs with their own claims.
 *   relationship_manager  an AutoEd platform admin inside an open support session ("view as", x-view-as header) for
 *                         the school, opened with a reason and a time limit. Runs with THEIR OWN claims: RLS sees the
 *                         support session (app.support_session_id()), so every row change is audited with the session
 *                         id and the AutoEd person, never as a school user. Writing needs a read-write session.
 *
 * Everything else (teachers, other staff, a platform admin without a session) is refused. The database repeats the
 * rule in app.designer_allowed() (RLS on core.design_changesets).
 */
import { isLang, makeT, type Lang } from '@autoed/shared';
import { asUser, ForbiddenError, maybe, q, type Tx } from '../db';
import { loadCtx, rank, UnauthorizedError, type ProductKey } from '../core';

export type AuthorKind = 'org_admin' | 'relationship_manager';

export interface DesignerActor {
  kind: AuthorKind;
  userId: string;
  orgId: string;
  orgName: string;
  /** Active branch (branch-level blocks: checklists, recurring tasks, attendance rules...). */
  branchId: string;
  branchCode: string;
  branches: { id: string; code: string; name: string }[];
  staffId: string | null;
  supportSessionId: string | null;
  /** A read-only support session may look but not plan, publish or undo. */
  readOnly: boolean;
  products: ProductKey[];
  lang: Lang;
  t: ReturnType<typeof makeT>;
}

export interface ActorOptions {
  viewAs?: string | null;
  branchId?: string | null;
  lang?: string | null;
  device?: string | null;
}

async function isPlatformAdmin(userId: string): Promise<boolean> {
  return !!(await asUser({ userId }, (c) => maybe(c, `select 1 from core.platform_admins where user_id = $1 and active`, [userId])));
}

/** Resolves the designer actor for a signed-in user, or throws 403 (401 for an expired support session). */
export async function designerActor(userId: string, opts: ActorOptions = {}): Promise<DesignerActor> {
  if (opts.viewAs) return relationshipManager(userId, opts.viewAs, opts);
  if (await isPlatformAdmin(userId)) throw new ForbiddenError('support_session_required');
  const ctx = await loadCtx(userId, { branchId: opts.branchId ?? null, device: opts.device ?? null, lang: opts.lang ?? null });
  if (rank(ctx, 'setup', 'configure') < 5) throw new ForbiddenError('designer_management_only');
  return asUser({ userId, staffId: ctx.staffId }, async (c) => {
    if (!(await allowedInDb(c, ctx.orgId, true))) throw new ForbiddenError('designer_management_only');
    const org = await maybe<{ name: string }>(c, `select name from core.organizations where id = $1`, [ctx.orgId]);
    const branches = await q<{ id: string; code: string; name: string }>(c, `select id, code, name from core.branches where id = any($1) order by name`, [ctx.branchIds]);
    return {
      kind: 'org_admin',
      userId,
      orgId: ctx.orgId,
      orgName: org?.name ?? '',
      branchId: ctx.branchId,
      branchCode: branches.find((b) => b.id === ctx.branchId)?.code ?? '',
      branches,
      staffId: ctx.staffId,
      supportSessionId: null,
      readOnly: false,
      products: ctx.products,
      lang: ctx.lang,
      t: ctx.t,
    };
  });
}

async function allowedInDb(c: Tx, orgId: string, write: boolean): Promise<boolean> {
  return !!(await maybe<{ ok: boolean }>(c, `select app.designer_allowed($1, $2) as ok`, [orgId, write]))?.ok;
}

async function relationshipManager(userId: string, sessionId: string, opts: ActorOptions): Promise<DesignerActor> {
  if (!(await isPlatformAdmin(userId))) throw new ForbiddenError('support_session_required');
  return asUser({ userId }, async (c) => {
    // the session must be THIS admin's open session (app.support_session_id() is the newest open one)
    const s = await maybe<{ id: string; org_id: string; read_only: boolean; open: boolean }>(
      c,
      `select id, org_id, read_only, (ended_at is null and expires_at > now()) as open from core.support_sessions where id = $1 and platform_user_id = $2`,
      [sessionId, userId],
    );
    if (!s?.open) throw new UnauthorizedError('view_as_expired');
    const current = await maybe<{ id: string | null }>(c, `select app.support_session_id() as id`);
    if (current?.id !== s.id) throw new ForbiddenError('support_session_not_current');
    if (!(await allowedInDb(c, s.org_id, false))) throw new ForbiddenError('support_session_required');
    const org = await maybe<{ name: string }>(c, `select name from core.organizations where id = $1`, [s.org_id]);
    const branches = await q<{ id: string; code: string; name: string }>(c, `select id, code, name from core.branches where org_id = $1 and id = any(app.user_branch_ids()) order by name`, [s.org_id]);
    if (!branches.length) throw new ForbiddenError('no_branch');
    const products = (await q<{ key: ProductKey }>(c, `select p.key from core.products p where app.user_has_product($1, p.key) order by p.key`, [s.org_id])).map((r) => r.key);
    const branch = branches.find((b) => b.id === opts.branchId) ?? branches[0]!;
    const lang: Lang = isLang(opts.lang) ? opts.lang : 'en';
    return {
      kind: 'relationship_manager',
      userId,
      orgId: s.org_id,
      orgName: org?.name ?? '',
      branchId: branch.id,
      branchCode: branch.code,
      branches,
      staffId: null,
      supportSessionId: s.id,
      readOnly: s.read_only,
      products,
      lang,
      t: makeT(lang),
    };
  });
}

/** Runs fn in one transaction as the actor (RLS + audit as that person, support session included). */
export function asActor<T>(a: DesignerActor, fn: (c: Tx) => Promise<T>): Promise<T> {
  return asUser({ userId: a.userId, staffId: a.staffId }, fn);
}

export function needWrite(a: DesignerActor) {
  if (a.readOnly) throw new ForbiddenError('view_as_is_read_only');
}
