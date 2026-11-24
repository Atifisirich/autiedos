/**
 * Request context, permission checks and transaction helpers shared by every service.
 *
 * `run(ctx, fn)` opens ONE transaction as the database role os_server with the user's claims, so RLS applies
 * to every statement. Inside it, `sys(fn)` switches the claims to the org's OS system actor for side effects
 * that cross users (system tasks, notifications to others) after the service has checked permission — still
 * bounded by the org and the OS product, and a request either commits completely or not at all.
 * Three checks guard each route: needProduct('os') (subscription + user access), needModule (module flag of
 * the branch) and need / needTarget (OS role permission and scope).
 */
import { makeT, isLang, flagModuleFor, toLocal, type Action, type Lang, type ModuleKey, type PermissionModule, type WorkCalendar } from '@autoed/shared';
import { asUser, ForbiddenError, maybe, one, q, setClaims, systemUserId, type DbUser, type Tx } from './db';

export type ProductKey = 'crm' | 'os' | 'erp';

export interface StaffRow {
  id: string;
  org_id: string;
  branch_id: string | null;
  user_id: string;
  full_name: string;
  first_name: string;
  last_name: string | null;
  status: string;
  email: string | null;
  phone: string | null;
  position_id: string | null;
  department_id: string | null;
  wing_id: string | null;
  reports_to: string | null;
  language: Lang;
  ui_prefs: Record<string, unknown>;
  is_teaching: boolean;
}

export interface Ctx {
  userId: string;
  staff: StaffRow;
  staffId: string;
  orgId: string;
  branchId: string;
  branchIds: string[];
  lang: Lang;
  device: string | null;
  isSuperAdmin: boolean;
  /** 'module.action' -> highest scope rank (1 own .. 6 group) */
  perms: Map<string, number>;
  /** module flags of the active branch */
  modules: Record<string, boolean>;
  /** products the org has AND the user was given (app.user_has_product), read on every request */
  products: ProductKey[];
  /** the org's OS system actor (null when the org has no OS) */
  systemUserId: string | null;
  db: DbUser;
  t: ReturnType<typeof makeT>;
  now: Date;
}

export interface PlatformCtx {
  userId: string;
  isSuperAdmin: true;
  device: string | null;
}

export class UnauthorizedError extends Error {
  status = 401;
  constructor(message = 'unauthorized') {
    super(message);
  }
}

/** Clock override for tests and the seed (OS_NOW=2026-11-16T10:00:00+05:30). */
export function now(): Date {
  return process.env.OS_NOW ? new Date(process.env.OS_NOW) : new Date();
}

export async function loadCtx(userId: string, opts: { branchId?: string | null; device?: string | null; lang?: string | null } = {}): Promise<Ctx> {
  // Runs as the user: the staff row, branches, OS permissions and module flags are what RLS lets them see.
  return asUser({ userId, device: opts.device }, async (c) => {
    const staff = await maybe<StaffRow>(c, `select * from core.staff where user_id = $1 and org_id = app.current_org_id() and deleted_at is null and status in ('active','invited','on_notice')`, [userId]);
    if (!staff) throw new UnauthorizedError('no_staff_profile');
    const products = (await q<{ key: ProductKey }>(c, `select p.key from core.products p where app.user_has_product($1, p.key) order by p.key`, [staff.org_id])).map((r) => r.key);
    const systemUser = products.includes('os') ? await systemUserId(c, staff.org_id) : null;
    if (staff.status === 'invited' && systemUser) {
      // first sign-in of an invited member (system actor: the member may not hold staff.edit)
      await setClaims(c, systemUser, { onBehalfOf: userId });
      await c.query(`update core.staff set status = 'active' where id = $1`, [staff.id]);
      await setClaims(c, userId, { device: opts.device });
    }
    const branchIds = (await one<{ ids: string[] }>(c, `select os.branch_ids_of($1) as ids`, [userId])).ids ?? [];
    const branchId = opts.branchId && branchIds.includes(opts.branchId) ? opts.branchId : staff.branch_id && branchIds.includes(staff.branch_id) ? staff.branch_id : branchIds[0];
    if (!branchId) throw new ForbiddenError('no_branch');
    const permRows = await q<{ module: string; action: string; r: number }>(c, `select module, action, r from os.my_permissions()`);
    const flags = await q<{ module_key: string; enabled: boolean }>(c, `select module_key, enabled from os.module_flags where branch_id = $1 and deleted_at is null`, [branchId]);
    const isSuperAdmin = !!(await maybe(c, `select 1 from core.platform_admins where user_id = $1 and active`, [userId]));
    const lang: Lang = isLang(opts.lang) ? opts.lang : staff.language;
    return {
      userId,
      staff,
      staffId: staff.id,
      orgId: staff.org_id,
      branchId,
      branchIds,
      lang,
      device: opts.device ?? null,
      isSuperAdmin,
      perms: new Map(permRows.map((p) => [`${p.module}.${p.action}`, Number(p.r)])),
      modules: Object.fromEntries(flags.map((f) => [f.module_key, f.enabled])),
      products,
      systemUserId: systemUser,
      db: { userId, staffId: staff.id, device: opts.device ?? null },
      t: makeT(lang),
      now: now(),
    };
  });
}

