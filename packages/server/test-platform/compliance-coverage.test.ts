/**
 * Compliance coverage of the REAL product schemas (data-subject-rights-procedure.md 5.5, docs/adr/compliance-tooling.md).
 *
 * compliance-catalogue.test.ts checks the registry on a scratch database that holds only platform + core master +
 * compliance, so it never sees os, crm or erp. This file runs on the harness database itself, which global-setup builds
 * with `db.mjs reset --platform-only` (platform, core, os, crm, erp, compliance and 20261126000001_compliance_products):
 *
 *   1. every table with a person-identifying column, in every schema, is in core.pii_registry, and every registry,
 *      table-policy and retention row points at something that exists (a new product table with PII fails CI here);
 *   2. end to end on the harness world (fixture.ts: rows in every table for orgs A and B): export and erasure of a CRM lead,
 *      an ERP student with fees and receipts, and a payroll staff member with a login who collected receipts;
 *   3. an ERP product deletion goes through the immutable money tables, which no one else may delete.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findRegistryProblems, findUnregisteredTables } from '../src/compliance/catalogue';
import { createSetRoleDb } from '../src/compliance/db';
import { executeOrgDeletion, planOrgDeletion } from '../src/compliance/orgDeletion';
import { createFsSink, runOrgExport } from '../src/compliance/orgExport';
import { executePersonErasure, exportPerson, planPersonErasure, type PersonExportData } from '../src/compliance/person';
import type { PersonType } from '../src/compliance/types';
import { buildWorld, type World } from './fixture';
import { owner, ownerQuery } from './helpers';

const cat = { query: (sql: string, params?: unknown[]) => owner.query(sql, params) as never };
const db = createSetRoleDb(owner);
const n = async (sql: string, params: unknown[] = []) => Number((await ownerQuery<{ n: string }>(`select count(*) as n from (${sql}) x`, params))[0]!.n);
const rowsOf = (d: PersonExportData, t: string) => d.tables.filter((x) => `${x.schema}.${x.table}` === t).flatMap((x) => x.rows);

afterAll(async () => {
  await owner.end();
});

describe('catalogue on the full harness schema (os, crm, erp included)', () => {
  it('every product table with a person-identifying column is registered in core.pii_registry', async () => {
    const products = await ownerQuery<{ n: string }>(`select count(*) as n from pg_tables where schemaname in ('os','crm','erp')`);
    expect(Number(products[0]!.n), 'the harness database must hold the product schemas').toBeGreaterThan(150);
    const missing = await findUnregisteredTables(cat);
    expect(missing, `register these in core.pii_registry (personal or exempt): ${JSON.stringify(missing)}`).toEqual([]);
  });

  it('registry and table-policy rows point only at tables and columns that exist and can be applied', async () => {
    expect(await findRegistryProblems(cat)).toEqual([]);
  });

  it('a new product table with a person column fails the check until it is registered', async () => {
    await owner.query(`create table erp.cov_probe (id uuid primary key default gen_random_uuid(), org_id uuid not null references core.organizations(id), guardian_phone text, note text)`);
    try {
      expect(await findUnregisteredTables(cat)).toEqual([{ schema: 'erp', table: 'cov_probe', columns: ['guardian_phone'] }]);
    } finally {
      await owner.query(`drop table if exists erp.cov_probe`);
    }
    expect(await findUnregisteredTables(cat)).toEqual([]);
  });

  it('every retention rule names an existing table and clock column, and none is switched on (all CONFIRM drafts)', async () => {
    const rules = await ownerQuery<{ data_type: string; schema_name: string; table_name: string; date_column: string; filter_column: string | null; enabled: boolean; legal_status: string; ok: boolean }>(
      `select data_type, schema_name, table_name, date_column, filter_column, enabled, legal_status,
              to_regclass(format('%I.%I', schema_name, table_name)) is not null
              and app.has_column(schema_name, table_name, date_column)
              and (filter_column is null or app.has_column(schema_name, table_name, filter_column)) as ok
         from core.retention_policies where org_id is null and scope = 'table' order by data_type`);
    expect(rules.filter((r) => !r.ok).map((r) => r.data_type)).toEqual([]);
    expect(rules.filter((r) => r.enabled)).toEqual([]);
    const types = rules.map((r) => r.data_type);
    for (const t of ['crm_enquiries_inactive', 'crm_messages', 'outbox_message_content', 'students_after_leaving', 'staff_after_leaving', 'erp_fin_3_receipts', 'erp_fin_7_payslips']) {
      expect(types, t).toContain(t);
      expect(rules.find((r) => r.data_type === t)!.legal_status, t).toBe('draft');
    }
  });

  it('every product table is covered by person tools or is a reviewed exemption: lead, student, guardian and staff tables exist per product', async () => {
    const by = await ownerQuery<{ schema_name: string; person_type: string; n: string }>(
      `select schema_name, person_type, count(*) as n from core.pii_registry where org_id is null and classification = 'personal' group by 1, 2`);
    const has = (s: string, p: string) => by.some((r) => r.schema_name === s && r.person_type === p);
    expect(has('crm', 'lead')).toBe(true);
    expect(has('crm', 'staff')).toBe(true);
    expect(has('os', 'staff')).toBe(true);
    expect(has('erp', 'student')).toBe(true);
    expect(has('erp', 'guardian')).toBe(true);
    expect(has('erp', 'staff')).toBe(true);
  });
});

describe('end to end on the harness world', () => {
  let w: World;
  let dir: string;
  beforeAll(async () => {
    w = await buildWorld();
    // the fixture places an org-wide legal hold on A and B (isolation harness rows); it would pause every tool here
    await owner.query(`update core.legal_holds set released_at = now(), release_reason = 'released for the coverage test' where org_id = any($1) and released_at is null`, [[w.A.id, w.B.id]]);
    dir = await mkdtemp(join(tmpdir(), 'compliance-coverage-'));
  }, 600000);
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  async function erase(personType: PersonType, personId: string, identifiers: string[] = []) {
    const plan = await planPersonErasure(db, w.u.aAdmin, { orgId: w.A.id, personType, personId, identifiers }, { reason: `Erasure request for a ${personType}, ticket 900`, identityVerified: true });
    expect(plan.blockers).toEqual([]);
    expect(plan.eligible).toBe(true);
    // every registered table is usable for org A (it has all three products): nothing is skipped as missing
    expect(plan.plan!.tables.filter((t) => t.mode === 'skip')).toEqual([]);
    return executePersonErasure(db, w.u.aAdmin, plan.requestId, plan.confirmationToken!);
  }

  describe('a CRM lead (the family that enquired)', () => {
    const LEAD_TABLES = ['crm.households', 'crm.guardians', 'crm.prospects', 'crm.enquiries', 'crm.activities', 'crm.follow_ups', 'crm.visits', 'crm.messages', 'crm.applications',
      'crm.enquiry_documents', 'crm.enquiry_sensitive', 'crm.source_touches', 'crm.workflow_runs', 'crm.meta_leads', 'crm.import_rows', 'crm.payments'];

    it('export finds every CRM row of the family, whichever of its ids is given, and nothing of org B', async () => {
      for (const id of [w.crmA.hh, w.crmA.guardian, w.crmA.prospect, w.crmA.enquiry]) {
        const f = await exportPerson(db, w.u.aAdmin, { orgId: w.A.id, personType: 'lead', personId: id });
        for (const t of LEAD_TABLES) expect(rowsOf(f.data, t).length, `${t} via ${id === w.crmA.hh ? 'household' : id}`).toBeGreaterThanOrEqual(1);
        expect(JSON.stringify(f.data)).not.toContain(w.B.id);
        expect(JSON.stringify(f.data)).not.toContain(w.crmB.hh);
      }
    });

    it('erasure removes the lead everywhere, keeps pseudonymous funnel stubs and the fee payment without the person, strips audit images, leaves org B alone', async () => {
      const phone = (await ownerQuery<{ phone: string }>(`select phone from crm.guardians where id = $1`, [w.crmA.guardian]))[0]!.phone;
      const payment = (await ownerQuery<{ id: string; amount: string }>(`select id, amount from crm.payments where enquiry_id = $1`, [w.crmA.enquiry]))[0]!;
      const r = await erase('lead', w.crmA.guardian);
      expect(r.result.deleted).toBeGreaterThanOrEqual(12);
      expect(r.result.anonymised).toBeGreaterThanOrEqual(4);

      // family, child and enquiry stay as empty stubs (funnel counts); the parents and the names are gone
      expect(await ownerQuery(`select address, locality, pincode from crm.households where id = $1`, [w.crmA.hh])).toEqual([{ address: null, locality: null, pincode: null }]);
      expect(await ownerQuery(`select first_name, last_name, full_name, dob from crm.prospects where id = $1`, [w.crmA.prospect])).toEqual([{ first_name: 'Erased person', last_name: null, full_name: 'Erased person', dob: null }]);
      expect(await ownerQuery(`select custom, tags from crm.enquiries where id = $1`, [w.crmA.enquiry])).toEqual([{ custom: {}, tags: [] }]);
      for (const [t, col, id] of [['guardians', 'household_id', w.crmA.hh],
        ['activities', 'household_id', w.crmA.hh], ['follow_ups', 'household_id', w.crmA.hh], ['visits', 'household_id', w.crmA.hh], ['messages', 'household_id', w.crmA.hh],
        ['applications', 'enquiry_id', w.crmA.enquiry], ['enquiry_documents', 'enquiry_id', w.crmA.enquiry], ['enquiry_sensitive', 'enquiry_id', w.crmA.enquiry],
        ['source_touches', 'enquiry_id', w.crmA.enquiry], ['workflow_runs', 'enquiry_id', w.crmA.enquiry], ['meta_leads', 'enquiry_id', w.crmA.enquiry], ['import_rows', 'enquiry_id', w.crmA.enquiry]] as const) {
        expect(await n(`select 1 from crm.${t} where org_id = $1 and ${col} = $2`, [w.A.id, id]), `crm.${t}`).toBe(0);
      }
      // money stays, the person goes
      const pay = await ownerQuery<{ amount: string; reference: string | null }>(`select amount, reference from crm.payments where id = $1`, [payment.id]);
      expect(pay).toEqual([{ amount: payment.amount, reference: null }]);
      // the audit trail keeps the row ids but no longer holds the parent's phone
      expect(await n(`select 1 from audit.log where org_id = $1 and schema_name = 'crm' and (coalesce(before::text, '') || coalesce(after::text, '')) like $2`, [w.A.id, `%${phone}%`])).toBe(0);
      expect(await n(`select 1 from audit.log where org_id = $1 and schema_name = 'crm' and table_name = 'guardians' and row_id = $2`, [w.A.id, w.crmA.guardian])).toBeGreaterThan(0);
      // org B's lead with the same shape is untouched
      expect(await n(`select 1 from crm.households where id = $1`, [w.crmB.hh])).toBe(1);
      expect(await n(`select 1 from crm.enquiries where id = $1`, [w.crmB.enquiry])).toBe(1);
    });
  });

  describe('an ERP student with fees', () => {
    it('export holds the fee demands, receipts, health and pickup data of the student', async () => {
      const f = await exportPerson(db, w.u.aAdmin, { orgId: w.A.id, personType: 'student', personId: w.learnerA });
      expect(rowsOf(f.data, 'erp.fee_demands')).toHaveLength(2);
      expect(rowsOf(f.data, 'erp.receipts').length).toBeGreaterThanOrEqual(1);
      expect(rowsOf(f.data, 'erp.student_sensitive')).toHaveLength(1);
      expect(rowsOf(f.data, 'erp.health_checks')).toHaveLength(1);
      expect(rowsOf(f.data, 'erp.pickup_persons')).toHaveLength(1);
      expect(rowsOf(f.data, 'core.students')).toHaveLength(1);
      expect(JSON.stringify(f.data)).not.toContain(w.learnerB);
    });

    it('erasure removes the person and the sensitive data, keeps every money row and amount, and the money guard still stops everyone else', async () => {
      const money = async () => ownerQuery<{ t: string; n: string; s: string }>(
        `select 'receipts' as t, count(*) as n, coalesce(sum(total), 0) as s from erp.receipts where org_id = $1 and student_id = $2
         union all select 'demands', count(*), coalesce(sum(amount), 0) from erp.fee_demands where org_id = $1 and student_id = $2
         union all select 'allocations', count(*), coalesce(sum(amount), 0) from erp.receipt_allocations where org_id = $1 and student_id = $2
         union all select 'refunds', count(*), coalesce(sum(amount), 0) from erp.refunds where org_id = $1 and student_id = $2
         union all select 'vouchers', count(*), 0 from erp.vouchers where org_id = $1
         order by 1`, [w.A.id, w.learnerA]);
      const before = await money();
      expect(before.find((m) => m.t === 'receipts')!.n).not.toBe('0');
      await owner.query(`update erp.fee_demands set note = 'Father lost job, call Rakesh' where org_id = $1 and student_id = $2`, [w.A.id, w.learnerA]);

      await erase('student', w.learnerA);

      expect(await money()).toEqual(before);
      expect((await ownerQuery(`select first_name, last_name, dob from core.students where id = $1`, [w.learnerA]))[0]).toEqual({ first_name: 'Erased person', last_name: null, dob: null });
      for (const t of ['student_sensitive', 'health_checks', 'infirmary_visits', 'pickup_persons', 'counselling_referrals', 'growth_records', 'stored_documents', 'alumni_profiles', 'fee_followups', 'hostel_allocations', 'student_transport'])
        expect(await n(`select 1 from erp.${t} where org_id = $1 and student_id = $2`, [w.A.id, w.learnerA]), `erp.${t}`).toBe(0);
      expect(await n(`select 1 from core.student_sensitive where student_id = $1`, [w.learnerA])).toBe(0);
      expect(await n(`select 1 from erp.fee_demands where student_id = $1 and note is not null`, [w.learnerA])).toBe(0);
      expect((await ownerQuery<{ reason: string }>(`select reason from erp.refunds where student_id = $1`, [w.learnerA])).map((r) => r.reason)).toEqual(['Erased']);
      // the other learner's records are untouched
      expect(await n(`select 1 from erp.student_sensitive where student_id = $1`, [w.coreA.other])).toBe(1);
      expect(await n(`select 1 from core.students where id = $1 and first_name = 'Other'`, [w.coreA.other])).toBe(1);

      // outside the compliance engine the receipts stay immutable, also for the table owner
      await expect(owner.query(`delete from erp.receipts where org_id = $1 and student_id = $2`, [w.A.id, w.learnerA])).rejects.toMatchObject({ code: '42501' });
      await expect(owner.query(`update erp.receipts set note = 'x' where org_id = $1 and student_id = $2`, [w.A.id, w.learnerA])).rejects.toMatchObject({ code: '42501' });
    });
  });

  describe('a payroll staff member with a login', () => {
    it('export holds payroll, payslips and the receipts the person collected; erasure removes the person and keeps the statutory records', async () => {
      const staffId = w.erpA.staff.accounts!;
      const userId = w.erpA.users.accounts!;
      await owner.query(`insert into erp.staff_payroll (org_id, staff_id, bank_name, bank_account, ifsc, pan, uan, address, emergency_contact, aadhaar_last4)
                         values ($1, $2, 'SBI', '5550001112223', 'SBIN0000999', 'PQRSX9876Z', '100200300400', '7 Hill Road', '+919800000777', '9876')`, [w.A.id, staffId]);
      await owner.query(`insert into erp.salary_structures (org_id, staff_id, basic, hra) values ($1, $2, 30000, 9000)`, [w.A.id, staffId]);
      await owner.query(`insert into erp.payslips (org_id, run_id, staff_id, month, gross, total_deductions, net) values ($1, $2, $3, '2026-10-01', 39000, 1800, 37200)`, [w.A.id, w.erpA.run, staffId]);
      await owner.query(`select erp.post_receipts($1, $2::jsonb, $3, 'Accounts Clerk')`, [w.A.id,
        JSON.stringify({ idempotency_key: `cov-${w.A.id}`, allocations: [{ demand_id: w.erpA.dOther1, amount: 1000 }], payments: [{ mode: 'cash', amount: 1000 }] }), userId]);
      const collected = await n(`select 1 from erp.receipts where org_id = $1 and collected_by_user_id = $2`, [w.A.id, userId]);
      expect(collected).toBeGreaterThanOrEqual(1);

      const f = await exportPerson(db, w.u.aAdmin, { orgId: w.A.id, personType: 'staff', personId: staffId });
      expect(rowsOf(f.data, 'erp.staff_payroll')).toHaveLength(1);
      expect(rowsOf(f.data, 'erp.payslips')).toHaveLength(1);
      expect(rowsOf(f.data, 'erp.salary_structures')).toHaveLength(1);
      expect(rowsOf(f.data, 'erp.receipts')).toHaveLength(collected);
      expect(rowsOf(f.data, 'core.org_users')).toHaveLength(1);

      const receiptsBefore = await n(`select 1 from erp.receipts where org_id = $1`, [w.A.id]);
      const r = await erase('staff', staffId);
      expect(r.externalActions).toEqual([expect.objectContaining({ kind: 'auth_user_delete', user_ids: [userId] })]);

      expect(await n(`select 1 from core.org_users where org_id = $1 and user_id = $2`, [w.A.id, userId])).toBe(0);
      expect((await ownerQuery(`select first_name, user_id, email, phone from core.staff where id = $1`, [staffId]))[0]).toEqual({ first_name: 'Erased person', user_id: null, email: null, phone: null });
      expect((await ownerQuery(`select bank_account, ifsc, address, emergency_contact, aadhaar_last4, pan, uan from erp.staff_payroll where staff_id = $1`, [staffId]))[0])
        .toEqual({ bank_account: null, ifsc: null, address: null, emergency_contact: null, aadhaar_last4: null, pan: 'PQRSX9876Z', uan: '100200300400' });
      expect(await n(`select 1 from erp.payslips where staff_id = $1 and net = 37200`, [staffId])).toBe(1);
      expect(await n(`select 1 from erp.salary_structures where staff_id = $1`, [staffId])).toBe(1);
      // the receipts stay, the collector does not
      expect(await n(`select 1 from erp.receipts where org_id = $1`, [w.A.id])).toBe(receiptsBefore);
      expect(await n(`select 1 from erp.receipts where org_id = $1 and (collected_by_user_id = $2 or collected_by_name = 'Accounts Clerk')`, [w.A.id, userId])).toBe(0);
    });
  });

  describe('retention rules for the products', () => {
    it('a dry run of every product evaluates the new rules against the real tables (counts only, nothing changes)', async () => {
      for (const product of ['crm', 'erp'] as const) {
        const out = await db.run('job_runner', {}, async (q) => (await q.query<{ r: { rules: { data_type: string; status: string }[] } }>(`select app.compliance_retention_purge($1, $2, true) as r`, [w.A.id, product])).rows[0]!.r);
        const statuses = Object.fromEntries(out.rules.map((x) => [x.data_type, x.status]));
        if (product === 'crm') {
          expect(statuses.crm_enquiries_inactive).toBe('dry_run');
          expect(statuses.crm_messages).toBe('dry_run');
        } else {
          for (const t of ['erp_fin_1_receipt_allocations', 'erp_fin_3_receipts', 'erp_fin_6_vouchers', 'erp_fin_7_payslips', 'erp_conversation_messages']) expect(statuses[t], t).toBe('dry_run');
        }
      }
    });
  });

  describe('ERP product deletion', () => {
    it('deletes the immutable money tables of org B after the read-only period and the export, and nothing of org A', async () => {
      const receiptsA = await n(`select 1 from erp.receipts where org_id = $1`, [w.A.id]);
      expect(await n(`select 1 from erp.receipts where org_id = $1`, [w.B.id])).toBeGreaterThan(0);
      await owner.query(`update core.subscriptions set status = 'cancelled' where org_id = $1 and product_key = 'erp'`, [w.B.id]);
      await owner.query(
        `update audit.config_history set created_at = now() - interval '31 days'
          where org_id = $1 and schema_name = 'core' and table_name = 'subscriptions' and after ->> 'product_key' = 'erp' and after ->> 'status' = 'cancelled'`, [w.B.id]);
      await runOrgExport(db, createFsSink(dir), w.u.platform, { orgId: w.B.id, purpose: 'non_payment', formats: ['csv'] });
      const plan = await planOrgDeletion(db, w.u.platform, { orgId: w.B.id, product: 'erp', reason: 'Client stopped paying ERP, ticket 910' });
      expect(plan.blockers).toEqual([]);
      expect(plan.eligible).toBe(true);
      await executeOrgDeletion(db, w.u.platform, plan.requestId, plan.confirmationToken!);
      for (const t of ['receipts', 'receipt_payments', 'receipt_allocations', 'vouchers', 'voucher_lines', 'fee_demands', 'payslips', 'staff_payroll'])
        expect(await n(`select 1 from erp.${t} where org_id = $1`, [w.B.id]), `erp.${t}`).toBe(0);
      expect(await n(`select 1 from erp.receipts where org_id = $1`, [w.A.id])).toBe(receiptsA);
      // core and the other products of B stay
      expect(await n(`select 1 from core.students where org_id = $1`, [w.B.id])).toBeGreaterThan(0);
      expect(await n(`select 1 from crm.enquiries where org_id = $1`, [w.B.id])).toBeGreaterThan(0);
    });
  });
});
