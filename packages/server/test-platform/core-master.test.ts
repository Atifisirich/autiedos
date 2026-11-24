/**
 * Core master data (20261115100001..8, docs/core-master-data.md): catalogue rules for every core master
 * table, cross-org references, portal visibility (parent / student), restricted tables, single-writer tables
 * and the shared write functions. Runs on the same fixture as isolation.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { count, errorCode, owner, ownerQuery, tx } from './helpers';
import { buildWorld, type World } from './fixture';

let w: World;
let coreMaster: string[] = [];

/** Foundation core tables (20261115000002), set up before apply_core_rls existed. */
const FOUNDATION_CORE = ['branches', 'learner_links', 'login_events', 'org_branch_products', 'org_users', 'organizations', 'platform_admins',
  'product_modules', 'products', 'role_permissions', 'roles', 'subscriptions', 'support_sessions', 'user_branch_access', 'user_product_access', 'user_security',
  // compliance tooling (20261115200001): written only by security definer functions, platform defaults with org_id null, bespoke policies
  'compliance_requests', 'consent_events', 'legal_holds', 'org_export_jobs', 'pii_registry', 'retention_policies', 'table_policy'];

beforeAll(async () => {
  w = await buildWorld();
  coreMaster = (await ownerQuery<{ t: string }>(
    `select c.relname as t from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'core' and c.relkind = 'r' and obj_description(c.oid, 'pg_class') like 'core master data.%' order by 1`)).map((r) => r.t);
}, 300000);

afterAll(async () => {
  await owner.end();
});

const rows = (user: string, sql: string, params: unknown[] = []) => tx('authenticated', user, async (c) => (await c.query(sql, params)).rows);
const col = async (user: string, sql: string, params: unknown[] = []) => (await rows(user, sql, params)).map((r) => Object.values(r)[0]);

describe('core master catalogue', () => {
  it('every core table is either a reviewed foundation table or set up through app.apply_core_rls', async () => {
    const all = (await ownerQuery<{ t: string }>(`select tablename as t from pg_tables where schemaname = 'core' order by 1`)).map((r) => r.t);
    expect(all.filter((t) => !FOUNDATION_CORE.includes(t) && !coreMaster.includes(t))).toEqual([]);
    expect(coreMaster.length).toBeGreaterThanOrEqual(67);
  });

  it('every core master table has the standard columns (R3), unique (org_id, id) and the updated_at trigger', async () => {
    const bad: string[] = [];
    for (const t of coreMaster) {
      const cols = (await ownerQuery<{ c: string }>(`select column_name as c from information_schema.columns where table_schema = 'core' and table_name = $1`, [t])).map((r) => r.c);
      for (const c of ['id', 'org_id', 'created_at', 'created_by', 'updated_at', 'deleted_at']) if (!cols.includes(c)) bad.push(`${t}.${c}`);
      const uq = await ownerQuery(
        `select 1 from pg_constraint where conrelid = ('core.' || quote_ident($1))::regclass and contype = 'u'
            and (select array_agg(a.attname::text order by k.o) from unnest(conkey) with ordinality k(n, o) join pg_attribute a on a.attrelid = conrelid and a.attnum = k.n) = array['org_id','id']`, [t]);
      if (!uq.length) bad.push(`${t}: unique (org_id, id)`);
      const trg = await ownerQuery(`select 1 from pg_trigger where tgrelid = ('core.' || quote_ident($1))::regclass and tgname = 'trg_touch'`, [t]);
      if (!trg.length) bad.push(`${t}: trg_touch`);
    }
    expect(bad).toEqual([]);
  });

  it('every foreign key between org-scoped core tables includes org_id (no cross-org reference is possible)', async () => {
    const r = await ownerQuery<{ t: string }>(
      `select l.relname || '.' || c.conname as t from pg_constraint c
         join pg_class l on l.oid = c.conrelid join pg_namespace ln on ln.oid = l.relnamespace
         join pg_class r on r.oid = c.confrelid join pg_namespace rn on rn.oid = r.relnamespace
        where c.contype = 'f' and ln.nspname = 'core' and rn.nspname = 'core'
          and r.relname not in ('organizations','products','product_modules','platform_admins')
          and not exists (select 1 from unnest(c.conkey) k join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k where a.attname = 'org_id')
        order by 1`);
    expect(r.map((x) => x.t)).toEqual([]);
  });

  it('every foreign key column of a core master table is covered by an index starting with org_id', async () => {
    const r = await ownerQuery<{ t: string }>(
      `select l.relname || '.' || c.conname as t from pg_constraint c
         join pg_class l on l.oid = c.conrelid join pg_namespace ln on ln.oid = l.relnamespace
        where c.contype = 'f' and ln.nspname = 'core' and l.relname = any($1) and array_length(c.conkey, 1) = 2
          and not exists (select 1 from pg_index i where i.indrelid = c.conrelid
                           and i.indkey[0] = (select attnum from pg_attribute where attrelid = c.conrelid and attname = 'org_id')
                           and i.indkey[1] = c.conkey[2])
        order by 1`, [coreMaster]);
    expect(r.map((x) => x.t)).toEqual([]);
  });

  it('a core table cannot point at another org\'s row, even for the table owner', async () => {
    await expect(ownerQuery(`insert into core.sections (org_id, programme_id, name) values ($1, $2, 'x')`, [w.A.id, w.coreB.prog])).rejects.toMatchObject({ code: '23503' });
    await expect(ownerQuery(`insert into core.students (org_id, branch_id, first_name) values ($1, $2, 'x')`, [w.A.id, w.B.branches.b1])).rejects.toMatchObject({ code: '23503' });
    // a staff row can only link a login of its own org (decision 37)
    await expect(ownerQuery(`insert into core.staff (org_id, user_id, first_name) values ($1, $2, 'x')`, [w.B.id, w.u.nobody])).rejects.toMatchObject({ code: '23503' });
    // and the admin of A gets the same answer through RLS-passing inserts
    expect(await errorCode('authenticated', w.u.aAdmin, `insert into core.sections (org_id, programme_id, name) values ($1, $2, 'x')`, [w.A.id, w.coreB.prog])).toBe('23503');
    expect(await errorCode('authenticated', w.u.aAdmin, `insert into core.sections (org_id, programme_id, name) values ($1, $2, 'x')`, [w.A.id, w.coreA.prog])).toBe('');
  });
});