/** Blocks the API when the org has no active subscription to the product or the user was not given it (plan 4.3). */
export function needProduct(ctx: Ctx, product: ProductKey) {
  if (!ctx.products.includes(product)) throw new ForbiddenError('product_not_available');
}

export function rank(ctx: Ctx, module: PermissionModule, action: Action): number {
  return ctx.perms.get(`${module}.${action}`) ?? 0;
}

export function moduleOn(ctx: Ctx, module: ModuleKey): boolean {
  return ctx.modules[module] !== false;
}

/** Blocks the API when a module is switched off for the active branch (rule 2). */
export function needModule(ctx: Ctx, module: ModuleKey | null) {
  if (module && !moduleOn(ctx, module)) throw new ForbiddenError('module_disabled');
}

/** Coarse check: the user holds module.action at any scope (RLS narrows rows). */
export function need(ctx: Ctx, module: PermissionModule, action: Action, minRank = 1) {
  const flag = flagModuleFor(module);
  if (flag) needModule(ctx, flag);
  if (rank(ctx, module, action) < minRank) throw new ForbiddenError(`missing_permission:${module}.${action}`);
}

/** Fine-grained check against a specific row, via the same SQL function RLS uses. */
export async function needTarget(c: Tx, ctx: Ctx, module: PermissionModule, action: Action, target: { branch_id?: string | null; owner_id?: string | null; department_id?: string | null; wing_id?: string | null }) {
  if (!(await canTarget(c, ctx, module, action, target))) throw new ForbiddenError(`missing_permission:${module}.${action}`);
}

export async function canTarget(c: Tx, ctx: Ctx, module: PermissionModule, action: Action, target: { branch_id?: string | null; owner_id?: string | null; department_id?: string | null; wing_id?: string | null }): Promise<boolean> {
  const r = await one<{ ok: boolean }>(c, `select os.has_permission($1, $2, $3, $4) as ok`, [ctx.userId, module, action, JSON.stringify({ org_id: ctx.orgId, ...target })]);
  return r.ok;
}

export type Sys = <T>(fn: () => Promise<T>) => Promise<T>;

/** One transaction: RLS as the user, `sys` for checked side effects as the org's OS system actor. */
export async function run<T>(ctx: Ctx, fn: (c: Tx, sys: Sys) => Promise<T>): Promise<T> {
  return asUser(ctx.db, async (c) => {
    const sys: Sys = async (f) => {
      if (!ctx.systemUserId) throw new ForbiddenError('product_not_available');
      await setClaims(c, ctx.systemUserId, { onBehalfOf: ctx.userId, device: ctx.device, staffId: ctx.staffId });
      let out: Awaited<ReturnType<typeof f>>;
      try {
        out = await f();
      } catch (e) {
        // the transaction is aborted anyway: keep the original error, do not mask it with the claims restore
        await setClaims(c, ctx.userId, { device: ctx.device, staffId: ctx.staffId }).catch(() => undefined);
        throw e;
      }
      await setClaims(c, ctx.userId, { device: ctx.device, staffId: ctx.staffId });
      return out;
    };
    return fn(c, sys);
  });
}

