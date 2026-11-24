/**
 * Super admin console (Digivate only, PRD 8.5) and per-user platform services: profile,
 * notification inbox and preferences, devices (remote sign-out), uploads.
 */
import { randomUUID } from 'node:crypto';
import { NOTIFICATION_EVENTS, UPLOAD_LIMITS, monthKey, type PresetKey } from '@autoed/shared';
import { ForbiddenError, NotFoundError, ValidationError, asService, insert, maybe, one, q, update } from '../db';
import { run, now, type Ctx } from '../core';
import { applyPreset } from '../presets';
import { authUser } from '../seed/demo';
import { signedDownloadUrl, signedUploadUrl } from '../adapters/channels';
import { loadGlobalCurriculum } from '../curriculum';
import { notify } from '../notify';

// ---------------------------------------------------------------- super admin
export async function requireSuperAdmin(userId: string) {
  const ok = await asService((c) => maybe(c, `select 1 from core.platform_admins where user_id = $1 and deleted_at is null`, [userId]));
  if (!ok) throw new ForbiddenError('super_admin_only');
}

export async function adminOverview(userId: string) {
  await requireSuperAdmin(userId);
  return asService(async (c) => {
    const period = monthKey(now());
    const orgs = await q(c, `select o.id, o.name, o.slug, o.setup_step, o.created_at, (select count(*)::int from core.branches b where b.org_id = o.id) as branches, (select count(*)::int from core.staff s where s.org_id = o.id and s.status = 'active') as staff from core.organizations o where o.deleted_at is null order by o.created_at desc`);
    const credits = await q(c, `select b.id as branch_id, b.name as branch, o.name as org, p.name as plan, coalesce(sum(l.credits) filter (where l.credits > 0 and l.period = $1), 0) as granted, coalesce(-sum(l.credits) filter (where l.credits < 0 and l.period = $1), 0) as used, coalesce(sum(l.provider_cost) filter (where l.period = $1), 0) as provider_cost from core.branches b join core.organizations o on o.id = b.org_id left join public.branch_subscriptions bs on bs.branch_id = b.id and bs.status = 'active' left join public.plans p on p.id = bs.plan_id left join public.ai_credit_ledger l on l.branch_id = b.id group by b.id, b.name, o.name, p.name order by o.name, b.name`, [period]);
    const whatsapp = await q(c, `select o.name as org, b.name as branch, count(m.id)::int as messages, coalesce(sum(m.units), 0)::int as units from public.message_usage m join core.organizations o on o.id = m.org_id left join core.branches b on b.id = m.branch_id where to_char(m.created_at, 'YYYY-MM') = $1 group by 1, 2 order by messages desc`, [period]);
    const topups = await q(c, `select r.*, b.name as branch, o.name as org from public.credit_topup_requests r join core.branches b on b.id = r.branch_id join core.organizations o on o.id = r.org_id where r.status = 'pending' order by r.created_at`);
    const support = await q(c, `select t.*, o.name as org, s.full_name from core.support_tickets t join core.organizations o on o.id = t.org_id left join core.staff s on s.id = t.staff_id where t.status <> 'closed' order by t.created_at desc limit 100`);
    const unanswered = await q(c, `select c.id, c.language, c.messages, c.status, c.created_at, o.name as org from os.bot_conversations c join core.organizations o on o.id = c.org_id where c.status in ('unanswered','escalated') order by c.created_at desc limit 100`);
    const poorly = await q(c, `select f.question, f.comment, f.created_at, o.name as org from os.bot_feedback f join core.organizations o on o.id = f.org_id where f.rating = -1 order by f.created_at desc limit 100`);
    const plans = await q(c, `select * from public.plans order by monthly_credits`);
    const costs = await q(c, `select * from public.ai_action_costs order by action`);
    const curriculum = await q(c, `select key, syllabus_year, is_latest, count(*) over (partition by key)::int as versions from os.curriculum_boards where org_id is null order by key, syllabus_year desc`);
    const kb = await q(c, `select slug, array_agg(language order by language) as languages from os.kb_articles where org_id is null and deleted_at is null group by slug order by slug`);
    const viewAs = await q(c, `select v.*, o.name as org from public.view_as_sessions v join core.organizations o on o.id = v.org_id order by v.created_at desc limit 50`);
    return { period, orgs, credits, whatsapp, topups, support, unanswered, poorly_rated: poorly, plans, costs, curriculum, kb, view_as: viewAs };
  });
}

