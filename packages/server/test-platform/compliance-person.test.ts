/**
 * Per-person export and erasure (data-subject-rights-procedure.md 5.1, 5.2) against real Postgres:
 * driven by the registry, scoped to one org, two-step, audited, legal holds honoured, financial rows anonymised.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ComplianceError } from '../src/compliance/types';
import { executePersonErasure, exportPerson, planPersonErasure } from '../src/compliance/person';
import { placeHold, releaseHold } from '../src/compliance/holds';
import { readZip } from '../src/compliance/files';
import { createWorld, type World } from './compliance-support';

let w: World;
beforeAll(async () => {
  w = await createWorld();
}, 300000);
afterAll(async () => {
  await w?.close();
});

const rejects = async (p: Promise<unknown>, code: string) => {
  const e = await p.then(() => null, (x: unknown) => x);
  expect(e, `expected ${code}`).toBeInstanceOf(ComplianceError);
  expect((e as ComplianceError).code).toBe(code);
  return e as ComplianceError;
};

describe('per-person export', () => {
  it('collects every row about a staff member across core tables, as JSON and CSV in a zip', async () => {
    const f = await exportPerson(w.db, w.u.aAdmin!, { orgId: w.A.id, personType: 'staff', personId: w.p.teacher });
    const by = Object.fromEntries(f.data.tables.map((t) => [`${t.schema}.${t.table}`, t.rows.length]));
    expect(by['core.org_users']).toBe(1);
    expect(by['core.user_branch_access']).toBe(1);
    expect(by['core.user_product_access']).toBe(1);
    expect(by['core.login_events']).toBe(2);
    const names = readZip(f.zip).map((e) => e.name);
    expect(names).toContain('data.json');
    expect(names).toContain('manifest.json');
    expect(names).toContain('summary.txt');
    expect(names.some((n) => n.startsWith('csv/core.login_events'))).toBe(true);
    const csv = readZip(f.zip).find((e) => e.name.startsWith('csv/core.org_users'))!.data.toString('utf8');
    expect(csv).toContain('Tara Teacher');
  });

  it('never contains rows of another organisation, even when phone and email are identical', async () => {
    const f = await exportPerson(w.db, w.u.aAdmin!, { orgId: w.A.id, personType: 'lead', personId: w.p.leadA, identifiers: ['+91 98765 00001', 'LENA@example.test'] });
    const leads = f.data.tables.find((t) => t.table === 'leads')!;
    expect(leads.rows.map((r) => r.full_name)).toEqual(['Lena Lead']);
    const everything = JSON.stringify(f.data);
    expect(everything).not.toContain('Bela Lead');
    expect(everything).not.toContain(w.B.id);
    // the consent row of org A is found by contact, B's opt-out with the same number is not
    const consents = f.data.tables.find((t) => t.table === 'consents')!;
    expect(consents.rows).toHaveLength(1);
    expect(consents.rows[0]!.status).toBe('opted_in');
  });

  it('refuses people who may not export: no compliance permission, another org, no user', async () => {
    await rejects(exportPerson(w.db, w.u.aStaffNoCompliance!, { orgId: w.A.id, personType: 'staff', personId: w.p.teacher }), 'forbidden');
    await rejects(exportPerson(w.db, w.u.bAdmin!, { orgId: w.A.id, personType: 'staff', personId: w.p.teacher }), 'forbidden');
    await rejects(exportPerson(w.db, w.u.aGuardian!, { orgId: w.A.id, personType: 'staff', personId: w.p.teacher }), 'forbidden');
    await rejects(exportPerson(w.db, w.u.cAdmin!, { orgId: w.A.id, personType: 'staff', personId: w.p.teacher }), 'forbidden');
  });

  it('a platform admin may export for any org, and the export is audited', async () => {
    const f = await exportPerson(w.db, w.u.platform!, { orgId: w.B.id, personType: 'staff', personId: w.p.teacherB });
    expect(f.data.tables.find((t) => t.table === 'org_users')!.rows).toHaveLength(1);
    const ev = await w.q(`select detail from audit.log where org_id = $1 and action = 'compliance.person_export' order by id desc limit 1`, [w.B.id]);
    expect(ev).toHaveLength(1);
    // the audit event holds counts, not the personal data
    expect(JSON.stringify(ev[0])).not.toContain('Tej Teacher');
  });

  it('product tables are reached without the product role ever reading another schema', async () => {
    // the export of a lead reads crm.leads although the call runs as platform_admin_server, which has no grant on crm
    const direct = await w.pool.connect();
    try {
      await direct.query('begin');
      await direct.query('set local role platform_admin_server');
      await expect(direct.query('select 1 from crm.leads')).rejects.toMatchObject({ code: '42501' });
    } finally {
      await direct.query('rollback');
      direct.release();
    }
  });
});

describe('per-person erasure', () => {
  it('step 1 is a dry run: lists the plan, changes nothing, and gives a token', async () => {
    const before = await w.q(`select count(*)::int as n from core.org_users where user_id = $1`, [w.p.teacher]);
    const plan = await planPersonErasure(w.db, w.u.aAdmin!, { orgId: w.A.id, personType: 'staff', personId: w.p.teacher }, { reason: 'Written instruction from school, ticket 77', identityVerified: true });
    expect(plan.eligible).toBe(true);
    expect(plan.confirmationToken).toMatch(/^[0-9a-f]{64}$/);
    const modes = Object.fromEntries(plan.plan!.tables.map((t) => [`${t.schema}.${t.table}:${t.key_column}`, `${t.mode}:${t.rows}`]));
    expect(modes['core.org_users:user_id']).toBe('delete:1');
    expect(modes['core.login_events:user_id']).toBe('anonymise:2');
    expect((await w.q(`select count(*)::int as n from core.org_users where user_id = $1`, [w.p.teacher]))[0]).toEqual(before[0]);
    const logs = await w.q(`select status, rows_before::int as rows_before from audit.purge_log where request_id = $1 and table_name = 'org_users'`, [plan.requestId]);
    expect(logs).toEqual([{ status: 'dry_run', rows_before: 1 }]);
  });

  it('needs the token from step 1; a wrong or reused token does nothing', async () => {
    const plan = await planPersonErasure(w.db, w.u.aAdmin!, { orgId: w.A.id, personType: 'staff', personId: w.p.teacher }, { reason: 'Written instruction from school, ticket 78', identityVerified: true });
    await rejects(executePersonErasure(w.db, w.u.aAdmin!, plan.requestId, 'f'.repeat(64)), 'forbidden');
    expect((await w.q(`select count(*)::int as n from core.org_users where user_id = $1`, [w.p.teacher]))[0]!.n).toBe(1);
    // expired token
    await w.q(`update core.compliance_requests set token_expires_at = now() - interval '1 minute' where id = $1`, [plan.requestId]);
    await rejects(executePersonErasure(w.db, w.u.aAdmin!, plan.requestId, plan.confirmationToken!), 'forbidden');
    // someone else cannot use it either
    const p2 = await planPersonErasure(w.db, w.u.aAdmin!, { orgId: w.A.id, personType: 'staff', personId: w.p.teacher }, { reason: 'Written instruction from school, ticket 79', identityVerified: true });
    await rejects(executePersonErasure(w.db, w.u.bAdmin!, p2.requestId, p2.confirmationToken!), 'forbidden');
    await rejects(executePersonErasure(w.db, w.u.aStaffNoCompliance!, p2.requestId, p2.confirmationToken!), 'forbidden');
  });

  it('refuses to execute when the identity was not verified', async () => {
    const plan = await planPersonErasure(w.db, w.u.aAdmin!, { orgId: w.A.id, personType: 'staff', personId: w.p.teacher }, { reason: 'Request received by email, not yet verified' });
    const e = await rejects(executePersonErasure(w.db, w.u.aAdmin!, plan.requestId, plan.confirmationToken!), 'refused');
    expect(e.blockers.map((b) => b.code)).toEqual(['identity_not_verified']);
    expect((await w.q(`select count(*)::int as n from core.org_users where user_id = $1`, [w.p.teacher]))[0]!.n).toBe(1);
  });

  it('a legal hold on the person stops it; a table hold keeps just that table; releasing lets it through', async () => {
    const hold = await placeHold(w.db, w.u.aAdmin!, { orgId: w.A.id, scope: 'person', personId: w.p.teacher, personType: 'staff', reason: 'Court order 2026/11, preserve staff records' });
    const refused = await planPersonErasure(w.db, w.u.aAdmin!, { orgId: w.A.id, personType: 'staff', personId: w.p.teacher }, { reason: 'Erasure request ticket 80', identityVerified: true });
    expect(refused.eligible).toBe(false);
    expect(refused.status).toBe('refused');
    expect(refused.confirmationToken).toBeUndefined();
    expect(refused.blockers[0]!.code).toBe('legal_hold');
    await releaseHold(w.db, w.u.aAdmin!, hold, 'Order lifted');

    const tableHold = await placeHold(w.db, w.u.aAdmin!, { orgId: w.A.id, scope: 'table', schema: 'core', table: 'login_events', reason: 'Investigation open, keep login logs' });
    const plan = await planPersonErasure(w.db, w.u.aAdmin!, { orgId: w.A.id, personType: 'staff', personId: w.p.teacher }, { reason: 'Erasure request ticket 81', identityVerified: true });
    const le = plan.plan!.tables.find((t) => t.table === 'login_events')!;
    expect(le.mode).toBe('retain');
    expect(le.reason).toBe('legal_hold');
    await releaseHold(w.db, w.u.aAdmin!, tableHold, 'Investigation closed');
  });

  it('only an authorised user of the org can plan; another org cannot', async () => {
    await rejects(planPersonErasure(w.db, w.u.bAdmin!, { orgId: w.A.id, personType: 'staff', personId: w.p.teacher }, { reason: 'Erasure request ticket 82', identityVerified: true }), 'forbidden');
    await rejects(planPersonErasure(w.db, w.u.aStaffNoCompliance!, { orgId: w.A.id, personType: 'staff', personId: w.p.teacher }, { reason: 'Erasure request ticket 83', identityVerified: true }), 'forbidden');
    await rejects(planPersonErasure(w.db, w.u.aAdmin!, { orgId: w.A.id, personType: 'staff', personId: w.p.teacher }, { reason: 'short' }), 'invalid');
  });

  it('erases a staff member: PII gone, audit trail kept, tombstone without personal data', async () => {
    const piiBefore = await w.q(`select count(*)::int as n from audit.log where org_id = $1 and (before::text like '%Tara Teacher%' or after::text like '%Tara Teacher%')`, [w.A.id]);
    expect(piiBefore[0]!.n).toBeGreaterThan(0); // the audit trigger had stored the name
    const plan = await planPersonErasure(w.db, w.u.aAdmin!, { orgId: w.A.id, personType: 'staff', personId: w.p.teacher }, { reason: 'Written instruction from school, ticket 90', identityVerified: true });
    const done = await executePersonErasure(w.db, w.u.aAdmin!, plan.requestId, plan.confirmationToken!);

    // the person is gone from core
    for (const t of ['org_users', 'user_branch_access', 'user_product_access']) {
      expect((await w.q(`select count(*)::int as n from core.${t} where user_id = $1`, [w.p.teacher]))[0]!.n, t).toBe(0);
    }
    // security log rows stay for statistics but no longer point at the person, the IP or the device
    const events = await w.q(`select user_id, ip, user_agent from core.login_events where org_id = $1 and method = 'password' order by created_at`, [w.A.id]);
    expect(events.every((e) => e.user_id === null && e.ip === null && e.user_agent === null)).toBe(true);
    expect(events.length).toBeGreaterThanOrEqual(2);
    // the audit images no longer carry the name; the rows (who/when/which table) do remain
    const piiAfter = await w.q(`select count(*)::int as n from audit.log where org_id = $1 and (before::text like '%Tara Teacher%' or after::text like '%Tara Teacher%')`, [w.A.id]);
    expect(piiAfter[0]!.n).toBe(0);
    const cfgAfter = await w.q(`select count(*)::int as n from audit.config_history where org_id = $1 and (before::text like '%Tara Teacher%' or after::text like '%Tara Teacher%')`, [w.A.id]);
    expect(cfgAfter[0]!.n).toBe(0);
    const trail = await w.q(`select count(*)::int as n from audit.log where org_id = $1 and table_name = 'org_users' and action in ('insert','delete')`, [w.A.id]);
    expect(trail[0]!.n).toBeGreaterThan(0);
    // an audit event of the erasure itself, and a purge log with counts only
    const ev = await w.q(`select actor_user_id, detail from audit.log where org_id = $1 and action = 'compliance.person_erased'`, [w.A.id]);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.actor_user_id).toBe(w.u.aAdmin);
    const purge = await w.q(`select table_name, action, status, rows_affected::int as rows_affected from audit.purge_log where request_id = $1 and status = 'done' order by id`, [plan.requestId]);
    expect(purge.find((p) => p.table_name === 'org_users')).toMatchObject({ action: 'delete', rows_affected: 1 });
    // tombstone: identifiers dropped, counts only
    const req = (await w.q(`select status, params, result, confirmed_by from core.compliance_requests where id = $1`, [plan.requestId]))[0]!;
    expect(req.status).toBe('executed');
    expect(req.params).toEqual({});
    expect(req.confirmed_by).toBe(w.u.aAdmin);
    // the auth user (email) is outside SQL reach: reported as an external action for the server
    expect(done.externalActions).toEqual([expect.objectContaining({ kind: 'auth_user_delete', user_id: w.p.teacher })]);
    // and a second export finds nothing
    const again = await exportPerson(w.db, w.u.aAdmin!, { orgId: w.A.id, personType: 'staff', personId: w.p.teacher });
    // only the request register and (released) holds remain, both retained on purpose
    expect(again.data.tables.filter((t) => t.rows.length > 0).map((t) => t.table).sort()).toEqual(['compliance_requests', 'legal_holds']);
    // a request cannot be executed twice
    await rejects(executePersonErasure(w.db, w.u.aAdmin!, plan.requestId, plan.confirmationToken!), 'invalid');
    // org B's teacher is untouched
    expect((await w.q(`select count(*)::int as n from core.org_users where user_id = $1`, [w.p.teacherB]))[0]!.n).toBe(1);
  });

  it('anonymises financial rows instead of deleting them (configurable per table in the registry)', async () => {
    const plan = await planPersonErasure(w.db, w.u.aAdmin!, { orgId: w.A.id, personType: 'student', personId: w.p.learnerA }, { reason: 'Parent request, verified in person', identityVerified: true });
    const fee = plan.plan!.tables.find((t) => t.table === 'fee_receipts')!;
    expect(fee).toMatchObject({ mode: 'anonymise', rows: 2 });
    await executePersonErasure(w.db, w.u.aAdmin!, plan.requestId, plan.confirmationToken!);
    const rows = await w.q(`select receipt_no, payer_name, payer_phone, student_id, amount_paise::int as amount_paise from erp.fee_receipts where org_id = $1 order by receipt_no`, [w.A.id]);
    expect(rows).toHaveLength(3); // nothing deleted
    expect(rows[0]).toMatchObject({ receipt_no: 'R-A-1', payer_name: 'Erased person', payer_phone: null, amount_paise: 1500000 });
    expect(rows[0]!.student_id).toBe('00000000-0000-0000-0000-000000000000');
    expect(rows[1]).toMatchObject({ receipt_no: 'R-A-2', payer_name: 'Erased person', amount_paise: 500000 });
    expect(rows[2]).toMatchObject({ receipt_no: 'R-A-3', payer_name: 'Someone Else' }); // another student: untouched
    // org B's receipt untouched
    expect((await w.q(`select payer_name from erp.fee_receipts where org_id = $1`, [w.B.id]))[0]!.payer_name).toBe('Bob Parent');
    // the learner link of the student is gone
    expect((await w.q(`select count(*)::int as n from core.learner_links where learner_id = $1`, [w.p.learnerA]))[0]!.n).toBe(0);
    // and the money is in the audit images but the payer name is not
    const names = await w.q(`select count(*)::int as n from audit.log where org_id = $1 and table_name = 'fee_receipts' and (before::text like '%Gita Guardian%' or after::text like '%Gita Guardian%')`, [w.A.id]);
    expect(names[0]!.n).toBe(0);
  });

  it('erases a lead found by id and by phone, keeps the consent proof, never touches the other org', async () => {
    const plan = await planPersonErasure(w.db, w.u.aAdmin!, { orgId: w.A.id, personType: 'lead', personId: w.p.leadA, identifiers: ['98765 00001'] }, { reason: 'Lead asked to be forgotten', identityVerified: true });
    const modes = Object.fromEntries(plan.plan!.tables.map((t) => [t.table, `${t.mode}:${t.rows}`]));
    expect(modes.leads).toBe('delete:1');
    expect(modes.consents).toBe('retain:1');
    expect(plan.plan!.retained).toBeGreaterThanOrEqual(1);
    await executePersonErasure(w.db, w.u.aAdmin!, plan.requestId, plan.confirmationToken!);
    expect(await w.q(`select full_name from crm.leads where org_id = $1 and full_name = 'Lena Lead'`, [w.A.id])).toHaveLength(0);
    expect(await w.q(`select full_name from crm.leads where org_id = $1`, [w.B.id])).toHaveLength(1); // Bela, same phone, other org
    expect((await w.q(`select count(*)::int as n from core.consents where org_id = $1`, [w.A.id]))[0]!.n).toBe(1);
    const pii = await w.q(`select count(*)::int as n from audit.log where org_id = $1 and (before::text like '%Lena%' or after::text like '%Lena%' or before::text like '%lena@example.test%')`, [w.A.id]);
    expect(pii[0]!.n).toBe(0);
  });
});