describe('parents and students see only their own learners', () => {
  it('a guardian of org A reads only its own child, family and portal rows', async () => {
    const g = w.u.aGuardian;
    expect(await col(g, `select id from core.students`)).toEqual([w.learnerA]);
    expect(await col(g, `select id from core.households`)).toEqual([w.coreA.fam]);
    expect(await col(g, `select name from core.guardians`)).toEqual(['Linked guardian']);
    for (const t of ['enrolments', 'student_sensitive', 'student_attendance_marks', 'exam_seating', 'student_status_events', 'student_leave_requests']) {
      expect(await col(g, `select distinct student_id from core.${t}`), t).toEqual([w.learnerA]);
    }
    expect(await col(g, `select title from core.class_posts`)).toEqual(['Section homework']);
    expect(await col(g, `select title from core.calendar_events`)).toEqual(['Annual day']);
    expect(await col(g, `select title from core.tickets`)).toEqual(['Bus late']);
    expect(await col(g, `select note from core.ticket_events`)).toEqual(['We are checking']); // internal row hidden
    expect(await col(g, `select title from core.approval_requests`)).toEqual(['Guardian request']);
    expect(await col(g, `select title from core.notifications`)).toEqual(['Learner absent']);
    expect((await col(g, `select purpose from core.consents order by 1`))).toEqual(['photos', 'whatsapp']); // not the other learner's, not CRM leads
    expect(await count('authenticated', g, `select * from core.data_requests`)).toBe(1);
  });

  it('a guardian reads no staff-side data', async () => {
    const zero = ['staff', 'staff_attendance', 'leave_requests', 'leave_balances', 'incidents', 'outbox', 'files', 'teacher_allocations', 'number_series',
      'approval_types', 'approval_flows', 'approval_steps', 'delegations', 'devices', 'attendance_imports', 'attendance_rules', 'integrations', 'api_keys',
      'webhooks', 'question_bank', 'student_attendance_sessions', 'message_templates', 'notification_rules', 'support_tickets', 'retention_rules',
      'notification_prefs', 'device_tokens'];
    const seen: string[] = [];
    for (const t of zero) if (await count('authenticated', w.u.aGuardian, `select * from core.${t}`)) seen.push(t);
    expect(seen).toEqual([]);
    // reference data needed by the portal stays readable
    for (const t of ['academic_years', 'programmes', 'sections', 'subjects', 'timetable_entries', 'leave_types', 'terminology', 'events', 'ticket_categories']) {
      expect(await count('authenticated', w.u.aGuardian, `select * from core.${t}`), t).toBeGreaterThan(0);
    }
  });

  it('a guardian (or parent) of one org reads nothing of the other org in any core table', async () => {
    const leaks: string[] = [];
    for (const t of coreMaster) {
      if (await count('authenticated', w.u.aGuardian, `select * from core.${t} where org_id <> $1`, [w.A.id])) leaks.push(`A guardian -> ${t}`);
      if (await count('authenticated', w.u.bGuardian, `select * from core.${t} where org_id <> $1`, [w.B.id])) leaks.push(`B parent -> ${t}`);
    }
    expect(leaks).toEqual([]);
    expect(await col(w.u.bGuardian, `select id from core.students`)).toEqual([w.learnerB]);
  });

  it('a student login sees itself, not its sibling, until a link is added', async () => {
    const s = w.u.aStudent;
    expect(await col(s, `select id from core.students`)).toEqual([w.learnerA]);
    expect(await col(s, `select distinct student_id from core.student_attendance_marks`)).toEqual([w.learnerA]);
    expect(await col(s, `select id from core.households`)).toEqual([w.coreA.fam]); // own household
    expect(await col(w.u.aGuardian, `select id from core.students where id = $1`, [w.coreA.sibling])).toEqual([]);
    await ownerQuery(`insert into core.learner_links (org_id, user_id, learner_id, relation) values ($1, $2, $3, 'other')`, [w.A.id, s, w.coreA.sibling]);
    try {
      expect((await col(s, `select id from core.students`)).sort()).toEqual([w.learnerA, w.coreA.sibling].sort());
    } finally {
      await ownerQuery(`delete from core.learner_links where user_id = $1 and learner_id = $2`, [s, w.coreA.sibling]);
    }
    expect(await col(s, `select id from core.students`)).toEqual([w.learnerA]);
  });

  it('portal writes: own learner only, nothing else', async () => {
    const g = w.u.aGuardian;
    const leave = `insert into core.student_leave_requests (org_id, student_id, start_date, end_date) values ($1, $2, current_date, current_date)`;
    expect(await errorCode('authenticated', g, leave, [w.A.id, w.learnerA])).toBe('');
    expect(await errorCode('authenticated', g, leave, [w.A.id, w.coreA.other])).toBe('42501');
    expect(await errorCode('authenticated', g, `insert into core.tickets (org_id, title, student_id, source) values ($1, 'x', $2, 'portal')`, [w.A.id, w.learnerA])).toBe('');
    expect(await errorCode('authenticated', g, `insert into core.tickets (org_id, title, student_id, source) values ($1, 'x', $2, 'portal')`, [w.A.id, w.coreA.other])).toBe('42501');
    expect(await errorCode('authenticated', g, `insert into core.students (org_id, branch_id, first_name) values ($1, $2, 'x')`, [w.A.id, w.A.branches.a1])).toBe('42501');
    expect(await errorCode('authenticated', g, `insert into core.consents (org_id, subject_type, student_id, purpose, granted) values ($1, 'student', $2, 'photos', true)`, [w.A.id, w.learnerA])).toBe('42501');
    const upd = await tx('authenticated', g, async (c) => (await c.query(`update core.students set first_name = 'Hacked'`)).rowCount);
    expect(upd).toBe(0);
  });
});

