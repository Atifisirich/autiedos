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
import { asUser, asUserIn, ForbiddenError, maybe, q, type ProductRole, type Tx } from '../db';
import { UnauthorizedError, type ProductKey } from '../core';

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
  /** The product whose server login runs the designer's own transaction (designer tables, OS blocks when present). */
  homeProduct: ProductKey;
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
  // School management of ANY product (OS, CRM or ERP): the database rule app.designer_allowed decides (a role holding
  // setup.configure at branch scope or wider in a product the org has), exactly like the RLS of the designer tables.
  return asUser({ userId }, async (c) => {
    const staff = await maybe<{ id: string; org_id: string; branch_id: string | null; language: string | null }>(
      c,
      `select id, org_id, branch_id, language from core.staff where user_id = $1 and org_id = app.current_org_id() and deleted_at is null and status in ('active', 'invited', 'on_notice')`,
      [userId],
    );
    if (!staff) throw new ForbiddenError('designer_management_only');
    if (!(await allowedInDb(c, staff.org_id, true))) throw new ForbiddenError('designer_management_only');
    const products = (await q<{ key: ProductKey }>(c, `select p.key from core.products p where app.user_has_product($1, p.key) order by p.key`, [staff.org_id])).map((r) => r.key);
    if (!products.length) throw new ForbiddenError('designer_management_only');
    const org = await maybe<{ name: string }>(c, `select name from core.organizations where id = $1`, [staff.org_id]);
    const branches = await q<{ id: string; code: string; name: string }>(c, `select id, code, name from core.branches where org_id = $1 and id = any(app.user_branch_ids()) order by name`, [staff.org_id]);
    if (!branches.length) throw new ForbiddenError('no_branch');
    const branch = branches.find((b) => b.id === opts.branchId) ?? branches.find((b) => b.id === staff.branch_id) ?? branches[0]!;
    const lang: Lang = isLang(opts.lang) ? opts.lang : isLang(staff.language) ? staff.language : 'en';
    const actor: DesignerActor = {
      kind: 'org_admin',
      userId,
      orgId: staff.org_id,
      orgName: org?.name ?? '',
      branchId: branch.id,
      branchCode: branch.code,
      branches,
      staffId: staff.id,
      supportSessionId: null,
      readOnly: false,
      products,
      homeProduct: homeProductOf(products),
      lang,
      t: makeT(lang),
    };
    return actor;
  });
}

/** The product whose server login runs the designer's own transaction (OS first, then CRM, then ERP). */
export function homeProductOf(products: ProductKey[]): ProductKey {
  return (['os', 'crm', 'erp'] as const).find((p) => products.includes(p)) ?? 'os';
}

/** The database login of a product. */
export const ROLE_OF: Record<ProductKey, ProductRole> = { os: 'os_server', crm: 'crm_server', erp: 'erp_server' };

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
      homeProduct: homeProductOf(products),
      lang,
      t: makeT(lang),
    };
  });
}

/** Runs fn in one transaction as the actor (RLS + audit as that person, support session included). */
export function asActor<T>(a: DesignerActor, fn: (c: Tx) => Promise<T>): Promise<T> {
  return asUserIn(ROLE_OF[a.homeProduct], { userId: a.userId, staffId: a.staffId }, fn);
}

export function needWrite(a: DesignerActor) {
  if (a.readOnly) throw new ForbiddenError('view_as_is_read_only');
}
