/**
 * ERP port (migrations 20261118000001..9_erp_*, docs/erp-port.md): isolation of erp.* between clients and products,
 * the parent / student portal (own child only), role-based staff access, immutable money, locked marks, restricted data
 * that is read through logged functions, the payment functions and the CRM hand-off. Same fixture as isolation.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { count, owner, ownerQuery, qi, tx, type RequestRole } from './helpers';
import { buildWorld, type World } from './fixture';

let w: World;
let erpTables: string[] = [];

beforeAll(async () => {
  w = await buildWorld();
  erpTables = (await ownerQuery<{ t: string }>(
    `select c.relname as t from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'erp' and c.relkind = 'r' and obj_description(c.oid, 'pg_class') like 'erp product data%' order by 1`)).map((r) => r.t);
}, 300000);

afterAll(async () => {
  await owner.end();
});

/** Reads (rolled back). */
const rows = (user: string | null, sql: string, params: unknown[] = [], role: RequestRole = 'authenticated') =>
  tx(role, user, async (c) => (await c.query(sql, params)).rows);
/** One request that is committed, so later tests see its effect; returns the error code ('' on success). */
async function ec(role: RequestRole, user: string | null, sql: string, params: unknown[] = []): Promise<string> {
  try {
    await tx(role, user, (c) => c.query(sql, params), true);
    return '';
  } catch (e) {
    return (e as { code?: string }).code ?? String(e);
  }
}
const col = async (user: string, sql: string, params: unknown[] = []) => (await rows(user, sql, params)).map((r) => Object.values(r)[0]);
const call = async (user: string | null, sql: string, params: unknown[] = [], role: RequestRole = 'authenticated') =>
  (await tx(role, user, async (c) => (await c.query(sql, params)).rows[0], true));
const asOwner = async (sql: string, params: unknown[] = []) => ownerQuery(sql, params);

// ---------------------------------------------------------------------------------------------- catalogue
describe('erp catalogue', () => {
  it('has the 126 generated tables of MAP-TABLES (+ the harness probe) and a private OTP table', async () => {
    expect(erpTables.length).toBe(126);
    const all = await asOwner(`select count(*)::int as n from pg_tables where schemaname = 'erp'`);
    expect(all[0]!.n).toBe(127);
    expect((await asOwner(`select count(*)::int as n from pg_tables where schemaname = 'private' and tablename = 'gate_pass_otps'`))[0]!.n).toBe(1);
  });

  it('every erp table has the standard columns, unique (org_id, id), the updated_at trigger and org-first indexes on every foreign key', async () => {
    const bad: string[] = [];
    for (const t of erpTables) {
      const cols = (await asOwner(`select column_name as c from information_schema.columns where table_schema = 'erp' and table_name = $1`, [t])).map((r) => r.c as string);
      for (const c of ['id', 'org_id', 'created_at', 'created_by', 'updated_at', 'deleted_at']) if (!cols.includes(c)) bad.push(`${t}.${c}`);
      const uq = await asOwner(
        `select 1 from pg_constraint where conrelid = ('erp.' || quote_ident($1))::regclass and contype = 'u'
            and (select array_agg(a.attname::text order by k.o) from unnest(conkey) with ordinality k(n, o) join pg_attribute a on a.attrelid = conrelid and a.attnum = k.n) = array['org_id','id']`, [t]);
      if (!uq.length) bad.push(`${t}: unique (org_id, id)`);
      if (!(await asOwner(`select 1 from pg_trigger where tgrelid = ('erp.' || quote_ident($1))::regclass and tgname = 'trg_touch'`, [t])).length) bad.push(`${t}: trg_touch`);
    }
    const fkNoOrg = await asOwner<{ t: string }>(
      `select l.relname || '.' || c.conname as t from pg_constraint c
         join pg_class l on l.oid = c.conrelid join pg_namespace ln on ln.oid = l.relnamespace
         join pg_class r on r.oid = c.confrelid
        where c.contype = 'f' and ln.nspname = 'erp' and r.relname not in ('organizations','product_modules')
          and not exists (select 1 from unnest(c.conkey) k join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k where a.attname = 'org_id')`);
    expect(fkNoOrg.map((r) => r.t)).toEqual([]);
    const fkNoIdx = await asOwner<{ t: string }>(
      `select l.relname || '.' || c.conname as t from pg_constraint c
         join pg_class l on l.oid = c.conrelid join pg_namespace ln on ln.oid = l.relnamespace
        where c.contype = 'f' and ln.nspname = 'erp' and array_length(c.conkey, 1) = 2 and l.relname <> 'harness_probe'
          and c.confrelid::regclass::text <> 'core.product_modules'
          and not exists (select 1 from pg_index i where i.indrelid = c.conrelid
                           and i.indkey[0] = (select attnum from pg_attribute where attrelid = c.conrelid and attname = 'org_id')
                           and i.indkey[1] = c.conkey[2])`);
    expect(bad).toEqual([]);
    expect(fkNoIdx.map((r) => r.t)).toEqual([]);
  });

  it('the immutability, marks-lock and function-only guards exist where they must', async () => {
    const trg = await asOwner<{ t: string }>(`select c.relname || ':' || g.tgname as t from pg_trigger g join pg_class c on c.oid = g.tgrelid join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'erp' and g.tgname in ('trg_immutable','trg_marks_lock','trg_fn_only','trg_guard_assessment','trg_voucher_balanced') order by 1`);
    expect(trg.map((r) => r.t)).toEqual([
      'assessment_results:trg_marks_lock', 'assessments:trg_guard_assessment', 'fee_demands:trg_fn_only', 'receipt_allocations:trg_immutable',
      'receipt_payments:trg_immutable', 'receipts:trg_immutable', 'student_wallets:trg_fn_only', 'voucher_lines:trg_immutable',
      'voucher_lines:trg_voucher_balanced', 'vouchers:trg_immutable']);
  });

  it('restricted tables have no direct select data, no DML grants; the OTP table is not reachable at all', async () => {
    for (const t of ['staff_payroll', 'student_sensitive']) {
      for (const r of ['authenticated', 'erp_server']) {
        const g = await asOwner(`select has_table_privilege($1, 'erp.${t}', 'insert') as i, has_table_privilege($1, 'erp.${t}', 'update') as u, has_table_privilege($1, 'erp.${t}', 'delete') as d`, [r]);
        expect(g[0], `${r} ${t}`).toEqual({ i: false, u: false, d: false });
      }
    }
    for (const r of ['authenticated', 'erp_server', 'crm_server', 'os_server', 'platform_admin_server', 'anon']) {
      expect((await asOwner(`select has_table_privilege($1, 'private.gate_pass_otps', 'select') as s`, [r]))[0]!.s, r).toBe(false);
    }
  });

  it('erp functions: nothing for PUBLIC or anon; the payment, hand-off and document check functions are server-only', async () => {
    const callable = async (role: string, fn: string) => (await asOwner(`select has_function_privilege($1, $2::regprocedure, 'execute') as e`, [role, fn]))[0]!.e as boolean;
    for (const fn of ['erp.settle_payment_order(uuid,text,numeric)', 'erp.post_admission_payment(uuid,numeric,text,text,text,text,date,text)', 'erp.verify_document(text)']) {
      expect(await callable('authenticated', fn), `authenticated ${fn}`).toBe(false);
      expect(await callable('crm_server', fn), `crm_server ${fn}`).toBe(false);
      expect(await callable('erp_server', fn), `erp_server ${fn}`).toBe(true);
    }
    for (const fn of ['erp.reverse_receipt(uuid,text)', 'erp.post_receipts(uuid,jsonb,uuid,text)', 'erp.apply_concession(uuid)', 'erp.seed_roles(uuid)', 'erp.notify_guardians(uuid,text,text,text,text)']) {
      for (const r of ['authenticated', 'erp_server', 'anon']) expect(await callable(r, fn), `${r} ${fn}`).toBe(false);
    }
  });

  it('the ERP permission modules and default roles are seeded', async () => {
    const mods = (await asOwner(`select module_key from core.product_modules where product_key = 'erp' order by 1`)).map((r) => r.module_key as string);
    for (const m of ['fees', 'payroll', 'marks', 'student_sensitive', 'transport', 'setup', 'leadership', 'communication']) expect(mods).toContain(m);
    const roles = (await asOwner(`select key from core.roles where org_id = $1 and product_key = 'erp' order by 1`, [w.A.id])).map((r) => r.key as string);
    expect(roles).toEqual(['accounts', 'admin', 'class_teacher', 'coordinator', 'counsellor', 'driver', 'front_office', 'group_admin', 'hr', 'librarian', 'nurse',
      'portal', 'principal', 'security', 'store', 'subject_teacher', 'system_admin', 'transport', 'warden'].sort());
    // levels F/B/S/V become (action, scope) rows: accounts can create fee rows at branch scope and only view payroll
    const p = await asOwner(`select rp.module_key, rp.action, rp.scope from core.role_permissions rp join core.roles r on r.id = rp.role_id
        where r.org_id = $1 and r.product_key = 'erp' and r.key = 'accounts' and rp.module_key in ('fees','payroll') order by 1, 2`, [w.A.id]);
    expect(p).toEqual([
      { module_key: 'fees', action: 'create', scope: 'branch' }, { module_key: 'fees', action: 'delete', scope: 'branch' },
      { module_key: 'fees', action: 'edit', scope: 'branch' }, { module_key: 'fees', action: 'view', scope: 'branch' },
      { module_key: 'payroll', action: 'view', scope: 'branch' }]);
  });
});

