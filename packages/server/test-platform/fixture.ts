/**
 * Test world for the isolation harness, written as the table owner (RLS bypassed):
 *
 *   org A  crm + os + erp, branches a1, a2 (crm switched off on a2)
 *   org B  crm + os + erp, branch b1            (the "other client")
 *   org C  crm only, branch c1                  (rows planted in os/erp to prove they stay hidden)
 *   org D  crm + os, branch d1                  (a user granted only OS, and a CRM-only admin)
 *
 * Every table with org_id gets rows for A and B (harness asserts this, so a new table without fixture
 * rows fails and must be added here).
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { owner } from './helpers';
import { seedCore } from './fixture-core';
import { seedCompliance } from './fixture-compliance';
import { seedErp } from './fixture-erp';
import { seedCrm } from './fixture-crm';
import { seedOs } from './fixture-os';
import { resetPlatformDatabase } from './global-setup';

export type World = Awaited<ReturnType<typeof buildWorld>>;

const PRODUCTS = ['crm', 'os', 'erp'] as const;

export async function buildWorld() {
  // Each test file builds its own world; start from an empty platform if an earlier file left one behind.
  if ((await owner.query('select 1 from core.organizations limit 1')).rowCount) resetPlatformDatabase();
  const c = await owner.connect();
  try {
    await c.query('begin');
    const w = await build(c);
    await c.query('commit');
    return w;
  } catch (e) {
    await c.query('rollback');
    throw e;
  } finally {
    c.release();
  }
}

async function build(c: pg.PoolClient) {
  const id = () => randomUUID();
  const q = (sql: string, params: unknown[] = []) => c.query(sql, params);

  async function user(email: string) {
    const uid = id();
    await q(`insert into auth.users (id, email) values ($1, $2)`, [uid, email]);
    return uid;
  }
  async function org(slug: string, products: readonly string[], branchCodes: string[]) {
    const oid = id();
    await q(`insert into core.organizations (id, name, slug, kind) values ($1, $2, $3, 'school')`, [oid, `Org ${slug}`, slug]);
    const branches: Record<string, string> = {};
    for (const code of branchCodes) {
      branches[code] = id();
      await q(`insert into core.branches (id, org_id, name, code, state_code) values ($1, $2, $3, $4, '36')`, [branches[code], oid, `Branch ${code}`, code]);
    }
    for (const p of products) {
      await q(`insert into core.subscriptions (org_id, product_key, status, plan_key) values ($1, $2, 'active', $3)`, [oid, p, `${p}_monthly`]);
      // admin role: everything at org scope
      const rid = id();
      await q(`insert into core.roles (id, org_id, product_key, key, name) values ($1, $2, $3, 'admin', 'Admin')`, [rid, oid, p]);
      await q(`insert into core.role_permissions (org_id, role_id, module_key, action, scope) values ($1, $2, '*', '*', 'org')`, [oid, rid]);
      // portal role: no permissions (guardian access is through learner links)
      await q(`insert into core.roles (org_id, product_key, key, name) values ($1, $2, 'portal', 'Portal')`, [oid, p]);
    }
    return { id: oid, branches };
  }
  async function member(orgId: string, uid: string, kind: string, grants: Record<string, string>, homeBranch: string | null = null) {
    await q(`insert into core.org_users (org_id, user_id, kind, display_name, home_branch_id) values ($1, $2, $3, $4, $5)`, [orgId, uid, kind, `User ${uid.slice(0, 6)}`, homeBranch]);
    for (const [product, role] of Object.entries(grants)) {
      await q(`insert into core.user_product_access (org_id, user_id, product_key, role_key) values ($1, $2, $3, $4)`, [orgId, uid, product, role]);
    }
  }
  async function probe(schema: string, orgId: string, branchId: string | null, ownerId: string | null, title: string) {
    await q(`insert into ${schema}.harness_probe (org_id, branch_id, owner_id, title) values ($1, $2, $3, $4)`, [orgId, branchId, ownerId, title]);
  }

  // ------------------------------------------------------------ orgs
  const A = await org('org-a', PRODUCTS, ['a1', 'a2']);
  const B = await org('org-b', PRODUCTS, ['b1']);
  const C = await org('org-c', ['crm'], ['c1']);
  const D = await org('org-d', ['crm', 'os'], ['d1']);

  // A teacher role in A/os: harness view in own branch, create own rows only.
  const teacherRole = id();
  await q(`insert into core.roles (id, org_id, product_key, key, name) values ($1, $2, 'os', 'teacher', 'Teacher')`, [teacherRole, A.id]);
  await q(`insert into core.role_permissions (org_id, role_id, module_key, action, scope) values ($1, $2, 'harness', 'view', 'branch'), ($1, $2, 'harness', 'create', 'own'), ($1, $2, 'harness', 'edit', 'own')`, [A.id, teacherRole]);

  // ------------------------------------------------------------ users
  const u = {
    aAdmin: await user('admin@a.test'),
    aTeacher: await user('teacher@a.test'),
    aGuardian: await user('guardian@a.test'),
    aStudent: await user('student@a.test'),
    aOtherParent: await user('other-parent@a.test'),
    bAdmin: await user('admin@b.test'),
    bGuardian: await user('guardian@b.test'),
    cAdmin: await user('admin@c.test'),
    dOsOnly: await user('os-only@d.test'),
    dCrmAdmin: await user('crm-admin@d.test'),
    platform: await user('support@autoed.test'),
    nobody: await user('nobody@nowhere.test'),
  };
  await member(A.id, u.aAdmin, 'staff', { crm: 'admin', os: 'admin', erp: 'admin' });
  await member(A.id, u.aTeacher, 'staff', { os: 'teacher' }, A.branches.a1!);
  await member(A.id, u.aGuardian, 'guardian', { erp: 'portal' });
  await member(A.id, u.aStudent, 'student', { erp: 'portal' });
  await member(A.id, u.aOtherParent, 'parent', { erp: 'portal' });
  await member(B.id, u.bAdmin, 'staff', { crm: 'admin', os: 'admin', erp: 'admin' });
  await member(B.id, u.bGuardian, 'parent', { erp: 'portal' });
  await member(C.id, u.cAdmin, 'staff', { crm: 'admin' });
  await member(D.id, u.dOsOnly, 'staff', { os: 'admin' });
  await member(D.id, u.dCrmAdmin, 'staff', { crm: 'admin' });
  await q(`insert into core.platform_admins (user_id, name) values ($1, 'AutoEd Support')`, [u.platform]);

  await q(`insert into core.user_branch_access (org_id, user_id, branch_id) values ($1, $2, $3), ($4, $5, $6)`, [A.id, u.aGuardian, A.branches.a1!, B.id, u.bAdmin, B.branches.b1!]);
  // core master data (20261115100001..8): learners, families, staff and one row per core table for A and B
  const coreA = await seedCore(q, { org: A.id, branch: A.branches.a1!, admin: u.aAdmin, guardian: u.aGuardian, teacher: u.aTeacher });
  const coreB = await seedCore(q, { org: B.id, branch: B.branches.b1!, admin: u.bAdmin, guardian: u.bGuardian });
  await seedCompliance(q, A.id);
  await seedCompliance(q, B.id);
  // CRM rows (20261117000001..6): the automation user and crm.settings come from the trigger on core.subscriptions
  const crmA = await seedCrm(q, { org: A.id, branch: A.branches.a1!, admin: u.aAdmin, year: coreA.year, prog: coreA.prog });
  const crmB = await seedCrm(q, { org: B.id, branch: B.branches.b1!, admin: u.bAdmin, year: coreB.year, prog: coreB.prog });
  // OS product rows (20261116000001..5): one row per os table (and OS wallet tables) for A and B
  await seedOs(q, { org: A.id, branch: A.branches.a1!, admin: u.aAdmin, core: coreA });
  await seedOs(q, { org: B.id, branch: B.branches.b1!, admin: u.bAdmin, core: coreB });
  // AI school designer (20261127100001): one published changeset with one item per org
  for (const [o, admin] of [[A.id, u.aAdmin], [B.id, u.bAdmin]] as const) {
    const cs = id();
    await q(`insert into core.design_changesets (id, org_id, prompt, plan, status, author_user_id, author_kind, approved_by_user_id, version, published_at, product_scope)
             values ($1, $2, 'fixture: daily opening checklist', '{"summary":"fixture","ops":[]}', 'published', $3, 'org_admin', $3, 1, now(), '{os}')`, [cs, o, admin]);
    await q(`insert into core.design_changeset_items (org_id, changeset_id, seq, product_key, block_key, op, instance_key, settings, inverse)
             values ($1, $2, 1, 'os', 'os.checklist', 'create', 'daily_opening', '{}', '{"op":"delete","block":"os.checklist","key":"daily_opening"}')`, [o, cs]);
  }
  const learnerA = coreA.learner;
  const learnerB = coreB.learner;
  await q(`insert into core.learner_links (org_id, user_id, learner_id, relation) values ($1, $2, $3, 'mother'), ($4, $5, $6, 'father')`, [A.id, u.aGuardian, learnerA, B.id, u.bGuardian, learnerB]);
  // second learner in A belonging to another family: the guardian must not see this link
  await q(`insert into core.learner_links (org_id, user_id, learner_id, relation) values ($1, $2, $3, 'father')`, [A.id, u.aOtherParent, coreA.other]);
  // a student login linked to itself only (its sibling in the same household is not linked)
  await q(`insert into core.learner_links (org_id, user_id, learner_id, relation) values ($1, $2, $3, 'self')`, [A.id, u.aStudent, learnerA]);

  // ERP rows (20261118000001..9): one row per erp table for A and B, receipts through erp.post_receipts, ERP roles in A
  const erpA = await seedErp(q, { org: A.id, branch: A.branches.a1!, admin: u.aAdmin, guardian: u.aGuardian, core: coreA, roles: true });
  const erpB = await seedErp(q, { org: B.id, branch: B.branches.b1!, admin: u.bAdmin, guardian: u.bGuardian, core: coreB });

  // Per-branch switch: CRM off on a2; an explicit "on" row in B.
  await q(`insert into core.org_branch_products (org_id, branch_id, product_key, enabled) values ($1, $2, 'crm', false), ($3, $4, 'os', true)`, [A.id, A.branches.a2!, B.id, B.branches.b1!]);

  // ------------------------------------------------------------ product rows (probe tables)
  for (const s of PRODUCTS) {
    await probe(s, A.id, A.branches.a1!, u.aAdmin, `${s} A a1`);
    await probe(s, A.id, A.branches.a2!, u.aTeacher, `${s} A a2`);
    await probe(s, A.id, null, null, `${s} A org-level`);
    await probe(s, B.id, B.branches.b1!, u.bAdmin, `${s} B b1`);
    await probe(s, C.id, C.branches.c1!, null, `${s} C c1`); // os/erp rows for a CRM-only org: must stay invisible (T2)
  }
  await probe('crm', D.id, D.branches.d1!, null, 'crm D');
  await probe('os', D.id, D.branches.d1!, null, 'os D');

  // ------------------------------------------------------------ login security, support log
  for (const uid of [u.aAdmin, u.bAdmin]) {
    await q(`select app.record_login_event($1, 'password', false, 'bad password')`, [uid]);
    await q(`select app.record_login_event($1, 'password', true)`, [uid]);
  }
  await q(`insert into core.support_sessions (org_id, platform_user_id, reason, started_at, expires_at, ended_at)
           values ($1, $3, 'fixture: earlier ticket 101', now() - interval '3 days', now() - interval '3 days' + interval '1 hour', now() - interval '3 days' + interval '30 minutes'),
                  ($2, $3, 'fixture: earlier ticket 202', now() - interval '2 days', now() - interval '2 days' + interval '1 hour', now() - interval '2 days' + interval '30 minutes')`,
    [A.id, B.id, u.platform]);

  // ------------------------------------------------------------ billing
  await q(`insert into billing.plans (key, product_key, name, billing_interval, price_paise, sac_code) values
           ('crm_monthly', 'crm', 'CRM monthly', 'month', 499900, '998314'),
           ('os_monthly', 'os', 'OS monthly', 'month', 499900, '998314'),
           ('erp_monthly', 'erp', 'ERP monthly', 'month', 499900, '998314')`);
  let n = 0;
  for (const o of [A, B]) {
    n += 1;
    await q(`insert into billing.accounts (org_id, legal_name, gstin, state_code) values ($1, $2, '36AABCA1234A1Z5', '36')`, [o.id, `Legal ${n}`]);
    const sub = (await q(`select id from core.subscriptions where org_id = $1 and product_key = 'crm'`, [o.id])).rows[0].id as string;
    await q(`insert into billing.razorpay_subscriptions (org_id, subscription_id, plan_key, razorpay_subscription_id, status) values ($1, $2, 'crm_monthly', $3, 'active')`, [o.id, sub, `sub_test_${n}`]);
    const inv = id();
    // intra-state (36 -> 36): CGST 9% + SGST 9%
    await q(`insert into billing.invoices (id, org_id, invoice_number, financial_year, invoice_date, status, supplier_state_code, customer_legal_name, place_of_supply, taxable_paise, cgst_paise, sgst_paise, total_paise)
             values ($1, $2, $3, '2026-27', current_date, 'issued', '36', $4, '36', 499900, 44991, 44991, 589882)`, [inv, o.id, `AE/2026-27/00000${n}`, `Legal ${n}`]);
    await q(`insert into billing.invoice_lines (org_id, invoice_id, product_key, description, sac_code, unit_paise, taxable_paise, gst_rate) values ($1, $2, 'crm', 'CRM monthly', '998314', 499900, 499900, 18)`, [o.id, inv]);
    await q(`insert into billing.payments (org_id, invoice_id, razorpay_payment_id, amount_paise, status) values ($1, $2, $3, 589882, 'captured')`, [o.id, inv, `pay_test_${n}`]);
    await q(`insert into billing.usage (org_id, product_key, metric, quantity, period_start, period_end) values ($1, 'os', 'ai_credits', 12.5, date_trunc('month', current_date), current_date)`, [o.id]);
  }

  return { A, B, C, D, u, learnerA, learnerB, coreA, coreB, erpA, erpB, crmA, crmB };
}
