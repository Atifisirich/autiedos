/**
 * Sign-in, sign-out, the shell (everything the app frame needs on every page) and the person's own account.
 * Sign-in is the platform's: Supabase Auth proves who the person is (phone or email OTP), the server exchanges that proof
 * for the platform session token; AUTH_PROVIDER=dev adds an email-only sign-in for demos and tests.
 */
import { asUser, getPool, UnauthorizedError } from '../db';
import { endSession, issueSession, verifySession, verifySupabaseToken } from '../auth';
import { ADMIN_SECTIONS, adminSections, canCreateLeads, canEditLeads, canMessage, has, leadScope } from '../perm';
import { asMe, bearer, fail, on, str, who } from './router';

const buckets = new Map<string, { tokens: number; at: number }>();
/** Token bucket per key (single instance memory; put a shared store in front for several instances). */
function allow(key: string, perMinute: number): boolean {
  const now = Date.now();
  const b = buckets.get(key) ?? { tokens: perMinute, at: now };
  b.tokens = Math.min(perMinute, b.tokens + ((now - b.at) / 60000) * perMinute);
  b.at = now;
  if (b.tokens < 1) {
    buckets.set(key, b);
    return false;
  }
  b.tokens -= 1;
  buckets.set(key, b);
  return true;
}

on('POST', '/auth/dev-login', async ({ req, b }) => {
  if (process.env.AUTH_PROVIDER !== 'dev') throw new UnauthorizedError('dev_login_disabled');
  if (!allow(`dev-login:${req.ip ?? 'local'}`, 30)) return { status: 429, json: { error: 'rate_limited' } };
  const email = str(b.email).toLowerCase();
  const id = ((await getPool().query('select crm.dev_user_by_email($1) as id', [email])).rows[0]?.id as string | null) ?? null;
  if (!id) throw new UnauthorizedError('unknown_user');
  const session = await issueSession(id, { platform: 'web', name: req.headers['user-agent']?.slice(0, 80) ?? null });
  return { status: 200, json: { ok: true }, setSession: session };
});

on('POST', '/auth/session', async ({ req, b }) => {
  if (!allow(`session:${req.ip ?? 'local'}`, 30)) return { status: 429, json: { error: 'rate_limited' } };
  const id = await verifySupabaseToken(str(b.accessToken));
  const session = await issueSession(id, { platform: b.platform === 'android' || b.platform === 'ios' ? b.platform : 'web', name: str(b.device) || null });
  return { status: 200, json: { ok: true, token: b.platform ? session.token : undefined }, setSession: session };
});

on('POST', '/auth/logout', async ({ req }) => {
  try {
    const s = await verifySession(bearer(req));
    await endSession(s.userId, s.sid);
  } catch {
    /* already signed out */
  }
  return { status: 200, json: { ok: true }, setSession: null };
});