// ---------------------------------------------------------------------------------------------- T1/T2/T3/T4 on erp
describe('erp isolation (T1-T4 on real erp tables)', () => {
  it('T1: no user of org A reads a row of org B in any erp table (admin, class teacher, accounts, guardian, student), and vice versa', async () => {
    const leaks: string[] = [];
    const who: [string, string][] = [['aAdmin', w.u.aAdmin], ['accounts', w.erpA.users.accounts!], ['classTeacher', w.erpA.users.classTeacher!], ['aGuardian', w.u.aGuardian], ['aStudent', w.u.aStudent],
      ['bAdmin', w.u.bAdmin], ['bGuardian', w.u.bGuardian]];
    for (const t of erpTables) {
      for (const [name, uid] of who) {
        const mine = name.startsWith('b') ? w.B.id : w.A.id;
        if (await count('authenticated', uid, `select * from ${qi('erp', t)} where org_id <> $1`, [mine])) leaks.push(`${name} -> erp.${t}`);
      }
      // the ERP server role with A claims
      if (await count('erp_server', w.u.aAdmin, `select * from ${qi('erp', t)} where org_id <> $1`, [w.A.id])) leaks.push(`erp_server -> erp.${t}`);
    }
    expect(leaks).toEqual([]);
  });

  it('T2: an org without ERP (CRM only; CRM + OS) reads nothing in erp even when rows exist for it', async () => {
    await asOwner(`insert into erp.masters (org_id, type, name) values ($1, 'house', 'Planted'), ($2, 'house', 'Planted')`, [w.C.id, w.D.id]);
    await asOwner(`insert into erp.module_flags (org_id, module_key) values ($1, 'fees')`, [w.C.id]);
    for (const t of ['masters', 'module_flags']) {
      expect(await count('authenticated', w.u.cAdmin, `select * from erp.${t}`), t).toBe(0);
      expect(await count('authenticated', w.u.dOsOnly, `select * from erp.${t}`), t).toBe(0);
      expect(await count('authenticated', w.u.dCrmAdmin, `select * from erp.${t}`), t).toBe(0);
    }
    expect(await ec('authenticated', w.u.cAdmin, `insert into erp.masters (org_id, type, name) values ($1, 'house', 'x')`, [w.C.id])).toBe('42501');
    expect(await ec('authenticated', w.u.cAdmin, `select erp.collect_fee('{}'::jsonb)`)).toBe('42501');
    for (const t of erpTables) expect(await count('authenticated', w.u.cAdmin, `select * from ${qi('erp', t)}`), t).toBe(0);
  });

  it('T3: a user of a school with ERP but without ERP access, or whose access was revoked, reads nothing; the portal role has no staff access', async () => {
    const nobody = w.u.aTeacher; // staff of A holding only OS
    for (const t of erpTables) expect(await count('authenticated', nobody, `select * from ${qi('erp', t)}`), t).toBe(0);
    await asOwner(`update core.user_product_access set revoked_at = now() where user_id = $1 and product_key = 'erp'`, [w.erpA.users.accounts]);
    try {
      for (const t of ['receipts', 'fee_demands', 'masters']) expect(await count('authenticated', w.erpA.users.accounts!, `select * from erp.${t}`), t).toBe(0);
    } finally {
      await asOwner(`update core.user_product_access set revoked_at = null where user_id = $1 and product_key = 'erp'`, [w.erpA.users.accounts]);
    }
    expect(await count('authenticated', w.erpA.users.accounts!, `select * from erp.receipts`)).toBeGreaterThan(0);
  });

  it('T4: suspending ERP closes every erp table (staff and portal) on the next request, and reopens it', async () => {
    await asOwner(`update core.subscriptions set status = 'suspended' where org_id = $1 and product_key = 'erp'`, [w.A.id]);
    try {
      for (const uid of [w.u.aAdmin, w.u.aGuardian, w.erpA.users.accounts!]) {
        for (const t of erpTables) expect(await count('authenticated', uid, `select * from ${qi('erp', t)}`), `${uid} ${t}`).toBe(0);
      }
      expect(await ec('authenticated', w.u.aGuardian, `select erp.create_payment_order($1, '[]'::jsonb)`, [w.learnerA])).toBe('42501');
      expect(await ec('authenticated', w.erpA.users.accounts!, `select erp.collect_fee('{}'::jsonb)`)).toBe('42501');
      // the school's other products and org B are unaffected
      expect(await count('authenticated', w.u.aAdmin, `select * from os.harness_probe`)).toBeGreaterThan(0);
      expect(await count('authenticated', w.u.bAdmin, `select * from erp.receipts`)).toBeGreaterThan(0);
    } finally {
      await asOwner(`update core.subscriptions set status = 'active' where org_id = $1 and product_key = 'erp'`, [w.A.id]);
    }
    expect(await count('authenticated', w.u.aAdmin, `select * from erp.receipts`)).toBeGreaterThan(0);
  });

  it('inserting into org B or pointing at an org B row is refused, also for the owner (composite foreign keys)', async () => {
    expect(await ec('authenticated', w.u.aAdmin, `insert into erp.masters (org_id, type, name) values ($1, 'house', 'x')`, [w.B.id])).toBe('42501');
    expect(await ec('authenticated', w.u.aAdmin, `insert into erp.fee_demands (org_id, student_id, head_id, amount, due_date) values ($1, $2, $3, 10, current_date)`,
      [w.A.id, w.coreB.learner, w.erpA.dLearner1])).toBe('23503');
    await expect(asOwner(`insert into erp.fee_demands (org_id, student_id, head_id, amount, due_date) values ($1, $2, (select id from erp.fee_heads where org_id = $1 limit 1), 10, current_date)`,
      [w.A.id, w.coreB.learner])).rejects.toMatchObject({ code: '23503' });
    await expect(asOwner(`insert into erp.routes (org_id, name, driver_id) values ($1, 'x', $2)`, [w.A.id, w.coreB.adminStaff])).rejects.toMatchObject({ code: '23503' });
    await expect(asOwner(`insert into erp.announcement_recipients (org_id, message_id, user_id) values ($1, (select id from erp.announcements where org_id = $1 limit 1), $2)`,
      [w.A.id, w.u.bAdmin])).rejects.toMatchObject({ code: '23503' }); // a login of another org
  });
});

