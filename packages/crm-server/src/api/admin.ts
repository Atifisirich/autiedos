/**
 * The admin console (PRD 7.15, 12): organisation, users, roles, fields, pipeline, sources, routing, templates, forms,
 * workflows, integrations, wallet, audit, help. Ported from autoedcrm app/(app)/admin and app/actions/admin.ts + ops.ts.
 *
 * Every write runs AS THE PERSON (asUser): the section check below is the product rule (which role may open which
 * section) and the database's row policies are the second lock (a role without admin.configure cannot write
 * crm.stages even if this file had a bug). Places where a table needs the org-wide automation actor say so.
 */
import crypto from 'node:crypto';
import { asSystem, asUser, ForbiddenError, getPool, NotFoundError, type Db, type Row } from '../db';
import type { Ctx } from '../auth';
import { audit, assignOwner, changeStage, DEFAULT_SCORING, logActivity, SCORE_LABELS, stageByName } from '../core';
import { CAPS, LEVELS, LEVEL_HELP, adminSections, canPublishWorkflows, isFullAdmin, lvl } from '../perm';
import { mapStage } from '../migration';
import { deleteSecret, getSecret, secretHint, setSecret } from '../secrets';
import { syncTemplates, waConfig, waTest, pageTest } from '../meta';
import { RECIPES, TRIGGERS, testRun, type Step } from '../workflows';
import { PACKS, roleKey, seedProgrammes } from '../provision';
import { hashKey, publicUrl } from '../util';
import { splitName } from '../core';
import { bool, fail, need, num, on, str, who, type ApiRequest } from './router';

type Section = 'org' | 'users' | 'roles' | 'fields' | 'pipeline' | 'sources' | 'routing' | 'templates' | 'forms' | 'workflows' | 'integrations' | 'wallet' | 'data' | 'audit' | 'help';

/** The signed-in person, refused unless their role may open this admin section. */
async function admin(req: ApiRequest, section: Section) {
  const w = await who(req);
  if (!adminSections(w.ctx.perms).includes(section)) throw new ForbiddenError('Your role cannot change this setting.');
  return w;
}
/** Runs fn as the person after the section check. */
async function inAdmin<T>(req: ApiRequest, section: Section, fn: (db: Db, ctx: Ctx, actor: { id: string; name: string }) => Promise<T>): Promise<T> {
  const { s, ctx, actor } = await admin(req, section);
  return asUser(s.userId, ctx.orgId, (db) => fn(db, ctx, actor));
}
const log = (db: Db, actor: { id: string; name: string }, entity: string, summary: string, before?: unknown, after?: unknown) => audit(db, actor, 'config', entity, null, summary, before, after);
const lines = (v: unknown) => str(v).split('\n').map((x) => x.trim()).filter(Boolean);
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const setSettings = (db: Db, patch: Row) => db.q('update crm.settings set settings = settings || $2::jsonb where org_id = $1', [db.requireOrg(), JSON.stringify(patch)]);

// ---------------------------------------------------------------- home
on('GET', '/admin/home', async ({ req }) => {
  const { s, ctx } = await who(req);
  const allowed = adminSections(ctx.perms);
  if (!allowed.length) throw new ForbiddenError('Your role has no admin access.');
  return asUser(s.userId, ctx.orgId, async (db) => {
    const org = ctx.orgId;
    const [users, rules, wa, forms, last] = await Promise.all([
      db.one("select count(*)::int n from crm.staff_v where org_id = $1 and active and role_key <> 'system'", [org]),
      db.one("select count(*)::int n from crm.assignment_rules where org_id = $1 and active and jsonb_array_length(user_ids) > 0", [org]),
      db.one("select count(*)::int n from core.message_templates where org_id = $1 and product_key = 'crm' and status = 'approved' and deleted_at is null", [org]),
      db.one('select count(*)::int n from crm.forms where org_id = $1 and active', [org]),
      allowed.includes('audit') ? db.q("select * from crm.audit_events(null, null, 40)").then((r) => r.filter((x) => ['config', 'permission'].includes(x.action)).slice(0, 5)) : Promise.resolve([]),
    ]);
    const setup: [string, boolean, string][] = [
      ['Add your branches and seats', ctx.branches.length > 0, 'org'], ['Invite your team', users!.n > 1, 'users'], ['Set who receives new leads', rules!.n > 0, 'routing'],
      ['Review message templates', wa!.n > 0, 'templates'], ['Publish your website enquiry form', forms!.n > 0, 'forms'], ['Connect WhatsApp, telephony and the payment gateway', false, 'integrations'],
    ];
    return { sections: ctx.perms && allowed.length ? (await import('../perm')).ADMIN_SECTIONS.filter(([k]) => allowed.includes(k)).map(([key, label, description]) => ({ key, label, description })) : [], setup: setup.map(([label, ok, section]) => ({ label, ok, section })), recent: last.map((a: Row) => ({ summary: a.summary, user_name: a.user_name, created_at: a.created_at })), canSetup: allowed.includes('org') };
  });
});

// ---------------------------------------------------------------- organisation, branches, years, seats
on('GET', '/admin/org', ({ req }) =>
  inAdmin(req, 'org', async (db, ctx) => {
    const org = ctx.orgId;
    const [branches, years, programmes] = await Promise.all([
      db.q(
        `select b.id, b.name, b.city, b.address, b.phone, b.active, coalesce(bs.open_hour, 9) as open_hour, coalesce(bs.close_hour, 18) as close_hour, coalesce(bs.visit_capacity, 3) as visit_capacity
           from core.branches b left join crm.branch_settings bs on bs.org_id = b.org_id and bs.branch_id = b.id where b.org_id = $1 order by b.name`,
        [org],
      ),
      db.q('select id, name, status, is_current, seq, starts_on, ends_on from core.academic_years where org_id = $1 and deleted_at is null order by seq', [org]),
      db.q(
        `select p.id as programme_id, i.id as intake_id, b.name as branch, p.board, p.name as grade, p.seq, coalesce(i.capacity, 0) as capacity, i.min_age_years, i.age_cutoff::text as age_cutoff
           from core.programmes p join core.branches b on b.org_id = p.org_id and b.id = p.branch_id left join crm.intakes i on i.org_id = p.org_id and i.programme_id = p.id and i.academic_year_id = $2
          where p.org_id = $1 and p.deleted_at is null order by b.name, p.seq`,
        [org, ctx.yearId],
      ),
    ]);
    const last = years[years.length - 1];
    const next = last ? Number(String(last.name).slice(0, 4)) + 1 : new Date().getFullYear();
    return { org: { name: ctx.org.name }, settings: ctx.settings, branches, years, programmes, yearId: ctx.yearId, nextYearName: `${next}-${String(next + 1).slice(2)}`, packs: Object.keys(PACKS) };
  }),
);

on('POST', '/admin/org', ({ req, b }) =>
  inAdmin(req, 'org', async (db, ctx, actor) => {
    const s = {
      legal_name: str(b.legal_name), gstin: str(b.gstin), first_response_mins: num(b.first_response_mins, 30) || 30, reopen_on_reenquiry: bool(b.reopen), call_recording: bool(b.call_recording),
      fees: { registration: num(b.fee_registration), admission: num(b.fee_admission) }, app_no_prefix: str(b.app_no_prefix) || 'APP', receipt_prefix: str(b.receipt_prefix) || 'RCPT',
      closure_reasons: lines(b.closure_reasons), doc_types: lines(b.doc_types), privacy_notice: str(b.privacy_notice),
      quiet_hours: { from: Math.min(23, Math.max(0, num(b.quiet_from, 21))), to: Math.min(23, Math.max(0, num(b.quiet_to, 8))) },
      max_auto_per_day: Math.max(1, num(b.max_auto_per_day, 4)), require_2fa_admins: bool(b.require_2fa_admins), brand_color: /^#[0-9a-f]{6}$/i.test(str(b.color)) ? str(b.color) : '#0f6e6e',
    };
    await setSettings(db, s);
    if (str(b.name) && str(b.name) !== ctx.org.name) await db.q('update core.organizations set name = $2 where id = $1', [ctx.orgId, str(b.name)]);
    await log(db, actor, 'organisation', 'Updated organisation settings', ctx.settings, { ...ctx.settings, ...s });
    return { ok: true, message: 'Organisation settings saved.' };
  }),
);

