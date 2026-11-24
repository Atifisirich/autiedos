/**
 * Test world for the compliance tests. Each compliance test file gets its OWN scratch database:
 *
 *   platform migrations (db.mjs reset --platform-only) + every other 20261115* migration (the compliance one among them)
 *
 * so the shared harness database (rebuilt by global-setup, platform migrations only) is never touched and the
 * isolation harness keeps testing the platform as it is. Roles are cluster-wide and shared.
 *
 *   org A  crm + os + erp, branches a1, a2      (the client under test)
 *   org B  crm + os + erp, branch b1            (the other client: must never appear in A's exports)
 *   org C  crm only                             (rows planted in os/erp: must stay out of C's exports)
 *
 * Product tables of the future are simulated with crm.leads and erp.fee_receipts, created through app.apply_rls and
 * registered in core.pii_registry exactly the way a real migration would.
 */
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { createSetRoleDb, type ComplianceDb } from '../src/compliance/db';

const BASE_URL = process.env.PLATFORM_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgres://postgres@localhost:54322/postgres';
const ROOT = join(__dirname, '..', '..', '..');

export interface World {
  dbName: string;
  url: string;
  pool: pg.Pool;
  db: ComplianceDb;
  A: Org;
  B: Org;
  C: Org;
  u: Record<string, string>;
  /** persons whose data the tests export and erase */
  p: { teacher: string; guardian: string; learnerA: string; leadA: string; leadB: string; teacherB: string };
  close(): Promise<void>;
  q<R extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, params?: unknown[]): Promise<R[]>;
}

export interface Org {
  id: string;
  branches: Record<string, string>;
}