// ---------------------------------------------------------------------------------------------- portal
/** Rows the guardian of org A (linked to `learner` only) may read in each erp table; every other erp table must give zero. */
const GUARDIAN_VISIBLE: Record<string, number> = {
  alumni_profiles: 1, announcement_recipients: 1, appointments: 1, assessment_results: 1, book_reservations: 1, books: 1, concessions: 1, content_items: 1,
  conversation_messages: 1, conversations: 1, council_positions: 1, deposits: 1, discipline_rules: 1, disclosures: 1, emergency_broadcasts: 1,
  event_registrations: 1, external_exam_results: 1, fee_demands: 2, fee_heads: 2, form_responses: 1, forms: 1, gallery_albums: 1, gallery_photos: 1,
  gate_passes: 1, growth_records: 1, health_checks: 1, hostel_allocations: 1, house_points: 1, infirmary_visits: 1, issued_documents: 1, items: 1, loans: 1,
  meal_bookings: 1, mess_menus: 1, online_classes: 1, online_tests: 1, payment_orders: 1, pickup_persons: 1, policies: 1, post_admission_tasks: 1,
  post_submissions: 1, ptm_slots: 1, receipt_allocations: 1, receipt_payments: 1, receipts: 1, refunds: 1, report_cards: 1, reading_logs: 1,
  routes: 1, sales: 1, size_history: 1, stops: 1, store_orders: 1, student_group_members: 1, student_groups: 1, student_transport: 1, student_wallet_txns: 1,
  student_wallets: 1, stored_documents: 1, test_attempts: 1, trip_events: 1, trip_positions: 1, trips: 1,
};

