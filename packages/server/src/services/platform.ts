/**
 * Super admin console (AutoEd staff, PRD 8.5) and per-user platform services: profile, notification inbox and
 * preferences, devices (remote sign-out), uploads.
 *
 * On the shared platform (docs/adr/os-move.md) the console's entitlement and billing writes run as the database
 * role platform_admin_server with the admin's claims (RLS: app.is_platform_admin()); OS set-up rows of a client
 * (branch, presets, first admin) are written as that org's OS system actor. AutoEd staff reach client data only
 * through time-limited support sessions (core.support_sessions, app.start_support_session). The full platform
 * console is a separate app (packages/server/src/platform-admin); this keeps the OS console's routes working.
 */
import { randomUUID } from 'node:crypto';
import { NOTIFICATION_EVENTS, UPLOAD_LIMITS, monthKey, type PresetKey } from '@autoed/shared';
import { ForbiddenError, NotFoundError, ValidationError, asAnonymousServer, asPlatformAdmin, asSystem, asUser, insert, maybe, one, q, splitName, update } from '../db';
import { run, now, type Ctx } from '../core';
import { applyPreset } from '../presets';
import { signedDownloadUrl, signedUploadUrl } from '../adapters/channels';
import { notify } from '../notify';

// ---------------------------------------------------------------- super admin
export async function requireSuperAdmin(userId: string) {
  const ok = await asUser({ userId }, (c) => maybe(c, `select 1 from core.platform_admins where user_id = $1 and active`, [userId]));
  if (!ok) throw new ForbiddenError('super_admin_only');
}

/** Org of a branch (console inputs carry branch ids; platform admins cannot read client branches). */
async function orgOfBranch(branchId: string): Promise<string> {
  const r = await asAnonymousServer((c) => maybe<{ org_id: string | null }>(c, `select os.branch_org_id($1) as org_id`, [branchId]));
  if (!r?.org_id) throw new NotFoundError('branch');
  return r.org_id;
}

const osPlanKey = (k: string) => (k.startsWith('os_') ? k : `os_${k}`);

export async function adminOverview(userId: string) {
  await requireSuperAdmin(userId);
  return asPlatformAdmin(userId, async (c) => {
    const period = monthKey(now());
    const orgs = await q(c, `select o.id, o.name, o.slug, (case when o.setup_step ~ '^[0-9]+$' then o.setup_step::int else 0 end) as setup_step, o.created_at, (select string_agg(s.product_key || ':' || s.status, ', ') from core.subscriptions s where s.org_id = o.id) as products from core.organizations o order by o.created_at desc`);
    const credits = await q(
      c,
      `select o.id as org_id, o.name as org, a.plan_key as plan, coalesce(sum(l.credits) filter (where l.credits > 0 and l.period = $1), 0) as granted,
              coalesce(-sum(l.credits) filter (where l.credits < 0 and l.period = $1), 0) as used, coalesce(sum(l.provider_cost) filter (where l.period = $1), 0) as provider_cost
         from core.organizations o left join billing.ai_allowances a on a.org_id = o.id and a.branch_id is null and a.status = 'active'
         left join billing.ai_credit_ledger l on l.org_id = o.id group by o.id, o.name, a.plan_key order by o.name`,
      [period],
    );
    const topups = await q(c, `select r.*, o.name as org from billing.credit_topup_requests r join core.organizations o on o.id = r.org_id where r.status = 'pending' order by r.created_at`);
    const plans = await q(c, `select key, name, ai_monthly_credits as monthly_credits, ai_carry_forward as carry_forward, whatsapp_included, price_paise from billing.plans where product_key = 'os' order by ai_monthly_credits`);
    const costs = await q(c, `select action, credits, included, daily_fair_use, model_tier from billing.ai_action_costs where org_id is null order by action`);
    const viewAs = await q(c, `select s.id, s.org_id, s.reason, s.started_at as starts_at, s.expires_at, s.ended_at, o.name as org from core.support_sessions s join core.organizations o on o.id = s.org_id order by s.started_at desc limit 50`);
    // Client operational data (support tickets, bot conversations, WhatsApp usage) is visible to AutoEd staff only
    // inside a support session; curriculum and help-bot content is loaded by migrations and the seed.
    return { period, orgs, credits, whatsapp: [], topups, support: [], unanswered: [], poorly_rated: [], plans, costs, curriculum: [], kb: [], view_as: viewAs };
  });
}

