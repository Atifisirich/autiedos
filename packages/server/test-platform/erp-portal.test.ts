/**
 * ERP portal functions (migration 20261118200001_erp_portal_functions.sql): what a parent and a student may learn through
 * erp.portal_directory, erp.portal_results and erp.request_gate_pass. Same fixture as isolation.test.ts / erp.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { owner, ownerQuery, tx } from './helpers';
import { buildWorld, type World } from './fixture';

let w: World;
beforeAll(async () => {
  w = await buildWorld();
}, 300000);
afterAll(async () => {
  await owner.end();
});

const call = async (user: string | null, sql: string, params: unknown[] = []) => tx('authenticated', user, async (c) => (await c.query(sql, params)).rows);
async function code(user: string | null, sql: string, params: unknown[] = []): Promise<string> {
  try {
    await tx('authenticated', user, (c) => c.query(sql, params));
    return '';
  } catch (e) {
    return (e as { code?: string }).code ?? String(e);
  }
}

describe('erp.portal_directory', () => {
  it('a parent gets the class teacher, subject teachers, PTM staff and the bus of the own child', async () => {
    const [r] = await call(w.u.aGuardian, `select erp.portal_directory($1) as d`, [w.learnerA]);
    const d = r!.d as Record<string, any>;
    expect(d.section).toBeTruthy();
    expect(d.class_teacher.name).toBeTruthy();
    expect(Array.isArray(d.subject_teachers)).toBe(true);
    expect(d.ptm_staff.length).toBeGreaterThan(0);
    expect(d.transport.route).toBe('Route 1');
    expect(d.transport.vehicle).toBeTruthy();
    // names only: no phone, e-mail or login ids leak through the directory
    expect(JSON.stringify(d)).not.toMatch(/phone|email|user_id/);
  });

  it('the student login sees its own directory; other families, other clients and the unlinked get "not allowed"', async () => {
    expect((await call(w.u.aStudent, `select erp.portal_directory($1) as d`, [w.learnerA]))[0]!.d).toBeTruthy();
    expect(await code(w.u.aGuardian, `select erp.portal_directory($1)`, [w.coreA.other])).toBe('42501'); // another family in the same school
    expect(await code(w.u.aOtherParent, `select erp.portal_directory($1)`, [w.learnerA])).toBe('42501');
    expect(await code(w.u.aGuardian, `select erp.portal_directory($1)`, [w.learnerB])).toBe('42501'); // another client
    expect(await code(w.u.bGuardian, `select erp.portal_directory($1)`, [w.learnerA])).toBe('42501');
    expect(await code(w.u.nobody, `select erp.portal_directory($1)`, [w.learnerA])).toBe('42501');
    expect(await code(null, `select erp.portal_directory($1)`, [w.learnerA])).not.toBe('');
  });

  it('not callable by anon', async () => {
    const r = await ownerQuery(`select has_function_privilege('anon', 'erp.portal_directory(uuid)', 'execute') as a, has_function_privilege('authenticated', 'erp.portal_directory(uuid)', 'execute') as u,
                                       has_function_privilege('anon', 'erp.request_gate_pass(uuid,text,text,text,uuid,timestamptz)', 'execute') as g,
                                       has_function_privilege('anon', 'erp.portal_results(uuid)', 'execute') as r`);
    expect(r[0]).toEqual({ a: false, u: true, g: false, r: false });
  });
});

describe('erp.portal_results', () => {
  it('returns published marks with labels for the own child only', async () => {
    const rows = await call(w.u.aGuardian, `select * from erp.portal_results($1)`, [w.learnerA]);
    expect(rows.map((r) => r.name)).toEqual(['Unit test 1']); // the open "Unit test 2" marks are not shown
    expect(rows[0]).toMatchObject({ subject: 'Science', term: 'Term 1' });
    expect(Number(rows[0]!.marks)).toBe(41);
    expect(await code(w.u.aGuardian, `select * from erp.portal_results($1)`, [w.coreA.other])).toBe('42501');
    expect(await code(w.u.bGuardian, `select * from erp.portal_results($1)`, [w.learnerA])).toBe('42501');
  });
});

describe('erp.request_gate_pass', () => {
  async function request(user: string, student: string, reason = 'Doctor appointment') {
    const c = await owner.connect();
    try {
      await c.query('begin');
      await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: user, role: 'authenticated' })]);
      await c.query('set local role authenticated');
      const id = (await c.query(`select erp.request_gate_pass($1, $2, 'Uncle', '9000000000', null, now() + interval '2 hours') as id`, [student, reason])).rows[0].id as string;
      await c.query('commit');
      return id;
    } catch (e) {
      await c.query('rollback');
      throw e;
    } finally {
      c.release();
    }
  }

  it('creates the pass (requested, branch of the child) and the approval request for the class teacher, in one step', async () => {
    const id = await request(w.u.aGuardian, w.learnerA);
    const [g] = await ownerQuery(`select status, branch_id, requested_by, student_id from erp.gate_passes where id = $1`, [id]);
    expect(g).toMatchObject({ status: 'requested', requested_by: w.u.aGuardian, student_id: w.learnerA });
    expect(g!.branch_id).toBeTruthy();
    const [a] = await ownerQuery(`select status, linked_type, linked_id, student_id, applicant_user_id, cardinality(pending_approver_ids) as n, product_key from core.approval_requests where linked_id = $1`, [id]);
    expect(a).toMatchObject({ status: 'pending', linked_type: 'gate_pass', applicant_user_id: w.u.aGuardian, student_id: w.learnerA, n: 1, product_key: 'erp' });
    // no OTP exists until the approval is applied
    expect((await ownerQuery(`select 1 from private.gate_pass_otps where pass_id = $1`, [id])).length).toBe(0);
  });

  it('refuses another family\'s child, another client\'s child, an empty reason and a pickup person of another child', async () => {
    expect(await code(w.u.aGuardian, `select erp.request_gate_pass($1, 'x')`, [w.coreA.other])).toBe('42501');
    expect(await code(w.u.aGuardian, `select erp.request_gate_pass($1, 'x')`, [w.learnerB])).toBe('42501');
    expect(await code(w.u.aGuardian, `select erp.request_gate_pass($1, '  ')`, [w.learnerA])).toBe('22023');
    const other = (await ownerQuery(`select id from erp.pickup_persons where org_id = $1 and student_id = $2`, [w.A.id, w.coreA.other]))[0]!.id;
    expect(await code(w.u.aGuardian, `select erp.request_gate_pass($1, 'x', null, null, $2)`, [w.learnerA, other])).toBe('22023');
  });
});