/** Creates a school group with its first branch and admin (invited; no self sign-up). */
export async function createOrganization(userId: string, input: { name: string; slug: string; preset_key: PresetKey; branch_name: string; branch_code: string; admin_name: string; admin_email: string; admin_phone?: string; plan_key: string }) {
  await requireSuperAdmin(userId);
  return asService(async (c) => {
    if (await maybe(c, `select 1 from core.organizations where slug = $1`, [input.slug])) throw new ValidationError('slug_taken');
    const org = await insert<{ id: string }>(c, 'core.organizations', { name: input.name, slug: input.slug, preset_key: input.preset_key, setup_step: 0 });
    const branch = await insert<{ id: string }>(c, 'core.branches', { org_id: org.id, name: input.branch_name, code: input.branch_code });
    await applyPreset(c, org.id, branch.id, input.preset_key);
    const plan = await one<{ id: string }>(c, `select id from public.plans where key = $1`, [input.plan_key]);
    await insert(c, 'branch_subscriptions', { org_id: org.id, branch_id: branch.id, plan_id: plan.id, starts_on: new Date().toISOString().slice(0, 10) });
    const pos = await one<{ id: string; default_role_id: string }>(c, `select id, default_role_id from core.positions where org_id = $1 and key = 'director'`, [org.id]);
    const authId = await authUser(c, input.admin_email, input.admin_phone ?? `+910000${Math.floor(Math.random() * 1e6)}`);
    const staff = await insert<{ id: string }>(c, 'core.staff', { org_id: org.id, branch_id: null, user_id: authId, full_name: input.admin_name, email: input.admin_email, phone: input.admin_phone ?? null, employee_code: 'ADMIN1', position_id: pos.id, status: 'invited', is_teaching: false });
    await insert(c, 'os.staff_roles', { org_id: org.id, staff_id: staff.id, role_id: pos.default_role_id });
    return { org_id: org.id, branch_id: branch.id, admin_staff_id: staff.id };
  });
}

export async function adminSetModule(userId: string, input: { branch_id: string; module_key: string; enabled: boolean }) {
  await requireSuperAdmin(userId);
  return asService(async (c) => {
    const b = await one<{ org_id: string }>(c, `select org_id from core.branches where id = $1`, [input.branch_id]);
    await c.query(`insert into os.module_flags (org_id, branch_id, module_key, enabled) values ($1,$2,$3,$4) on conflict (branch_id, module_key) do update set enabled = excluded.enabled`, [b.org_id, input.branch_id, input.module_key, input.enabled]);
    return { ok: true };
  });
}

/** Super admin adds credits (optionally approving a school's request). Generation resumes at once. */
export async function adminTopup(userId: string, input: { branch_id: string; credits: number; note?: string; request_id?: string }) {
  await requireSuperAdmin(userId);
  return asService(async (c) => {
    const b = await one<{ org_id: string }>(c, `select org_id from core.branches where id = $1`, [input.branch_id]);
    await insert(c, 'ai_credit_ledger', { org_id: b.org_id, branch_id: input.branch_id, kind: 'topup', period: monthKey(now()), credits: input.credits, note: input.note ?? 'Top-up' });
    if (input.request_id) await c.query(`update public.credit_topup_requests set status = 'approved' where id = $1`, [input.request_id]);
    const admins = await q<{ id: string }>(c, `select s.id from core.staff s join os.staff_roles sr on sr.staff_id = s.id join os.roles r on r.id = sr.role_id where s.branch_id = $1 and r.key in ('principal','admin_officer')`, [input.branch_id]);
    await notify(c, { orgId: b.org_id, branchId: input.branch_id, staffIds: admins.map((a) => a.id), event: 'credits.warning', titleKey: 'notif.credits.topup', vars: { credits: input.credits }, link: '/os/ai-credits' });
    return { ok: true };
  });
}

export async function adminSetCost(userId: string, input: { action: string; credits: number; daily_fair_use?: number | null }) {
  await requireSuperAdmin(userId);
  return asService((c) => c.query(`update public.ai_action_costs set credits = $2, daily_fair_use = coalesce($3, daily_fair_use) where action = $1`, [input.action, input.credits, input.daily_fair_use ?? null]).then(() => ({ ok: true })));
}

export async function adminSetPlan(userId: string, input: { key: string; name: string; monthly_credits: number; carry_forward: boolean; whatsapp_included: number }) {
  await requireSuperAdmin(userId);
  return asService((c) => insert(c, 'plans', input, { onConflict: '(key) do update set name = excluded.name, monthly_credits = excluded.monthly_credits, carry_forward = excluded.carry_forward, whatsapp_included = excluded.whatsapp_included' }));
}