/** Creates a client with the OS product, its first branch and admin (invited; no self sign-up). */
export async function createOrganization(userId: string, input: { name: string; slug: string; preset_key: PresetKey; branch_name: string; branch_code: string; admin_name: string; admin_email: string; admin_phone?: string; plan_key: string }) {
  await requireSuperAdmin(userId);
  // 1. entitlements: the platform admin creates the org, the OS subscription and its AI allowance
  const orgId = await asPlatformAdmin(userId, async (c) => {
    if (await maybe(c, `select 1 from core.organizations where slug = $1`, [input.slug])) throw new ValidationError('slug_taken');
    const plan = await maybe<{ key: string; ai_monthly_credits: number; ai_carry_forward: boolean }>(c, `select key, ai_monthly_credits, ai_carry_forward from billing.plans where key = $1 and product_key = 'os'`, [osPlanKey(input.plan_key)]);
    if (!plan) throw new ValidationError('unknown_plan');
    const org = await one<{ id: string }>(c, `insert into core.organizations (name, slug, kind, preset_key, setup_step) values ($1, $2, 'school', $3, 0) returning id`, [input.name, input.slug, input.preset_key]);
    await c.query(`insert into core.subscriptions (org_id, product_key, status, plan_key) values ($1, 'os', 'active', $2)`, [org.id, plan.key]);
    await c.query(`insert into billing.ai_allowances (org_id, plan_key, monthly_credits, carry_forward) values ($1, $2, $3, $4)`, [org.id, plan.key, plan.ai_monthly_credits, plan.ai_carry_forward]);
    return org.id;
  });
  // 2. OS set-up as the new org's system actor: branch, presets, first admin with the director role
  return asSystem(orgId, async (c) => {
    const branch = await insert<{ id: string }>(c, 'core.branches', { org_id: orgId, name: input.branch_name, code: input.branch_code });
    await applyPreset(c, orgId, branch.id, input.preset_key);
    const pos = await one<{ id: string }>(c, `select id from core.positions where org_id = $1 and key = 'director'`, [orgId]);
    const role = await one<{ id: string }>(c, `select id from os.roles where org_id = $1 and key = 'director'`, [orgId]);
    const authId = (await one<{ id: string }>(c, `select os.ensure_staff_login($1, $2, $3, null) as id`, [input.admin_email, input.admin_phone ?? null, input.admin_name])).id;
    const staff = await insert<{ id: string }>(c, 'core.staff', { org_id: orgId, branch_id: null, user_id: authId, ...splitName(input.admin_name), email: input.admin_email, phone: input.admin_phone ?? null, employee_code: 'ADMIN1', position_id: pos.id, status: 'invited', staff_type: 'admin' });
    await insert(c, 'os.staff_roles', { org_id: orgId, staff_id: staff.id, role_id: role.id });
    return { org_id: orgId, branch_id: branch.id, admin_staff_id: staff.id };
  });
}

export async function adminSetModule(userId: string, input: { branch_id: string; module_key: string; enabled: boolean }) {
  await requireSuperAdmin(userId);
  const orgId = await orgOfBranch(input.branch_id);
  return asSystem(orgId, async (c) => {
    await c.query(`insert into os.module_flags (org_id, branch_id, module_key, enabled) values ($1,$2,$3,$4) on conflict (branch_id, module_key) do update set enabled = excluded.enabled`, [orgId, input.branch_id, input.module_key, input.enabled]);
    return { ok: true };
  }, { userId });
}

/** Super admin adds credits to the client's wallet (optionally approving a request). Generation resumes at once. */
export async function adminTopup(userId: string, input: { branch_id: string; credits: number; note?: string; request_id?: string }) {
  await requireSuperAdmin(userId);
  const orgId = await orgOfBranch(input.branch_id);
  await asPlatformAdmin(userId, async (c) => {
    await c.query(`insert into billing.ai_credit_ledger (org_id, branch_id, kind, period, credits, note) values ($1,$2,'topup',$3,$4,$5)`, [orgId, input.branch_id, monthKey(now()), input.credits, input.note ?? 'Top-up']);
    if (input.request_id) await c.query(`update billing.credit_topup_requests set status = 'approved', updated_at = now() where id = $1 and org_id = $2`, [input.request_id, orgId]);
  });
  await asSystem(orgId, async (c) => {
    const admins = await q<{ id: string }>(c, `select distinct s.id from core.staff s join os.staff_roles sr on sr.staff_id = s.id join os.roles r on r.id = sr.role_id where s.branch_id = $1 and r.key in ('principal','admin_officer')`, [input.branch_id]);
    await notify(c, { orgId, branchId: input.branch_id, staffIds: admins.map((a) => a.id), event: 'credits.warning', titleKey: 'notif.credits.topup', vars: { credits: input.credits }, link: '/os/ai-credits' });
  });
  return { ok: true };
}

export async function adminSetCost(userId: string, input: { action: string; credits: number; daily_fair_use?: number | null }) {
  await requireSuperAdmin(userId);
  return asPlatformAdmin(userId, (c) => c.query(`update billing.ai_action_costs set credits = $2, daily_fair_use = coalesce($3, daily_fair_use), updated_at = now() where org_id is null and action = $1`, [input.action, input.credits, input.daily_fair_use ?? null]).then(() => ({ ok: true })));
}