on('POST', '/admin/branches', ({ req, b }) =>
  inAdmin(req, 'org', async (db, ctx, actor) => {
    const name = str(b.name);
    if (!name) fail('Give the branch a name.');
    const hours = { open_hour: num(b.open_hour, 9), close_hour: num(b.close_hour, 18), visit_capacity: Math.max(1, num(b.visit_capacity, 3)) };
    let id = str(b.id);
    if (id) {
      await db.q('update core.branches set name = $2, city = $3, address = $4, phone = $5 where org_id = $1 and id = $6', [ctx.orgId, name, str(b.city) || null, str(b.address) || null, str(b.phone) || null, id]);
    } else {
      const code = slug(name).slice(0, 10) + '_' + crypto.randomBytes(2).toString('hex');
      const br = await db.insert('core.branches', { name, code, city: str(b.city) || null, address: str(b.address) || null, phone: str(b.phone) || null, state_code: str(b.state_code) || '36', boards: ctx.settings.boards ?? [] });
      id = br.id;
      for (const y of ctx.years.filter((x) => x.status !== 'closed')) await seedProgrammes(db, id, y.id, ctx.settings.pack && PACKS[ctx.settings.pack] ? ctx.settings.pack : 'cbse_day', Number(String(y.name).slice(0, 4)));
    }
    await db.q('insert into crm.branch_settings (org_id, branch_id, open_hour, close_hour, visit_capacity) values ($1, $2, $3, $4, $5) on conflict (org_id, branch_id) do update set open_hour = excluded.open_hour, close_hour = excluded.close_hour, visit_capacity = excluded.visit_capacity', [ctx.orgId, id, hours.open_hour, hours.close_hour, hours.visit_capacity]);
    await log(db, actor, 'branch', `Saved branch "${name}"`);
    return { ok: true, id, message: 'Branch saved.' };
  }),
);

on('POST', '/admin/years/:id', ({ req, p, b }) =>
  inAdmin(req, 'org', async (db, ctx, actor) => {
    const what = str(b.what);
    if (what === 'default') {
      await db.q('update core.academic_years set is_current = false where org_id = $1 and is_current and id <> $2', [ctx.orgId, p.id]);
      await db.q("update core.academic_years set is_current = true, status = 'active' where org_id = $1 and id = $2", [ctx.orgId, p.id]);
    } else if (what === 'close' || what === 'open') {
      await db.q('update core.academic_years set status = $3 where org_id = $1 and id = $2', [ctx.orgId, p.id, what === 'close' ? 'closed' : 'active']);
    } else fail('Unknown action.');
    await log(db, actor, 'academic_year', `Academic year: ${what}`);
    return { ok: true };
  }),
);

/** Rollover wizard: next academic year with programmes and seats copied; last year's "not now" families carried forward as prospects (HUB-03). */
on('POST', '/admin/years', ({ req, b }) =>
  inAdmin(req, 'org', async (db, ctx, actor) => {
    const from = ctx.years.find((y) => y.id === str(b.from));
    const name = str(b.name);
    if (!from || !/^\d{4}-\d{2}$/.test(name)) fail('Enter the new year as, for example, 2028-29.');
    if (ctx.years.some((y) => y.name === name)) fail('That academic year already exists.');
    const start = Number(name.slice(0, 4));
    if (b.makeDefault) await db.q('update core.academic_years set is_current = false where org_id = $1 and is_current', [ctx.orgId]);
    const year = await db.insert('core.academic_years', { name, starts_on: `${start}-04-01`, ends_on: `${start + 1}-03-31`, status: 'active', is_current: bool(b.makeDefault), seq: Math.max(0, ...ctx.years.map((y) => y.seq)) + 1 });
    await db.q(
      `insert into crm.intakes (org_id, academic_year_id, programme_id, capacity, min_age_years, age_cutoff)
       select org_id, $3, programme_id, capacity, min_age_years, age_cutoff + interval '1 year' from crm.intakes where org_id = $1 and academic_year_id = $2`,
      [ctx.orgId, from!.id, year.id],
    );
    let carried = 0;
    if (bool(b.carry)) {
      const sys = await import('../db');
      // Carrying families forward writes enquiries for other owners: the org automation actor does it, after the person's own check above.
      carried = await sys.asSystem(ctx.orgId, async (sdb) => {
        const startStage = await stageByName(sdb, 'New data');
        const lost = await sdb.q(
          `select e.* from crm.enquiries e join crm.stages s on s.org_id = e.org_id and s.id = e.stage_id where e.org_id = $1 and e.academic_year_id = $2
             and ((s.is_closed and e.closure_reason in ('Undecided','Fee too high','No response','No seat available')) or (not s.is_closed and not s.is_won))`,
          [ctx.orgId, from!.id],
        );
        for (const e of lost) {
          const n = await sdb.insert('crm.enquiries', { household_id: e.household_id, prospect_id: e.prospect_id, branch_id: e.branch_id, academic_year_id: year.id, board: e.board, grade: e.grade, programme_id: e.programme_id, stage_id: startStage!.id, owner_id: e.owner_id, custom: e.custom, tags: ['carried forward'] });
          await sdb.insert('crm.source_touches', { enquiry_id: n.id, channel: 'Data', source: `Carried forward from ${from!.name}` });
          await logActivity(sdb, { householdId: e.household_id, enquiryId: n.id, type: 'system', content: `Carried forward from ${from!.name} as a prospect for ${name}. Earlier history stays on this family's timeline.` });
        }
        return lost.length;
      });
    }
    await log(db, actor, 'academic_year', `Rolled over ${from!.name} to ${name}; ${carried} families carried forward`);
    return { ok: true, id: year.id, carried, message: `${name} created with programmes and seats copied. ${carried} famil${carried === 1 ? 'y' : 'ies'} carried forward as prospects.` };
  }),
);

on('POST', '/admin/programmes/:id', ({ req, p, b }) =>
  inAdmin(req, 'org', async (db, ctx) => {
    // :id is the programme; the intake (seats and age rule for the picked year) is created on first save
    const minAge = str(b.min_age_years) ? num(b.min_age_years) : null;
    const r = await db.q(
      `insert into crm.intakes (org_id, academic_year_id, programme_id, capacity, min_age_years) values ($1, $2, $3, $4, $5)
       on conflict (org_id, academic_year_id, programme_id) do update set capacity = excluded.capacity, min_age_years = excluded.min_age_years returning id`,
      [ctx.orgId, ctx.yearId, p.id, Math.max(0, num(b.capacity)), minAge],
    );
    return { ok: true, id: r[0]!.id };
  }),
);

// ---------------------------------------------------------------- users and roles
/** Creating the sign-in is the platform's job: Supabase Auth invites by email; AUTH_PROVIDER=dev creates a local login. */
async function createLogin(db: Db, email: string, phone: string | null): Promise<string> {
  if (process.env.AUTH_PROVIDER === 'dev') return (await db.one('select crm.dev_create_login($1, $2) as id', [email, phone]))!.id as string;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) fail('Inviting people needs the Supabase service key on the server (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY).', 503);
  const r = await fetch(`${url}/auth/v1/invite`, { method: 'POST', headers: { apikey: key!, authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ email }), signal: AbortSignal.timeout(10000) });
  const data = (await r.json().catch(() => ({}))) as { id?: string; msg?: string; message?: string };
  if (!r.ok || !data.id) fail(`Could not send the invitation: ${data.msg ?? data.message ?? r.status}`, 502);
  return data.id!;
}