describe('staff audiences and restricted tables', () => {
  it('a teacher without core permissions sees branch master data and own records, not restricted rows', async () => {
    const t = w.u.aTeacher;
    expect(await count('authenticated', t, `select * from core.students`)).toBe(3);
    expect(await count('authenticated', t, `select * from core.staff`)).toBeGreaterThan(0);
    for (const x of ['student_sensitive', 'incidents', 'outbox', 'consents', 'integrations', 'leave_requests', 'leave_balances', 'approval_requests']) {
      expect(await count('authenticated', t, `select * from core.${x}`), x).toBe(0);
    }
    expect(await col(t, `select staff_id from core.staff_attendance`)).toEqual([w.coreA.teacherStaff]);
    expect(await errorCode('authenticated', t, `insert into core.students (org_id, branch_id, first_name) values ($1, $2, 'x')`, [w.A.id, w.A.branches.a1])).toBe('42501');
  });

  it('staff apply for their own leave only', async () => {
    const ins = `insert into core.leave_requests (org_id, staff_id, leave_type_id, start_date, end_date) values ($1, $2, $3, current_date, current_date)`;
    expect(await errorCode('authenticated', w.u.aTeacher, ins, [w.A.id, w.coreA.teacherStaff, w.coreA.cl])).toBe('');
    expect(await errorCode('authenticated', w.u.aTeacher, ins, [w.A.id, w.coreA.otherStaff, w.coreA.cl])).toBe('42501');
  });

  it('the admin (all permissions) sees restricted rows of its own org', async () => {
    expect(await count('authenticated', w.u.aAdmin, `select * from core.student_sensitive`)).toBe(2);
    expect(await count('authenticated', w.u.aAdmin, `select * from core.incidents`)).toBe(1);
    expect(await count('authenticated', w.u.aAdmin, `select * from core.consents`)).toBe(4); // admin has CRM, so crm_guardian rows too
  });

  it('notifications are private to their user', async () => {
    expect(await col(w.u.aAdmin, `select title from core.notifications`)).toEqual(['Leave request']);
    expect(await tx('authenticated', w.u.aTeacher, async (c) => (await c.query(`update core.notifications set read_at = now()`)).rowCount)).toBe(0);
    expect(await tx('authenticated', w.u.aGuardian, async (c) => (await c.query(`update core.notifications set read_at = now()`)).rowCount)).toBe(1);
  });

  it('single-writer tables accept writes only through the named product', async () => {
    // leave_balances / staff_attendance / leave_requests: OS. enrolments / student_leave_requests: ERP.
    const lb = `insert into core.leave_balances (org_id, staff_id, leave_type_id, academic_year_id) values ($1, gen_random_uuid(), gen_random_uuid(), gen_random_uuid())`;
    expect(await errorCode('authenticated', w.u.dCrmAdmin, lb, [w.D.id])).toBe('42501');
    expect(await errorCode('authenticated', w.u.dOsOnly, lb, [w.D.id])).toBe('23503'); // passed RLS, failed only on the made-up keys
    const en = `insert into core.enrolments (org_id, student_id, academic_year_id) values ($1, gen_random_uuid(), gen_random_uuid())`;
    expect(await errorCode('authenticated', w.u.dOsOnly, en, [w.D.id])).toBe('42501');
  });
});

