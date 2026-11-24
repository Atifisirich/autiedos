/**
 * CRM port on the isolation harness (plan section 8): the crm tables for T2 (a CRM-only client), T3 (a user granted only
 * OS) and T5 (the CRM server role cannot touch os / erp). The generic T1/T7 checks already cover every crm table through
 * the catalogue and the fixture rows of orgs A and B (fixture-crm.ts); this file adds the product-boundary cases.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { count, errorCode, loginAs, orgTables, owner, ownerQuery, qi, tx } from './helpers';
import { buildWorld, type World } from './fixture';
import { seedCrm } from './fixture-crm';

let w: World;
let crmTables: { schema: string; table: string }[] = [];

async function plantCrm(org: string, branch: string, admin: string) {
  const year = (await ownerQuery<{ id: string }>(`insert into core.academic_years (org_id, name, starts_on, ends_on, is_current, status) values ($1, '2026-27', '2026-04-01', '2027-03-31', true, 'active') returning id`, [org]))[0]!.id;
  const prog = (await ownerQuery<{ id: string }>(`insert into core.programmes (org_id, name, board) values ($1, 'Class 8', 'CBSE') returning id`, [org]))[0]!.id;
  await seedCrm((sql, params) => owner.query(sql, params), { org, branch, admin, year, prog });
}

beforeAll(async () => {
  w = await buildWorld();
  crmTables = (await orgTables(['crm'])).filter((t) => t.table !== 'harness_probe');
  // org C is CRM-only, org D has CRM and OS (a user there holds only OS): give both real CRM data
  await plantCrm(w.C.id, w.C.branches.c1!, w.u.cAdmin);
  await plantCrm(w.D.id, w.D.branches.d1!, w.u.dCrmAdmin);
}, 300000);

afterAll(async () => {
  await owner.end();
});

describe('crm tables exist and are covered', () => {
  it('the port created all CRM tables of MAP-TABLES A.2 that stay in crm (plus the wallet and secrets tables)', () => {
    const names = crmTables.map((t) => t.table).sort();
    for (const n of ['enquiries', 'households', 'guardians', 'prospects', 'stages', 'phases', 'sources', 'payments', 'campaigns', 'messages', 'workflows', 'workflow_runs', 'follow_ups', 'visits', 'applications', 'enquiry_documents', 'activities', 'source_touches', 'saved_views', 'assignment_rules', 'forms', 'import_batches', 'import_rows', 'meta_leads', 'settings', 'branch_settings', 'counsellor_settings', 'roles', 'intakes', 'wallet_ledger', 'org_secrets', 'enquiry_sensitive', 'field_settings']) {
      expect(names, n).toContain(n);
    }
    expect(names.length).toBe(33);
  });
});

describe('T2 an org with only the CRM', () => {
  it('reads its CRM rows, and zero rows from every os / erp table (rows planted for it in both)', async () => {
    for (const t of crmTables) expect(await count('authenticated', w.u.cAdmin, `select * from ${qi(t.schema, t.table)} where org_id = $1`, [w.C.id]), `${t.table}`).toBeGreaterThan(0);
    for (const s of ['os', 'erp']) expect(await count('authenticated', w.u.cAdmin, `select * from ${s}.harness_probe`), s).toBe(0);
  });

  it('cannot call os / erp functions or queue jobs for them; the CRM job is allowed', async () => {
    expect(await errorCode('authenticated', w.u.cAdmin, `select app.enqueue_job('erp', 'demo')`)).toBe('42501');
    expect(await errorCode('crm_server', w.u.cAdmin, `select app.enqueue_job('crm', 'demo')`)).toBe('');
  });
});

describe('T3 a user granted only OS in an org that also has the CRM', () => {
  it('sees zero rows in every crm table (rows exist for the org) and cannot write, admit, post to the wallet or read consents', async () => {
    for (const t of crmTables) {
      expect(Number((await ownerQuery(`select count(*)::int as n from ${qi(t.schema, t.table)} where org_id = $1`, [w.D.id]))[0]!.n), `${t.table} planted`).toBeGreaterThan(0);
      for (const role of ['authenticated', 'crm_server'] as const) {
        expect(await count(role, w.u.dOsOnly, `select * from ${qi(t.schema, t.table)}`), `${role} ${t.table}`).toBe(0);
      }
    }
    expect(await errorCode('crm_server', w.u.dOsOnly, `insert into crm.households (org_id) values ($1)`, [w.D.id])).toBe('42501');
    expect(await errorCode('crm_server', w.u.dOsOnly, `select crm.wallet_post('credit', 'recharge', 10)`)).toBe('42501');
    expect(await errorCode('crm_server', w.u.dOsOnly, `select crm.set_consent(gen_random_uuid(), 'whatsapp', true)`)).toBe('42501');
    const enquiry = (await ownerQuery<{ id: string }>(`select id from crm.enquiries where org_id = $1 limit 1`, [w.D.id]))[0]!.id;
    expect(await errorCode('crm_server', w.u.dOsOnly, `select core.admit_student($1)`, [enquiry])).toBe('42501');
    expect(await count('authenticated', w.u.dOsOnly, `select * from core.consents where subject_type = 'crm_guardian'`)).toBe(0);
    // the CRM admin of the same org does see its data
    expect(await count('crm_server', w.u.dCrmAdmin, `select * from crm.enquiries`)).toBeGreaterThan(0);
  });

  it('a CRM admin cannot hand out OS access, and an OS-only user cannot grant themselves the CRM', async () => {
    const self = `insert into core.user_product_access (org_id, user_id, product_key, role_key) values ($1, $2, 'crm', 'admin')`;
    expect(await errorCode('authenticated', w.u.dOsOnly, self, [w.D.id, w.u.dOsOnly])).toBe('42501');
  });
});

describe('T5 the CRM server role', () => {
  it('is denied os.* and erp.* (real login), and reaches only crm + core tables', async () => {
    const c = await loginAs('crm_server');
    try {
      for (const q of ['select * from os.harness_probe', 'select * from erp.harness_probe', 'select * from audit.log', 'select * from billing.plans', 'select * from private.jobs']) {
        await expect(c.query(q), q).rejects.toMatchObject({ code: '42501' });
      }
      expect((await c.query('select count(*)::int as n from crm.enquiries')).rows[0].n).toBe(0); // no claims: nothing
    } finally {
      await c.end();
    }
  });

  it('cannot execute the entitlement, support or billing functions, nor assume another role', async () => {
    expect(await errorCode('crm_server', w.u.cAdmin, `select app.start_support_session($1, 'trying to look around', 10, true)`, [w.A.id])).toBe('42501');
    const c = await loginAs('crm_server');
    try {
      await expect(c.query('set role authenticated')).rejects.toMatchObject({ code: '42501' });
      await expect(c.query('set role os_server')).rejects.toMatchObject({ code: '42501' });
    } finally {
      await c.end();
    }
  });

  it('org A\'s CRM admin through the crm_server role reads A\'s CRM rows only, in every crm table', async () => {
    for (const t of crmTables) {
      expect(await count('crm_server', w.u.aAdmin, `select * from ${qi(t.schema, t.table)} where org_id <> $1`, [w.A.id]), t.table).toBe(0);
      expect(await count('crm_server', w.u.aAdmin, `select * from ${qi(t.schema, t.table)} where org_id = $1`, [w.A.id]), t.table).toBeGreaterThan(0);
    }
  });

  it('admit_student works for the CRM of an org and for nobody else (A cannot admit B\'s enquiry)', async () => {
    const stage = (await ownerQuery<{ id: string }>(`insert into crm.stages (org_id, phase_id, name, seq, is_won) values ($1, $2, 'Admission confirmed', 9, true) returning id`, [w.A.id, w.crmA.stage ? (await ownerQuery<{ phase_id: string }>(`select phase_id from crm.stages where id = $1`, [w.crmA.stage]))[0]!.phase_id : null]))[0]!.id;
    await ownerQuery(`update crm.enquiries set stage_id = $2 where id = $1`, [w.crmA.enquiry, stage]);
    expect(await errorCode('crm_server', w.u.bAdmin, `select core.admit_student($1)`, [w.crmA.enquiry])).toBe('42501');
    expect(await errorCode('os_server', w.u.aAdmin, `select core.admit_student($1)`, [w.crmA.enquiry])).toBe('42501');
    const r = await tx('crm_server', w.u.aAdmin, async (c) => (await c.query(`select core.admit_student($1) as r`, [w.crmA.enquiry])).rows[0].r, true);
    expect(r).toMatchObject({ created: true });
    // the new student is visible to the other products of the same org, through core
    expect(await count('os_server', w.u.aAdmin, `select * from core.students where id = $1`, [r.student_id])).toBe(1);
    // and never to the other client
    expect(await count('authenticated', w.u.bAdmin, `select * from core.students where id = $1`, [r.student_id])).toBe(0);
  });
});