describe('parents and students see only their own child (decision 30)', () => {
  async function visible(uid: string) {
    const out: Record<string, number> = {};
    for (const t of erpTables) {
      const n = await count('authenticated', uid, `select * from ${qi('erp', t)}`);
      if (n) out[t] = n;
    }
    return out;
  }

  it('the guardian of org A reads exactly the portal tables, with only the linked child\'s rows', async () => {
    expect(await visible(w.u.aGuardian)).toEqual(GUARDIAN_VISIBLE);
  });

  it('the student login sees its own rows, not the guardian\'s inbox or form answers', async () => {
    expect(await visible(w.u.aStudent)).toEqual({ ...GUARDIAN_VISIBLE, announcement_recipients: undefined, form_responses: undefined, conversation_messages: undefined });
  });

  it('the guardian of org B sees only org B\'s own child', async () => {
    expect(await visible(w.u.bGuardian)).toEqual(GUARDIAN_VISIBLE);
    expect(await count('authenticated', w.u.bGuardian, `select * from erp.fee_demands where student_id <> $1`, [w.learnerB])).toBe(0);
  });

  it('fees, receipts, report cards and transport: own child only, never another family', async () => {
    const g = w.u.aGuardian;
    expect((await col(g, `select distinct student_id from erp.fee_demands`))).toEqual([w.learnerA]);
    expect(await count('authenticated', g, `select * from erp.fee_demands where id = $1`, [w.erpA.dOther1])).toBe(0);
    expect((await col(g, `select id from erp.receipts`))).toEqual([w.erpA.receipt]);
    expect((await col(g, `select distinct receipt_id from erp.receipt_payments`))).toEqual([w.erpA.receipt]);
    expect((await col(g, `select term from erp.report_cards`))).toEqual(['Term 1']); // not the unpublished Term 2, not the other child's
    expect((await col(g, `select name from erp.routes`))).toEqual(['Route 1']);
    expect((await col(g, `select id from erp.trips`))).toEqual([w.erpA.trip1]);
    expect((await col(g, `select distinct student_id from erp.trip_events`))).toEqual([w.learnerA]);
    expect((await col(g, `select open_slot from (select (status = 'open') as open_slot from erp.ptm_slots) x`))).toEqual([true]); // another family's booked slot stays hidden
    // staff-only rows next to them: follow-up notes, safeguarding, counselling, vouchers, payroll
    for (const t of ['fee_followups', 'safeguarding_incidents', 'counselling_referrals', 'vouchers', 'voucher_lines', 'accounts', 'salary_structures', 'payslips', 'staff_loans', 'bank_lines', 'expenses', 'staff_payroll', 'student_sensitive']) {
      expect(await count('authenticated', g, `select * from erp.${t}`), t).toBe(0);
    }
    expect((await col(g, `select count(*)::int from erp.growth_records where visibility <> 'teacher' or note = 'Counsellor only'`))).toEqual([0]);
  });

  it('the other family sees only its own child', async () => {
    expect((await col(w.u.aOtherParent, `select distinct student_id from erp.fee_demands`))).toEqual([w.coreA.other]);
    expect((await col(w.u.aOtherParent, `select receipt_no from erp.receipts`)).length).toBe(1);
    expect(await count('authenticated', w.u.aOtherParent, `select * from erp.receipts where id = $1`, [w.erpA.receipt])).toBe(0);
  });

  it('a family cannot write money, marks, fee or wallet rows, or act for another family\'s child', async () => {
    const g = w.u.aGuardian;
    expect(await ec('authenticated', g, `insert into erp.receipts (org_id, receipt_no, total) values ($1, 'X-1', 10)`, [w.A.id])).toBe('42501');
    expect(await ec('authenticated', g, `insert into erp.fee_demands (org_id, student_id, head_id, amount, due_date) values ($1, $2, (select id from erp.fee_heads limit 1), 1, current_date)`, [w.A.id, w.learnerA])).toBe('42501');
    expect(await ec('authenticated', g, `insert into erp.payment_orders (org_id, student_id, amount, allocations) values ($1, $2, 1, '[]')`, [w.A.id, w.learnerA])).toBe('42501');
    expect(await ec('authenticated', g, `insert into erp.sales (org_id, student_id, lines, total) values ($1, $2, '[]', 1)`, [w.A.id, w.learnerA])).toBe('42501');
    expect(await tx('authenticated', g, async (c) => (await c.query(`update erp.student_wallets set balance = 9999`)).rowCount)).toBe(0);
    expect(await tx('authenticated', g, async (c) => (await c.query(`update erp.assessment_results set marks = 100`)).rowCount)).toBe(0);
    // own-row inserts: only for the linked child and only in the starting state
    const gp = `insert into erp.gate_passes (org_id, student_id, reason, requested_by, status) values ($1, $2, 'doctor', $3, $4)`;
    expect(await ec('authenticated', g, gp, [w.A.id, w.learnerA, g, 'requested'])).toBe('');
    expect(await ec('authenticated', g, gp, [w.A.id, w.learnerA, g, 'approved'])).toBe('42501');
    expect(await ec('authenticated', g, gp, [w.A.id, w.coreA.other, g, 'requested'])).toBe('42501');
    expect(await ec('authenticated', g, gp, [w.A.id, w.learnerA, w.u.aAdmin, 'requested'])).toBe('42501');
    const order = `insert into erp.store_orders (org_id, student_id, lines, total, status) values ($1, $2, '[]', 0, 'ordered')`;
    expect(await ec('authenticated', g, order, [w.A.id, w.learnerA])).toBe('');
    expect(await ec('authenticated', g, order, [w.A.id, w.coreA.other])).toBe('42501');
    expect(await ec('authenticated', g, `insert into erp.reading_logs (org_id, student_id, title) values ($1, $2, 'x')`, [w.A.id, w.learnerA])).toBe('');
    expect(await ec('authenticated', g, `insert into erp.reading_logs (org_id, student_id, title) values ($1, $2, 'x')`, [w.A.id, w.coreA.other])).toBe('42501');
    // a message read mark is the only change a family may make to its inbox
    expect(await ec('authenticated', g, `update erp.announcement_recipients set status = 'read', read_at = now()`)).toBe('');
    expect(await ec('authenticated', g, `update erp.announcement_recipients set title = 'edited'`)).toBe('42501');
  });

  it('gate pass OTP: the guardian sees the code of the own child\'s pass only; the table is closed; gate staff verify with an attempt limit', async () => {
    const g = w.u.aGuardian;
    expect((await call(g, `select erp.my_gate_pass_otp($1) as otp`, [w.erpA.passes.learner])).otp).toBe('123456');
    expect(await ec('authenticated', g, `select erp.my_gate_pass_otp($1)`, [w.erpA.passes.other])).toBe('42501');
    expect(await ec('authenticated', g, `select * from private.gate_pass_otps`)).toBe('42501');
    expect(await ec('erp_server', g, `select * from private.gate_pass_otps`, [], 'erp_server')).toBe('42501');
    expect(await ec('authenticated', g, `select erp.verify_gate_pass($1, '123456')`, [w.erpA.passes.learner])).toBe('42501');
    const a = w.u.aAdmin;
    expect((await call(a, `select erp.verify_gate_pass($1, '000000') as r`, [w.erpA.passes.learner])).r).toBe('mismatch');
    expect((await call(a, `select erp.verify_gate_pass($1, '123456') as r`, [w.erpA.passes.learner])).r).toBe('ok');
    expect(await ec('authenticated', a, `select erp.verify_gate_pass($1, '123456')`, [w.erpA.passes.learner])).toBe('22023'); // already handed over
    expect(await ec('authenticated', w.u.bAdmin, `select erp.verify_gate_pass($1, '654321')`, [w.erpA.passes.other])).toBe('42501'); // another school
  });

  it('PTM booking, online tests and payment orders only for the own child', async () => {
    const g = w.u.aGuardian;
    const open = (await rows(w.u.aAdmin, `select id from erp.ptm_slots where status = 'open'`))[0]!.id;
    expect(await ec('authenticated', g, `select erp.book_ptm_slot($1, $2)`, [open, w.coreA.other])).toBe('42501');
    expect(await ec('authenticated', g, `select erp.book_ptm_slot($1, $2)`, [open, w.learnerA])).toBe('');
    expect(await ec('authenticated', w.u.aOtherParent, `select erp.book_ptm_slot($1, $2)`, [open, w.coreA.other])).toBe('55000'); // taken
    expect(await ec('authenticated', g, `select erp.get_test_questions($1)`, [w.erpA.live])).toBe('');
    expect(await ec('authenticated', g, `select erp.submit_test($1, $2, '{}'::jsonb)`, [w.erpA.live, w.coreA.other])).toBe('42501');
    // create_payment_order: own child, within the balance
    const alloc = (id: string, amount: number) => JSON.stringify([{ demand_id: id, amount }]);
    expect(await ec('authenticated', g, `select erp.create_payment_order($1, $2::jsonb)`, [w.coreA.other, alloc(w.erpA.dOther1, 100)])).toBe('42501');
    expect(await ec('authenticated', g, `select erp.create_payment_order($1, $2::jsonb)`, [w.learnerA, alloc(w.erpA.dOther1, 100)])).toBe('22023'); // another child's demand
    expect(await ec('authenticated', g, `select erp.create_payment_order($1, $2::jsonb)`, [w.learnerA, alloc(w.erpA.dLearner2, 999999)])).toBe('22023');
    expect(await ec('authenticated', g, `select erp.create_payment_order($1, $2::jsonb)`, [w.learnerA, alloc(w.erpA.dLearner1, 10)])).toBe('22023'); // already paid
    expect(await ec('authenticated', g, `select erp.create_payment_order($1, $2::jsonb)`, [w.learnerA, alloc(w.erpA.dLearner2, 1000)])).toBe('');
  });

  it('report cards and health data are opened through functions that log the view', async () => {
    const g = w.u.aGuardian;
    const rc = (await asOwner(`select id from erp.report_cards where org_id = $1 and student_id = $2 and status = 'published'`, [w.A.id, w.learnerA]))[0]!.id;
    const draft = (await asOwner(`select id from erp.report_cards where org_id = $1 and student_id = $2 and status = 'draft'`, [w.A.id, w.learnerA]))[0]!.id;
    const before = Number((await asOwner(`select count(*)::int as n from audit.log where org_id = $1 and action = 'erp.view'`, [w.A.id]))[0]!.n);
    expect((await call(g, `select term, views from erp.open_report_card($1)`, [rc])).views).toBe(1);
    expect(await ec('authenticated', g, `select erp.open_report_card($1)`, [draft])).toBe('42501');
    expect(await ec('authenticated', g, `select erp.open_report_card($1)`, [(await asOwner(`select id from erp.report_cards where org_id = $1 and student_id = $2`, [w.A.id, w.coreA.other]))[0]!.id])).toBe('42501');
    const own = await call(g, `select doctor_name from erp.read_student_sensitive($1)`, [w.learnerA]);
    expect(own.doctor_name).toBe('Dr Rao');
    expect(await ec('authenticated', g, `select erp.read_student_sensitive($1)`, [w.coreA.other])).toBe('42501');
    expect(await ec('authenticated', g, `select erp.save_student_sensitive($1, '{}'::jsonb)`, [w.learnerA])).toBe('42501');
    const logged = await asOwner(`select table_name, actor_user_id from audit.log where org_id = $1 and action = 'erp.view' order by id`, [w.A.id]);
    expect(logged.length - before).toBe(2);
    expect(logged.slice(-2)).toEqual([{ table_name: 'report_cards', actor_user_id: g }, { table_name: 'student_sensitive', actor_user_id: g }]);
  });
});