/** Loads a newer syllabus year; schools are told and choose when to move. */
export async function adminCurriculumUpdate(userId: string) {
  await requireSuperAdmin(userId);
  return asService(async (c) => {
    const res = await loadGlobalCurriculum(c);
    if (res.boards) {
      const heads = await q<{ id: string; org_id: string }>(c, `select s.id, s.org_id from core.staff s join os.staff_roles sr on sr.staff_id = s.id join os.roles r on r.id = sr.role_id where r.key in ('academic_coordinator','principal')`);
      for (const h of heads) await notify(c, { orgId: h.org_id, branchId: null, staffIds: [h.id], event: 'plan.review', titleKey: 'notif.curriculum.newYear', link: '/os/lesson-plans/library' });
    }
    return res;
  });
}

/** Time-limited "view as" access that is logged and visible to the school. */
export async function startViewAs(userId: string, input: { org_id: string; reason: string; minutes: number }) {
  await requireSuperAdmin(userId);
  return asService(async (c) => {
    const s = await insert<{ id: string; expires_at: string }>(c, 'view_as_sessions', { org_id: input.org_id, admin_user_id: userId, reason: input.reason, expires_at: new Date(now().getTime() + input.minutes * 60000).toISOString() });
    const target = await maybe<{ user_id: string }>(c, `select s.user_id from core.staff s join os.staff_roles sr on sr.staff_id = s.id join os.roles r on r.id = sr.role_id where s.org_id = $1 and r.key in ('director','chairman','principal') and s.status in ('active','invited') order by case r.key when 'director' then 1 when 'chairman' then 2 else 3 end limit 1`, [input.org_id]);
    if (!target) throw new NotFoundError('no_admin_to_view_as');
    return { session_id: s.id, expires_at: s.expires_at, as_user_id: target.user_id };
  });
}

export async function viewAsLog(ctx: Ctx) {
  return run(ctx, async (c, sys) => sys(() => q(c, `select v.reason, v.starts_at, v.expires_at, p.name as admin from public.view_as_sessions v left join core.platform_admins p on p.user_id = v.admin_user_id where v.org_id = $1 order by v.starts_at desc`, [ctx.orgId])));
}

export async function closeSupportTicket(userId: string, id: string) {
  await requireSuperAdmin(userId);
  return asService((c) => update(c, 'core.support_tickets', id, { status: 'closed' }));
}

// ---------------------------------------------------------------- per-user
export async function me(ctx: Ctx) {
  return run(ctx, async (c) => {
    const org = await one(c, `select id, name, logo_url, branding, setup_step, setup_completed_at from core.organizations where id = $1`, [ctx.orgId]);
    const branches = await q(c, `select id, name, code, settings, latitude, longitude, geofence_radius_m from core.branches where id = any($1) order by name`, [ctx.branchIds]);
    const roles = await q<{ key: string; name: string }>(c, `select r.key, r.name from os.staff_roles sr join os.roles r on r.id = sr.role_id where sr.staff_id = $1 and sr.deleted_at is null`, [ctx.staffId]);
    const terminology = await q<{ term_key: string; value: Record<string, string> }>(c, `select term_key, value from core.terminology where org_id = $1 and (branch_id is null or branch_id = $2) and deleted_at is null order by branch_id nulls first`, [ctx.orgId, ctx.branchId]);
    return {
      staff: { id: ctx.staffId, full_name: ctx.staff.full_name, email: ctx.staff.email, language: ctx.staff.language, ui_prefs: ctx.staff.ui_prefs, is_teaching: ctx.staff.is_teaching, department_id: ctx.staff.department_id, wing_id: ctx.staff.wing_id, branch_id: ctx.staff.branch_id },
      org,
      branch_id: ctx.branchId,
      branches,
      roles,
      permissions: Object.fromEntries(ctx.perms),
      modules: ctx.modules,
      terminology: Object.fromEntries(terminology.map((t) => [t.term_key, t.value])),
      is_super_admin: ctx.isSuperAdmin,
      lang: ctx.lang,
    };
  });
}

export async function updateProfile(ctx: Ctx, input: { language?: 'en' | 'hi' | 'te'; ui_prefs?: Record<string, unknown> }) {
  return run(ctx, async (c, sys) => sys(() => update(c, 'core.staff', ctx.staffId, { language: input.language, ui_prefs: input.ui_prefs ? { ...ctx.staff.ui_prefs, ...input.ui_prefs } : undefined })));
}

export async function inbox(ctx: Ctx, opts: { unread?: boolean; limit?: number }) {
  return run(ctx, async (c) => q(c, `select id, event_key, title, body, link, priority, read_at, created_at, data from core.notifications where staff_id = $1 and deliver_after <= now() and ($2 = false or read_at is null) order by created_at desc limit $3`, [ctx.staffId, !!opts.unread, Math.min(opts.limit ?? 100, 300)]));
}