on('GET', '/admin/users', ({ req }) =>
  inAdmin(req, 'users', async (db, ctx) => {
    const org = ctx.orgId;
    const [users, roles] = await Promise.all([
      db.q("select id, name, email, phone, active, role_key, role_name, permissions, branch_ids, reports_to, daily_capacity, on_leave from crm.staff_v where org_id = $1 and role_key <> 'system' order by active desc, name", [org]),
      db.q("select key, name, permissions->>'admin' as admin from crm.roles where org_id = $1 order by name", [org]),
    ]);
    const full = isFullAdmin(ctx.perms);
    const visible = full ? users : users.filter((u) => (u.branch_ids as string[]).some((x) => ctx.branchIds.includes(x)));
    return {
      users: visible, roles: roles.filter((r) => full || r.admin !== 'F'), branches: ctx.branches.map((x) => ({ id: x.id, name: x.name })), full, me: ctx.user.id,
      licences: users.filter((u) => u.active).length,
    };
  }),
);

on('POST', '/admin/users', ({ req, b }) =>
  inAdmin(req, 'users', async (db, ctx, actor) => {
    const role = await db.one('select key, name, permissions from crm.roles where org_id = $1 and key = $2', [ctx.orgId, str(b.roleKey)]);
    if (!role) fail('Choose a role.');
    // A branch-scoped admin cannot mint organisation-wide admins or reach other branches.
    const full = isFullAdmin(ctx.perms);
    if (!full && role!.permissions.admin === 'F') fail('Only a group admin can give that role.', 403);
    let branchIds: string[] = (Array.isArray(b.branchIds) ? b.branchIds : []).map(String).filter((x: string) => ctx.branches.some((y) => y.id === x));
    if (!full && !branchIds.length) branchIds = ctx.branchIds;
    const name = str(b.name);
    if (!name) fail('Enter the name.');
    const n = splitName(name);
    const cap = Math.max(0, num(b.daily_capacity, 25));
    const reports = str(b.reports_to) ? ((await db.one('select id from core.staff where org_id = $1 and user_id = $2', [ctx.orgId, str(b.reports_to)]))?.id ?? null) : null;
    let userId = str(b.id);
    let created = false;
    if (userId) {
      const cur = await db.one('select email, phone from crm.staff_v where org_id = $1 and id = $2', [ctx.orgId, userId]);
      if (!cur) throw new NotFoundError('User not found.');
      await db.q('select core.upsert_staff($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)', [userId, n.first, n.last, cur.email, cur.phone, branchIds[0] ?? null, 'crm', role!.key, 'admin', 'active', reports]);
    } else {
      const email = str(b.email).toLowerCase();
      if (!/^\S+@\S+\.\S+$/.test(email)) fail('Enter a valid work email.');
      if (await db.one('select 1 from core.staff where org_id = $1 and lower(email) = $2 and deleted_at is null', [ctx.orgId, email])) fail('Someone already uses that email.', 409);
      userId = await createLogin(db, email, str(b.phone) || null);
      await db.q('select core.upsert_staff($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)', [userId, n.first, n.last, email, str(b.phone) || null, branchIds[0] ?? null, 'crm', role!.key, 'admin', 'active', reports]);
      created = true;
    }
    await db.q('select crm.set_user_branches($1, array(select jsonb_array_elements_text($2::jsonb)::uuid))', [userId, branchIds.slice(1)]);
    await db.q('insert into crm.counsellor_settings (org_id, user_id, daily_capacity, on_leave) values ($1, $2, $3, $4) on conflict (org_id, user_id) do update set daily_capacity = excluded.daily_capacity, on_leave = excluded.on_leave', [ctx.orgId, userId, cap, bool(b.on_leave)]);
    await audit(db, actor, 'permission', 'user', userId, created ? `Invited ${name} as ${role!.name}` : `Updated user ${name} (${role!.name})`);
    return { ok: true, id: userId, created, message: created ? `${name} was invited. They sign in with their work email (a code is sent to it).` : 'User saved.' };
  }),
);

on('POST', '/admin/users/:id/action', ({ req, p, b }) =>
  inAdmin(req, 'users', async (db, ctx, actor) => {
    if (p.id === ctx.user.id) fail('You cannot pause or reset your own account here.');
    const u = await db.one('select id, name from crm.staff_v where org_id = $1 and id = $2', [ctx.orgId, p.id]);
    if (!u) throw new NotFoundError('User not found.');
    const what = str(b.what);
    let message = '';
    if (what === 'pause') {
      await db.q('select crm.set_user_active($1, false)', [p.id]);
      const open = await db.one('select count(*)::int n from crm.enquiries e join crm.stages s on s.org_id = e.org_id and s.id = e.stage_id where e.org_id = $1 and e.owner_id = $2 and not s.is_closed and not s.is_won', [ctx.orgId, p.id]);
      message = `${u.name} is paused and signed out.` + (open!.n ? ` They still own ${open!.n} open enquiries: reassign them from Leads.` : '');
    } else if (what === 'activate') {
      await db.q('select crm.set_user_active($1, true)', [p.id]);
      message = `${u.name} is active again.`;
    } else if (what === 'signout') {
      await db.q('select crm.revoke_user_sessions($1)', [p.id]);
      message = `${u.name} is signed out on every device.`;
    } else fail('Unknown action.');
    await audit(db, actor, 'permission', 'user', p.id!, `User ${u.name}: ${what}`);
    return { ok: true, message };
  }),
);

on('GET', '/admin/roles', ({ req }) =>
  inAdmin(req, 'roles', async (db, ctx) => {
    const roles = await db.q("select r.id, r.key, r.name, r.permissions, r.is_system, (select count(*)::int from crm.staff_v u where u.org_id = r.org_id and u.role_key = r.key and u.active) as users from crm.roles r where r.org_id = $1 and r.key <> 'system' order by r.is_system desc, r.name", [ctx.orgId]);
    const order = ['Group Admin', 'Branch Admin', 'Admission Head', 'Counsellor', 'Front Office', 'Principal', 'Marketing', 'Accounts', 'Read-only Management'];
    roles.sort((a, c) => (order.indexOf(a.name) + 1 || 99) - (order.indexOf(c.name) + 1 || 99));
    return { roles, caps: CAPS, levels: LEVELS, help: LEVEL_HELP };
  }),
);
on('POST', '/admin/roles', ({ req, b }) =>
  inAdmin(req, 'roles', async (db, ctx, actor) => {
    const roles = await db.q("select * from crm.roles where org_id = $1 and key <> 'system'", [ctx.orgId]);
    const changed: string[] = [];
    for (const r of roles) {
      if (r.name === 'Group Admin') continue; // the last full-access role cannot be weakened
      const sent = (b.permissions?.[r.key] ?? null) as Record<string, string> | null;
      if (!sent) continue;
      const perms = Object.fromEntries(CAPS.map(([k]) => [k, LEVELS.includes(sent[k] as string) ? sent[k] : (r.permissions[k] ?? '-')]));
      if (JSON.stringify(perms) !== JSON.stringify(r.permissions)) {
        await db.q('update crm.roles set permissions = $2 where id = $1', [r.id, JSON.stringify(perms)]);
        await audit(db, actor, 'permission', 'role', r.id, `Changed permissions of role "${r.name}"`, r.permissions, perms);
        changed.push(r.name);
      }
    }
    return { ok: true, changed, message: changed.length ? 'Permissions saved. They apply from each user\'s next page load.' : 'Nothing changed.' };
  }),
);
on('POST', '/admin/roles/clone', ({ req, b }) =>
  inAdmin(req, 'roles', async (db, ctx, actor) => {
    const r = await db.one('select * from crm.roles where org_id = $1 and key = $2', [ctx.orgId, str(b.key)]);
    const name = str(b.name);
    if (!r || !name) fail('Name the new role.');
    const key = roleKey(name);
    if (!key || (await db.one('select 1 from crm.roles where org_id = $1 and key = $2', [ctx.orgId, key]))) fail('A role with that name already exists.', 409);
    await db.q('insert into core.roles (org_id, product_key, key, name) values ($1, $2, $3, $4) on conflict (org_id, product_key, key) do nothing', [ctx.orgId, 'crm', key, name]);
    // A role cannot be cloned above the cloner's own admin level: a branch admin cannot create an org-wide admin.
    const perms = { ...r!.permissions };
    if (!isFullAdmin(ctx.perms) && perms.admin === 'F') perms.admin = lvl(ctx.perms, 'admin');
    await db.insert('crm.roles', { key, name, permissions: perms });
    await log(db, actor, 'role', `Created role "${name}" from "${r!.name}"`);
    return { ok: true, key, message: `Role "${name}" created.` };
  }),
);