// ---------------------------------------------------------------------------------------------- staff roles
describe('staff access follows the ERP role (core.role_permissions)', () => {
  it('accounts: fees yes, payroll and student health no; class teacher: marks on open assessments only; hr: payroll', async () => {
    const acc = w.erpA.users.accounts!;
    const teacher = w.erpA.users.classTeacher!;
    const hr = w.erpA.users.hr!;
    expect(await count('authenticated', acc, `select * from erp.receipts`)).toBe(2);
    expect(await count('authenticated', acc, `select * from erp.accounts`)).toBeGreaterThan(0);
    expect(await count('authenticated', acc, `select * from erp.payslips`)).toBe(2); // accounts:payroll V
    expect(await count('authenticated', acc, `select * from erp.salary_structures`)).toBe(2);
    expect(await ec('authenticated', acc, `insert into erp.salary_structures (org_id, staff_id, basic) values ($1, $2, 1)`, [w.A.id, w.coreA.adminStaff])).toBe('42501');
    expect(await count('authenticated', acc, `select * from erp.safeguarding_incidents`)).toBe(0);
    expect(await ec('authenticated', acc, `select erp.read_student_sensitive($1)`, [w.learnerA])).toBe('42501');
    expect(await count('authenticated', teacher, `select * from erp.payslips`)).toBe(0);
    expect(await count('authenticated', teacher, `select * from erp.fee_demands`)).toBe(3); // fees:V
    expect(await ec('authenticated', teacher, `insert into erp.fee_heads (org_id, name) values ($1, 'x')`, [w.A.id])).toBe('42501');
    expect(await count('authenticated', teacher, `select * from erp.growth_records`)).toBe(2); // teacher-visible only (counsellor note hidden)
    expect(await count('authenticated', hr, `select * from erp.payslips`)).toBe(2);
    expect(await count('authenticated', hr, `select * from erp.receipts`)).toBe(0);
    expect((await call(hr, `select bank_name from erp.read_staff_payroll($1)`, [w.coreA.otherStaff])).bank_name).toBe('HDFC');
    expect(await ec('authenticated', teacher, `select erp.read_staff_payroll($1)`, [w.coreA.otherStaff])).toBe('42501');
    expect(await ec('authenticated', acc, `select erp.save_staff_payroll($1, '{}'::jsonb)`, [w.coreA.otherStaff])).toBe('42501');
  });

  it('the restricted payroll and health tables are closed to direct reads even for the admin; reads and saves go through logged functions with redacted audit rows', async () => {
    for (const t of ['staff_payroll', 'student_sensitive']) {
      expect(await count('authenticated', w.u.aAdmin, `select * from erp.${t}`), t).toBe(0);
      expect(await ec('authenticated', w.u.aAdmin, `update erp.${t} set created_at = now()`), t).toBe('42501');
      expect(await ec('erp_server', w.u.aAdmin, `delete from erp.${t}`, [], 'erp_server'), t).toBe('42501');
    }
    const hr = w.erpA.users.hr!;
    const before = Number((await asOwner(`select count(*)::int as n from audit.log where org_id = $1 and table_name = 'staff_payroll' and action = 'erp.view'`, [w.A.id]))[0]!.n);
    await call(hr, `select erp.save_staff_payroll($1, $2::jsonb) as id`, [w.coreA.otherStaff, JSON.stringify({ bank_name: 'Axis', bank_account: '5555000011112222', pan: 'abcde1234f' })]);
    const row = await call(hr, `select bank_name, bank_account, pan from erp.read_staff_payroll($1)`, [w.coreA.otherStaff]);
    expect(row).toEqual({ bank_name: 'Axis', bank_account: '5555000011112222', pan: 'ABCDE1234F' });
    expect(Number((await asOwner(`select count(*)::int as n from audit.log where org_id = $1 and table_name = 'staff_payroll' and action = 'erp.view'`, [w.A.id]))[0]!.n) - before).toBe(1);
    const audit = await asOwner(`select after->>'bank_account' as acct, after->>'bank_name' as bank, after->>'pan' as pan from audit.log where org_id = $1 and table_name = 'staff_payroll' and action = 'update' order by id desc limit 1`, [w.A.id]);
    expect(audit[0]).toEqual({ acct: '[redacted]', bank: '[redacted]', pan: '[redacted]' });
    expect(await ec('authenticated', hr, `select erp.save_staff_payroll($1, '{"pan":"bad"}'::jsonb)`, [w.coreA.otherStaff])).toBe('23514');
    expect(await ec('authenticated', hr, `select erp.log_view('no_such_table', null)`)).toBe('22023');
  });

  it('the driver sees and works only the assigned route', async () => {
    const d = w.erpA.users.driver!;
    expect(await col(d, `select name from erp.driver_routes()`)).toEqual(['Route 1']);
    expect((await col(d, `select name from erp.driver_trip_students($1)`, [w.erpA.trip1])).length).toBe(1);
    expect(await col(d, `select name from erp.driver_trip_students($1)`, [w.erpA.trip2])).toEqual([]);
    expect(await ec('authenticated', d, `select erp.driver_mark($1, $2, 'dropped')`, [w.erpA.trip2, w.coreA.other])).toBe('42501');
    expect(await ec('authenticated', d, `select erp.driver_mark($1, $2, 'dropped')`, [w.erpA.trip1, w.coreA.other])).toBe('22023'); // not on the route
    expect(await ec('authenticated', d, `select erp.driver_mark($1, $2, 'dropped')`, [w.erpA.trip1, w.learnerA])).toBe('');
    expect(await ec('authenticated', d, `select erp.driver_position($1, 17.4, 78.4, 80)`, [w.erpA.trip1])).toBe('');
    expect(await count('authenticated', d, `select * from erp.fee_demands`)).toBe(0);
    expect(await ec('authenticated', d, `select erp.driver_trip_end($1)`, [w.erpA.trip2])).toBe('42501');
    // the guardian was told
    expect(await count('authenticated', w.u.aGuardian, `select * from core.notifications where event_key in ('transport.dropped','transport.overspeed')`)).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------- immutability and locks
describe('money is immutable, marks lock after publication', () => {
  it('receipts, payments, allocations, vouchers and lines cannot be edited or deleted by anyone with an ordinary role, nor by the owner', async () => {
    const a = w.u.aAdmin;
    expect(await ec('authenticated', a, `update erp.receipts set total = 1`)).toBe('42501');
    expect(await ec('authenticated', a, `update erp.receipts set status = 'reversed'`)).toBe('42501'); // only the reversal function may
    expect(await ec('authenticated', a, `update erp.receipt_payments set amount = 1`)).toBe('42501');
    expect(await ec('authenticated', a, `update erp.receipt_allocations set amount = 1`)).toBe('42501');
    expect(await ec('authenticated', a, `update erp.vouchers set narration = 'x'`)).toBe('42501');
    expect(await ec('authenticated', a, `update erp.voucher_lines set debit = debit + 1`)).toBe('42501');
    for (const t of ['receipts', 'receipt_payments', 'receipt_allocations', 'vouchers', 'voucher_lines']) {
      expect(await tx('authenticated', a, async (c) => (await c.query(`delete from erp.${t}`)).rowCount), `delete ${t}`).toBe(0);
      await expect(asOwner(`delete from erp.${t} where org_id = $1`, [w.A.id]), `owner delete ${t}`).rejects.toMatchObject({ code: '42501' });
    }
    await expect(asOwner(`update erp.receipts set total = 1 where org_id = $1`, [w.A.id])).rejects.toMatchObject({ code: '42501' });
    // cheque status may move (deposit, clearance), nothing else of a payment
    const chq = (await asOwner(`insert into erp.receipt_payments (org_id, receipt_id, mode, amount, cheque_no, cheque_status) select org_id, receipt_id, 'cheque', 1, 'C1', 'received' from erp.receipt_payments where org_id = $1 limit 1 returning id`, [w.A.id]))[0]!.id;
    expect(await ec('authenticated', a, `update erp.receipt_payments set cheque_status = 'deposited' where id = $1`, [chq])).toBe('');
  });

  it('a voucher must balance (checked at commit)', async () => {
    const acc = (await asOwner(`select id from erp.accounts where org_id = $1 and code = '1000'`, [w.A.id]))[0]!.id;
    const bad = await ownerTx(async (c) => {
      const v = (await c.query(`insert into erp.vouchers (org_id, voucher_no) values ($1, 'V-BAD') returning id`, [w.A.id])).rows[0].id;
      await c.query(`insert into erp.voucher_lines (org_id, voucher_id, account_id, debit) values ($1, $2, $3, 10)`, [w.A.id, v, acc]);
    });
    expect(bad).toBe('23514');
    const good = await ownerTx(async (c) => {
      const v = (await c.query(`insert into erp.vouchers (org_id, voucher_no) values ($1, 'V-OK') returning id`, [w.A.id])).rows[0].id;
      await c.query(`insert into erp.voucher_lines (org_id, voucher_id, account_id, debit) values ($1, $2, $3, 10)`, [w.A.id, v, acc]);
      const inc = (await c.query(`select id from erp.accounts where org_id = $1 and code = '4000'`, [w.A.id])).rows[0].id;
      await c.query(`insert into erp.voucher_lines (org_id, voucher_id, account_id, credit) values ($1, $2, $3, 10)`, [w.A.id, v, inc]);
    });
    expect(good).toBe('');
  });

  it('fee_demands.paid and student_wallets.balance change only inside the fee and wallet functions', async () => {
    const a = w.u.aAdmin;
    expect(await ec('authenticated', a, `update erp.fee_demands set paid = paid + 1`)).toBe('42501');
    expect(await ec('authenticated', a, `update erp.fee_demands set concession = 1`)).toBe('42501');
    expect(await ec('authenticated', a, `insert into erp.fee_demands (org_id, student_id, head_id, amount, paid, due_date) values ($1, $2, (select id from erp.fee_heads where org_id = $1 limit 1), 10, 10, current_date)`, [w.A.id, w.learnerA])).toBe('42501');
    expect(await ec('authenticated', a, `update erp.student_wallets set balance = 5000`)).toBe('42501');
    expect(await ec('authenticated', a, `update erp.fee_demands set note = 'edited note' where id = $1`, [w.erpA.dLearner2])).toBe(''); // other columns are free
  });

  it('marks of a published assessment cannot be changed, reopened or deleted by hand; an approved marks_unlock request reopens them', async () => {
    const a = w.u.aAdmin;
    expect(await ec('authenticated', a, `update erp.assessment_results set marks = 99 where assessment_id = $1`, [w.erpA.asPub])).toBe('42501');
    expect(await ec('authenticated', a, `insert into erp.assessment_results (org_id, assessment_id, student_id, marks) values ($1, $2, $3, 1)`, [w.A.id, w.erpA.asPub, w.coreA.sibling])).toBe('42501');
    expect(await ec('authenticated', a, `delete from erp.assessment_results where assessment_id = $1`, [w.erpA.asPub])).toBe('42501');
    expect(await ec('authenticated', a, `update erp.assessments set status = 'open' where id = $1`, [w.erpA.asPub])).toBe('42501');
    expect(await ec('authenticated', a, `delete from erp.assessments where id = $1`, [w.erpA.asPub])).toBe('42501');
    // open assessments stay editable by a teacher with marks.S
    expect(await ec('authenticated', w.erpA.users.classTeacher!, `update erp.assessment_results set marks = 22 where assessment_id = $1`, [w.erpA.asOpen])).toBe('');
    // unlock through the approval engine
    const req = await approval('marks_unlock', w.erpA.asPub, 'approved');
    expect((await call(a, `select erp.apply_approval($1) as r`, [req])).r).toBe('approved');
    expect((await asOwner(`select status from erp.assessments where id = $1`, [w.erpA.asPub]))[0]!.status).toBe('open');
    expect(await ec('authenticated', a, `update erp.assessment_results set marks = 99 where assessment_id = $1`, [w.erpA.asPub])).toBe('');
  });

  it('deleting a whole organisation cascades through the immutable tables', async () => {
    const o = await asOwner(`insert into core.organizations (name, slug) values ('Doomed', 'doomed-' || substr(gen_random_uuid()::text, 1, 6)) returning id`);
    const org = o[0]!.id as string;
    const br = (await asOwner(`insert into core.branches (org_id, name, code) values ($1, 'Main', 'M') returning id`, [org]))[0]!.id;
    const stu = (await asOwner(`insert into core.students (org_id, branch_id, first_name, admission_no, status) values ($1, $2, 'Gone', '1', 'active') returning id`, [org, br]))[0]!.id;
    for (const [code, type] of [['1000', 'asset'], ['1010', 'asset'], ['4000', 'income']]) await asOwner(`insert into erp.accounts (org_id, code, name, type) values ($1, $2, $2, $3)`, [org, code, type]);
    const head = (await asOwner(`insert into erp.fee_heads (org_id, name) values ($1, 'T') returning id`, [org]))[0]!.id;
    const dem = (await asOwner(`insert into erp.fee_demands (org_id, branch_id, student_id, head_id, amount, due_date) values ($1, $2, $3, $4, 100, current_date) returning id`, [org, br, stu, head]))[0]!.id;
    await asOwner(`select erp.post_receipts($1, $2::jsonb, null, 'x')`, [org, JSON.stringify({ allocations: [{ demand_id: dem, amount: 100 }], payments: [{ mode: 'cash', amount: 100 }] })]);
    expect(Number((await asOwner(`select count(*)::int as n from erp.voucher_lines where org_id = $1`, [org]))[0]!.n)).toBe(2);
    await expect(asOwner(`delete from core.students where id = $1`, [stu])).rejects.toMatchObject({ code: '23503' }); // money restricts deleting a learner
    await asOwner(`delete from core.organizations where id = $1`, [org]);
    for (const t of ['receipts', 'receipt_payments', 'receipt_allocations', 'vouchers', 'voucher_lines', 'fee_demands']) {
      expect(Number((await asOwner(`select count(*)::int as n from erp.${t} where org_id = $1`, [org]))[0]!.n), t).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------------------------- fee functions
async function ownerTx(fn: (c: import('pg').PoolClient) => Promise<void>): Promise<string> {
  const c = await owner.connect();
  try {
    await c.query('begin');
    await fn(c);
    await c.query('commit');
    return '';
  } catch (e) {
    await c.query('rollback').catch(() => undefined);
    return (e as { code?: string }).code ?? String(e);
  } finally {
    c.release();
  }
}

async function approval(type: string, linkedId: string, status: string, orgId = w.A.id): Promise<string> {
  const t = await asOwner(`insert into core.approval_types (org_id, key, name, product_key) values ($1, $2, $2, 'erp') on conflict (org_id, key) do update set name = excluded.name returning id`, [orgId, `erp_${type}_${randomUUID().slice(0, 4)}`]);
  return (await asOwner(`insert into core.approval_requests (org_id, approval_type_id, product_key, applicant_user_id, title, status, linked_type, linked_id, data)
      values ($1, $2, 'erp', $3, $4, $5, $6, $7, '{"reason":"fixture reversal"}') returning id`, [orgId, t[0]!.id, w.u.aAdmin, `Approve ${type}`, status, type, linkedId]))[0]!.id;
}

describe('fee collection, reversal, concessions, online payment, CRM hand-off', () => {
  const dem = () => w.erpA.dLearner2;
  const alloc = (amount: number, id = dem()) => JSON.stringify({ idempotency_key: `t-${id}-${amount}`, allocations: [{ demand_id: id, amount }], payments: [{ mode: 'upi', amount, reference: 'U1' }] });

  it('counter collection: numbered receipt, voucher posted, demand updated; the same idempotency key returns the same receipt', async () => {
    const acc = w.erpA.users.accounts!;
    const r = (await call(acc, `select erp.collect_fee($1::jsonb) as r`, [alloc(1000)])).r;
    expect(r.duplicate).toBe(false);
    const receipt = r.receipt_ids[0];
    const rec = (await asOwner(`select receipt_no, total, status, collected_by_user_id from erp.receipts where id = $1`, [receipt]))[0]!;
    expect(rec).toMatchObject({ total: '1000.00', status: 'valid', collected_by_user_id: acc });
    expect(String(rec.receipt_no)).toMatch(/^RCPT-a1-\d{5}$/);
    const d = (await asOwner(`select paid, status from erp.fee_demands where id = $1`, [dem()]))[0]!;
    expect(d).toEqual({ paid: '1000.00', status: 'partial' });
    const v = await asOwner(`select sum(debit) as d, sum(credit) as c from erp.voucher_lines vl join erp.vouchers v on v.id = vl.voucher_id where v.ref_id = $1`, [receipt]);
    expect(v[0]).toEqual({ d: '1000.00', c: '1000.00' });
    const again = (await call(acc, `select erp.collect_fee($1::jsonb) as r`, [alloc(1000)])).r;
    expect(again).toEqual({ duplicate: true, receipt_ids: [receipt] });
    expect((await asOwner(`select paid from erp.fee_demands where id = $1`, [dem()]))[0]!.paid).toBe('1000.00');
  });

  it('collection is checked: balance, payment total, permission, org, and the guardian\'s notification', async () => {
    const acc = w.erpA.users.accounts!;
    expect(await ec('authenticated', acc, `select erp.collect_fee($1::jsonb)`, [alloc(999999, dem())])).toBe('22023');
    expect(await ec('authenticated', acc, `select erp.collect_fee($1::jsonb)`, [JSON.stringify({ allocations: [{ demand_id: dem(), amount: 100 }], payments: [{ mode: 'cash', amount: 90 }] })])).toBe('22023');
    expect(await ec('authenticated', acc, `select erp.collect_fee($1::jsonb)`, [JSON.stringify({ allocations: [{ demand_id: dem(), amount: 50 }, { demand_id: dem(), amount: 50 }], payments: [{ mode: 'cash', amount: 100 }] })])).toBe('22023');
    expect(await ec('authenticated', w.erpA.users.classTeacher!, `select erp.collect_fee($1::jsonb)`, [alloc(10)])).toBe('42501');
    expect(await ec('authenticated', w.u.aGuardian, `select erp.collect_fee($1::jsonb)`, [alloc(10)])).toBe('42501');
    expect(await ec('authenticated', w.u.bAdmin, `select erp.collect_fee($1::jsonb)`, [alloc(10)])).toBe('22023'); // A's demand does not exist for B
    expect(await count('authenticated', w.u.aGuardian, `select * from core.notifications where event_key = 'fees.receipt'`)).toBe(1);
  });

  it('a receipt is reversed only through an approved reversal request: demand reopened, mirror voucher, once', async () => {
    const acc = w.erpA.users.accounts!;
    const receipt = (await call(acc, `select erp.collect_fee($1::jsonb) as r`, [alloc(500)])).r.receipt_ids[0] as string;
    const paidBefore = Number((await asOwner(`select paid from erp.fee_demands where id = $1`, [dem()]))[0]!.paid);
    const pending = await approval('receipt_reversal', receipt, 'pending');
    expect(await ec('authenticated', acc, `select erp.apply_approval($1)`, [pending])).toBe('22023'); // not decided yet
    const ok = await approval('receipt_reversal', receipt, 'approved');
    expect(await ec('authenticated', w.u.aGuardian, `select erp.apply_approval($1)`, [ok])).toBe('42501');
    expect(await ec('authenticated', w.u.bAdmin, `select erp.apply_approval($1)`, [ok])).toBe('22023');
    expect((await call(acc, `select erp.apply_approval($1) as r`, [ok])).r).toBe('approved');
    await call(acc, `select erp.apply_approval($1)`, [ok]); // second call changes nothing
    const r = (await asOwner(`select status, reversed_reason from erp.receipts where id = $1`, [receipt]))[0]!;
    expect(r).toEqual({ status: 'reversed', reversed_reason: 'fixture reversal' });
    expect(Number((await asOwner(`select paid from erp.fee_demands where id = $1`, [dem()]))[0]!.paid)).toBe(paidBefore - 500);
    const rev = await asOwner(`select sum(debit) as d, sum(credit) as c, count(distinct v.id)::int as n from erp.voucher_lines vl join erp.vouchers v on v.id = vl.voucher_id where v.ref_type = 'receipt_reversal' and v.ref_id = $1`, [receipt]);
    expect(rev[0]).toEqual({ d: '500.00', c: '500.00', n: 1 });
  });

  it('an approved concession is applied to the open demands of the learner (and not to another learner)', async () => {
    const conc = (await asOwner(`select id from erp.concessions where org_id = $1 and student_id = $2`, [w.A.id, w.learnerA]))[0]!.id;
    const otherBefore = (await asOwner(`select concession from erp.fee_demands where id = $1`, [w.erpA.dOther1]))[0]!.concession;
    const before = Number((await asOwner(`select concession from erp.fee_demands where id = $1`, [dem()]))[0]!.concession);
    const req = await approval('concession', conc, 'approved');
    await call(w.erpA.users.accounts!, `select erp.apply_approval($1)`, [req]);
    expect((await asOwner(`select status from erp.concessions where id = $1`, [conc]))[0]!.status).toBe('approved');
    expect(Number((await asOwner(`select concession from erp.fee_demands where id = $1`, [dem()]))[0]!.concession)).toBe(before + 300); // 10% of 3000
    expect((await asOwner(`select concession from erp.fee_demands where id = $1`, [w.erpA.dOther1]))[0]!.concession).toBe(otherBefore);
    // approving the same request again does not apply it twice
    await call(w.erpA.users.accounts!, `select erp.apply_approval($1)`, [req]);
    expect(Number((await asOwner(`select concession from erp.fee_demands where id = $1`, [dem()]))[0]!.concession)).toBe(before + 300);
  });

  it('online payment: only the server settles an order; the order must match the amount; settling twice gives one receipt', async () => {
    const order = (await asOwner(`select id from erp.payment_orders where org_id = $1 and student_id = $2`, [w.A.id, w.learnerA]))[0]!.id;
    const amount = 1000;
    await asOwner(`update erp.payment_orders set amount = $3, allocations = $2::jsonb where id = $1`, [order, JSON.stringify([{ demand_id: dem(), amount }]), amount]);
    for (const role of ['authenticated', 'crm_server'] as const) {
      expect(await ec(role, w.u.aGuardian, `select erp.settle_payment_order($1, 'pay_1', $2)`, [order, amount])).toBe('42501');
    }
    expect(await ec('erp_server', null, `select erp.settle_payment_order($1, 'pay_1', $2)`, [order, amount + 1], 'erp_server')).toBe('22023');
    const r1 = (await call(null, `select erp.settle_payment_order($1, 'pay_1', $2) as r`, [order, amount], 'erp_server')).r;
    const r2 = (await call(null, `select erp.settle_payment_order($1, 'pay_1', $2) as r`, [order, amount], 'erp_server')).r;
    expect(r2).toBe(r1);
    expect((await asOwner(`select channel, status from erp.receipts where id = $1`, [r1]))[0]).toEqual({ channel: 'online', status: 'valid' });
    expect((await asOwner(`select status from erp.payment_orders where id = $1`, [order]))[0]!.status).toBe('paid');
    // and the guardian sees the receipt
    expect(await col(w.u.aGuardian, `select id from erp.receipts where id = $1`, [r1])).toEqual([r1]);
  });

  it('CRM hand-off: the ERP server posts a receipt and voucher from a CRM payment, once; CRM, OS and users cannot call it', async () => {
    const args = [w.coreA.sibling, 2500, 'upi', 'crm.payment', 'pay-0001', 'UTR-77'];
    const sql = `select erp.post_admission_payment($1, $2, $3, $4, $5, $6) as r`;
    expect(await ec('crm_server', w.u.aAdmin, sql, args, 'crm_server')).toBe('42501'); // no usage on schema erp at all
    expect(await ec('authenticated', w.u.aAdmin, sql, args)).toBe('42501');
    expect(await ec('erp_server', null, `select erp.post_admission_payment($1, 0, 'upi', 'crm.payment', 'x')`, [w.coreA.sibling], 'erp_server')).toBe('22023');
    const r1 = (await call(null, sql, args, 'erp_server')).r;
    const r2 = (await call(null, sql, args, 'erp_server')).r;
    expect(r2).toBe(r1);
    const rec = (await asOwner(`select total, channel, note, student_id from erp.receipts where id = $1`, [r1]))[0]!;
    expect(rec).toMatchObject({ total: '2500.00', channel: 'import', student_id: w.coreA.sibling });
    expect(String(rec.note)).toContain('crm.payment pay-0001');
    expect(Number((await asOwner(`select count(*)::int as n from erp.voucher_lines vl join erp.vouchers v on v.id = vl.voucher_id where v.ref_id = $1`, [r1]))[0]!.n)).toBe(2);
    expect(Number((await asOwner(`select count(*)::int as n from erp.fee_demands where org_id = $1 and student_id = $2`, [w.A.id, w.coreA.sibling]))[0]!.n)).toBe(1);
    // a school without ERP (org D) cannot receive it
    const ghost = (await asOwner(`insert into core.students (org_id, branch_id, first_name, admission_no, status) values ($1, $2, 'Ghost', '9', 'active') returning id`, [w.D.id, w.D.branches.d1]))[0]!.id;
    expect(await ec('erp_server', null, sql, [ghost, 100, 'upi', 'crm.payment', 'g1', null], 'erp_server')).toBe('42501');
  });

  it('a learner who leaves: the exit listener cancels open future fees, transport and hostel (after the status function)', async () => {
    await asOwner(`insert into erp.fee_demands (org_id, student_id, head_id, label, amount, due_date) values ($1, $2, (select id from erp.fee_heads where org_id = $1 limit 1), 'Future fee', 100, current_date + 30)`, [w.A.id, w.coreA.other]);
    const a = w.u.aAdmin;
    expect(await ec('authenticated', a, `select erp.apply_student_exit($1, 'withdrawn')`, [w.coreA.other])).toBe('22023'); // status not changed yet
    await call(a, `select core.change_student_status($1, 'withdrawn', 'moved')`, [w.coreA.other]);
    await call(a, `select erp.apply_student_exit($1, 'withdrawn')`, [w.coreA.other]);
    expect((await asOwner(`select status from erp.fee_demands where org_id = $1 and label = 'Future fee'`, [w.A.id]))[0]!.status).toBe('cancelled');
    expect((await asOwner(`select active from erp.student_transport where org_id = $1 and student_id = $2`, [w.A.id, w.coreA.other]))[0]!.active).toBe(false);
    expect((await asOwner(`select status from core.enrolments where org_id = $1 and student_id = $2`, [w.A.id, w.coreA.other]))[0]!.status).toBe('left');
    expect(await ec('authenticated', w.u.aGuardian, `select erp.apply_student_exit($1, 'withdrawn')`, [w.learnerA])).toBe('42501');
  });
});

describe('store, canteen wallet', () => {
  it('a wallet sale is checked against the balance and the daily limit; balances move only through the functions', async () => {
    const a = w.u.aAdmin;
    const sale = (qty: number) => JSON.stringify({ counter: 'canteen', student_id: w.learnerA, payment_mode: 'wallet', lines: [{ item_id: w.erpA.item, qty, price: 40 }] });
    expect(await ec('authenticated', a, `select erp.pos_sale($1::jsonb)`, [sale(5)])).toBe('22023'); // 200 > 100
    await call(a, `select erp.pos_sale($1::jsonb)`, [sale(1)]);
    expect((await asOwner(`select balance from erp.student_wallets where id = $1`, [w.erpA.wallet]))[0]!.balance).toBe('60.00');
    await asOwner(`update erp.student_wallets set daily_limit = 50 where id = $1`, [w.erpA.wallet]);
    expect(await ec('authenticated', a, `select erp.pos_sale($1::jsonb)`, [sale(1)])).toBe('22023'); // 40 + 40 > 50
    expect((await call(a, `select erp.wallet_topup($1, 100, 'cash') as b`, [w.learnerA])).b).toBe('160.00');
    expect(await ec('authenticated', w.u.aGuardian, `select erp.pos_sale($1::jsonb)`, [sale(1)])).toBe('42501');
    expect(await ec('authenticated', w.u.aGuardian, `select erp.wallet_topup($1, 100)`, [w.learnerA])).toBe('42501');
  });
});

describe('erp.setup_org', () => {
  it('seeds roles and the default chart of accounts for the own school only', async () => {
    expect(await ec('authenticated', w.u.aGuardian, `select erp.setup_org($1)`, [w.A.id])).toBe('42501');
    expect(await ec('authenticated', w.u.aAdmin, `select erp.setup_org($1)`, [w.B.id])).toBe('42501');
    expect(await ec('authenticated', w.u.aAdmin, `select erp.setup_org($1)`, [w.A.id])).toBe('');
    expect(Number((await asOwner(`select count(*)::int as n from erp.accounts where org_id = $1 and code in ('1000','1010','4000','5000')`, [w.A.id]))[0]!.n)).toBe(4);
  });
});