export async function markRead(ctx: Ctx, ids: string[] | 'all') {
  return run(ctx, async (c) => {
    if (ids === 'all') await c.query(`update core.notifications set read_at = now() where staff_id = $1 and read_at is null`, [ctx.staffId]);
    else await c.query(`update core.notifications set read_at = now() where staff_id = $1 and id = any($2) and read_at is null`, [ctx.staffId, ids]);
    return { ok: true };
  });
}

/** Users can mute only the categories the school marks optional. */
export async function notificationPrefs(ctx: Ctx) {
  return run(ctx, async (c) => {
    const rules = await q<{ event_key: string; optional: boolean; channels: string[] }>(c, `select event_key, optional, channels from core.notification_rules where org_id = $1 and deleted_at is null and enabled`, [ctx.orgId]);
    const prefs = await q<{ event_key: string; muted: boolean }>(c, `select event_key, muted from core.notification_prefs where staff_id = $1 and deleted_at is null`, [ctx.staffId]);
    const all = rules.length ? rules : NOTIFICATION_EVENTS.map((e) => ({ event_key: e.key, optional: e.optional, channels: e.channels }));
    return all.map((r) => ({ ...r, muted: prefs.find((p) => p.event_key === r.event_key)?.muted ?? false }));
  });
}

export async function setNotificationPref(ctx: Ctx, input: { event_key: string; muted: boolean }) {
  return run(ctx, async (c) => {
    const rule = await maybe<{ optional: boolean }>(c, `select optional from core.notification_rules where org_id = $1 and event_key = $2`, [ctx.orgId, input.event_key]);
    if (rule && !rule.optional && input.muted) throw new ValidationError('not_optional');
    await c.query(`insert into core.notification_prefs (org_id, branch_id, staff_id, event_key, muted) values ($1,$2,$3,$4,$5) on conflict (staff_id, event_key) do update set muted = excluded.muted, deleted_at = null`, [ctx.orgId, ctx.branchId, ctx.staffId, input.event_key, input.muted]);
    return { ok: true };
  });
}

export async function registerDevice(ctx: Ctx, input: { token: string; platform: 'android' | 'ios' | 'web'; device_name?: string }) {
  return run(ctx, async (c, sys) => sys(() => insert(c, 'core.device_tokens', { org_id: ctx.orgId, branch_id: ctx.branchId, staff_id: ctx.staffId, token: input.token, platform: input.platform, device_name: input.device_name ?? null, last_seen_at: new Date().toISOString(), revoked_at: null }, { onConflict: '(token) do update set staff_id = excluded.staff_id, last_seen_at = now(), revoked_at = null, device_name = excluded.device_name' })));
}

export async function devices(ctx: Ctx) {
  return run(ctx, async (c) => q(c, `select id, platform, device_name, last_seen_at, revoked_at, token like 'session:%' as is_session from core.device_tokens where staff_id = $1 order by last_seen_at desc`, [ctx.staffId]));
}

/** Remote sign-out: revoking a session device ends that session on its next request. */
export async function revokeDevice(ctx: Ctx, id: string) {
  return run(ctx, async (c) => {
    const r = await c.query(`update core.device_tokens set revoked_at = now() where id = $1 and staff_id = $2`, [id, ctx.staffId]);
    if (!r.rowCount) throw new NotFoundError();
    return { ok: true };
  });
}

// ---------------------------------------------------------------- uploads
export async function uploadUrl(ctx: Ctx, input: { purpose: keyof typeof UPLOAD_LIMITS; file_name: string; mime: string; size_bytes: number }) {
  const lim = UPLOAD_LIMITS[input.purpose];
  if (input.size_bytes > lim.max) throw new ValidationError('file_too_large', { max: lim.max });
  if (!lim.mimes.test(input.mime)) throw new ValidationError('file_type_not_allowed');
  const safe = input.file_name.replace(/[^\w.-]+/g, '_').slice(-80);
  const owner = input.purpose === 'selfie' ? `/${ctx.staffId}` : '';
  const path = `${ctx.orgId}/${input.purpose}${owner}/${monthKey(now())}/${randomUUID()}-${safe}`;
  return { path, ...(await signedUploadUrl(path)) };
}

/** Signed download URL. Files are private per organisation; selfies only to attendance managers or the owner. */
export async function downloadUrl(ctx: Ctx, path: string) {
  if (!path.startsWith(`${ctx.orgId}/`)) throw new ForbiddenError();
  const parts = path.split('/');
  if (parts[1] === 'selfie' && parts[2] !== ctx.staffId && (ctx.perms.get('staff_attendance.view') ?? 0) < 3) throw new ForbiddenError();
  return { url: await signedDownloadUrl(path) };
}