describe('shared write functions', () => {
  it('student status changes only through core.change_student_status, with valid transitions, and are logged', async () => {
    expect(await errorCode('authenticated', w.u.aAdmin, `update core.students set status = 'withdrawn' where id = $1`, [w.coreA.other])).toBe('42501');
    expect(await errorCode('authenticated', w.u.aAdmin, `select core.change_student_status($1, 'archived')`, [w.coreA.other])).toBe('22023');
    expect(await errorCode('authenticated', w.u.aGuardian, `select core.change_student_status($1, 'withdrawn')`, [w.learnerA])).toBe('42501');
    expect(await errorCode('authenticated', w.u.bAdmin, `select core.change_student_status($1, 'withdrawn')`, [w.coreA.other])).toBe('42501');
    const r = await tx('authenticated', w.u.aAdmin, async (c) => {
      const ev = (await c.query(`select * from core.change_student_status($1, 'withdrawn', 'moved city')`, [w.coreA.other])).rows[0];
      const st = (await c.query(`select status, left_on is not null as left from core.students where id = $1`, [w.coreA.other])).rows[0];
      return { from: ev.from_status, to: ev.to_status, actor: ev.actor_user_id, ...st };
    });
    expect(r).toEqual({ from: 'active', to: 'withdrawn', actor: w.u.aAdmin, status: 'withdrawn', left: true });
  });

  it('core.next_number draws gap-free numbers for staff only', async () => {
    const nums = await tx('authenticated', w.u.aAdmin, async (c) => {
      const a = (await c.query(`select core.next_number('admission_no', null, $1) as n`, [w.coreA.year])).rows[0].n;
      const b = (await c.query(`select core.next_number('admission_no', null, $1) as n`, [w.coreA.year])).rows[0].n;
      return [a, b];
    });
    const tag = w.A.id.slice(0, 8);
    expect(nums).toEqual([`${tag}/0001`, `${tag}/0002`]);
    expect(await errorCode('authenticated', w.u.aGuardian, `select core.next_number('admission_no')`)).toBe('42501');
    expect(await errorCode('authenticated', w.u.aAdmin, `select core.next_number('no_such_series')`)).toBe('22023');
  });

  it('labels come from core.terminology, else from the organisation kind', async () => {
    expect(await rows(w.u.aAdmin, `select app.term('section') as s, app.term('programme') as p`)).toEqual([{ s: 'Batch', p: 'Class' }]);
    expect(await ownerQuery(`select app.default_term('coaching_centre', 'section') as a, app.default_term('college', 'term') as b, app.default_term('school', 'learner') as c`))
      .toEqual([{ a: 'Batch', b: 'Semester', c: 'Student' }]);
  });
});