export async function adminSetPlan(userId: string, input: { key: string; name: string; monthly_credits: number; carry_forward: boolean; whatsapp_included: number }) {
  await requireSuperAdmin(userId);
  return asPlatformAdmin(userId, (c) =>
    one(
      c,
      `insert into billing.plans (key, product_key, name, billing_interval, price_paise, sac_code, ai_monthly_credits, ai_carry_forward, whatsapp_included)
       values ($1, 'os', $2, 'month', 0, '998314', $3, $4, $5)
       on conflict (key) do update set name = excluded.name, ai_monthly_credits = excluded.ai_monthly_credits, ai_carry_forward = excluded.ai_carry_forward, whatsapp_included = excluded.whatsapp_included returning *`,
      [osPlanKey(input.key), input.name, input.monthly_credits, input.carry_forward, input.whatsapp_included],
    ),
  );
}

/** AutoEd master curriculum maps (org_id null rows) are shipped by migrations / the seed, not written by a request. */
export async function adminCurriculumUpdate(userId: string) {
  await requireSuperAdmin(userId);
  throw new ValidationError('curriculum_maps_are_shipped_by_migrations');
}

/** Time-limited "view as" access: an audited support session (app.start_support_session), visible to the school. */
export async function startViewAs(userId: string, input: { org_id: string; reason: string; minutes: number }) {
  await requireSuperAdmin(userId);
  return asUser({ userId }, async (c) => {
    const s = await one<{ id: string }>(c, `select app.start_support_session($1, $2, $3, true) as id`, [input.org_id, input.reason.padEnd(10, '.'), input.minutes]);
    const exp = await one<{ expires_at: string }>(c, `select expires_at from core.support_sessions where id = $1`, [s.id]);
    const target = await maybe<{ user_id: string }>(c, `select s.user_id from core.staff s join os.staff_roles sr on sr.staff_id = s.id join os.roles r on r.id = sr.role_id where s.org_id = $1 and r.key in ('director','chairman','principal') and s.status in ('active','invited') and s.user_id is not null order by case r.key when 'director' then 1 when 'chairman' then 2 else 3 end limit 1`, [input.org_id]);
    if (!target) throw new NotFoundError('no_admin_to_view_as');
    return { session_id: s.id, expires_at: exp.expires_at, as_user_id: target.user_id };
  });
}

/** The school's support-access log (who from AutoEd looked, why, when). */
export async function viewAsLog(ctx: Ctx) {
  return run(ctx, async (c, sys) => sys(() => q(c, `select s.reason, s.started_at as starts_at, s.expires_at, p.name as admin from core.support_sessions s left join core.platform_admins p on p.user_id = s.platform_user_id where s.org_id = $1 order by s.started_at desc`, [ctx.orgId])));
}

/** Support tickets are client data: AutoEd staff close them from the platform console inside a support session. */
export async function closeSupportTicket(userId: string, id: string) {
  await requireSuperAdmin(userId);
  void id;
  throw new ValidationError('use_the_platform_console');
}

// ---------------------------------------------------------------- per-user
export async function me(ctx: Ctx) {
  return run(ctx, async (c) => {
    const org = await one(c, `select o.id, o.name, (select f.storage_path from core.files f where f.id = o.logo_file_id) as logo_url, o.branding, (case when o.setup_step ~ '^[0-9]+$' then o.setup_step::int else 0 end) as setup_step, o.setup_completed_at from core.organizations o where o.id = $1`, [ctx.orgId]);
    const branches = await q(c, `select id, name, code, settings, latitude, longitude, geofence_radius_m from core.branches where id = any($1) order by name`, [ctx.branchIds]);
    const roles = await q<{ key: string; name: string }>(c, `select r.key, r.name from os.staff_roles sr join os.roles r on r.id = sr.role_id where sr.staff_id = $1 and sr.deleted_at is null`, [ctx.staffId]);
    const terminology = await q<{ key: string; locale: string; singular: string }>(c, `select key, locale, singular from core.terminology where org_id = $1 and (branch_id is null or branch_id = $2) and deleted_at is null order by branch_id nulls first`, [ctx.orgId, ctx.branchId]);
    const terms: Record<string, Record<string, string>> = {};
    for (const t of terminology) terms[t.key] = { ...(terms[t.key] ?? {}), [t.locale]: t.singular };
    return {
      staff: { id: ctx.staffId, full_name: ctx.staff.full_name, email: ctx.staff.email, language: ctx.staff.language, ui_prefs: ctx.staff.ui_prefs, is_teaching: ctx.staff.is_teaching, department_id: ctx.staff.department_id, wing_id: ctx.staff.wing_id, branch_id: ctx.staff.branch_id },
      org,
      // products the org has and the user was given (plan 4.3 layer 3: the UI builds its navigation from these)
      products: ctx.products,
      branch_id: ctx.branchId,
      branches,
      roles,
      permissions: Object.fromEntries(ctx.perms),
      modules: ctx.modules,
      terminology: terms,
      is_super_admin: ctx.isSuperAdmin,
      lang: ctx.lang,
    };
  });
}