// ---------------------------------------------------------------- branch calendar & settings
export interface BranchSettings {
  quiet_hours?: { start: string; end: string };
  day_close_time?: string;
  substitution_mode?: 'confirm' | 'auto';
  digest_time?: string;
  coverage_at_risk?: number;
  coverage_critical?: number;
  bot_enabled?: boolean;
  parent_absent_alert?: boolean;
  app_lock?: boolean;
}

export async function branchInfo(c: Tx, branchId: string) {
  return one<{ id: string; org_id: string; name: string; timezone: string; working_days: number[]; settings: BranchSettings; latitude: number | null; longitude: number | null; geofence_radius_m: number }>(
    c,
    `select id, org_id, name, coalesce(time_zone, 'Asia/Kolkata') as timezone, working_days, settings, latitude, longitude, geofence_radius_m from core.branches where id = $1`,
    [branchId],
  );
}

/** Working calendar for a branch: holidays from the school calendar (group + branch layers). */
export async function workCalendar(c: Tx, branchId: string, from?: string, to?: string): Promise<WorkCalendar> {
  const b = await branchInfo(c, branchId);
  const rule = await maybe<{ shift_start: string; shift_end: string }>(c, `select coalesce(settings->>'shift_start', '08:00') as shift_start, coalesce(settings->>'shift_end', '15:30') as shift_end from core.attendance_rules where branch_id = $1 and position_id is null and applies_to = 'staff' and deleted_at is null`, [branchId]);
  const hol = await q<{ d: string }>(
    c,
    `select generate_series(starts_on, ends_on, interval '1 day')::date::text as d from core.calendar_events
     where org_id = $1 and (branch_id is null or branch_id = $2) and layer = 'holiday' and not is_working_day and deleted_at is null
       and ends_on >= coalesce($3::date, '1900-01-01') and starts_on <= coalesce($4::date, '2999-12-31')`,
    [b.org_id, branchId, from ?? null, to ?? null],
  );
  return { workingDays: b.working_days, holidays: hol.map((h) => h.d), dayStart: (rule?.shift_start ?? '08:00').slice(0, 5), dayEnd: (rule?.shift_end ?? '16:00').slice(0, 5), timeZone: b.timezone };
}

export function localToday(ctx: { now: Date }, tz = 'Asia/Kolkata'): string {
  return toLocal(ctx.now, tz).date;
}

/** Staff holding a role in a branch (role holders resolve "by role" targets). */
export async function staffWithRole(c: Tx, orgId: string, roleKey: string, branchId: string | null): Promise<string[]> {
  const rows = await q<{ id: string }>(
    c,
    `select distinct s.id from core.staff s join os.staff_roles sr on sr.staff_id = s.id and sr.deleted_at is null
     join os.roles r on r.id = sr.role_id where s.org_id = $1 and r.key = $2 and s.status = 'active' and s.deleted_at is null
       and ($3::uuid is null or s.branch_id = $3)`,
    [orgId, roleKey, branchId],
  );
  return rows.map((r) => r.id);
}

/**
 * core.files row for an uploaded object path (R9: shared tables reference files by id). Idempotent per path.
 * The object path always starts with the org id (storage policy, plan 4.7).
 */
export async function fileId(c: Tx, orgId: string, path: string, ownerType: string): Promise<string> {
  if (!path.startsWith(`${orgId}/`)) throw new ForbiddenError('bad_path');
  const ex = await maybe<{ id: string }>(c, `select id from core.files where bucket = 'os-files' and storage_path = $1`, [path]);
  if (ex) return ex.id;
  const r = await one<{ id: string }>(
    c,
    `insert into core.files (org_id, bucket, storage_path, file_name, owner_type, product_key, uploaded_by) values ($1, 'os-files', $2, $3, $4, 'os', app.uid()) returning id`,
    [orgId, path, path.split('/').pop() ?? path, ownerType],
  );
  return r.id;
}

/** Active delegate for a manager on a date (PRD 4.2). */
export async function delegateFor(c: Tx, staffId: string, date: string): Promise<string> {
  const d = await maybe<{ delegate_id: string }>(c, `select delegate_id from core.delegations where staff_id = $1 and $2::date between starts_on and ends_on and deleted_at is null order by created_at desc limit 1`, [staffId, date]);
  return d?.delegate_id ?? staffId;
}