/** Everything the app frame needs: who, what they may do, pickers, alerts, badges. One call per page load. */
on('GET', '/shell', ({ req }) =>
  asMe(req, async (db, ctx) => {
    const org = db.requireOrg();
    const me = ctx.user.id;
    const [notes, unread, sources, fields, overdue, inbox, wallet] = await Promise.all([
      db.q("select id, title, link, event_key as category, read_at, created_at from core.notifications where user_id = $1 and product_key = 'crm' and deleted_at is null order by created_at desc limit 20", [me]),
      db.one("select count(*)::int n from core.notifications where user_id = $1 and product_key = 'crm' and deleted_at is null and read_at is null", [me]),
      db.q('select id, name, channel from crm.sources where org_id = $1 and active order by channel, name', [org]),
      db.q(
        `select f.key, f.label, f.options, f.required from core.custom_fields f left join crm.field_settings s on s.org_id = f.org_id and s.entity = 'enquiry' and s.key = f.key
          where f.org_id = $1 and f.product_key = 'crm' and f.entity = 'enquiry' and f.active and f.deleted_at is null and f.field_type = 'select' and not coalesce(s.sensitive, false) order by f.seq`,
        [org],
      ),
      db.one("select count(*)::int n from crm.follow_ups where org_id = $1 and owner_id = $2 and status = 'open' and due_at < now()", [org, me]),
      db.one("select count(distinct household_id)::int n from crm.messages where org_id = $1 and direction = 'in' and not read", [org]),
      has(ctx.perms, 'payments') || has(ctx.perms, 'admin') ? db.one('select wallet_balance from crm.settings where org_id = $1', [org]) : Promise.resolve(null),
    ]);
    const s = ctx.settings;
    const p = ctx.perms;
    const m = (k: string) => s.modules?.[k] !== false;
    return {
      user: ctx.user,
      org: { id: ctx.orgId, name: ctx.org.name, color: s.brand_color ?? null },
      role: { key: ctx.roleKey, name: ctx.roleName },
      perms: p,
      scope: leadScope(p),
      years: ctx.years.map((y) => ({ id: y.id, name: y.name, status: y.status, is_current: y.is_current })),
      yearId: ctx.yearId,
      branches: ctx.branches.map((x) => ({ id: x.id, name: x.name })),
      branchId: ctx.branchId,
      grades: s.grades ?? [],
      boards: s.boards ?? [],
      closureReasons: s.closure_reasons ?? [],
      fees: s.fees ?? { registration: 1500, admission: 25000 },
      sources,
      fields: fields.map((f) => ({ key: f.key, label: f.label, options: f.options ?? [], required: !!f.required })),
      notifications: notes.map((n) => ({ id: n.id, title: n.title, link: n.link, category: n.category, read: !!n.read_at, at: n.created_at })),
      unread: unread!.n,
      badges: { tasks: overdue!.n, inbox: inbox!.n },
      nav: {
        leads: has(p, 'leads'), inbox: has(p, 'leads') && has(p, 'templates'), tasks: has(p, 'tasks'), visits: has(p, 'tasks') && m('visits'), applications: has(p, 'applications') && m('applications'),
        campaigns: has(p, 'campaigns') && m('campaigns'), reports: has(p, 'reports'), walkin: canCreateLeads(p), admin: has(p, 'admin') || has(p, 'workflows') || has(p, 'audit'),
      },
      can: { create: canCreateLeads(p), edit: canEditLeads(p), message: canMessage(p) },
      adminSections: adminSections(p),
      adminCatalogue: ADMIN_SECTIONS.filter(([k]) => adminSections(p).includes(k)).map(([key, label, description]) => ({ key, label, description })),
      wallet: wallet ? Number(wallet.wallet_balance) : null,
      demoPayments: process.env.DEMO_PAYMENTS === '1',
      authProvider: process.env.AUTH_PROVIDER === 'dev' ? 'dev' : 'supabase',
    };
  }),
);

on('POST', '/notifications/read', ({ req }) =>
  asMe(req, async (db, ctx) => {
    await db.q("update core.notifications set read_at = now() where user_id = $1 and product_key = 'crm' and read_at is null", [ctx.user.id]);
    return { ok: true };
  }),
);

/** The person's own account: profile and signed-in devices. Two-factor and passwords are the platform's (Supabase Auth). */
on('GET', '/account', async ({ req }) => {
  const { s, ctx } = await who(req);
  return asUser(s.userId, ctx.orgId, async (db) => {
    const devices = await db.q(
      "select id, device_name, platform, created_at, last_seen_at, revoked_at, token = $2 as current from core.device_tokens where user_id = $1 and token like 'session:%' and revoked_at is null order by created_at desc limit 20",
      [ctx.user.id, `session:${s.sid}`],
    );
    return { user: ctx.user, role: ctx.roleName, org: ctx.org.name, devices };
  });
});
on('POST', '/account/devices/:id/revoke', ({ req, p }) =>
  asMe(req, async (db, ctx) => {
    const r = await db.q("update core.device_tokens set revoked_at = now() where id = $1 and user_id = $2 and token like 'session:%' returning id", [p.id, ctx.user.id]);
    if (!r.length) fail('Device not found.', 404);
    return { ok: true };
  }),
);
