/**
 * Custom records engine (20261127200001_core_custom_records, docs/custom-records.md): org isolation, per-object role
 * permissions, validation in the database, link targets in the same org, portal visibility, product entitlement,
 * workflow + approvals, reminders on private.jobs, and the compliance tooling (export / erasure by link field).
 * Runs on the harness world (fixture.ts + fixture-records.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { count, errorCode, owner, ownerQuery, tx } from './helpers';
import { buildWorld, type World } from './fixture';
import { createSetRoleDb } from '../src/compliance/db';
import { executePersonErasure, exportPerson, planPersonErasure } from '../src/compliance/person';

let w: World;

beforeAll(async () => {
  w = await buildWorld();
}, 300000);

afterAll(async () => {
  await owner.end();
});

const rows = (user: string, sql: string, params: unknown[] = []) => tx('authenticated', user, async (c) => (await c.query(sql, params)).rows);
const col = async (user: string, sql: string, params: unknown[] = []) => (await rows(user, sql, params)).map((r) => Object.values(r)[0]);
const insertRecord = (object: string, data: Record<string, unknown>, org?: string) =>
  `insert into core.custom_records (org_id, object_id, data) values ('${org ?? w.A.id}', '${object}', '${JSON.stringify(data).replace(/'/g, "''")}'::jsonb)`;

describe('org isolation', () => {
  it('org B sees none of org A objects, records or history, and the reverse', async () => {
    for (const t of ['custom_objects', 'custom_records', 'custom_record_events']) {
      expect(await count('authenticated', w.u.bAdmin, `select * from core.${t} where org_id = $1`, [w.A.id]), t).toBe(0);
      expect(await count('authenticated', w.u.aAdmin, `select * from core.${t} where org_id = $1`, [w.B.id]), t).toBe(0);
      expect(await count('authenticated', w.u.aAdmin, `select * from core.${t} where org_id = $1`, [w.A.id]), t).toBeGreaterThan(0);
    }
    for (const role of ['crm_server', 'os_server', 'erp_server'] as const) {
      expect(await count(role, w.u.bAdmin, `select * from core.custom_records where org_id = $1`, [w.A.id]), role).toBe(0);
    }
  });

  it('org A cannot write into org B objects or records', async () => {
    expect(await errorCode('authenticated', w.u.aAdmin, insertRecord(w.recB.visitor, { visitor_name: 'x', student: w.learnerB }, w.B.id))).toBe('42501');
    expect(await errorCode('authenticated', w.u.aAdmin, `insert into core.custom_objects (org_id, key, label_singular, label_plural, fields) values ($1, 'evil', 'x', 'x', '[{"key":"a","label":"A","type":"text"}]')`, [w.B.id])).toBe('42501');
    const n = await tx('authenticated', w.u.aAdmin, async (c) => (await c.query(`update core.custom_records set data = data where org_id = $1`, [w.B.id])).rowCount);
    expect(n).toBe(0);
  });

  it('a record of A cannot point at an object of B (composite key), even for the owner', async () => {
    await expect(ownerQuery(`insert into core.custom_records (org_id, object_id, data) values ($1, $2, '{}')`, [w.A.id, w.recB.visitor])).rejects.toMatchObject({ code: '23503' });
  });
});

describe('per-object role permissions', () => {
  it('a teacher (rule: view own, create) sees the object but none of the admin rows, creates one and then sees only it', async () => {
    expect(await col(w.u.aTeacher, `select key from core.custom_objects order by 1`)).toEqual(['visitor_log']);
    expect(await count('authenticated', w.u.aTeacher, `select * from core.custom_records`)).toBe(0);
    const seen = await tx('authenticated', w.u.aTeacher, async (c) => {
      await c.query(insertRecord(w.recA.visitor, { visitor_name: 'Teacher guest', student: w.learnerA }));
      return (await c.query(`select data->>'visitor_name' as v, owner_id from core.custom_records`)).rows;
    });
    expect(seen).toEqual([{ v: 'Teacher guest', owner_id: w.u.aTeacher }]);
  });

  it('a teacher cannot create a row owned by someone else, edit the admin rows, or manage objects', async () => {
    expect(await errorCode('authenticated', w.u.aTeacher,
      `insert into core.custom_records (org_id, object_id, data, owner_id) values ($1, $2, $3, $4)`,
      [w.A.id, w.recA.visitor, JSON.stringify({ visitor_name: 'x', student: w.learnerA }), w.u.aAdmin])).toBe('42501');
    const n = await tx('authenticated', w.u.aTeacher, async (c) => (await c.query(`update core.custom_records set data = data || '{"purpose":"Other"}' where id = $1`, [w.recA.visit])).rowCount);
    expect(n).toBe(0);
    expect(await errorCode('authenticated', w.u.aTeacher, `insert into core.custom_objects (org_id, key, label_singular, label_plural, fields) values ($1, 'mine', 'x', 'x', '[{"key":"a","label":"A","type":"text"}]')`, [w.A.id])).toBe('42501');
    expect(await tx('authenticated', w.u.aTeacher, async (c) => (await c.query(`update core.custom_objects set label_plural = 'x'`)).rowCount)).toBe(0);
  });

  it('a role without a view rule sees nothing: no object, no record, no history', async () => {
    await ownerQuery(`update core.custom_objects set permissions = '[]' where id = $1`, [w.recA.visitor]);
    try {
      expect(await count('authenticated', w.u.aTeacher, `select * from core.custom_objects`)).toBe(0);
      expect(await count('authenticated', w.u.aTeacher, `select * from core.custom_records`)).toBe(0);
      expect(await count('authenticated', w.u.aTeacher, `select * from core.custom_record_events`)).toBe(0);
      expect(await errorCode('authenticated', w.u.aTeacher, insertRecord(w.recA.visitor, { visitor_name: 'x', student: w.learnerA }))).toBe('42501');
    } finally {
      await ownerQuery(`update core.custom_objects set permissions = $2 where id = $1`,
        [w.recA.visitor, JSON.stringify([{ who: 'role', product: 'os', role: 'teacher', view: 'own', create: true, edit: 'own', delete: 'none' }])]);
    }
  });

  it('an all_staff rule with view all opens every row of the object to staff with the product', async () => {
    await ownerQuery(`update core.custom_objects set permissions = '[{"who":"all_staff","view":"all"}]' where id = $1`, [w.recA.visitor]);
    try {
      // the teacher's branch is a1: the org-level row (branch null) and the a1 row are both visible
      expect(await count('authenticated', w.u.aTeacher, `select * from core.custom_records where object_id = $1`, [w.recA.visitor])).toBe(2);
      expect(await errorCode('authenticated', w.u.aTeacher, insertRecord(w.recA.visitor, { visitor_name: 'x', student: w.learnerA }))).toBe('42501'); // no create
    } finally {
      await ownerQuery(`update core.custom_objects set permissions = $2 where id = $1`,
        [w.recA.visitor, JSON.stringify([{ who: 'role', product: 'os', role: 'teacher', view: 'own', create: true, edit: 'own', delete: 'none' }])]);
    }
  });
});

describe('validation in the database', () => {
  const bad = async (data: Record<string, unknown>) => errorCode('authenticated', w.u.aAdmin, insertRecord(w.recA.visitor, data));

  it('rejects wrong types, missing required fields, unknown fields and values outside the choices', async () => {
    expect(await bad({ student: w.learnerA })).toBe('23514'); // visitor_name required
    expect(await bad({ visitor_name: 42, student: w.learnerA })).toBe('23514');
    expect(await bad({ visitor_name: 'x', student: w.learnerA, purpose: 'Party' })).toBe('23514');
    expect(await bad({ visitor_name: 'x', student: w.learnerA, visit_date: '2026-13-45' })).toBe('23514');
    expect(await bad({ visitor_name: 'x', student: w.learnerA, phone: 'call me' })).toBe('23514');
    expect(await bad({ visitor_name: 'x', student: w.learnerA, shoe_size: 9 })).toBe('23514');
    expect(await bad({ visitor_name: 'x', student: 'not-a-uuid' })).toBe('23514');
    expect(await bad({ visitor_name: 'x', student: w.learnerA })).toBe('');
  });

  it('applies defaults and enforces unique fields', async () => {
    const r = await tx('authenticated', w.u.aAdmin, async (c) => (await c.query(`${insertRecord(w.recA.visitor, { visitor_name: 'x', student: w.learnerA })} returning data->>'visit_date' as d, state, learner_ids`)).rows[0]);
    expect(r.d).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(r.state).toBe('open');
    expect(r.learner_ids).toEqual([w.learnerA]);
    expect(await bad({ visitor_name: 'x', student: w.learnerA, pass_no: 'P-1' })).toBe('23514');
    expect(await bad({ visitor_name: 'x', student: w.learnerA, pass_no: 'P-9' })).toBe('');
  });

  it('a link to another org\'s student, staff or branch is rejected (also for the table owner)', async () => {
    expect(await bad({ visitor_name: 'x', student: w.learnerB })).toBe('23514');
    expect(await bad({ visitor_name: 'x', student: w.learnerA, warden: w.coreB.adminStaff })).toBe('23514');
    await expect(ownerQuery(insertRecord(w.recA.visitor, { visitor_name: 'x', student: w.learnerB }))).rejects.toMatchObject({ code: '23514' });
  });

  it('rejects a bad object definition', async () => {
    const def = (fields: unknown, extra = '') => errorCode('authenticated', w.u.aAdmin,
      `insert into core.custom_objects (org_id, key, label_singular, label_plural, fields${extra ? ', portal' : ''}) values ($1, 'probe_obj', 'P', 'Ps', $2${extra ? ', $3' : ''})`,
      extra ? [w.A.id, JSON.stringify(fields), extra] : [w.A.id, JSON.stringify(fields)]);
    expect(await def([{ key: 'a', label: 'A', type: 'colour' }])).toBe('23514');
    expect(await def([{ key: 'a', label: 'A', type: 'choice' }])).toBe('23514');
    expect(await def([{ key: 'a', label: 'A', type: 'text' }, { key: 'a', label: 'B', type: 'text' }])).toBe('23514');
    expect(await def([{ key: 'Bad Key', label: 'A', type: 'text' }])).toBe('23514');
    expect(await def([{ key: 'a', label: 'A', type: 'text' }], '{"enabled": true, "learner_field": "a"}')).toBe('23514');
    expect(await def([{ key: 'a', label: 'A', type: 'text' }])).toBe('');
  });
});

describe('families (portal visibility)', () => {
  it('a guardian sees nothing of an object with portal visibility off', async () => {
    expect(await count('authenticated', w.u.aGuardian, `select * from core.custom_records where object_id = $1`, [w.recA.visitor])).toBe(0);
    expect(await col(w.u.aGuardian, `select key from core.custom_objects`)).toEqual(['pickup_log']);
  });

  it('with portal visibility on, each family sees only its own learner\'s rows, never the history', async () => {
    expect(await col(w.u.aGuardian, `select id from core.custom_records`)).toEqual([w.recA.pickOwn]);
    expect(await col(w.u.aStudent, `select id from core.custom_records`)).toEqual([w.recA.pickOwn]);
    expect(await col(w.u.aOtherParent, `select id from core.custom_records`)).toEqual([w.recA.pickOther]);
    expect(await col(w.u.bGuardian, `select id from core.custom_records`)).toEqual([w.recB.pickOwn]);
    expect(await count('authenticated', w.u.aGuardian, `select * from core.custom_record_events`)).toBe(0);
    expect(await errorCode('authenticated', w.u.aGuardian, insertRecord(w.recA.pickup, { picked_by: 'x', child: w.learnerA }))).toBe('42501');
  });

  it('turning portal visibility off hides the rows again', async () => {
    await ownerQuery(`update core.custom_objects set portal = '{"enabled": false}' where id = $1`, [w.recA.pickup]);
    try {
      expect(await count('authenticated', w.u.aGuardian, `select * from core.custom_records`)).toBe(0);
      expect(await count('authenticated', w.u.aGuardian, `select * from core.custom_objects`)).toBe(0);
    } finally {
      await ownerQuery(`update core.custom_objects set portal = '{"enabled": true, "learner_field": "child"}' where id = $1`, [w.recA.pickup]);
    }
  });
});

describe('product entitlement', () => {
  it('an object owned by a product the user does not hold stays hidden, whatever its rules say', async () => {
    await ownerQuery(`update core.custom_objects set permissions = '[{"who":"all_staff","view":"all","create":true}]' where id = $1`, [w.recA.pickup]);
    try {
      // the teacher holds OS only; pick-up register belongs to ERP
      expect(await count('authenticated', w.u.aTeacher, `select * from core.custom_objects where id = $1`, [w.recA.pickup])).toBe(0);
      expect(await count('authenticated', w.u.aTeacher, `select * from core.custom_records where object_id = $1`, [w.recA.pickup])).toBe(0);
    } finally {
      await ownerQuery(`update core.custom_objects set permissions = '[]' where id = $1`, [w.recA.pickup]);
    }
  });

  it('when the org loses the owning product its records close; core objects stay with any product', async () => {
    await ownerQuery(`update core.subscriptions set status = 'suspended' where org_id = $1 and product_key = 'erp'`, [w.A.id]);
    try {
      expect(await count('authenticated', w.u.aAdmin, `select * from core.custom_records where object_id = $1`, [w.recA.pickup])).toBe(0);
      expect(await count('authenticated', w.u.aAdmin, `select * from core.custom_objects where id = $1`, [w.recA.pickup])).toBe(0);
      expect(await count('authenticated', w.u.aGuardian, `select * from core.custom_records`)).toBe(0);
      expect(await count('authenticated', w.u.aAdmin, `select * from core.custom_records where object_id = $1`, [w.recA.visitor])).toBe(2);
    } finally {
      await ownerQuery(`update core.subscriptions set status = 'active' where org_id = $1 and product_key = 'erp'`, [w.A.id]);
    }
  });
});

describe('workflow and approvals', () => {
  it('state cannot be written directly by a request', async () => {
    expect(await errorCode('authenticated', w.u.aAdmin, `update core.custom_records set state = 'closed' where id = $1`, [w.recA.visit])).toBe('42501');
    expect(await errorCode('authenticated', w.u.aAdmin, `select core.custom_record_transition($1, 'closed')`, [w.recA.visit])).toBe('22023'); // not a transition from open
  });

  it('a transition with approval opens a core approval request; the decision moves the record and is in its history', async () => {
    const out = await tx('authenticated', w.u.aAdmin, async (c) => {
      const t = (await c.query(`select core.custom_record_transition($1, 'approved', 'Uncle verified') as r`, [w.recA.visit])).rows[0].r;
      const rec = (await c.query(`select state, pending_state, pending_approval_id from core.custom_records where id = $1`, [w.recA.visit])).rows[0];
      const req = (await c.query(`select linked_type, linked_id, status from core.approval_requests where id = $1`, [rec.pending_approval_id])).rows[0];
      const mine = (await c.query(`select count(*)::int as n from core.custom_record_approvals()`)).rows[0].n;
      const d = (await c.query(`select core.custom_record_decide($1, true, 'ok') as d`, [rec.pending_approval_id])).rows[0].d;
      const after = (await c.query(`select state, pending_state from core.custom_records where id = $1`, [w.recA.visit])).rows[0];
      const hist = (await c.query(`select kind from core.custom_record_events where record_id = $1 order by created_at, kind`, [w.recA.visit])).rows.map((r) => r.kind);
      return { t, rec, req, mine, d, after, hist };
    });
    expect(out.t).toBe('pending');
    expect(out.rec).toMatchObject({ state: 'open', pending_state: 'approved' });
    expect(out.req).toEqual({ linked_type: 'custom_record', linked_id: w.recA.visit, status: 'pending' });
    expect(out.mine).toBe(1);
    expect(out.d).toBe('approved');
    expect(out.after).toEqual({ state: 'approved', pending_state: null });
    expect(out.hist).toEqual(expect.arrayContaining(['created', 'approval_requested', 'approved', 'state']));
  });

  it('a teacher may not decide approvals of objects it does not manage', async () => {
    const reqId = await tx('authenticated', w.u.aAdmin, async (c) => {
      await c.query(`select core.custom_record_transition($1, 'approved')`, [w.recA.visitOther]);
      return (await c.query(`select pending_approval_id from core.custom_records where id = $1`, [w.recA.visitOther])).rows[0].pending_approval_id;
    }, true);
    try {
      expect(await errorCode('authenticated', w.u.aTeacher, `select core.custom_record_decide($1, true)`, [reqId])).toBe('42501');
      expect(await errorCode('authenticated', w.u.bAdmin, `select core.custom_record_decide($1, true)`, [reqId])).toBe('22023');
    } finally {
      await ownerQuery(`update core.custom_records set pending_state = null, pending_approval_id = null where id = $1`, [w.recA.visitOther]);
      await ownerQuery(`delete from core.approval_requests where id = $1`, [reqId]);
    }
  });

  it('an export is logged in audit.log and the object history; a teacher without export access is refused', async () => {
    const n = await tx('authenticated', w.u.aAdmin, async (c) => {
      await c.query(`select core.custom_records_log_export($1, 2, 'csv')`, [w.recA.visitor]);
      return (await c.query(`select count(*)::int as n from core.custom_record_events where object_id = $1 and kind = 'exported'`, [w.recA.visitor])).rows[0].n;
    });
    expect(n).toBe(2); // fixture row + this one
    expect(await errorCode('authenticated', w.u.aTeacher, `select core.custom_records_log_export($1, 1, 'csv')`, [w.recA.visitor])).toBe('42501');
  });
});

describe('reminders (private.jobs, job_runner only)', () => {
  it('enqueues one job per due record of orgs with the product, claims only reminder jobs and notifies the owner', async () => {
    const out = await tx('job_runner', null, async (c) => {
      const n = (await c.query(`select app.custom_records_enqueue_reminders() as n`)).rows[0].n;
      const again = (await c.query(`select app.custom_records_enqueue_reminders() as n`)).rows[0].n;
      const jobs = (await c.query(`select id, org_id, kind from private.claim_record_jobs('test', 50)`)).rows;
      let sent = 0;
      for (const j of jobs) sent += (await c.query(`select app.custom_records_deliver_reminder($1) as n`, [j.id])).rows[0].n;
      return { n, again, jobs, sent };
    });
    // visit_date defaults to today: both visitor rows of A and B are due
    expect(out.n).toBe(4);
    expect(out.again).toBe(0);
    expect(out.jobs.every((j: { kind: string }) => j.kind === 'records.reminder')).toBe(true);
    expect(out.sent).toBe(4);
    expect(await errorCode('authenticated', w.u.aAdmin, `select app.custom_records_enqueue_reminders()`)).toBe('42501');
    expect(await errorCode('os_server', w.u.aAdmin, `select * from private.claim_record_jobs('x', 1)`)).toBe('42501');
  });
});

describe('compliance tooling', () => {
  const db = createSetRoleDb(owner);

  it('a learner\'s export holds the custom records that link them; a staff member\'s holds the records that name them', async () => {
    await owner.query(`update core.legal_holds set released_at = now(), release_reason = 'released for the records test' where org_id = $1 and released_at is null`, [w.A.id]);
    const s = await exportPerson(db, w.u.aAdmin, { orgId: w.A.id, personType: 'student', personId: w.learnerA });
    const recs = s.data.tables.filter((t) => t.table === 'custom_records').flatMap((t) => t.rows) as { id: string }[];
    expect(recs.map((r) => r.id).sort()).toEqual([w.recA.visit, w.recA.pickOwn].sort());
    const st = await exportPerson(db, w.u.aAdmin, { orgId: w.A.id, personType: 'staff', personId: w.coreA.adminStaff });
    expect(st.data.tables.filter((t) => t.table === 'custom_records').flatMap((t) => t.rows).map((r) => (r as { id: string }).id)).toContain(w.recA.visit);
  });

  it('erasing a learner deletes their records and history; other families\' records stay', async () => {
    const plan = await planPersonErasure(db, w.u.aAdmin, { orgId: w.A.id, personType: 'student', personId: w.learnerA }, { reason: 'Erasure request for a student, ticket 901', identityVerified: true });
    expect(plan.blockers).toEqual([]);
    await executePersonErasure(db, w.u.aAdmin, plan.requestId, plan.confirmationToken!);
    expect(await ownerQuery(`select id from core.custom_records where org_id = $1 and $2 = any(learner_ids)`, [w.A.id, w.learnerA])).toEqual([]);
    expect(await ownerQuery(`select id from core.custom_record_events where record_id = any($1)`, [[w.recA.visit, w.recA.pickOwn]])).toEqual([]);
    expect((await ownerQuery(`select id from core.custom_records where id = any($1)`, [[w.recA.visitOther, w.recA.pickOther]])).length).toBe(2);
  });
});