export async function updateProfile(ctx: Ctx, input: { language?: 'en' | 'hi' | 'te'; ui_prefs?: Record<string, unknown> }) {
  return run(ctx, async (c, sys) => sys(() => update(c, 'core.staff', ctx.staffId, { language: input.language, ui_prefs: input.ui_prefs ? { ...ctx.staff.ui_prefs, ...input.ui_prefs } : undefined })));
}

export async function inbox(ctx: Ctx, opts: { unread?: boolean; limit?: number }) {
  return run(ctx, async (c) => q(c, `select id, event_key, title, body, link, priority, read_at, created_at, data from core.notifications where user_id = $1 and product_key = 'os' and deliver_after <= now() and ($2 = false or read_at is null) order by created_at desc limit $3`, [ctx.userId, !!opts.unread, Math.min(opts.limit ?? 100, 300)]));
}

export async function markRead(ctx: Ctx, ids: string[] | 'all') {
  return run(ctx, async (c) => {
    if (ids === 'all') await c.query(`update core.notifications set read_at = now() where user_id = $1 and product_key = 'os' and read_at is null`, [ctx.userId]);
    else await c.query(`update core.notifications set read_at = now() where user_id = $1 and id = any($2) and read_at is null`, [ctx.userId, ids]);
    return { ok: true };
  });
}

/** Users can mute only the categories the school marks optional. */
export async function notificationPrefs(ctx: Ctx) {
  return run(ctx, async (c) => {
    // notification_rules / prefs are core (one channel layer): OS rules carry product_key 'os', their OS flags in settings
    const rules = await q<{ event_key: string; optional: boolean; channels: string[] }>(c, `select event_key, coalesce((settings->>'optional')::boolean, true) as optional, channels from core.notification_rules where org_id = $1 and product_key = 'os' and deleted_at is null and active`, [ctx.orgId]);
    const prefs = await q<{ event_key: string; muted: boolean }>(c, `select event_key, muted from core.notification_prefs where user_id = $1 and channel is null and deleted_at is null`, [ctx.userId]);
    const all = rules.length ? rules : NOTIFICATION_EVENTS.map((e) => ({ event_key: e.key, optional: e.optional, channels: e.channels }));
    return all.map((r) => ({ ...r, muted: prefs.find((p) => p.event_key === r.event_key)?.muted ?? false }));
  });
}

export async function setNotificationPref(ctx: Ctx, input: { event_key: string; muted: boolean }) {
  return run(ctx, async (c) => {
    const rule = await maybe<{ optional: boolean }>(c, `select coalesce((settings->>'optional')::boolean, true) as optional from core.notification_rules where org_id = $1 and product_key = 'os' and event_key = $2 and deleted_at is null`, [ctx.orgId, input.event_key]);
    if (rule && !rule.optional && input.muted) throw new ValidationError('not_optional');
    await c.query(`insert into core.notification_prefs (org_id, user_id, event_key, channel, muted) values ($1,$2,$3,null,$4) on conflict (org_id, user_id, event_key, channel) do update set muted = excluded.muted, deleted_at = null`, [ctx.orgId, ctx.userId, input.event_key, input.muted]);
    return { ok: true };
  });
}

export async function registerDevice(ctx: Ctx, input: { token: string; platform: 'android' | 'ios' | 'web'; device_name?: string }) {
  return run(ctx, async (c) => insert(c, 'core.device_tokens', { org_id: ctx.orgId, user_id: ctx.userId, staff_id: ctx.staffId, token: input.token, platform: input.platform, device_name: input.device_name ?? null, last_seen_at: new Date().toISOString(), revoked_at: null }, { onConflict: '(token) do update set staff_id = excluded.staff_id, last_seen_at = now(), revoked_at = null, device_name = excluded.device_name' }));
}

export async function devices(ctx: Ctx) {
  return run(ctx, async (c) => q(c, `select id, platform, device_name, last_seen_at, revoked_at, token like 'session:%' as is_session from core.device_tokens where user_id = $1 order by last_seen_at desc nulls last`, [ctx.userId]));
}

/** Remote sign-out: revoking a session device ends that session on its next request. */
export async function revokeDevice(ctx: Ctx, id: string) {
  return run(ctx, async (c) => {
    const r = await c.query(`update core.device_tokens set revoked_at = now() where id = $1 and user_id = $2`, [id, ctx.userId]);
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