// ---------------------------------------------------------------- fields
on('GET', '/admin/fields', ({ req }) =>
  inAdmin(req, 'fields', async (db, ctx) => {
    const fields = await db.q(
      `select f.id, f.key, f.label, f.field_type as type, f.options, f.active, f.seq, coalesce(s.sensitive, false) as sensitive,
         (select count(*)::int from crm.enquiries e where e.org_id = f.org_id and coalesce(e.custom ->> f.key, '') <> '') + (select count(*)::int from crm.enquiry_sensitive x where x.org_id = f.org_id and x.data ? f.key) as used
       from core.custom_fields f left join crm.field_settings s on s.org_id = f.org_id and s.entity = 'enquiry' and s.key = f.key
      where f.org_id = $1 and f.product_key = 'crm' and f.entity = 'enquiry' and f.deleted_at is null order by f.seq`,
      [ctx.orgId],
    );
    return { fields: fields.map((f) => ({ ...f, options: f.options ?? [] })), standard: ['Student name', 'Date of birth (sensitive)', 'Gender', 'Grade', 'Board', 'Parent name', 'Mobile (unique per organisation)', 'Email', 'Address', 'Locality', 'Source', 'Stage', 'Owner', 'Expected decision date', 'Special needs note (sensitive)'] };
  }),
);
on('POST', '/admin/fields', ({ req, b }) =>
  inAdmin(req, 'fields', async (db, ctx, actor) => {
    const label = str(b.label);
    if (!label) fail('Give the field a label.');
    const options = (Array.isArray(b.options) ? b.options : str(b.options).split(',')).map((x: unknown) => str(x)).filter(Boolean);
    const type = str(b.type) === 'select' ? 'select' : 'text';
    if (type === 'select' && !options.length) fail('Add at least one dropdown value.');
    let key = '';
    if (str(b.id)) {
      const f = await db.one('select key from core.custom_fields where org_id = $1 and id = $2', [ctx.orgId, str(b.id)]);
      if (!f) throw new NotFoundError('Field not found.');
      key = f.key;
      await db.q('update core.custom_fields set label = $2, options = $3::jsonb, active = $4 where id = $1', [str(b.id), label, JSON.stringify(options), b.active === undefined ? true : bool(b.active)]);
      await log(db, actor, 'custom_field', `Edited field "${label}"`);
    } else {
      key = slug(label);
      if (!/^[a-z][a-z0-9_]*$/.test(key)) fail('Use letters in the field name.');
      if (await db.one("select 1 from core.custom_fields where org_id = $1 and product_key = 'crm' and entity = 'enquiry' and key = $2", [ctx.orgId, key])) fail('A field with that name already exists.', 409);
      const n = await db.one('select count(*)::int n from core.custom_fields where org_id = $1 and product_key = $2', [ctx.orgId, 'crm']);
      await db.insert('core.custom_fields', { product_key: 'crm', entity: 'enquiry', key, label, field_type: type, options, seq: n!.n + 1, active: true });
      await log(db, actor, 'custom_field', `Added field "${label}" to Enquiry`);
    }
    // Sensitivity moves existing values between crm.enquiries.custom and crm.enquiry_sensitive; it needs sensitive.edit as well.
    const wantSensitive = bool(b.sensitive);
    const cur = await db.one("select sensitive from crm.field_settings where org_id = $1 and entity = 'enquiry' and key = $2", [ctx.orgId, key]);
    if ((cur?.sensitive ?? false) !== wantSensitive) await db.q('select crm.set_field_sensitivity($1, $2)', [key, wantSensitive]);
    return { ok: true, key, message: 'Field saved. It is live on the family page, in the API and in exports of that record now.' };
  }),
);

// ---------------------------------------------------------------- pipeline (PL-01, PL-04)
on('GET', '/admin/pipeline', ({ req }) =>
  inAdmin(req, 'pipeline', async (db, ctx) => {
    const phases = await db.q('select * from crm.phases where org_id = $1 order by seq', [ctx.orgId]);
    const stages = await db.q('select s.*, (select count(*)::int from crm.enquiries e where e.org_id = s.org_id and e.stage_id = s.id) as records from crm.stages s where s.org_id = $1 and s.active order by s.seq', [ctx.orgId]);
    // Stage mapping for imports (Appendix B): what the common names from other CRMs become here.
    const probes = ['Untouched', 'Cold', 'Not reachable', 'Follow up', 'Follow up / campus visit planned', 'Walk-in', 'Interested - hot', 'Application started', 'Registration payment done', 'Enrolled', 'Closed - not interested', 'Junk duplicate'];
    return { phases, stages, importMap: probes.map((x) => ({ from: x, to: mapStage(x)?.stage ?? null })), colors: ['slate', 'sky', 'violet', 'amber', 'orange', 'teal', 'green', 'rose'], required: ['closure_reason', 'visit', 'expected_decision'] };
  }),
);
on('POST', '/admin/stages', ({ req, b }) =>
  inAdmin(req, 'pipeline', async (db, ctx, actor) => {
    const data = { name: str(b.name), color: str(b.color) || 'slate', probability: Math.min(100, Math.max(0, num(b.probability))), sla_hours: str(b.sla_hours) ? num(b.sla_hours) : null, exempt_next_action: bool(b.exempt) };
    if (!data.name) fail('Give the stage a name.');
    if (str(b.id)) {
      const before = await db.one('select name, color, probability, sla_hours, exempt_next_action from crm.stages where org_id = $1 and id = $2', [ctx.orgId, str(b.id)]);
      await db.update('crm.stages', str(b.id), data);
      await log(db, actor, 'stage', `Edited stage "${data.name}"`, before, data);
    } else {
      const ph = await db.one('select * from crm.phases where org_id = $1 and id = $2', [ctx.orgId, str(b.phaseId)]);
      if (!ph) fail('Choose a phase.');
      const n = await db.one('select coalesce(max(seq), 0) + 1 as n from crm.stages where org_id = $1 and phase_id = $2', [ctx.orgId, ph!.id]);
      await db.insert('crm.stages', { phase_id: ph!.id, seq: n!.n, ...data, is_closed: ph!.key === 'closed', is_won: ph!.key === 'enrolled', required_fields: ph!.key === 'closed' ? ['closure_reason'] : [], exempt_next_action: data.exempt_next_action || ['closed', 'enrolled', 'prospect'].includes(ph!.key) });
      await log(db, actor, 'stage', `Added stage "${data.name}" to ${ph!.name}`);
    }
    return { ok: true, message: 'Stage saved.' };
  }),
);
on('POST', '/admin/stages/:id/move', ({ req, p, b }) =>
  inAdmin(req, 'pipeline', async (db, ctx) => {
    const s = await db.one('select * from crm.stages where org_id = $1 and id = $2', [ctx.orgId, p.id]);
    if (!s) throw new NotFoundError('Stage not found.');
    const list = await db.q('select id from crm.stages where org_id = $1 and phase_id = $2 and active order by seq', [ctx.orgId, s.phase_id]);
    const i = list.findIndex((x) => x.id === s.id), j = i + (str(b.dir) === 'up' ? -1 : 1);
    if (j < 0 || j >= list.length) return { ok: true };
    [list[i], list[j]] = [list[j]!, list[i]!];
    for (let k = 0; k < list.length; k++) await db.q('update crm.stages set seq = $2 where id = $1', [list[k]!.id, k]);
    return { ok: true };
  }),
);
/** Retiring a stage asks where its records go; they move with a timeline entry and history keeps the old name (PL-04). */
on('POST', '/admin/stages/:id/retire', async ({ req, p, b }) => {
  const { s, ctx, actor } = await admin(req, 'pipeline');
  const st = await asUser(s.userId, ctx.orgId, (db) => db.one('select * from crm.stages where org_id = $1 and id = $2 and active', [ctx.orgId, p.id]));
  if (!st) throw new NotFoundError('Stage not found.');
  if (['New', 'New data', 'Admission confirmed'].includes(st.name)) fail(`"${st.name}" is used by the product logic and cannot be removed. You can rename it.`);
  const target = str(b.targetId);
  // Moving other people's records is an org-wide act: the automation actor does it, the person is the actor in the history.
  return asSystem(ctx.orgId, async (db) => {
    const records = await db.q('select id from crm.enquiries where org_id = $1 and stage_id = $2', [ctx.orgId, st.id]);
    if (records.length && (!target || target === st.id)) fail(`${records.length} records are in "${st.name}". Choose the stage they should move to.`);
    for (const r of records) {
      const res = await changeStage(db, r.id, target, actor, { closure_reason: 'Other', note: `Stage "${st.name}" was retired by an admin` });
      if (!res.ok) fail('Could not move every record to that stage (it needs information they do not have). Pick another target.');
    }
    await db.update('crm.stages', st.id, { active: false });
    await log(db, actor, 'stage', `Retired stage "${st.name}"; ${records.length} records moved`);
    return { ok: true, moved: records.length, message: `"${st.name}" retired. ${records.length} record${records.length === 1 ? '' : 's'} moved; past timelines still show the old name.` };
  });
});

