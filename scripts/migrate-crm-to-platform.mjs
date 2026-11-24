#!/usr/bin/env node
/**
 * Moves the AutoEd CRM (schema `autoed`, repo Atifisirich/autoedcrm) onto the unified platform: org, branches, people,
 * pipeline, families, enquiries and everything hanging off them, wallet, templates, jobs, secrets. Mapping: docs/MAP-TABLES.md
 * A.2 and C.2; run book: docs/crm-port.md.
 *
 *   SOURCE_DATABASE_URL=postgres://.../crmsource  DATABASE_URL=postgres://.../platform  APP_SECRET=...  \
 *     node scripts/migrate-crm-to-platform.mjs [--dry-run] [--tenant <id|subdomain>[,..]] [--source-schema autoed] [--json]
 *
 * Properties
 *  - Idempotent and re-runnable: ids are preserved (tenant -> org, user -> auth user, every row keeps its uuid) and every
 *    insert is `on conflict do nothing`, so a second run inserts nothing and cannot overwrite what happened after go-live.
 *    Settings and wallet balance are applied once per org (flag crm.settings.flags.legacy_migrated_at; --force-settings redoes it).
 *  - One transaction: everything or nothing. --dry-run does the whole load, prints the report and rolls back.
 *  - Row counts and checksums (md5 of the sorted ids, plus sums for money) per table, source versus target; exit code 1
 *    when anything differs.
 *  - Writes as the table owner (RLS bypassed), like every migration. Admission (core.admit_student) is run per won
 *    enquiry with the org's automation user as the acting user, exactly as the CRM server does.
 *  - Local databases only unless --allow-remote: the script refuses Supabase hosts by default.
 *  - Not migrated: sessions (platform sessions replace them), TOTP secrets and bcrypt-only login state (the platform
 *    uses Supabase Auth; hashes are copied into auth.users.encrypted_password when that column exists), support_access
 *    (no target table yet), jobs that are not queued.
 */
import crypto from 'node:crypto';
import pg from 'pg';

