import { cache } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { TOKEN_COOKIE, jwtPayload, userClient, core, erp, type Sb } from './db';
import { CAP_MODULES } from './caps';

export const STAFF_ROLES = ['group_admin', 'system_admin', 'principal', 'coordinator', 'class_teacher', 'subject_teacher', 'accounts', 'hr', 'front_office', 'transport', 'librarian', 'store', 'warden', 'counsellor', 'nurse', 'security', 'driver'] as const;
export const ROLE_LABEL: Record<string, string> = {
  group_admin: 'Group admin', system_admin: 'School system admin', principal: 'Principal', coordinator: 'Coordinator', class_teacher: 'Class teacher',
  subject_teacher: 'Subject teacher', accounts: 'Accounts', hr: 'HR', front_office: 'Front office', transport: 'Transport manager', librarian: 'Librarian',
  store: 'Store / canteen', warden: 'Hostel warden', counsellor: 'Counsellor', nurse: 'Nurse', security: 'Gate security', driver: 'Driver / attendant',
  portal: 'Parent and student portal', admin: 'Administrator',
};

export type Perm = { module_key: string; action: string; scope: string };
export type Branch = { id: string; name: string; code: string; working_days: number[] | null; day_starts_at: string | null; city: string | null; boards: string[] | null; state_code: string | null; gst_no: string | null };
export type Year = { id: string; name: string; starts_on: string; ends_on: string; is_current: boolean };

/** Per-request context: the signed-in user, school, role permissions, and the branch / year filters from the header. */
export const getCtx = cache(async () => {
  const store = await cookies();
  const token = store.get(TOKEN_COOKIE)?.value;
  const claims = token ? jwtPayload(token) : null;
  if (!token || !claims?.sub || (claims.exp && claims.exp * 1000 < Date.now())) redirect('/erp/login');
  const sb = userClient(token);
  const uid = claims.sub!;
  const [me, access, org, branches, years, myStaff, flags] = await Promise.all([
    core(sb).from('org_users').select('org_id, kind, display_name, status, home_branch_id').eq('user_id', uid).maybeSingle(),
    core(sb).from('user_product_access').select('role_key').eq('user_id', uid).eq('product_key', 'erp').is('revoked_at', null).limit(1),
    core(sb).from('organizations').select('id, name, slug, kind, branding, settings, time_zone, state, city, gst_no, pan, legal_name, setup_step, setup_completed_at').limit(1).maybeSingle(),
    core(sb).from('branches').select('id, name, code, working_days, day_starts_at, city, boards, state_code, gst_no').eq('active', true).order('name'),
    core(sb).from('academic_years').select('id, name, starts_on, ends_on, is_current').is('deleted_at', null).order('starts_on', { ascending: false }),
    core(sb).from('staff').select('id, first_name, last_name, full_name, branch_id, employee_code, position_id, department_id').eq('user_id', uid).is('deleted_at', null).maybeSingle(),
    erp(sb).from('module_flags').select('module_key, enabled, branch_id').is('deleted_at', null),
  ]);
  if (me.error?.code === 'PGRST301' || (me.error && /JWT/i.test(me.error.message))) redirect('/erp/login?err=' + encodeURIComponent('Your session has expired. Sign in again.'));
  if (!me.data) redirect('/erp/login?err=' + encodeURIComponent('This login has no school membership.'));
  const kind = me.data.kind as string;
  if (kind !== 'staff') redirect('/erp/parent');
  const roleKey = (access.data?.[0]?.role_key as string | undefined) ?? null;
  if (!roleKey) redirect('/erp/login?err=' + encodeURIComponent('Your login has no ERP access. Ask the school administrator.'));
  const role = await core(sb).from('roles').select('id').eq('product_key', 'erp').eq('key', roleKey).maybeSingle();
  const permsRes = role.data ? await core(sb).from('role_permissions').select('module_key, action, scope').eq('role_id', role.data.id) : { data: [] as Perm[] };
  const perms = (permsRes.data ?? []) as Perm[];
  const has = (module: string, action: string) => perms.some((p) => (p.module_key === module || p.module_key === '*') && (p.action === action || p.action === '*'));
  /** ERP capability check: read = view, write = create or edit on any permission module the capability maps to. */
  const can = (cap: string, need: 'read' | 'write' = 'read') => {
    const mods = CAP_MODULES[cap] ?? [cap];
    return mods.some((m) => (need === 'write' ? has(m, 'create') || has(m, 'edit') : has(m, 'view')));
  };
  const canAction = (module: string, action: string) => has(module, action);
  const br = (branches.data ?? []) as Branch[];
  const yrs = (years.data ?? []) as Year[];
  const year = yrs.find((y) => y.id === store.get('year')?.value) ?? yrs.find((y) => y.is_current) ?? yrs[0] ?? null;
  const cookieBranch = store.get('branch')?.value;
  const homeBranch = (me.data.home_branch_id as string | null) ?? null;
  const branchId: string | null = homeBranch ?? (br.some((b) => b.id === cookieBranch) ? cookieBranch! : null);
  const off = new Set(((flags.data ?? []) as { module_key: string; enabled: boolean; branch_id: string | null }[]).filter((f) => !f.enabled && (!f.branch_id || f.branch_id === branchId)).map((f) => f.module_key));
  const moduleOn = (key: string) => !off.has(key);
  const staff = (myStaff.data ?? null) as { id: string; first_name: string; last_name: string | null; full_name: string | null; branch_id: string | null; employee_code: string | null; position_id: string | null; department_id: string | null } | null;
  return {
    sb, token, user: { id: uid }, orgUser: me.data as { org_id: string; kind: string; display_name: string; status: string; home_branch_id: string | null },
    org: (org.data ?? { id: me.data.org_id, name: 'School' }) as { id: string; name: string; slug?: string; kind?: string; branding?: Record<string, string>; settings?: Record<string, unknown>; time_zone?: string; state?: string | null; city?: string | null; gst_no?: string | null; pan?: string | null; legal_name?: string | null; setup_step?: string | null; setup_completed_at?: string | null },
    orgId: me.data.org_id as string, role: roleKey, perms, can, canAction, moduleOn, branches: br, years: yrs, year, branchId, staff,
    name: (me.data.display_name as string) ?? '', isStaff: true,
  };
});
export type Ctx = Awaited<ReturnType<typeof getCtx>>;

/** Stop a page from rendering when the role lacks the capability. */
export async function requireCap(cap: string, need: 'read' | 'write' = 'read') {
  const ctx = await getCtx();
  if (!ctx.can(cap, need)) redirect('/erp?err=' + encodeURIComponent('You do not have access to that page.'));
  return ctx;
}

/** Roles of the ERP product in this school (core.roles). */
export async function erpRoles(sb: Sb) {
  const r = await core(sb).from('roles').select('id, key, name').eq('product_key', 'erp').order('name');
  return (r.data ?? []) as { id: string; key: string; name: string }[];
}