// ---------------------------------------------------------------- sources, routing, scoring
on('GET', '/admin/sources', ({ req }) =>
  inAdmin(req, 'sources', async (db, ctx) => ({ sources: await db.q('select s.*, (select count(*)::int from crm.source_touches t where t.org_id = s.org_id and t.source_id = s.id) as touches from crm.sources s where s.org_id = $1 order by s.channel, s.name', [ctx.orgId]) })),
);
on('POST', '/admin/sources', ({ req, b }) =>
  inAdmin(req, 'sources', async (db, ctx, actor) => {
    const data = { channel: str(b.channel), name: str(b.name), cost: Math.max(0, num(b.cost)), active: b.active === undefined ? true : bool(b.active) };
    if (!data.channel || !data.name) fail('Channel and source name are both needed.');
    if (str(b.id)) await db.update('crm.sources', str(b.id), data);
    else await db.insert('crm.sources', data);
    await log(db, actor, 'source', `Saved source "${data.name}"`);
    return { ok: true };
  }),
);

on('GET', '/admin/routing', ({ req }) =>
  inAdmin(req, 'routing', async (db, ctx) => {
    const [rules, users, channels] = await Promise.all([
      db.q('select * from crm.assignment_rules where org_id = $1 order by seq', [ctx.orgId]),
      db.q("select id, name, on_leave, daily_capacity from crm.staff_v where org_id = $1 and active and role_key <> 'system' and permissions->>'leads' in ('O','T') order by name", [ctx.orgId]),
      db.q('select distinct channel from crm.sources where org_id = $1 order by 1', [ctx.orgId]),
    ]);
    const s = ctx.settings;
    return { rules, users, channels: channels.map((c) => c.channel), branches: ctx.branches.map((x) => ({ id: x.id, name: x.name })), grades: s.grades ?? [], scoring: { ...DEFAULT_SCORING, ...(s.scoring ?? {}) }, labels: SCORE_LABELS, hot_at: s.hot_at ?? 60, warm_at: s.warm_at ?? 30 };
  }),
);
on('POST', '/admin/rules', ({ req, b }) =>
  inAdmin(req, 'routing', async (db, ctx, actor) => {
    if (str(b.what) === 'delete') {
      await db.q('delete from crm.assignment_rules where org_id = $1 and id = $2', [ctx.orgId, str(b.id)]);
    } else {
      const users = (Array.isArray(b.userIds) ? b.userIds : []).map(String);
      if (!users.length) fail('Pick at least one person to receive leads.');
      const data = { name: str(b.name) || 'Rule', seq: num(b.position, 1), method: str(b.method) === 'least_load' ? 'least_load' : 'round_robin', user_ids: users, conditions: { branch_id: str(b.branch_id) || undefined, channel: str(b.channel) || undefined, grades: (Array.isArray(b.grades) ? b.grades : []).map(String) } };
      if (str(b.id)) await db.update('crm.assignment_rules', str(b.id), data);
      else await db.insert('crm.assignment_rules', data);
    }
    await log(db, actor, 'assignment_rule', `Assignment rule ${str(b.what) === 'delete' ? 'deleted' : 'saved'}: ${str(b.name)}`);
    return { ok: true, message: 'Routing rules updated.' };
  }),
);
/** "Which rule would this lead hit?" tester (ASG-06). Nothing is assigned. */
on('POST', '/assignment/simulate', async ({ req, b }) => {
  const { ctx } = await admin(req, 'routing');
  return asSystem(ctx.orgId, async (db) => {
    const r = await assignOwner(db, { branchId: str(b.branchId ?? b.branch_id), board: str(b.board) || null, grade: str(b.grade) || null, channel: str(b.channel) || null }, true);
    return { ...r, text: `Would go to ${r.ownerName}. ${r.reason}.` };
  });
});
on('POST', '/admin/scoring', ({ req, b }) =>
  inAdmin(req, 'routing', async (db, ctx, actor) => {
    const scoring = Object.fromEntries(Object.keys(SCORE_LABELS).map((k) => [k, Math.min(100, Math.max(0, num((b.scoring ?? {})[k], DEFAULT_SCORING[k] ?? 0)))]));
    await setSettings(db, { scoring, hot_at: num(b.hot_at, 60) || 60, warm_at: num(b.warm_at, 30) || 30 });
    await log(db, actor, 'scoring', 'Changed scoring rules', ctx.settings.scoring, scoring);
    return { ok: true, message: 'Scoring saved. Scores refresh as each record gets new activity.' };
  }),
);