// ------------------------------------------------------------------ arguments
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const DRY = flag('dry-run');
const JSON_OUT = flag('json');
const SRC_URL = opt('source-url', process.env.SOURCE_DATABASE_URL);
const TGT_URL = opt('target-url', process.env.DATABASE_URL);
const S = opt('source-schema', process.env.SOURCE_SCHEMA ?? 'autoed');
const TENANTS = (opt('tenant', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
if (!SRC_URL || !TGT_URL) {
  console.error('Set SOURCE_DATABASE_URL and DATABASE_URL (or --source-url / --target-url).');
  process.exit(2);
}
for (const [what, u] of [['source', SRC_URL], ['target', TGT_URL]]) {
  const host = new URL(u).hostname;
  if (/supabase\.(co|com|net)|pooler\./i.test(host) && !flag('allow-remote')) {
    console.error(`Refusing to connect to ${what} host ${host}: this script is for local / staging databases (pass --allow-remote to override).`);
    process.exit(2);
  }
}

// dates and numerics stay strings so nothing is rounded on the way
pg.types.setTypeParser(1082, (v) => v);
pg.types.setTypeParser(1700, (v) => v);
pg.types.setTypeParser(20, (v) => Number(v));

// ------------------------------------------------------------------ small helpers
const slug = (s, fallback = 'x') => (String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || fallback);
const LANG = { english: 'en', hindi: 'hi', telugu: 'te', kannada: 'kn', tamil: 'ta', marathi: 'mr', malayalam: 'ml', bengali: 'bn', gujarati: 'gu', urdu: 'ur' };
const langCode = (l) => LANG[String(l ?? '').toLowerCase()] ?? (/^[a-z]{2}$/i.test(String(l ?? '')) ? String(l).toLowerCase() : 'en');
const coreLang = (c) => (['en', 'hi', 'te'].includes(c) ? c : 'en');
const relation = (r) => (['father', 'mother', 'guardian', 'other'].includes(String(r ?? '').toLowerCase()) ? String(r).toLowerCase() : 'guardian');
const gender = (g) => {
  const v = String(g ?? '').trim().toLowerCase();
  return ['girl', 'female', 'f'].includes(v) ? 'female' : ['boy', 'male', 'm'].includes(v) ? 'male' : v ? 'other' : null;
};
const splitName = (n) => {
  const p = String(n ?? '').trim().split(/\s+/);
  return [p[0] || 'Unknown', p.length > 1 ? p.slice(1).join(' ') : null];
};
const MASK = '••••••';
const isUuid = (s) => typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const asArr = (v) => (Array.isArray(v) ? v : typeof v === 'string' ? JSON.parse(v) : []);

function encryptSecret(plain) {
  const secret = process.env.APP_SECRET;
  if (!secret && !flag('allow-dev-secret')) throw new Error('APP_SECRET is required to encrypt webhook secrets (same value the CRM server uses), or pass --allow-dev-secret for a throw-away database.');
  const key = crypto.createHash('sha256').update(secret ?? 'autoed-dev-secret').digest();
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv.toString('base64'), c.getAuthTag().toString('base64'), data.toString('base64')].join('.');
}

// ------------------------------------------------------------------ connections, report
const src = new pg.Client({ connectionString: SRC_URL });
const tgt = new pg.Client({ connectionString: TGT_URL });
const sq = async (sql, params = []) => (await src.query(sql, params)).rows;
const tq = async (sql, params = []) => (await tgt.query(sql, params)).rows;

const report = { tables: {}, warnings: [], checks: [], started: new Date().toISOString() };
const rep = (name) => (report.tables[name] ??= { source: 0, inserted: 0, existing: 0 });
const warn = (m) => report.warnings.push(m);

/** Multi-row insert. `json` lists object columns (sent as JSON text), arrays pass through as Postgres arrays. */
async function bulk(table, rows, o = {}) {
  if (!rows.length) return 0;
  const cols = Object.keys(rows[0]);
  const json = new Set(o.json ?? []);
  const size = Math.max(1, Math.min(500, Math.floor(60000 / cols.length)));
  let inserted = 0;
  for (let i = 0; i < rows.length; i += size) {
    const part = rows.slice(i, i + size);
    const params = [];
    const tuples = part.map((r) => `(${cols.map((c) => {
      const v = r[c];
      params.push(json.has(c) && v !== null && v !== undefined ? JSON.stringify(v) : v === undefined ? null : v);
      return `$${params.length}${json.has(c) ? '::jsonb' : ''}`;
    }).join(',')})`);
    const res = await tgt.query(`insert into ${table} (${cols.map((c) => `"${c}"`).join(',')}) values ${tuples.join(',')} ${o.conflict ?? 'on conflict do nothing'}`, params);
    inserted += res.rowCount ?? 0;
  }
  return inserted;
}
const count = (name, srcRows, inserted) => {
  const t = rep(name);
  t.source += srcRows;
  t.inserted += inserted;
  t.existing += srcRows - inserted;
};

// ------------------------------------------------------------------ the load
async function main() {
  await src.connect();
  await tgt.connect();
  const tf = TENANTS.length ? `and (t.id::text = any($1) or t.subdomain = any($1))` : '';
  const tenantRows = await sq(`select * from ${S}.tenants t where true ${tf} order by created_at`, TENANTS.length ? [TENANTS] : []);
  if (!tenantRows.length) throw new Error(`no tenants found in ${S}.tenants`);
  const orgIds = tenantRows.map((t) => t.id);
  const inT = (col = 'tenant_id') => `${col} = any($1::uuid[])`;
  const rows = (table, extra = '', order = '') => sq(`select * from ${S}.${table} where ${inT()} ${extra} ${order}`, [orgIds]);

  await tgt.query('begin');
  try {
    const hasCol = async (schema, table, col) => (await tq('select 1 from information_schema.columns where table_schema=$1 and table_name=$2 and column_name=$3', [schema, table, col])).length > 0;
    const authHasPassword = await hasCol('auth', 'users', 'encrypted_password');
    const authHasAud = await hasCol('auth', 'users', 'aud');
    const authHasConfirmed = await hasCol('auth', 'users', 'email_confirmed_at');

    // ---- 1. organisations, subscriptions (the CRM subscription trigger creates crm.settings and the automation user)
    count('tenants -> core.organizations', tenantRows.length, await bulk('core.organizations', tenantRows.map((t) => ({
      id: t.id, name: t.name, slug: slug(t.subdomain, 'org').replace(/_/g, '-'), kind: 'school', preset_key: t.pack, branding: t.branding ?? {}, go_live_date: t.go_live_date, created_at: t.created_at,
    })), { json: ['branding'], conflict: 'on conflict (id) do nothing' }));
    const subStatus = { trial: 'trial', active: 'active', suspended: 'suspended', cancelled: 'cancelled', archived: 'cancelled' };
    count('tenants -> core.subscriptions(crm)', tenantRows.length, await bulk('core.subscriptions', tenantRows.map((t) => ({
      org_id: t.id, product_key: 'crm', status: subStatus[t.status] ?? 'suspended', plan_key: t.plan, starts_on: String(t.created_at.toISOString()).slice(0, 10),
    })), { conflict: 'on conflict (org_id, product_key) do nothing' }));
    const sysUsers = Object.fromEntries((await tq('select org_id, system_user_id from crm.settings where org_id = any($1::uuid[])', [orgIds])).map((r) => [r.org_id, r.system_user_id]));
    const force = flag('force-settings');
    let settingsApplied = 0;
    for (const t of tenantRows) {
      const settings = { ...(t.settings ?? {}) };
      delete settings.next_app_no;
      delete settings.next_receipt_no;
      const r = await tgt.query(
        `update crm.settings set settings = $2::jsonb, flags = $3::jsonb || jsonb_build_object('legacy_migrated_at', now()), onboarding = $4::jsonb, webhook_key = coalesce($5, webhook_key), wallet_balance = $6
          where org_id = $1 and ($7 or not (flags ? 'legacy_migrated_at'))`,
        [t.id, JSON.stringify(settings), JSON.stringify(t.flags ?? {}), JSON.stringify(t.onboarding ?? {}), t.webhook_key, t.wallet_balance, force],
      );
      settingsApplied += r.rowCount ?? 0;
    }
    count('tenants -> crm.settings', tenantRows.length, settingsApplied);

    // secrets (already encrypted by the CRM server with APP_SECRET; the same key keeps working)
    const secrets = await rows('tenant_secrets');
    count('tenant_secrets -> crm.org_secrets', secrets.length, await bulk('crm.org_secrets', secrets.map((s) => ({ org_id: s.tenant_id, key: s.key, value_enc: s.value_enc, updated_at: s.updated_at })), { conflict: 'on conflict (org_id, key) do nothing' }));

    // ---- 2. branches, academic years
    const branches = await rows('branches', '', 'order by name, id');
    const usedCodes = new Map();
    for (const r of await tq('select org_id, code from core.branches where org_id = any($1::uuid[])', [orgIds])) (usedCodes.get(r.org_id) ?? usedCodes.set(r.org_id, new Set()).get(r.org_id)).add(r.code);
    const existingBranch = new Set((await tq('select id from core.branches where org_id = any($1::uuid[])', [orgIds])).map((r) => r.id));
    const branchRows = branches.map((b) => {
      let code = slug(b.name, 'branch').replace(/_/g, '').slice(0, 8) || 'branch';
      const used = usedCodes.get(b.tenant_id) ?? usedCodes.set(b.tenant_id, new Set()).get(b.tenant_id);
      if (!existingBranch.has(b.id)) {
        let c = code, k = 1;
        while (used.has(c)) c = code.slice(0, 6) + ++k;
        code = c;
        used.add(code);
      }
      return { id: b.id, org_id: b.tenant_id, name: b.name, code, city: b.city, address: b.address, phone: b.phone, boards: asArr(b.boards), active: b.active };
    });
    count('branches -> core.branches', branches.length, await bulk('core.branches', branchRows, { conflict: 'on conflict (id) do nothing' }));
    count('branches -> crm.branch_settings', branches.length, await bulk('crm.branch_settings', branches.map((b) => ({ org_id: b.tenant_id, branch_id: b.id, open_hour: b.open_hour, close_hour: b.close_hour, visit_capacity: b.visit_capacity })), { conflict: 'on conflict (org_id, branch_id) do nothing' }));

    const years = await rows('academic_years', '', 'order by position');
    count('academic_years -> core.academic_years', years.length, await bulk('core.academic_years', years.map((y) => {
      const m = /(\d{4})\s*-\s*(\d{2,4})/.exec(y.name);
      let from;
      if (m) from = Number(m[1]);
      else {
        from = new Date().getFullYear();
        warn(`academic year "${y.name}": name is not YYYY-YY, dates assumed ${from}-04-01..${from + 1}-03-31`);
      }
      return { id: y.id, org_id: y.tenant_id, name: y.name, starts_on: `${from}-04-01`, ends_on: `${from + 1}-03-31`, is_current: y.is_default, status: y.status === 'closed' ? 'closed' : 'active', seq: y.position };
    }), { conflict: 'on conflict (id) do nothing' }));

    // ---- 3. roles and people
    const roles = await rows('roles', '', 'order by name');
    const roleKeys = new Map(); // source role id -> key
    {
      const taken = new Map();
      for (const r of await tq("select org_id, key from core.roles where org_id = any($1::uuid[]) and product_key = 'crm'", [orgIds])) (taken.get(r.org_id) ?? taken.set(r.org_id, new Set()).get(r.org_id)).add(r.key);
      const existingCrm = new Map((await tq('select id, key from crm.roles where org_id = any($1::uuid[])', [orgIds])).map((r) => [r.id, r.key]));
      for (const r of roles) {
        if (existingCrm.has(r.id)) { roleKeys.set(r.id, existingCrm.get(r.id)); continue; }
        const used = taken.get(r.tenant_id) ?? taken.set(r.tenant_id, new Set()).get(r.tenant_id);
        let key = slug(r.name, 'role'), k = 1;
        const base = key;
        while (used.has(key)) key = `${base}_${++k}`;
        used.add(key);
        roleKeys.set(r.id, key);
      }
    }
    await bulk('core.roles', roles.map((r) => ({ org_id: r.tenant_id, product_key: 'crm', key: roleKeys.get(r.id), name: r.name })), { conflict: 'on conflict (org_id, product_key, key) do nothing' });
    count('roles -> crm.roles (+core.roles, core.role_permissions via trigger)', roles.length, await bulk('crm.roles', roles.map((r) => ({ id: r.id, org_id: r.tenant_id, key: roleKeys.get(r.id), name: r.name, permissions: r.permissions ?? {}, is_system: r.is_system })), { json: ['permissions'], conflict: 'on conflict (id) do nothing' }));

    const users = await sq(`select * from ${S}.users order by created_at, id`);
    const staffUsers = users.filter((u) => u.tenant_id && orgIds.includes(u.tenant_id));
    const platformUsers = users.filter((u) => !u.tenant_id && (!TENANTS.length || true));
    // decision 37: one login = one organisation
    const clash = await tq('select user_id, org_id from core.org_users where user_id = any($1::uuid[])', [staffUsers.map((u) => u.id)]);
    for (const c of clash) if (staffUsers.find((u) => u.id === c.user_id)?.tenant_id !== c.org_id) throw new Error(`user ${c.user_id} already belongs to another organisation in the platform (decision 37)`);
    if (!flag('skip-auth-users')) {
      const authRows = [...staffUsers, ...platformUsers].map((u) => {
        const r = { id: u.id, email: u.email };
        if (authHasPassword) r.encrypted_password = u.password_hash;
        if (authHasAud) { r.aud = 'authenticated'; r.role = 'authenticated'; }
        if (authHasConfirmed) r.email_confirmed_at = u.created_at;
        return r;
      });
      count('users -> auth.users', authRows.length, await bulk('auth.users', authRows, { conflict: 'on conflict (id) do nothing' }));
    }
    const homeOf = (u) => asArr(u.branch_ids)[0] ?? null;
    count('users -> core.org_users', staffUsers.length, await bulk('core.org_users', staffUsers.map((u) => ({ org_id: u.tenant_id, user_id: u.id, kind: 'staff', display_name: u.name, status: u.status === 'active' ? 'active' : 'disabled', home_branch_id: homeOf(u) })), { conflict: 'on conflict (user_id) do nothing' }));
    await bulk('core.user_branch_access', staffUsers.flatMap((u) => asArr(u.branch_ids).slice(1).map((b) => ({ org_id: u.tenant_id, user_id: u.id, branch_id: b }))), { conflict: 'on conflict (user_id, branch_id) do nothing' });
    count('users -> core.staff', staffUsers.length, await bulk('core.staff', staffUsers.map((u) => {
      const [first, last] = splitName(u.name);
      return { org_id: u.tenant_id, user_id: u.id, branch_id: homeOf(u), first_name: first, last_name: last, email: u.email, status: u.status === 'active' ? 'active' : 'inactive', staff_type: 'admin', joined_on: String(u.created_at.toISOString()).slice(0, 10) };
    }), { conflict: 'on conflict (user_id) do nothing' }));
    for (const u of staffUsers.filter((x) => x.reports_to)) {
      await tgt.query('update core.staff s set reports_to = m.id from core.staff m where s.user_id = $1 and m.user_id = $2 and m.org_id = s.org_id and s.reports_to is null', [u.id, u.reports_to]);
    }
    count('users -> core.user_product_access(crm)', staffUsers.filter((u) => u.role_id).length, await bulk('core.user_product_access', staffUsers.filter((u) => u.role_id).map((u) => ({ org_id: u.tenant_id, user_id: u.id, product_key: 'crm', role_key: roleKeys.get(u.role_id) })), { conflict: 'on conflict (user_id, product_key) where revoked_at is null do nothing' }));
    count('users -> crm.counsellor_settings', staffUsers.length, await bulk('crm.counsellor_settings', staffUsers.map((u) => ({ org_id: u.tenant_id, user_id: u.id, daily_capacity: u.daily_capacity, on_leave: u.on_leave })), { conflict: 'on conflict (org_id, user_id) do nothing' }));
    count('users (platform) -> core.platform_admins', platformUsers.length, await bulk('core.platform_admins', platformUsers.map((u) => ({ user_id: u.id, name: u.name, active: u.status === 'active' })), { conflict: 'on conflict (user_id) do nothing' }));
    const orgUserIds = new Set(staffUsers.map((u) => u.id));
    const known = (id) => (id && orgUserIds.has(id) ? id : null);

    // ---- 4. pipeline, sources, programmes, routing, forms, fields, templates
    const phases = await rows('phases', '', 'order by position');
    count('phases -> crm.phases', phases.length, await bulk('crm.phases', phases.map((p) => ({ id: p.id, org_id: p.tenant_id, key: p.key, name: p.name, seq: p.position })), { conflict: 'on conflict (id) do nothing' }));
    const stages = await rows('stages', '', 'order by position');
    count('stages -> crm.stages', stages.length, await bulk('crm.stages', stages.map((s) => ({ id: s.id, org_id: s.tenant_id, phase_id: s.phase_id, name: s.name, seq: s.position, color: s.color, probability: s.probability, sla_hours: s.sla_hours, required_fields: s.required_fields ?? [], exempt_next_action: s.exempt_next_action, is_closed: s.is_closed, is_won: s.is_won, active: s.active })), { json: ['required_fields'], conflict: 'on conflict (id) do nothing' }));
    const sources = await rows('sources');
    count('sources -> crm.sources', sources.length, await bulk('crm.sources', sources.map((s) => ({ id: s.id, org_id: s.tenant_id, channel: s.channel, name: s.name, cost: s.cost, active: s.active })), { conflict: 'on conflict (id) do nothing' }));

    // programmes: one core.programmes row per (branch, board, grade); the per-year numbers become crm.intakes
    const progs = await rows('programmes', '', 'order by grade_order, id');
    const progKey = (r) => `${r.branch_id}|${r.board}|${r.grade}`;
    const progOf = new Map(); // key -> core programme id (first source id)
    for (const p of progs) if (!progOf.has(progKey(p))) progOf.set(progKey(p), p.id);
    const coreProgs = [...new Map(progs.map((p) => [progKey(p), p])).values()];
    count('programmes -> core.programmes (deduped by branch, board, grade)', coreProgs.length, await bulk('core.programmes', coreProgs.map((p) => ({ id: progOf.get(progKey(p)), org_id: p.tenant_id, branch_id: p.branch_id, name: p.grade, board: p.board, seq: p.grade_order, capacity: p.capacity })), { conflict: 'on conflict do nothing' }));
    // a programme row that already existed under another id (re-run after manual edits): resolve ids from the target
    for (const r of await tq('select id, branch_id, board, name from core.programmes where org_id = any($1::uuid[])', [orgIds])) {
      for (const [k] of [...progOf]) if (k === `${r.branch_id}|${r.board}|${r.name}`) progOf.set(k, r.id);
    }
    count('programmes -> crm.intakes', progs.length, await bulk('crm.intakes', progs.map((p) => ({ org_id: p.tenant_id, academic_year_id: p.year_id, programme_id: progOf.get(progKey(p)), capacity: p.capacity, min_age_years: p.min_age_years, age_cutoff: p.age_cutoff })), { conflict: 'on conflict (org_id, academic_year_id, programme_id) do nothing' }));

    const rules = await rows('assignment_rules', '', 'order by position');
    count('assignment_rules -> crm.assignment_rules', rules.length, await bulk('crm.assignment_rules', rules.map((r) => ({ id: r.id, org_id: r.tenant_id, name: r.name, seq: r.position, conditions: r.conditions ?? {}, method: r.method, user_ids: r.user_ids ?? [], pointer: r.pointer, active: r.active })), { json: ['conditions', 'user_ids'], conflict: 'on conflict (id) do nothing' }));
    const forms = await rows('forms');
    count('forms -> crm.forms', forms.length, await bulk('crm.forms', forms.map((f) => ({ id: f.id, org_id: f.tenant_id, slug: f.slug, name: f.name, branch_id: f.branch_id, source_id: f.source_id, fields: f.fields ?? [], thank_you: f.thank_you, active: f.active, submissions: f.submissions })), { json: ['fields'], conflict: 'on conflict (id) do nothing' }));

    const fields = await rows('custom_fields', '', 'order by position');
    const sensitiveKeys = new Map(); // org -> Set(keys)
    for (const f of fields) if (f.sensitive) (sensitiveKeys.get(f.tenant_id) ?? sensitiveKeys.set(f.tenant_id, new Set()).get(f.tenant_id)).add(f.key);
    const ftype = { text: 'text', select: 'select', number: 'number', date: 'date', boolean: 'boolean', multiselect: 'multiselect', phone: 'phone', email: 'email', file: 'file' };
    count('custom_fields -> core.custom_fields', fields.length, await bulk('core.custom_fields', fields.map((f) => {
      if (!/^[a-z][a-z0-9_]*$/.test(f.key)) warn(`custom field key "${f.key}" is not lower snake_case; loaded as ${slug(f.key)}`);
      return { id: f.id, org_id: f.tenant_id, product_key: 'crm', entity: f.entity, key: /^[a-z][a-z0-9_]*$/.test(f.key) ? f.key : slug(f.key), label: f.label, label_i18n: { en: f.label }, field_type: ftype[f.type] ?? 'text', options: f.options ?? [], required: f.required, seq: f.position, active: f.active };
    }), { json: ['label_i18n', 'options'], conflict: 'on conflict (id) do nothing' }));
    count('custom_fields -> crm.field_settings (sensitive flag)', fields.length, await bulk('crm.field_settings', fields.map((f) => ({ org_id: f.tenant_id, entity: f.entity, key: slug(f.key), sensitive: f.sensitive })), { conflict: 'on conflict (org_id, entity, key) do nothing' }));

    const tplStatus = { approved: 'approved', pending: 'submitted', rejected: 'rejected', draft: 'draft' };
    const templates = await rows('templates');
    count('templates -> core.message_templates(crm)', templates.length, await bulk('core.message_templates', templates.map((t) => {
      if (!['English', 'Hindi', 'Telugu'].includes(t.language) && t.language) warn(`template "${t.name}": language ${t.language} is not one of en/hi/te in core; loaded as en`);
      return { id: t.id, org_id: t.tenant_id, product_key: 'crm', name: t.name, channel: t.channel, language: coreLang(langCode(t.language)), category: t.category, body: t.body, status: tplStatus[t.status] ?? 'draft', provider_template_name: t.meta_name, provider_status: t.meta_status, provider_vars: t.meta_vars ?? [], provider_reason: t.meta_reason };
    }), { json: ['provider_vars'], conflict: 'on conflict (id) do nothing' }));

    // ---- 5. families, prospects, enquiries (sensitive custom values split out before the load)
    const households = await rows('households', '', 'order by created_at');
    count('households -> crm.households', households.length, await bulk('crm.households', households.map((h) => ({ id: h.id, org_id: h.tenant_id, address: h.address, locality: h.locality, pincode: h.pincode, home_language: h.home_language, sibling_in_school: h.sibling_in_school, heard_about: h.heard_about, inbox_status: h.inbox_status, created_at: h.created_at })), { conflict: 'on conflict (id) do nothing' }));
    const guardians = await rows('guardians');
    count('guardians -> crm.guardians', guardians.length, await bulk('crm.guardians', guardians.map((g) => ({ id: g.id, org_id: g.tenant_id, household_id: g.household_id, name: g.name, relation: relation(g.relation), phone: g.mobile, alt_phone: g.alt_mobile, email: g.email, occupation: g.occupation, is_primary: g.is_primary, language: langCode(g.language) })), { conflict: 'on conflict (id) do nothing' }));
    // consent jsonb -> core.consents (subject crm_guardian). A missing key meant "allowed" in the CRM; it is written as granted.
    const haveConsent = new Set((await tq("select crm_contact_id::text || ':' || purpose k from core.consents where org_id = any($1::uuid[]) and subject_type = 'crm_guardian'", [orgIds])).map((r) => r.k));
    const consentRows = [];
    for (const g of guardians) {
      const c = g.consent ?? {};
      for (const ch of ['whatsapp', 'sms', 'email', 'call']) {
        if (haveConsent.has(`${g.id}:${ch}`)) continue;
        const granted = c[ch] === undefined ? true : !!c[ch];
        const at = c.at ?? new Date().toISOString();
        consentRows.push({ org_id: g.tenant_id, subject_type: 'crm_guardian', crm_contact_id: g.id, purpose: ch, granted, wording_version: c.wording ?? null, source: c.source ?? null, granted_at: at, withdrawn_at: granted ? null : at, product_key: 'crm' });
      }
    }
    count('guardians.consent -> core.consents(crm_guardian)', guardians.length * 4, await bulk('core.consents', consentRows, { conflict: 'on conflict do nothing' }));

    const students = await rows('students');
    count('students -> crm.prospects', students.length, await bulk('crm.prospects', students.map((s) => {
      const [first, last] = splitName(s.name);
      return { id: s.id, org_id: s.tenant_id, household_id: s.household_id, first_name: first, last_name: last, dob: s.dob, gender: gender(s.gender), current_school: s.current_school, current_grade: s.current_grade, special_needs: s.special_needs };
    }), { conflict: 'on conflict (id) do nothing' }));

    const enquiries = await rows('enquiries', '', 'order by created_at');
    const sensRows = [];
    const enqRows = enquiries.map((e) => {
      const custom = { ...(e.custom ?? {}) };
      const sens = {};
      for (const k of sensitiveKeys.get(e.tenant_id) ?? []) {
        if (custom[k] !== undefined && custom[k] !== null && custom[k] !== '') { sens[k] = custom[k]; custom[k] = MASK; }
      }
      if (Object.keys(sens).length) sensRows.push({ org_id: e.tenant_id, branch_id: e.branch_id, enquiry_id: e.id, data: sens });
      const pid = progOf.get(`${e.branch_id}|${e.board}|${e.grade}`) ?? [...progOf].find(([k]) => k.startsWith(`${e.branch_id}|`) && k.endsWith(`|${e.grade}`))?.[1] ?? null;
      return {
        id: e.id, org_id: e.tenant_id, household_id: e.household_id, prospect_id: e.student_id, branch_id: e.branch_id, academic_year_id: e.year_id, programme_id: pid, board: e.board, grade: e.grade,
        stage_id: e.stage_id, owner_id: e.owner_id, score: e.score, engagement: e.engagement, temperature: e.temperature, expected_decision: e.expected_decision, closure_reason: e.closure_reason,
        custom, tags: e.tags ?? [], application_no: e.application_no, public_token: e.public_token, reenquired: e.reenquired, first_response_at: e.first_response_at, last_activity_at: e.last_activity_at,
        stage_entered_at: e.stage_entered_at, created_at: e.created_at, updated_at: e.updated_at,
      };
    });
    // the sensitive-field trigger would re-split these rows by the acting user's rights; the script has split them already
    await tgt.query('alter table crm.enquiries disable trigger trg_enquiry_sensitive');
    count('enquiries -> crm.enquiries', enquiries.length, await bulk('crm.enquiries', enqRows, { json: ['custom', 'tags'], conflict: 'on conflict (id) do nothing' }));
    await tgt.query('alter table crm.enquiries enable trigger trg_enquiry_sensitive');
    count('enquiries (sensitive custom values) -> crm.enquiry_sensitive', sensRows.length, await bulk('crm.enquiry_sensitive', sensRows, { json: ['data'], conflict: 'on conflict (org_id, enquiry_id) do nothing' }));

    // ---- 6. everything that hangs off an enquiry
    const touches = await rows('source_touches', '', 'order by created_at');
    count('source_touches -> crm.source_touches', touches.length, await bulk('crm.source_touches', touches.map((t) => ({ id: t.id, org_id: t.tenant_id, enquiry_id: t.enquiry_id, source_id: t.source_id, channel: t.channel, source: t.source, campaign: t.campaign, utm: t.utm ?? {}, created_at: t.created_at })), { json: ['utm'], conflict: 'on conflict (id) do nothing' }));
    const acts = await rows('activities', '', 'order by created_at');
    count('activities -> crm.activities', acts.length, await bulk('crm.activities', acts.map((a) => ({ id: a.id, org_id: a.tenant_id, household_id: a.household_id, enquiry_id: a.enquiry_id, type: a.type, actor_id: a.actor_id, outcome: a.outcome, content: a.content, meta: a.meta ?? {}, created_at: a.created_at })), { json: ['meta'], conflict: 'on conflict (id) do nothing' }));
    const tasks = await rows('tasks');
    count('tasks -> crm.follow_ups', tasks.length, await bulk('crm.follow_ups', tasks.map((t) => ({ id: t.id, org_id: t.tenant_id, enquiry_id: t.enquiry_id, household_id: t.household_id, type: t.type, title: t.title, due_at: t.due_at, owner_id: t.owner_id, priority: t.priority, status: t.status, outcome: t.outcome, completed_at: t.completed_at, created_at: t.created_at })), { conflict: 'on conflict (id) do nothing' }));
    const visits = await rows('visits');
    count('visits -> crm.visits', visits.length, await bulk('crm.visits', visits.map((v) => ({ id: v.id, org_id: v.tenant_id, enquiry_id: v.enquiry_id, household_id: v.household_id, branch_id: v.branch_id, type: v.type, slot_at: v.slot_at, host_id: known(v.host_id), status: v.status, checked_in_at: v.checked_in_at, outcome: v.outcome, created_at: v.created_at })), { conflict: 'on conflict (id) do nothing' }));
    const apps = await rows('applications');
    count('applications -> crm.applications', apps.length, await bulk('crm.applications', apps.map((a) => ({ id: a.id, org_id: a.tenant_id, enquiry_id: a.enquiry_id, progress: a.progress, answers: a.answers ?? {}, declaration: a.declaration, status: a.status, submitted_at: a.submitted_at, created_at: a.created_at, updated_at: a.updated_at })), { json: ['answers'], conflict: 'on conflict (id) do nothing' }));
    const docs = await rows('documents');
    count('documents -> crm.enquiry_documents', docs.length, await bulk('crm.enquiry_documents', docs.map((d) => ({ id: d.id, org_id: d.tenant_id, enquiry_id: d.enquiry_id, type: d.type, status: d.status, file_name: d.file_name, reject_reason: d.reject_reason, verifier_id: known(d.verifier_id), updated_at: d.updated_at })), { conflict: 'on conflict (id) do nothing' }));
    const pays = await rows('payments', '', 'order by created_at');
    count('payments -> crm.payments', pays.length, await bulk('crm.payments', pays.map((p) => ({ id: p.id, org_id: p.tenant_id, enquiry_id: p.enquiry_id, purpose: p.purpose, amount: p.amount, mode: p.mode, reference: p.reference, status: p.status, receipt_no: p.receipt_no, verified_by: known(p.verified_by), token: p.token, created_at: p.created_at, paid_at: p.paid_at })), { conflict: 'on conflict (id) do nothing' }));

    // ---- 7. campaigns, inbox, workflows, imports, Meta log, wallet
    const camps = await rows('campaigns');
    count('campaigns -> crm.campaigns', camps.length, await bulk('crm.campaigns', camps.map((c) => ({ id: c.id, org_id: c.tenant_id, name: c.name, channel: c.channel, template_id: c.template_id, audience: c.audience ?? {}, status: c.status, stats: c.stats ?? {}, cost: c.cost, sent_at: c.sent_at, created_at: c.created_at, created_by: known(c.created_by) })), { json: ['audience', 'stats'], conflict: 'on conflict (id) do nothing' }));
    const msgs = await rows('messages', '', 'order by created_at');
    count('messages -> crm.messages', msgs.length, await bulk('crm.messages', msgs.map((m) => ({ id: m.id, org_id: m.tenant_id, household_id: m.household_id, enquiry_id: m.enquiry_id, channel: m.channel, direction: m.direction, body: m.body, status: m.status, fail_reason: m.fail_reason, campaign_id: m.campaign_id, sender_id: m.sender_id, is_note: m.is_note, read: m.read, provider_id: m.provider_id, delivered_at: m.delivered_at, read_at: m.read_at, created_at: m.created_at })), { conflict: 'on conflict (id) do nothing' }));
    const wfs = await rows('workflows');
    count('workflows -> crm.workflows', wfs.length, await bulk('crm.workflows', wfs.map((w) => ({ id: w.id, org_id: w.tenant_id, recipe_key: w.recipe_key, name: w.name, description: w.description, trigger: w.trigger, conditions: w.conditions ?? [], steps: w.steps ?? [], status: w.status, version: w.version, updated_at: w.updated_at })), { json: ['conditions', 'steps'], conflict: 'on conflict (id) do nothing' }));
    const runs = await rows('workflow_runs', '', 'order by created_at');
    count('workflow_runs -> crm.workflow_runs', runs.length, await bulk('crm.workflow_runs', runs.map((r) => ({ id: r.id, org_id: r.tenant_id, workflow_id: r.workflow_id, enquiry_id: r.enquiry_id, status: r.status, entry_stage_id: r.entry_stage_id, log: r.log ?? [], test: r.test, created_at: r.created_at })), { json: ['log'], conflict: 'on conflict (id) do nothing' }));
    const batches = await rows('import_batches');
    count('import_batches -> crm.import_batches', batches.length, await bulk('crm.import_batches', batches.map((b) => ({ id: b.id, org_id: b.tenant_id, file_name: b.file_name, total: b.total, created: b.created, duplicates: b.duplicates, failed: b.failed, status: b.status, created_at: b.created_at, created_by: known(b.created_by) })), { conflict: 'on conflict (id) do nothing' }));
    const irows = await rows('import_rows');
    count('import_rows -> crm.import_rows', irows.length, await bulk('crm.import_rows', irows.map((r) => ({ id: r.id, org_id: r.tenant_id, batch_id: r.batch_id, data: r.data ?? {}, status: r.status, error: r.error, match_household_id: r.match_household_id, enquiry_id: r.enquiry_id })), { json: ['data'], conflict: 'on conflict (id) do nothing' }));
    const metaLeads = await rows('meta_leads');
    count('meta_leads -> crm.meta_leads', metaLeads.length, await bulk('crm.meta_leads', metaLeads.map((m) => ({ leadgen_id: m.leadgen_id, org_id: m.tenant_id, enquiry_id: m.enquiry_id, status: m.status, detail: m.detail, created_at: m.created_at })), { conflict: 'on conflict (leadgen_id) do nothing' }));
    const ledger = await rows('wallet_ledger', '', 'order by created_at, id');
    const bal = new Map();
    count('wallet_ledger -> crm.wallet_ledger', ledger.length, await bulk('crm.wallet_ledger', ledger.map((l) => {
      const b = (bal.get(l.tenant_id) ?? 0) + (l.type === 'credit' ? 1 : -1) * Number(l.amount);
      bal.set(l.tenant_id, b);
      return { id: l.id, org_id: l.tenant_id, type: l.type, category: l.category, amount: l.amount, balance_after: b.toFixed(2), note: l.note, created_at: l.created_at };
    }), { conflict: 'on conflict (id) do nothing' }));

    // ---- 8. notifications, saved views, keys, hooks, tickets, push tokens, jobs, audit
    const notes = await rows('notifications', '', 'order by created_at');
    count('notifications -> core.notifications', notes.length, await bulk('core.notifications', notes.map((n) => ({ id: n.id, org_id: n.tenant_id, user_id: n.user_id, product_key: 'crm', event_key: n.category, title: n.title, link: n.link, read_at: n.read ? n.created_at : null, created_at: n.created_at })), { conflict: 'on conflict (id) do nothing' }));
    const views = await rows('saved_views');
    count('saved_views -> crm.saved_views', views.length, await bulk('crm.saved_views', views.map((v) => ({ id: v.id, org_id: v.tenant_id, user_id: v.user_id, name: v.name, shared: v.shared, query: v.query })), { conflict: 'on conflict (id) do nothing' }));
    const keys = await rows('api_keys');
    count('api_keys -> core.api_keys(crm)', keys.length, await bulk('core.api_keys', keys.map((k) => ({ id: k.id, org_id: k.tenant_id, product_key: 'crm', name: k.name, prefix: k.key_prefix, key_hash: k.key_hash, scopes: k.source_id ? [`source:${k.source_id}`] : [], last_used_at: k.last_used, created_at: k.created_at })), { conflict: 'on conflict (id) do nothing' }));
    const hooks = (await rows('webhooks')).filter((w) => {
      if (/^https:\/\//.test(w.url)) return true;
      warn(`webhook ${w.id} (${w.url}) is not https and was skipped: core.webhooks requires https`);
      return false;
    });
    count('webhooks -> core.webhooks(crm) (+crm.org_secrets)', hooks.length, await bulk('core.webhooks', hooks.map((w) => ({ id: w.id, org_id: w.tenant_id, product_key: 'crm', url: w.url, events: asArr(w.events), active: w.active, secret_ref: `webhook_secret:${w.id}`, created_at: w.created_at })), { conflict: 'on conflict (id) do nothing' }));
    await bulk('crm.org_secrets', hooks.map((w) => ({ org_id: w.tenant_id, key: `webhook_secret:${w.id}`, value_enc: encryptSecret(w.secret) })), { conflict: 'on conflict (org_id, key) do nothing' });
    const tickets = await rows('tickets');
    count('tickets -> core.support_tickets(crm)', tickets.length, await bulk('core.support_tickets', tickets.map((t) => ({ id: t.id, org_id: t.tenant_id, product_key: 'crm', user_id: t.user_id, kind: t.kind, subject: t.subject, body: t.body, priority: t.priority, status: t.status, reply: t.reply, created_at: t.created_at })), { conflict: 'on conflict (id) do nothing' }));
    const access = await rows('support_access');
    if (access.length) warn(`${access.length} support_access row(s) were NOT migrated: the platform's audit.support_access does not exist yet (support sessions are core.support_sessions)`);
    const userOrg = new Map(staffUsers.map((u) => [u.id, u.tenant_id]));
    const push = (await sq(`select * from ${S}.push_tokens`)).filter((p) => userOrg.has(p.user_id));
    count('push_tokens -> core.device_tokens', push.length, await bulk('core.device_tokens', push.map((p) => ({ org_id: userOrg.get(p.user_id), user_id: p.user_id, token: p.token, platform: ['ios', 'android', 'web'].includes(p.platform) ? p.platform : null, last_seen_at: p.updated_at })), { conflict: 'on conflict (token) do nothing' }));
    const jobs = await rows('jobs', "and status = 'queued'");
    count('jobs (queued) -> private.jobs', jobs.length, await bulk('private.jobs', jobs.map((j) => ({ id: j.id, org_id: j.tenant_id, product_key: 'crm', kind: j.kind, payload: j.payload ?? {}, status: 'queued', run_at: j.run_at, created_at: j.created_at })), { json: ['payload'], conflict: 'on conflict (id) do nothing' }));

    const audits = await rows('audit_events', '', 'order by created_at');
    const haveAudit = new Set((await tq("select detail->>'legacy_id' k from audit.log where org_id = any($1::uuid[]) and detail ? 'legacy_id'", [orgIds])).map((r) => r.k));
    const newAudit = audits.filter((a) => !haveAudit.has(a.id));
    count('audit_events -> audit.log', audits.length, await bulk('audit.log', newAudit.map((a) => ({
      org_id: a.tenant_id, actor_user_id: known(a.user_id), action: 'crm.' + a.action, schema_name: 'crm', table_name: a.entity, row_id: isUuid(a.entity_id) ? a.entity_id : null,
      before: a.before ?? null, after: a.after ?? null, detail: { legacy_id: a.id, summary: a.summary, user_name: a.user_name, ip: a.ip }, created_at: a.created_at,
    })), { json: ['before', 'after', 'detail'], conflict: '' }));
    // audit_events rows of platform staff (tenant_id null) have no org to belong to
    const orphanAudit = await sq(`select count(*)::int n from ${S}.audit_events where tenant_id is null`);
    if (orphanAudit[0].n) warn(`${orphanAudit[0].n} audit_events row(s) without a tenant were not migrated`);

    // ---- 9. number series continue where the CRM left off (OQ-16)
    for (const t of tenantRows) {
      const s = t.settings ?? {};
      const appPrefix = s.app_no_prefix ?? 'APP';
      const byYear = new Map();
      for (const e of enquiries.filter((x) => x.tenant_id === t.id && x.application_no)) {
        const m = /^(.*)-(\d\d)-(\d+)$/.exec(e.application_no);
        if (!m) continue;
        const yr = years.find((y) => y.tenant_id === t.id && String(y.name).slice(2, 4) === m[2]);
        if (!yr) continue;
        byYear.set(yr.id, Math.max(byYear.get(yr.id) ?? 0, Number(m[3])));
      }
      const current = years.find((y) => y.tenant_id === t.id && y.is_default);
      for (const [yid, max] of byYear) {
        const yr = years.find((y) => y.id === yid);
        const next = Math.max(max + 1, yid === current?.id ? Number(s.next_app_no ?? 1) : 1);
        await tgt.query(
          `insert into core.number_series (org_id, key, academic_year_id, prefix, padding, next_value, product_key) values ($1, 'crm_application', $2, $3, 4, $4, 'crm')
           on conflict (org_id, branch_id, key, academic_year_id) do nothing`,
          [t.id, yid, `${appPrefix}-${String(yr.name).slice(2, 4)}-`, next],
        );
      }
      const maxReceipt = Math.max(0, ...pays.filter((p) => p.tenant_id === t.id && p.receipt_no).map((p) => Number((/(\d+)$/.exec(p.receipt_no) ?? [0, 0])[1])));
      await tgt.query(
        `insert into core.number_series (org_id, key, academic_year_id, prefix, padding, next_value, product_key) values ($1, 'crm_receipt', null, $2, 5, $3, 'crm')
         on conflict (org_id, branch_id, key, academic_year_id) do nothing`,
        [t.id, `${s.receipt_prefix ?? 'RCPT'}-`, Math.max(maxReceipt + 1, Number(s.next_receipt_no ?? 1))],
      );
    }

    // ---- 10. admission: every enquiry in a won stage becomes a core student (decision 38), as the CRM server does it
    const won = (await sq(`select e.id, e.tenant_id, e.created_at from ${S}.enquiries e join ${S}.stages s on s.id = e.stage_id where s.is_won and e.tenant_id = any($1::uuid[]) order by e.created_at`, [orgIds]));
    let admitted = 0, skipped = 0;
    if (!flag('no-admit')) {
      const active = new Set((await tq(`select org_id from core.subscriptions where org_id = any($1::uuid[]) and product_key = 'crm' and status in ('trial','active','past_due')`, [orgIds])).map((r) => r.org_id));
      for (const e of won) {
        if (!active.has(e.tenant_id) || !sysUsers[e.tenant_id]) { skipped++; continue; }
        await tgt.query(`select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)`, [JSON.stringify({ sub: sysUsers[e.tenant_id], role: 'authenticated' }), sysUsers[e.tenant_id]]);
        const r = (await tq('select core.admit_student($1) as r', [e.id]))[0].r;
        if (r.created) admitted++;
      }
      await tgt.query(`select set_config('request.jwt.claims', '', true), set_config('request.jwt.claim.sub', '', true)`);
      if (skipped) warn(`${skipped} won enquiry(ies) were not admitted into core because their organisation has no active CRM subscription; run core.admit_student when it does`);
    }
    count('won enquiries -> core.students (core.admit_student)', won.length, admitted);

    // ---- 11. checksums: source vs target. Ids are preserved, so the target side is restricted to the ids the source
    //          holds (a re-run after go-live is not confused by rows created since). md5 over id + business columns.
    const H = (expr, key) => `count(*)::int n, md5(coalesce(string_agg(${expr}, ',' order by ${key}), '')) h`;
    // [name, source table, source expr, source key, target table, target expr, target key, target org column, target extra where, key type]
    const CHK = [
      ['tenants -> organizations', 'tenants', 'id::text', 'id', 'core.organizations', 'id::text', 'id', 'id', '', 'uuid'],
      ['branches', 'branches', 'id::text || name', 'id', 'core.branches', 'id::text || name', 'id', 'org_id', '', 'uuid'],
      ['academic_years', 'academic_years', 'id::text || name', 'id', 'core.academic_years', 'id::text || name', 'id', 'org_id', '', 'uuid'],
      ['roles', 'roles', 'id::text || name', 'id', 'crm.roles', 'id::text || name', 'id', 'org_id', '', 'uuid'],
      ['users -> staff', 'users', 'id::text || email', 'id', 'core.staff', 'user_id::text || email', 'user_id', 'org_id', '', 'uuid'],
      ['phases', 'phases', 'id::text || key', 'id', 'crm.phases', 'id::text || key', 'id', 'org_id', '', 'uuid'],
      ['stages', 'stages', 'id::text || name || is_won::text', 'id', 'crm.stages', 'id::text || name || is_won::text', 'id', 'org_id', '', 'uuid'],
      ['sources', 'sources', 'id::text || name', 'id', 'crm.sources', 'id::text || name', 'id', 'org_id', '', 'uuid'],
      ['households', 'households', 'id::text', 'id', 'crm.households', 'id::text', 'id', 'org_id', '', 'uuid'],
      ['guardians (id, mobile)', 'guardians', 'id::text || mobile', 'id', 'crm.guardians', 'id::text || phone', 'id', 'org_id', '', 'uuid'],
      ['students -> prospects', 'students', 'id::text', 'id', 'crm.prospects', 'id::text', 'id', 'org_id', '', 'uuid'],
      ['enquiries (id, stage, owner, score)', 'enquiries', 'id::text || stage_id::text || owner_id::text || score::text', 'id', 'crm.enquiries', 'id::text || stage_id::text || owner_id::text || score::text', 'id', 'org_id', '', 'uuid'],
      ['source_touches', 'source_touches', 'id::text', 'id', 'crm.source_touches', 'id::text', 'id', 'org_id', '', 'uuid'],
      ['activities', 'activities', 'id::text', 'id', 'crm.activities', 'id::text', 'id', 'org_id', '', 'uuid'],
      ['tasks -> follow_ups', 'tasks', 'id::text || status', 'id', 'crm.follow_ups', 'id::text || status', 'id', 'org_id', '', 'uuid'],
      ['visits', 'visits', 'id::text || status', 'id', 'crm.visits', 'id::text || status', 'id', 'org_id', '', 'uuid'],
      ['applications', 'applications', 'id::text || status', 'id', 'crm.applications', 'id::text || status', 'id', 'org_id', '', 'uuid'],
      ['documents -> enquiry_documents', 'documents', 'id::text || status', 'id', 'crm.enquiry_documents', 'id::text || status', 'id', 'org_id', '', 'uuid'],
      ['payments (id, amount, status)', 'payments', 'id::text || amount::text || status', 'id', 'crm.payments', 'id::text || amount::text || status', 'id', 'org_id', '', 'uuid'],
      ['templates -> message_templates', 'templates', 'id::text || name', 'id', 'core.message_templates', 'id::text || name', 'id', 'org_id', "and product_key = 'crm'", 'uuid'],
      ['campaigns', 'campaigns', 'id::text || cost::text', 'id', 'crm.campaigns', 'id::text || cost::text', 'id', 'org_id', '', 'uuid'],
      ['messages', 'messages', 'id::text || status', 'id', 'crm.messages', 'id::text || status', 'id', 'org_id', '', 'uuid'],
      ['workflows', 'workflows', 'id::text || name', 'id', 'crm.workflows', 'id::text || name', 'id', 'org_id', '', 'uuid'],
      ['workflow_runs', 'workflow_runs', 'id::text || status', 'id', 'crm.workflow_runs', 'id::text || status', 'id', 'org_id', '', 'uuid'],
      ['custom_fields', 'custom_fields', 'id::text || key', 'id', 'core.custom_fields', 'id::text || key', 'id', 'org_id', "and product_key = 'crm'", 'uuid'],
      ['assignment_rules', 'assignment_rules', 'id::text || name', 'id', 'crm.assignment_rules', 'id::text || name', 'id', 'org_id', '', 'uuid'],
      ['forms', 'forms', 'id::text || slug', 'id', 'crm.forms', 'id::text || slug', 'id', 'org_id', '', 'uuid'],
      ['notifications', 'notifications', 'id::text', 'id', 'core.notifications', 'id::text', 'id', 'org_id', "and product_key = 'crm'", 'uuid'],
      ['saved_views', 'saved_views', 'id::text || name', 'id', 'crm.saved_views', 'id::text || name', 'id', 'org_id', '', 'uuid'],
      ['wallet_ledger (id, type, amount)', 'wallet_ledger', 'id::text || type || amount::text', 'id', 'crm.wallet_ledger', 'id::text || type || amount::text', 'id', 'org_id', '', 'uuid'],
      ['tickets -> support_tickets', 'tickets', 'id::text || status', 'id', 'core.support_tickets', 'id::text || status', 'id', 'org_id', "and product_key = 'crm'", 'uuid'],
      ['meta_leads', 'meta_leads', 'leadgen_id', 'leadgen_id', 'crm.meta_leads', 'leadgen_id', 'leadgen_id', 'org_id', '', 'text'],
      ['api_keys', 'api_keys', 'id::text || key_hash', 'id', 'core.api_keys', 'id::text || key_hash', 'id', 'org_id', "and product_key = 'crm'", 'uuid'],
      ['jobs (queued) -> private.jobs', 'jobs', 'id::text || kind', 'id', 'private.jobs', 'id::text || kind', 'id', 'org_id', "and product_key = 'crm'", 'uuid'],
      ['tenant_secrets -> org_secrets', 'tenant_secrets', "key || value_enc", 'key', 'crm.org_secrets', "key || value_enc", 'key', 'org_id', '', 'text'],
    ];
    const srcFilter = { jobs: "and status = 'queued'" };
    for (const [name, st, se, sk, tt, te, tk, tcol, tw, kt] of CHK) {
      const tenantCol = st === 'tenants' ? 'id' : 'tenant_id';
      const x = (await sq(`select ${H(se, sk)} from ${S}.${st} where ${tenantCol} = any($1::uuid[]) ${srcFilter[st] ?? ''}`, [orgIds]))[0];
      const ids = (await sq(`select ${sk}::text k from ${S}.${st} where ${tenantCol} = any($1::uuid[]) ${srcFilter[st] ?? ''}`, [orgIds])).map((r) => r.k);
      const y = (await tq(`select ${H(te, tk)} from ${tt} where ${tcol} = any($1::uuid[]) and ${tk} = any($2::${kt}[]) ${tw}`, [orgIds, ids]))[0];
      report.checks.push({ table: name, source: x.n, target: y.n, checksum: y.h.slice(0, 12), ok: x.n === y.n && x.h === y.h });
    }
    const pairs = [
      ['programmes -> intakes (rows)', `select count(*)::int n from ${S}.programmes where tenant_id = any($1::uuid[])`, `select count(*)::int n from crm.intakes where org_id = any($1::uuid[]) and academic_year_id in (select id from ${'core.academic_years'} where org_id = any($1::uuid[]))`],
      ['payments: sum(amount)', `select coalesce(sum(amount),0)::numeric(14,2)::text n from ${S}.payments where tenant_id = any($1::uuid[])`, `select coalesce(sum(amount),0)::numeric(14,2)::text n from crm.payments where org_id = any($1::uuid[]) and id = any($2::uuid[])`],
      ['wallet: sum(credits - debits)', `select coalesce(sum(case when type='credit' then amount else -amount end),0)::numeric(14,2)::text n from ${S}.wallet_ledger where tenant_id = any($1::uuid[])`, `select coalesce(sum(case when type='credit' then amount else -amount end),0)::numeric(14,2)::text n from crm.wallet_ledger where org_id = any($1::uuid[]) and id = any($2::uuid[])`],
      ['wallet balance: sum(tenants.wallet_balance)', `select coalesce(sum(wallet_balance),0)::numeric(14,2)::text n from ${S}.tenants where id = any($1::uuid[])`, `select coalesce(sum(wallet_balance),0)::numeric(14,2)::text n from crm.settings where org_id = any($1::uuid[])`],
      ['audit_events -> audit.log', `select count(*)::int n from ${S}.audit_events where tenant_id = any($1::uuid[])`, `select count(*)::int n from audit.log where org_id = any($1::uuid[]) and detail ? 'legacy_id'`],
      ['won enquiries (distinct children) -> core.students', `select count(distinct e.student_id)::int n from ${S}.enquiries e join ${S}.stages s on s.id = e.stage_id where s.is_won and e.tenant_id = any($1::uuid[])`, `select count(*)::int n from core.students where org_id = any($1::uuid[]) and crm_prospect_id is not null`],
    ];
    const payIds = pays.map((p) => p.id), ledIds = ledger.map((l) => l.id);
    for (const [name, a, b] of pairs) {
      const x = (await sq(a, [orgIds]))[0].n;
      const y = (await tq(b, name.startsWith('payments') ? [orgIds, payIds] : name.startsWith('wallet:') ? [orgIds, ledIds] : [orgIds]))[0].n;
      // settings and the wallet balance are applied once per org; after go-live a re-run must not compare them again
      const skip = (name.startsWith('wallet balance') && settingsApplied === 0) || (name.startsWith('won enquiries') && flag('no-admit'));
      report.checks.push({ table: name, source: x, target: y, checksum: skip ? '(skipped)' : '(value)', ok: skip || String(x) === String(y) });
    }
    // referential and tenant integrity: nothing of the load may point at another org
    const stray = await tq(
      `select 'enquiries' t, count(*)::int n from crm.enquiries e join core.org_users u on u.user_id = e.owner_id and u.org_id <> e.org_id where e.org_id = any($1::uuid[])
       union all select 'households', count(*)::int from crm.households h where h.org_id = any($1::uuid[]) and not exists (select 1 from core.organizations o where o.id = h.org_id)`, [orgIds]);
    for (const s of stray) if (s.n) report.checks.push({ table: `integrity: ${s.t}`, source: 0, target: s.n, checksum: '', ok: false });

    report.finished = new Date().toISOString();
    report.ok = report.checks.every((c) => c.ok);
    // one summary event so the load shows in the audit trail
    await tgt.query(`insert into audit.log (org_id, action, schema_name, table_name, detail) select id, 'crm.migration', 'crm', 'settings', $2::jsonb from core.organizations where id = any($1::uuid[])`,
      [orgIds, JSON.stringify({ source_schema: S, dry_run: DRY, ok: report.ok, tables: Object.fromEntries(Object.entries(report.tables).map(([k, v]) => [k, v.source])) })]);

    if (DRY || !report.ok) await tgt.query('rollback');
    else await tgt.query('commit');
    report.committed = !DRY && report.ok;
    // a bulk load leaves the planner without statistics; row-level security makes bad plans expensive, so analyse now
    if (report.committed) for (const t of ['crm.enquiries', 'crm.prospects', 'crm.households', 'crm.guardians', 'crm.activities', 'crm.stages', 'crm.phases', 'crm.follow_ups', 'crm.visits', 'crm.messages', 'core.staff', 'core.org_users', 'core.user_product_access', 'core.students', 'core.guardians', 'core.consents']) await tgt.query(`analyze ${t}`);
  } catch (e) {
    await tgt.query('rollback').catch(() => undefined);
    throw e;
  }
}

function print() {
  if (JSON_OUT) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  const pad = (s, n) => String(s).padEnd(n);
  console.log(`\nCRM -> platform migration${DRY ? ' (DRY RUN: everything was rolled back)' : ''}`);
  console.log(`source ${new URL(SRC_URL).pathname.slice(1)}.${S}  ->  target ${new URL(TGT_URL).pathname.slice(1)}\n`);
  console.log(pad('load', 62), pad('source', 8), pad('new', 8), 'existing');
  for (const [k, v] of Object.entries(report.tables)) console.log(pad(k, 62), pad(v.source, 8), pad(v.inserted, 8), v.existing);
  console.log('\n' + pad('check (source vs target)', 52), pad('source', 8), pad('target', 8), pad('checksum', 14), 'result');
  for (const c of report.checks) console.log(pad(c.table, 52), pad(c.source, 8), pad(c.target, 8), pad(c.checksum, 14), c.ok ? 'OK' : 'MISMATCH');
  if (report.warnings.length) console.log('\nWarnings\n  - ' + report.warnings.join('\n  - '));
  console.log(`\n${report.ok ? 'ALL CHECKS PASSED' : 'CHECKS FAILED: nothing was committed'}${report.committed ? ' (committed)' : ''}`);
}

main()
  .then(() => {
    print();
    process.exitCode = report.ok ? 0 : 1;
  })
  .catch((e) => {
    console.error('MIGRATION FAILED (rolled back):', e.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await src.end().catch(() => undefined);
    await tgt.end().catch(() => undefined);
  });