export async function createWorld(opts: { extraMigrations?: boolean } = {}): Promise<World> {
  const dbName = `compliance_t_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const base = new URL(BASE_URL);
  const admin = new pg.Client({ connectionString: base.toString() });
  await admin.connect();
  await admin.query(`create database ${dbName}`);
  await admin.end();
  const u = new URL(BASE_URL);
  u.pathname = `/${dbName}`;
  const url = u.toString();
  execSync(`node ${join(ROOT, 'scripts/db.mjs')} reset --platform-only`, { stdio: 'pipe', env: { ...process.env, DATABASE_URL: url } });

  const pool = new pg.Pool({ connectionString: url, max: 6 });
  // every migration of the platform stream that the platform-only filter does not pick up (the compliance one included)
  const dir = join(ROOT, 'supabase/migrations');
  const done = new Set((await pool.query<{ name: string }>('select name from public._migrations')).rows.map((r) => r.name));
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql') && x.startsWith('20261115') && !done.has(x)).sort()) {
    if (opts.extraMigrations === false && f !== '20261115200001_compliance.sql') continue;
    const c = await pool.connect();
    try {
      await c.query('begin');
      await c.query(readFileSync(join(dir, f), 'utf8'));
      await c.query('insert into public._migrations(name) values ($1)', [f]);
      await c.query('commit');
    } catch (e) {
      await c.query('rollback');
      throw new Error(`migration ${f} failed: ${(e as Error).message}`);
    } finally {
      c.release();
    }
  }

  const q = async <R extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, params: unknown[] = []) => (await pool.query<R>(sql, params)).rows;
  const world = await build(pool, q);
  return {
    dbName,
    url,
    pool,
    db: createSetRoleDb(pool),
    ...world,
    q,
    async close() {
      await pool.end();
      const a = new pg.Client({ connectionString: base.toString() });
      await a.connect();
      await a.query(`drop database if exists ${dbName} with (force)`);
      await a.end();
    },
  };
}

async function build(pool: pg.Pool, q: World['q']) {
  const id = () => randomUUID();
  async function user(email: string) {
    const uid = id();
    await q(`insert into auth.users (id, email) values ($1, $2)`, [uid, email]);
    return uid;
  }
  async function org(slug: string, products: string[], branchCodes: string[]): Promise<Org> {
    const oid = id();
    await q(`insert into core.organizations (id, name, slug, kind) values ($1, $2, $3, 'school')`, [oid, `Org ${slug}`, slug]);
    const branches: Record<string, string> = {};
    for (const code of branchCodes) {
      branches[code] = id();
      await q(`insert into core.branches (id, org_id, name, code, state_code) values ($1, $2, $3, $4, '36')`, [branches[code], oid, `Branch ${code}`, code]);
    }
    for (const p of products) {
      await q(`insert into core.subscriptions (org_id, product_key, status, plan_key) values ($1, $2, 'active', $3)`, [oid, p, `${p}_monthly`]);
      const rid = id();
      await q(`insert into core.roles (id, org_id, product_key, key, name) values ($1, $2, $3, 'admin', 'Admin')`, [rid, oid, p]);
      await q(`insert into core.role_permissions (org_id, role_id, module_key, action, scope) values ($1, $2, '*', '*', 'org')`, [oid, rid]);
      // a role that can do day-to-day work but nothing in compliance
      const tid = id();
      await q(`insert into core.roles (id, org_id, product_key, key, name) values ($1, $2, $3, 'teacher', 'Teacher')`, [tid, oid, p]);
      await q(`insert into core.role_permissions (org_id, role_id, module_key, action, scope) values ($1, $2, 'harness', 'view', 'org')`, [oid, tid]);
    }
    return { id: oid, branches };
  }
  async function member(orgId: string, uid: string, kind: string, name: string, grants: Record<string, string>) {
    await q(`insert into core.org_users (org_id, user_id, kind, display_name) values ($1, $2, $3, $4)`, [orgId, uid, kind, name]);
    for (const [product, role] of Object.entries(grants)) {
      await q(`insert into core.user_product_access (org_id, user_id, product_key, role_key) values ($1, $2, $3, $4)`, [orgId, uid, product, role]);
    }
  }

  const A = await org('org-a', ['crm', 'os', 'erp'], ['a1', 'a2']);
  const B = await org('org-b', ['crm', 'os', 'erp'], ['b1']);
  const C = await org('org-c', ['crm'], ['c1']);

  const u: Record<string, string> = {
    aAdmin: await user('admin@a.test'),
    aTeacher: await user('teacher@a.test'),
    aStaffNoCompliance: await user('plain@a.test'),
    aGuardian: await user('guardian@a.test'),
    bAdmin: await user('admin@b.test'),
    bTeacher: await user('teacher@b.test'),
    cAdmin: await user('admin@c.test'),
    platform: await user('support@autoed.test'),
    platform2: await user('support2@autoed.test'),
  };
  await member(A.id, u.aAdmin!, 'staff', 'Asha Admin', { crm: 'admin', os: 'admin', erp: 'admin' });
  await member(A.id, u.aTeacher!, 'staff', 'Tara Teacher', { os: 'admin' });
  await member(A.id, u.aStaffNoCompliance!, 'staff', 'Plain Staff', { os: 'teacher' });
  await member(A.id, u.aGuardian!, 'guardian', 'Gita Guardian', { erp: 'admin' });
  await member(B.id, u.bAdmin!, 'staff', 'Bina Admin', { crm: 'admin', os: 'admin', erp: 'admin' });
  await member(B.id, u.bTeacher!, 'staff', 'Tej Teacher', { os: 'admin' });
  await member(C.id, u.cAdmin!, 'staff', 'Chitra Admin', { crm: 'admin' });
  await q(`insert into core.platform_admins (user_id, name) values ($1, 'AutoEd Support'), ($2, 'AutoEd Support 2')`, [u.platform, u.platform2]);

  // the teacher in A has rows spread over several core tables
  await q(`insert into core.user_branch_access (org_id, user_id, branch_id) values ($1, $2, $3)`, [A.id, u.aTeacher, A.branches.a1]);
  await q(`select app.record_login_event($1, 'password', false, 'bad password', '203.0.113.7', 'Mozilla/5.0 Teacher Laptop')`, [u.aTeacher]);
  await q(`select app.record_login_event($1, 'password', true, null, '203.0.113.7', 'Mozilla/5.0 Teacher Laptop')`, [u.aTeacher]);
  await q(`select app.record_login_event($1, 'password', true, null, '198.51.100.9', 'Mozilla/5.0 Other')`, [u.bTeacher]);
  const learnerA = id();
  await q(`insert into core.learner_links (org_id, user_id, learner_id, relation) values ($1, $2, $3, 'mother')`, [A.id, u.aGuardian, learnerA]);
  const learnerB = id();
  await q(`insert into core.learner_links (org_id, user_id, learner_id, relation) values ($1, $2, $3, 'father')`, [B.id, u.bTeacher, learnerB]);

  // ---- simulated future product tables, set up exactly like a real migration would
  await q(`insert into core.product_modules (product_key, module_key, name) values ('crm', 'leads', 'Leads'), ('erp', 'fees', 'Fees')`);
  await q(`create table crm.leads (
      id uuid primary key default gen_random_uuid(),
      org_id uuid not null references core.organizations(id) on delete cascade,
      branch_id uuid,
      owner_id uuid,
      full_name text not null,
      phone text,
      email text,
      status text not null default 'new',
      last_activity_at timestamptz not null default now(),
      created_at timestamptz not null default now(),
      foreign key (org_id, branch_id) references core.branches(org_id, id) on delete cascade)`);
  await q(`select app.apply_rls('crm', 'leads', 'product', 'crm', 'leads')`);
  await q(`create table erp.fee_receipts (
      id uuid primary key default gen_random_uuid(),
      org_id uuid not null references core.organizations(id) on delete cascade,
      branch_id uuid,
      student_id uuid not null,
      payer_name text not null,
      payer_phone text,
      amount_paise bigint not null,
      receipt_no text not null,
      created_at timestamptz not null default now(),
      foreign key (org_id, branch_id) references core.branches(org_id, id) on delete cascade)`);
  await q(`select app.apply_rls('erp', 'fee_receipts', 'product', 'erp', 'fees')`);
  // registry: leads are removed (lead person), fee receipts are financial: anonymised, never deleted
  await q(
    `insert into core.pii_registry (schema_name, table_name, person_type, key_column, contact_columns, pii_columns, erasure_mode, is_subject, note) values
       ('crm', 'leads', 'lead', 'id', array['phone','email'], array['full_name','phone','email'], 'delete', true, 'test lead table')`,
  );
  await q(
    `insert into core.pii_registry (schema_name, table_name, person_type, key_column, contact_columns, pii_columns, anonymise_values, erasure_mode, note) values
       ('erp', 'fee_receipts', 'student', 'student_id', '{}', array['payer_name','payer_phone','student_id'], '{"payer_name":"Erased person","student_id":"00000000-0000-0000-0000-000000000000"}', 'anonymise', 'financial row: kept, person removed')`,
  );
  // a retention rule for old leads that never became students (disabled and draft, like every seeded rule)
  await q(
    `insert into core.retention_rules (scope, data_type, product_key, schema_name, table_name, date_column, filter_column, filter_values, action, period_value, period_unit, enabled, legal_status, legal_note)
     values ('table', 'crm_leads_not_admitted', 'crm', 'crm', 'leads', 'last_activity_at', 'status', array['new','lost'], 'delete', 24, 'months', false, 'draft', 'CONFIRM 24 months')`,
  );

  const teacher = u.aTeacher!;
  const lead = async (orgId: string, branch: string, name: string, phone: string, email: string, status: string, ageDays: number) =>
    (
      await q<{ id: string }>(
        `insert into crm.leads (org_id, branch_id, full_name, phone, email, status, last_activity_at) values ($1, $2, $3, $4, $5, $6, now() - make_interval(days => $7)) returning id`,
        [orgId, branch, name, phone, email, status, ageDays],
      )
    )[0]!.id;
  const leadA = await lead(A.id, A.branches.a1!, 'Lena Lead', '+919876500001', 'lena@example.test', 'new', 10);
  await lead(A.id, A.branches.a1!, 'Old Lead A1', '+919876500002', 'old1@example.test', 'new', 900); // older than 24 months
  await lead(A.id, A.branches.a1!, 'Old Lead A2 admitted', '+919876500003', 'old2@example.test', 'admitted', 900); // old but admitted: kept
  await lead(A.id, A.branches.a2!, 'Recent Lead A', '+919876500004', 'recent@example.test', 'new', 5);
  const leadB = await lead(B.id, B.branches.b1!, 'Bela Lead', '+919876500001', 'lena@example.test', 'new', 900); // SAME phone/email as Lena, other org
  const fee = async (orgId: string, branch: string, student: string, payer: string, phone: string, amount: number, no: string) =>
    q(`insert into erp.fee_receipts (org_id, branch_id, student_id, payer_name, payer_phone, amount_paise, receipt_no) values ($1, $2, $3, $4, $5, $6, $7)`, [orgId, branch, student, payer, phone, amount, no]);
  await fee(A.id, A.branches.a1!, learnerA, 'Gita Guardian', '+919876500009', 1500000, 'R-A-1');
  await fee(A.id, A.branches.a1!, learnerA, 'Gita Guardian', '+919876500009', 500000, 'R-A-2');
  await fee(A.id, A.branches.a1!, id(), 'Someone Else', '+919876500010', 700000, 'R-A-3');
  await fee(B.id, B.branches.b1!, learnerB, 'Bob Parent', '+919876500011', 900000, 'R-B-1');

  // probe rows (kept: they are the platform's own placeholders)
  for (const s of ['crm', 'os', 'erp']) {
    await q(`insert into ${s}.harness_probe (org_id, branch_id, owner_id, title) values ($1, $2, $3, $4), ($5, $6, $7, $8)`, [A.id, A.branches.a1, u.aAdmin, `${s} A`, B.id, B.branches.b1, u.bAdmin, `${s} B`]);
  }
  // C has os/erp rows planted although it only has crm
  await q(`insert into os.harness_probe (org_id, branch_id, title) values ($1, $2, 'os C planted')`, [C.id, C.branches.c1]);

  // consents
  await q(
    `insert into core.consents (org_id, person_type, person_id, channel, contact, purpose, status, source) values
       ($1, 'lead', $2, 'whatsapp', '+919876500001', 'promotional', 'opted_in', 'form'),
       ($3, 'lead', $4, 'whatsapp', '+919876500001', 'promotional', 'opted_out', 'stop')`,
    [A.id, leadA, B.id, leadB],
  );
  // billing
  await q(`insert into billing.plans (key, product_key, name, billing_interval, price_paise, sac_code) values ('crm_monthly','crm','CRM','month',499900,'998314'),('os_monthly','os','OS','month',499900,'998314'),('erp_monthly','erp','ERP','month',499900,'998314')`);
  let n = 0;
  for (const o of [A, B]) {
    n += 1;
    await q(`insert into billing.accounts (org_id, legal_name, gstin, state_code, billing_email) values ($1, $2, '36AABCA1234A1Z5', '36', $3)`, [o.id, `Legal ${n}`, `billing${n}@example.test`]);
    const inv = id();
    await q(`insert into billing.invoices (id, org_id, invoice_number, financial_year, invoice_date, status, supplier_state_code, customer_legal_name, place_of_supply, taxable_paise, cgst_paise, sgst_paise, total_paise)
             values ($1, $2, $3, '2026-27', current_date, 'issued', '36', $4, '36', 499900, 44991, 44991, 589882)`, [inv, o.id, `AE/2026-27/00000${n}`, `Legal ${n}`]);
  }
  void pool;
  void teacher;
  return { A, B, C, u, p: { teacher: u.aTeacher!, guardian: u.aGuardian!, learnerA, leadA, leadB, teacherB: u.bTeacher! } };
}

/** Moves a subscription's end back in time so grace periods can be tested. Edits the config history the rule reads. */
export async function endSubscription(w: World, orgId: string, product: string, status: 'cancelled' | 'suspended', daysAgo: number) {
  await w.q(`update core.subscriptions set status = $3 where org_id = $1 and product_key = $2`, [orgId, product, status]);
  await w.q(
    `update audit.config_history set created_at = now() - make_interval(days => $3)
      where org_id = $1 and schema_name = 'core' and table_name = 'subscriptions' and after ->> 'product_key' = $2 and after ->> 'status' = $4`,
    [orgId, product, daysAgo, status],
  );
}