// ---------------------------------------------------------------- templates, forms
const LANG: Record<string, string> = { english: 'en', hindi: 'hi', telugu: 'te' };
on('GET', '/admin/templates', ({ req }) =>
  inAdmin(req, 'templates', async (db, ctx) => ({
    templates: await db.q("select id, name, channel, category, language, body, status, provider_status, provider_reason from core.message_templates where org_id = $1 and product_key = 'crm' and deleted_at is null order by channel, name", [ctx.orgId]),
    variables: ['guardian_name', 'student_name', 'grade', 'branch', 'counsellor', 'school', 'apply_link'],
  })),
);
on('POST', '/admin/templates', ({ req, b }) =>
  inAdmin(req, 'templates', async (db, ctx, actor) => {
    const channel = ['whatsapp', 'sms', 'email'].includes(str(b.channel)) ? str(b.channel) : 'whatsapp';
    const data = { name: str(b.name), channel, category: str(b.category) === 'marketing' ? 'marketing' : 'utility', language: LANG[str(b.language).toLowerCase()] ?? (['en', 'hi', 'te'].includes(str(b.language)) ? str(b.language) : 'en'), body: str(b.body) };
    if (!data.name || !data.body) fail('A template needs a name and a body.');
    // WhatsApp templates need provider approval before use. Without a connected number this is recorded as submitted.
    const status = ['approved', 'submitted', 'draft', 'rejected', 'paused'].includes(str(b.status)) ? str(b.status) : null;
    if (str(b.id)) await db.update('core.message_templates', str(b.id), { ...data, status: status ?? 'approved' });
    else await db.insert('core.message_templates', { product_key: 'crm', ...data, status: data.channel === 'whatsapp' ? 'submitted' : 'approved' });
    await log(db, actor, 'template', `Saved template "${data.name}" (${data.channel})`);
    return { ok: true, message: str(b.id) ? 'Template saved.' : data.channel === 'whatsapp' ? 'Template saved as pending approval.' : 'Template saved.' };
  }),
);

on('GET', '/admin/forms', ({ req }) =>
  inAdmin(req, 'forms', async (db, ctx) => {
    const [forms, sources] = await Promise.all([db.q('select * from crm.forms where org_id = $1 order by name', [ctx.orgId]), db.q('select id, name, channel from crm.sources where org_id = $1 and active order by channel, name', [ctx.orgId])]);
    return { forms: forms.map((f) => ({ ...f, url: publicUrl('f', f.slug) })), sources, branches: ctx.branches.map((x) => ({ id: x.id, name: x.name })), optional: [['email', 'Email'], ['grade', 'Grade'], ['branch', 'Branch'], ['dob', 'Date of birth'], ['locality', 'Locality'], ['heard_about', 'How did you hear about us']] };
  }),
);
on('POST', '/admin/forms', ({ req, b }) =>
  inAdmin(req, 'forms', async (db, ctx, actor) => {
    const optional = ['email', 'grade', 'branch', 'dob', 'locality', 'heard_about'];
    const data = {
      name: str(b.name), branch_id: str(b.branch_id) || null, source_id: str(b.source_id) || null, thank_you: str(b.thank_you) || 'Thank you. Our admissions team will call you shortly.',
      fields: ['student_name', 'guardian_name', 'mobile', ...(Array.isArray(b.fields) ? b.fields : []).map(String).filter((f: string) => optional.includes(f))],
    };
    if (!data.name) fail('Give the form a name.');
    if (str(b.id)) await db.update('crm.forms', str(b.id), { ...data, active: b.active === undefined ? true : bool(b.active) });
    else {
      const sl = `${slug(ctx.org.slug ?? ctx.org.name).replace(/_/g, '-')}-${slug(data.name).replace(/_/g, '-') || 'form'}-${crypto.randomBytes(2).toString('hex')}`;
      await db.insert('crm.forms', { slug: sl, ...data, active: true });
    }
    await log(db, actor, 'form', `Saved form "${data.name}"`);
    return { ok: true, message: 'Form saved and live at its link.' };
  }),
);

// ---------------------------------------------------------------- workflows (AUT-01..05)
on('GET', '/admin/workflows', ({ req }) =>
  inAdmin(req, 'workflows', async (db, ctx) => {
    const org = ctx.orgId;
    const wfs = await db.q(
      `select w.*, (select count(*)::int from crm.workflow_runs r where r.workflow_id = w.id and not r.test) as runs, (select count(*)::int from crm.workflow_runs r where r.workflow_id = w.id and r.status = 'running') as waiting,
              (select count(*)::int from crm.workflow_runs r where r.workflow_id = w.id and r.status = 'error') as errors from crm.workflows w where w.org_id = $1 order by w.name`,
      [org],
    );
    const id = str(req.query.id);
    const cur = id ? wfs.find((w) => w.id === id) : null;
    const base = { workflows: wfs, triggers: TRIGGERS, recipes: RECIPES.filter((r) => !wfs.some((w) => w.recipe_key === r.key)).map((r) => ({ key: r.key, name: r.name, description: r.description })), canPublish: canPublishWorkflows(ctx.perms), canDelete: lvl(ctx.perms, 'workflows') === 'F' };
    if (!cur) return base;
    const [runs, templates, stages, custom] = await Promise.all([
      db.q('select r.*, st.full_name as student from crm.workflow_runs r left join crm.enquiries e on e.org_id = r.org_id and e.id = r.enquiry_id left join crm.prospects st on st.org_id = e.org_id and st.id = e.prospect_id where r.workflow_id = $1 order by r.created_at desc limit 15', [cur.id]),
      db.q("select distinct name from core.message_templates where org_id = $1 and product_key = 'crm' and status = 'approved' and deleted_at is null order by 1", [org]),
      db.q('select name from crm.stages where org_id = $1 and active order by seq', [org]),
      db.q("select key, label from core.custom_fields where org_id = $1 and product_key = 'crm' and entity = 'enquiry' and active and deleted_at is null", [org]),
    ]);
    const condFields: [string, string][] = [['grade', 'Grade'], ['board', 'Board'], ['branch_name', 'Branch'], ['stage_name', 'Stage'], ['temperature', 'Temperature'], ['closure_reason', 'Closure reason'], ...custom.map((f) => ['custom.' + f.key, f.label] as [string, string])];
    return { ...base, current: cur, runs, templates: templates.map((t) => t.name), stages: stages.map((x) => x.name), condFields };
  }),
);
const wfAuth = async (db: Db, ctx: Ctx, id: string, edit = true) => {
  const wf = await db.one('select * from crm.workflows where org_id = $1 and id = $2', [ctx.orgId, id]);
  if (!wf) throw new NotFoundError('Workflow not found.');
  if (edit && wf.status === 'published' && !canPublishWorkflows(ctx.perms)) fail('Pause the workflow before editing it, or ask someone who can publish.', 403);
  return wf;
};
on('POST', '/admin/workflows', ({ req, b }) =>
  inAdmin(req, 'workflows', async (db, _c, actor) => {
    if (str(b.recipe)) {
      const r = RECIPES.find((x) => x.key === str(b.recipe));
      if (!r) fail('Unknown recipe.');
      const wf = await db.insert('crm.workflows', { recipe_key: r!.key, name: r!.name, description: r!.description, trigger: r!.trigger, conditions: r!.conditions ?? [], steps: r!.steps, status: 'draft' });
      await log(db, actor, 'workflow', `Installed recipe "${r!.name}"`);
      return { ok: true, id: wf.id, message: `"${r!.name}" installed as a draft. Test it, then publish.` };
    }
    if (!TRIGGERS[str(b.trigger)]) fail('Choose a trigger.');
    const wf = await db.insert('crm.workflows', { name: str(b.name) || 'New workflow', description: 'Custom workflow', trigger: str(b.trigger), steps: [], status: 'draft' });
    return { ok: true, id: wf.id };
  }),
);
on('POST', '/admin/workflows/:id/status', ({ req, p, b }) =>
  inAdmin(req, 'workflows', async (db, ctx, actor) => {
    need(canPublishWorkflows(ctx.perms), 'Your role can draft workflows but not publish or pause them.');
    const status = ['published', 'paused', 'draft'].includes(str(b.status)) ? str(b.status) : fail('Unknown status.');
    const wf = await db.update('crm.workflows', p.id!, { status });
    if (!wf) throw new NotFoundError('Workflow not found.');
    await log(db, actor, 'workflow', `Workflow "${wf.name}" set to ${status}`);
    return { ok: true, message: status === 'published' ? 'Workflow is live.' : 'Workflow paused. Waiting steps will be cancelled when they come due.' };
  }),
);
on('POST', '/admin/workflows/:id/steps', ({ req, p, b }) =>
  inAdmin(req, 'workflows', async (db, ctx, actor) => {
    const wf = await wfAuth(db, ctx, p.id!);
    let steps = [...(wf.steps as Step[])];
    const what = str(b.what);
    if (what === 'remove') steps.splice(num(b.index), 1);
    else if (what === 'up') { const i = num(b.index); if (i > 0) [steps[i - 1], steps[i]] = [steps[i]!, steps[i - 1]!]; }
    else if (what === 'add') {
      const type = str(b.type);
      const step: Step | null =
        type === 'send' ? { type: 'send', channel: (str(b.channel) || 'whatsapp') as 'whatsapp', template: str(b.template) }
        : type === 'task' ? { type: 'task', title: str(b.title) || 'Follow-up', dueMins: num(b.mins, 60) || 60 }
        : type === 'wait' ? { type: 'wait', mins: num(b.mins, 1440) || 1440 }
        : type === 'notify' ? { type: 'notify', who: (str(b.who) || 'owner') as 'owner', title: str(b.title) || 'Please check this record' }
        : type === 'stage' ? { type: 'stage', stage: str(b.stage) }
        : type === 'tag' ? { type: 'tag', tag: str(b.title) }
        : type === 'reassign' ? { type: 'reassign' } : null;
      if (!step) fail('Choose a step type.');
      steps = [...steps, step!];
    } else fail('Unknown action.');
    await db.update('crm.workflows', wf.id, { steps, version: wf.version + 1 });
    await audit(db, actor, 'config', 'workflow', wf.id, `Edited steps of workflow "${wf.name}" (version ${wf.version + 1})`, wf.steps, steps);
    return { ok: true };
  }),
);
on('POST', '/admin/workflows/:id/conditions', ({ req, p, b }) =>
  inAdmin(req, 'workflows', async (db, ctx, actor) => {
    const wf = await wfAuth(db, ctx, p.id!);
    let conds = [...(wf.conditions as Row[])];
    if (str(b.what) === 'remove') conds.splice(num(b.index), 1);
    else {
      const field = str(b.field);
      if (!/^(grade|board|branch_name|stage_name|temperature|closure_reason|custom\.[a-z0-9_]+)$/.test(field)) fail('Choose a field.');
      const values = str(b.value).split(',').map((v) => v.trim()).filter(Boolean);
      if (!values.length) fail('Type a value.');
      conds = [...conds, str(b.op) === 'ne' ? { field, op: 'ne', value: values[0] } : { field, op: 'in', value: values }];
    }
    await db.update('crm.workflows', wf.id, { conditions: conds, version: wf.version + 1 });
    await audit(db, actor, 'config', 'workflow', wf.id, `Changed conditions of workflow "${wf.name}"`, wf.conditions, conds);
    return { ok: true };
  }),
);
on('POST', '/admin/workflows/:id/test', async ({ req, p }) => {
  const { ctx } = await admin(req, 'workflows');
  return asSystem(ctx.orgId, async (db) => {
    const sample = await db.one('select e.id from crm.enquiries e join crm.stages s on s.org_id = e.org_id and s.id = e.stage_id where e.org_id = $1 and not s.is_closed order by e.created_at desc limit 1', [ctx.orgId]);
    if (!sample) fail('Add at least one enquiry to test with.');
    const run = await testRun(db, p.id!, sample!.id);
    return { ok: true, run, message: 'Test run finished. Nothing was sent. See the run log below.' };
  });
});
on('POST', '/admin/workflows/:id/delete', ({ req, p }) =>
  inAdmin(req, 'workflows', async (db, ctx) => {
    need(lvl(ctx.perms, 'workflows') === 'F', 'Only a group admin can delete workflows.');
    await db.q("delete from crm.workflows where org_id = $1 and id = $2 and status <> 'published'", [ctx.orgId, p.id]);
    return { ok: true };
  }),
);

// ---------------------------------------------------------------- integrations: API keys, webhooks, Meta
on('GET', '/admin/integrations', ({ req }) =>
  inAdmin(req, 'integrations', async (db, ctx) => {
    const org = ctx.orgId;
    const wa = ctx.settings.integrations?.whatsapp ?? {};
    const ml = ctx.settings.integrations?.meta_leads ?? {};
    const [keys, hooks, sources, tokenHint, appHint, pageHint, verify, key, leads, tpl] = await Promise.all([
      db.q("select k.id, k.name, k.prefix, k.scopes, k.last_used_at, k.created_at, k.revoked_at from core.api_keys k where k.org_id = $1 and k.product_key = 'crm' and k.deleted_at is null order by k.created_at desc", [org]),
      db.q("select id, url, events, active, last_status, last_delivery_at from core.webhooks where org_id = $1 and product_key = 'crm' and deleted_at is null order by created_at desc", [org]),
      db.q('select id, name, channel from crm.sources where org_id = $1 and active order by channel, name', [org]),
      secretHint(db, 'wa_token'), secretHint(db, 'meta_app_secret'), secretHint(db, 'meta_page_token'), getSecret(db, 'meta_verify_token'),
      db.one('select webhook_key from crm.settings where org_id = $1', [org]),
      db.q('select status, count(*)::int n from crm.meta_leads where org_id = $1 group by status', [org]),
      db.q("select coalesce(provider_status, 'not sent') as s, count(*)::int n from core.message_templates where org_id = $1 and product_key = 'crm' and channel = 'whatsapp' and deleted_at is null group by 1", [org]),
    ]);
    const base = process.env.APP_URL ?? '';
    return {
      keys: keys.map((k) => ({ ...k, source_id: String(k.scopes?.find((x: string) => x.startsWith('source:')) ?? '').slice(7) || null })), hooks, sources,
      meta: { whatsapp: { phone_number_id: wa.phone_number_id ?? '', waba_id: wa.waba_id ?? '', enabled: !!wa.enabled, tokenHint, appSecretHint: appHint }, leads: { page_id: ml.page_id ?? '', pageHint }, verify, callbackUrl: `${base}/api/crm/webhooks/meta/${key?.webhook_key}`, leadStats: leads, templateStats: tpl },
      connectors: [
        ['WhatsApp Business API (Meta Cloud API)', 'Messaging', wa.enabled && wa.phone_number_id && tokenHint ? 'live' : 'simulated'], ['SMS (DLT registered)', 'Messaging', 'simulated'], ['Email sending domain', 'Messaging', 'simulated'],
        ['Cloud telephony', 'Telephony', 'not_connected'], ['Meta lead ads', 'Lead ads', ml.page_id && pageHint ? 'live' : 'not_connected'], ['Google Ads lead forms', 'Lead ads', 'not_connected'],
        ['Payment gateway (Razorpay / PayU / Cashfree)', 'Payments', 'simulated'], ['School ERP', 'ERP', 'not_connected'], ['Website forms and REST API', 'Website', 'live'], ['Outbound webhooks', 'Automation', 'live'],
      ],
      apiBase: `${base}/api/crm/v1`, branchName: ctx.branches[0]?.name ?? 'Main campus',
    };
  }),
);
on('POST', '/admin/api-keys', ({ req, b }) =>
  inAdmin(req, 'integrations', async (db, ctx, actor) => {
    const key = 'aed_' + crypto.randomBytes(24).toString('base64url');
    const src = str(b.source_id);
    await db.insert('core.api_keys', { product_key: 'crm', name: str(b.name) || 'API key', prefix: key.slice(0, 10), key_hash: hashKey(key), scopes: src ? [`source:${src}`] : [] });
    await log(db, actor, 'api_key', `Created API key "${str(b.name)}"`);
    return { ok: true, key, message: 'Copy this key now; it is not shown again.' };
  }),
);
on('POST', '/admin/api-keys/:id/revoke', ({ req, p }) =>
  inAdmin(req, 'integrations', async (db, ctx, actor) => {
    await db.q('update core.api_keys set revoked_at = now() where org_id = $1 and id = $2 and product_key = $3', [ctx.orgId, p.id, 'crm']);
    await log(db, actor, 'integration', 'Revoked an API key');
    return { ok: true };
  }),
);
on('POST', '/admin/webhooks', ({ req, b }) =>
  inAdmin(req, 'integrations', async (db, ctx, actor) => {
    const url = str(b.url);
    if (!/^https:\/\//.test(url)) fail('Webhook URLs must start with https://');
    const secret = crypto.randomBytes(16).toString('hex');
    const h = await db.insert('core.webhooks', { product_key: 'crm', url, events: [], secret_ref: 'crm.org_secrets' });
    await setSecret(db, `webhook_secret:${h.id}`, secret);
    await log(db, actor, 'integration', 'Added a webhook');
    return { ok: true, secret, message: 'Webhook added. The signing secret is shown once.' };
  }),
);
on('POST', '/admin/webhooks/:id/delete', ({ req, p }) =>
  inAdmin(req, 'integrations', async (db, ctx, actor) => {
    await db.q('delete from core.webhooks where org_id = $1 and id = $2 and product_key = $3', [ctx.orgId, p.id, 'crm']);
    await deleteSecret(db, `webhook_secret:${p.id}`);
    await log(db, actor, 'integration', 'Removed a webhook');
    return { ok: true };
  }),
);
on('POST', '/admin/meta', ({ req, b }) =>
  inAdmin(req, 'integrations', async (db, ctx, actor) => {
    const integrations = { ...(ctx.settings.integrations ?? {}) };
    const section = str(b.section);
    if (section === 'whatsapp') {
      integrations.whatsapp = { ...(integrations.whatsapp ?? {}), phone_number_id: str(b.phone_number_id), waba_id: str(b.waba_id), enabled: bool(b.enabled), updated_at: new Date().toISOString() };
      if (str(b.wa_token)) await setSecret(db, 'wa_token', str(b.wa_token));
    } else if (section === 'leads') {
      integrations.meta_leads = { ...(integrations.meta_leads ?? {}), page_id: str(b.page_id), updated_at: new Date().toISOString() };
      if (str(b.page_token)) await setSecret(db, 'meta_page_token', str(b.page_token));
    } else fail('Unknown section.');
    if (str(b.app_secret)) await setSecret(db, 'meta_app_secret', str(b.app_secret));
    if (bool(b.clear)) await deleteSecret(db, section === 'whatsapp' ? 'wa_token' : 'meta_page_token');
    if (!(await getSecret(db, 'meta_verify_token'))) await setSecret(db, 'meta_verify_token', crypto.randomBytes(16).toString('hex'));
    await setSettings(db, { integrations });
    await log(db, actor, 'integration', `Updated Meta ${section === 'whatsapp' ? 'WhatsApp' : 'lead ads'} settings`);
    return { ok: true, message: 'Saved. Use Test to check the connection.' };
  }),
);
on('POST', '/admin/meta/action', ({ req, b }) =>
  inAdmin(req, 'integrations', async (db, _c, actor) => {
    const what = str(b.what);
    if (what === 'test_wa') {
      const cfg = await waConfig(db);
      if (!cfg) fail('Fill in the phone number ID and access token, tick Use for sending, and save first.');
      const r = await waTest(cfg!);
      return { ok: r.ok, message: r.text };
    }
    if (what === 'sync_templates') {
      const r = await syncTemplates(db);
      await log(db, actor, 'template', `Synced WhatsApp templates with Meta: ${r.submitted} submitted, ${r.updated} refreshed`);
      return { ok: !r.errors.length, message: `${r.submitted} template(s) sent to Meta for review, ${r.updated} refreshed.` + (r.errors.length ? ` Problems: ${r.errors.slice(0, 3).join(' | ')}` : '') };
    }
    if (what === 'test_leads') {
      const r = await pageTest(db);
      return { ok: r.ok, message: r.text };
    }
    if (what === 'rotate_verify') {
      const t = crypto.randomBytes(16).toString('hex');
      await setSecret(db, 'meta_verify_token', t);
      return { ok: true, verify: t, message: "New verify token created. Paste it into your Meta app's webhook settings." };
    }
    fail('Unknown action.');
  }),
);

// ---------------------------------------------------------------- wallet
on('GET', '/admin/wallet', ({ req }) =>
  inAdmin(req, 'wallet', async (db, ctx) => {
    const org = ctx.orgId;
    const [ledger, usage, users, bal] = await Promise.all([
      db.q('select id, type, category, amount, note, created_at from crm.wallet_ledger where org_id = $1 order by created_at desc, id limit 40', [org]),
      db.q("select category, sum(amount)::float as amount, count(*)::int n from crm.wallet_ledger where org_id = $1 and type = 'debit' and created_at > now() - interval '30 days' group by category order by amount desc", [org]),
      db.one("select count(*)::int n from crm.staff_v where org_id = $1 and active and role_key <> 'system'", [org]),
      db.one('select wallet_balance from crm.settings where org_id = $1', [org]),
    ]);
    const sub = await db.one("select plan_key, status from core.subscriptions where org_id = $1 and product_key = 'crm' order by created_at desc limit 1", [org]).catch(() => null);
    return { balance: Number(bal!.wallet_balance), ledger, usage, users: users!.n, branches: ctx.branches.length, plan: sub?.plan_key ?? null, status: sub?.status ?? null };
  }),
);
on('POST', '/admin/wallet/recharge-request', ({ req }) =>
  inAdmin(req, 'wallet', async (db, ctx) => {
    await db.insert('core.support_tickets', { product_key: 'crm', user_id: ctx.user.id, kind: 'ticket', subject: 'Wallet recharge request', body: 'Please send a recharge link / invoice for message credits.', status: 'open' });
    return { ok: true, message: 'Request sent to AutoEd.' };
  }),
);

// ---------------------------------------------------------------- audit log
on('GET', '/admin/audit', async ({ req }) => {
  const { s, ctx } = await who(req);
  if (!adminSections(ctx.perms).includes('audit')) throw new ForbiddenError('Your role cannot open the audit log.');
  return asUser(s.userId, ctx.orgId, async (db) => ({
    events: await db.q('select * from crm.audit_events($1, $2, 200)', [str(req.query.action) || null, str(req.query.q) || null]),
    actions: ['config', 'permission', 'edit', 'export', 'import', 'delete', 'bulk', 'campaign', 'merge', 'erase'],
  }));
});

// ---------------------------------------------------------------- help
on('GET', '/admin/help', ({ req }) =>
  inAdmin(req, 'help', async (db, ctx) => ({
    tickets: await db.q("select t.id, t.kind, t.subject, t.body, t.status, t.reply, t.created_at, u.full_name as by from core.support_tickets t left join core.staff u on u.org_id = t.org_id and u.user_id = t.user_id where t.org_id = $1 and t.product_key = 'crm' and t.deleted_at is null order by t.created_at desc limit 30", [ctx.orgId]),
    // AutoEd support reaches a client only through time-limited view-as sessions (decision 37, core.support_sessions); those are listed read-only.
    support: await db.q('select id, reason, read_only, started_at, expires_at, ended_at from core.support_sessions where org_id = $1 order by started_at desc limit 10', [ctx.orgId]).catch(() => []),
  })),
);
on('POST', '/admin/tickets', ({ req, b }) =>
  inAdmin(req, 'help', async (db, ctx) => {
    if (!str(b.subject)) fail('Add a subject.');
    await db.insert('core.support_tickets', { product_key: 'crm', user_id: ctx.user.id, kind: str(b.kind) === 'feature' ? 'feature' : 'ticket', subject: str(b.subject), body: str(b.body) || null, status: 'open' });
    return { ok: true, message: 'Sent to AutoEd.' };
  }),
);

void getPool;
