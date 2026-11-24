/**
 * Row Level Security tests for the OS on the shared platform (build rule 4; docs/adr/os-move.md):
 * - every os table has RLS and policies; both seeded orgs have rows in every os table;
 * - a user of org A cannot read, update or insert any row of org B in any os table or shared core table the OS uses;
 * - OS scope, confidentiality and module-flag rules behave as specified (staff-based own / team / department / wing);
 * - product isolation (plan section 8, T2-T4 for the OS): an org without OS, a user without OS access and a suspended
 *   OS subscription read zero os rows on the next request.
 * Requests run exactly like the server: the database role os_server with request.jwt.claims (asUser). Fixtures and
 * checks use the table owner (asOwner). Requires `pnpm db:reset` (global setup); both orgs are seeded alike.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asOwner, asUser, closePool, getOwnerPool, one, q, type Tx } from '../src/db';
import { seedDemo } from '../src/seed/demo';

let demoOrg = '';
let otherOrg = '';
const users: Record<string, { userId: string; staffId: string }> = {};

async function user(email: string) {
  if (!users[email]) {
    users[email] = await asOwner((c) => one<{ userId: string; staffId: string }>(c, `select u.id as "userId", s.id as "staffId" from auth.users u join core.staff s on s.user_id = u.id where u.email = $1`, [email]));
  }
  return users[email]!;
}

async function as<T>(email: string, fn: (c: Tx) => Promise<T>): Promise<T> {
  const u = await user(email);
  return asUser({ userId: u.userId, staffId: u.staffId }, fn);
}

/** As the Data API would: role authenticated with the user's claims (storage policies apply to that role). */
async function asAuthenticated<T>(email: string, fn: (c: Tx) => Promise<T>): Promise<T> {
  const u = await user(email);
  const c = await getOwnerPool().connect();
  try {
    await c.query('begin');
    await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: u.userId, role: 'authenticated' })]);
    await c.query('set local role authenticated');
    return await fn(c);
  } finally {
    await c.query('rollback').catch(() => undefined);
    c.release();
  }
}

/** Shared core tables the OS reads and writes (the full core matrix is the platform harness, test-platform/). */
const OS_CORE_TABLES = ['staff', 'sections', 'students', 'programmes', 'subjects', 'rooms', 'wings', 'timetable_entries', 'timetable_versions', 'leave_requests', 'leave_balances', 'staff_attendance', 'student_attendance_sessions', 'student_attendance_marks', 'approval_requests', 'approval_actions', 'tickets', 'ticket_events', 'incidents', 'events', 'calendar_events', 'exams', 'exam_schedules', 'question_bank', 'class_posts', 'notifications', 'ai_generations'];

let orgTables: { schema: string; table: string; generated: string[] }[] = [];

beforeAll(async () => {
  demoOrg = (await seedDemo({})).orgId;
  otherOrg = (await seedDemo({ slug: 'riverside', name: 'Riverside Academy', domain: 'riverside.school', phonePrefix: '+9191000' })).orgId;
  orgTables = await asOwner(async (c) => {
    const rows = await q<{ schema: string; table: string }>(
      c,
      `select c.table_schema as schema, c.table_name as "table" from information_schema.columns c
         join pg_tables t on t.tablename = c.table_name and t.schemaname = c.table_schema
        where c.column_name = 'org_id' and ((c.table_schema = 'os' and c.table_name <> 'harness_probe') or (c.table_schema = 'core' and c.table_name = any($1)))
        order by 1, 2`,
      [OS_CORE_TABLES],
    );
    const out: { schema: string; table: string; generated: string[] }[] = [];
    for (const r of rows) {
      const gen = await q<{ column_name: string }>(c, `select column_name from information_schema.columns where table_schema = $1 and table_name = $2 and (is_generated = 'ALWAYS' or is_identity = 'YES')`, [r.schema, r.table]);
      out.push({ ...r, generated: gen.map((g) => g.column_name) });
    }
    return out;
  });
}, 600000);

afterAll(async () => {
  await closePool();
});

const T = (t: { schema: string; table: string }) => `"${t.schema}"."${t.table}"`;

describe('RLS is enabled everywhere', () => {
  it('every os table has row level security on', async () => {
    const rows = await asOwner((c) => q<{ tablename: string }>(c, `select tablename from pg_tables where schemaname = 'os' and not rowsecurity`));
    expect(rows.map((r) => r.tablename)).toEqual([]);
  });
  it('every os table has policies, and every policy carries the product check', async () => {
    const none = await asOwner((c) => q<{ tablename: string }>(c, `select t.tablename from pg_tables t where t.schemaname = 'os' and not exists (select 1 from pg_policies p where p.schemaname = 'os' and p.tablename = t.tablename)`));
    expect(none.map((r) => r.tablename)).toEqual([]);
    const unguarded = await asOwner((c) => q<{ p: string }>(c, `select tablename || '.' || policyname as p from pg_policies where schemaname = 'os' and coalesce(qual, '') !~ 'user_has_product' and coalesce(with_check, '') !~ 'user_has_product'`));
    expect(unguarded).toEqual([]);
  });
  it('both orgs have data in every os table and every shared table used here (tests below are not vacuous)', async () => {
    const empty: string[] = [];
    await asOwner(async (c) => {
      for (const t of orgTables) {
        for (const o of [demoOrg, otherOrg]) {
          const n = await one<{ n: number }>(c, `select count(*)::int as n from ${T(t)} where org_id = $1`, [o]);
          if (n.n === 0) empty.push(`${t.schema}.${t.table}@${o === demoOrg ? 'demo' : 'other'}`);
        }
      }
    });
    expect(empty).toEqual([]);
  });
});

describe('org isolation on every table', () => {
  // The other org's chairman holds every permission at group scope: the strongest possible user.
  const strongest = 'chairman@riverside.school';
  const teacher = 'deepa.teacher9@demo.school';

  it('the other org (all permissions) reads zero demo rows in every table', async () => {
    const leaks: string[] = [];
    await as(strongest, async (c) => {
      for (const t of orgTables) {
        const n = await one<{ n: number }>(c, `select count(*)::int as n from ${T(t)} where org_id = $1`, [demoOrg]);
        if (n.n > 0) leaks.push(`${t.schema}.${t.table}:${n.n}`);
      }
    });
    expect(leaks).toEqual([]);
  });

  it('a demo teacher reads zero rows of the other org in every table', async () => {
    const leaks: string[] = [];
    await as(teacher, async (c) => {
      for (const t of orgTables) {
        const n = await one<{ n: number }>(c, `select count(*)::int as n from ${T(t)} where org_id = $1`, [otherOrg]);
        if (n.n > 0) leaks.push(`${t.schema}.${t.table}:${n.n}`);
      }
    });
    expect(leaks).toEqual([]);
  });

  it('the other org cannot update or delete demo rows in any table', async () => {
    const changed: string[] = [];
    for (const t of orgTables) {
      await as(strongest, async (c) => {
        await c.query('savepoint s');
        try {
          const u = await c.query(`update ${T(t)} set org_id = org_id where org_id = $1`, [demoOrg]);
          const d = await c.query(`delete from ${T(t)} where org_id = $1`, [demoOrg]);
          if ((u.rowCount ?? 0) > 0 || (d.rowCount ?? 0) > 0) changed.push(`${t.schema}.${t.table}`);
        } catch (e) {
          // permission denied (no grant) is also a pass
          if ((e as { code?: string }).code !== '42501') changed.push(`${t.schema}.${t.table}:${(e as Error).message}`);
          await c.query('rollback to savepoint s');
        }
        throw new RollbackSignal();
      }).catch((e) => {
        if (!(e instanceof RollbackSignal)) throw e;
      });
    }
    expect(changed).toEqual([]);
  });

  it('the other org cannot insert rows into the demo org in any table', async () => {
    const accepted: string[] = [];
    for (const t of orgTables) {
      const sample = await asOwner((c) => q<Record<string, unknown>>(c, `select to_jsonb(x) as j from ${T(t)} x where org_id = $1 limit 1`, [demoOrg]));
      const row = (sample[0]?.j ?? null) as Record<string, unknown> | null;
      if (!row) continue;
      row.id = randomUUID();
      const cols = Object.keys(row).filter((k) => !t.generated.includes(k));
      try {
        await as(strongest, async (c) => {
          await c.query(`insert into ${T(t)} (${cols.map((k) => `"${k}"`).join(',')}) select ${cols.map((k) => `"${k}"`).join(',')} from jsonb_populate_record(null::${T(t)}, $1)`, [JSON.stringify(row)]);
        });
        accepted.push(`${t.schema}.${t.table}`);
      } catch (e) {
        const code = (e as { code?: string }).code;
        // 42501 = RLS violation or no privilege. Anything else means RLS did not stop it first.
        if (code !== '42501') accepted.push(`${t.schema}.${t.table}:${code}:${(e as Error).message}`);
      }
    }
    expect(accepted).toEqual([]);
  });

  it('the job queue is not reachable by the OS server or users at all', async () => {
    await expect(as(teacher, (c) => q(c, `select id from private.jobs`))).rejects.toMatchObject({ code: '42501' });
  });

  it('storage objects are isolated by org folder and need the OS product', async () => {
    await asOwner((c) => c.query(`insert into storage.objects (bucket_id, name) values ('os-files', $1), ('os-files', $2)`, [`${demoOrg}/x/a.jpg`, `${otherOrg}/x/b.jpg`]));
    const names = await asAuthenticated(teacher, (c) => q<{ name: string }>(c, `select name from storage.objects where bucket_id = 'os-files'`));
    expect(names.every((n) => n.name.startsWith(demoOrg))).toBe(true);
    expect(names.length).toBeGreaterThan(0);
  });
});

class RollbackSignal extends Error {}

describe('scope and permission rules', () => {
  const teacher = 'deepa.teacher9@demo.school'; // Science, Secondary, reports to Science HOD
  const otherTeacher = 'sneha.teacher11@demo.school'; // Languages
  const scienceHod = 'priya.hod6@demo.school';
  const principal = 'principal@demo.school';
  const principal2 = 'principal.kond@demo.school';
  const chairman = 'chairman@demo.school';

  it('teachers see only their own leave; managers see their team; principal sees the branch', async () => {
    const own = await as(otherTeacher, (c) => q(c, `select id from core.leave_requests`));
    const ownStaff = (await user(otherTeacher)).staffId;
    expect(own.length).toBeGreaterThan(0);
    const peer = await as(teacher, (c) => q<{ staff_id: string }>(c, `select staff_id from core.leave_requests`));
    expect(peer.some((r) => r.staff_id === ownStaff)).toBe(false);
    const p = await as(principal, (c) => q(c, `select id from core.leave_requests`));
    expect(p.length).toBeGreaterThanOrEqual(2);
  });

  it('branch principal cannot see the other branch; group chairman can', async () => {
    const p2 = await as(principal2, (c) => one<{ n: number }>(c, `select count(*)::int as n from core.staff_attendance sa join core.branches b on b.id = sa.branch_id where b.code = 'GACH'`));
    expect(p2.n).toBe(0);
    const ch = await as(chairman, (c) => one<{ n: number }>(c, `select count(*)::int as n from core.staff_attendance sa join core.branches b on b.id = sa.branch_id where b.code = 'GACH'`));
    expect(ch.n).toBeGreaterThan(0);
  });

  it('team scope follows the reporting tree including secondary lines', async () => {
    const hodSees = await as(scienceHod, (c) => q<{ staff_id: string }>(c, `select distinct staff_id from os.class_logs`));
    expect(hodSees.map((r) => r.staff_id)).toContain((await user(teacher)).staffId);
  });

  it('question papers are visible only to setter and named reviewers before the exam date', async () => {
    // The seeded paper: future exam date, setter = teacher, reviewers = Science HOD and coordinator.
    const seeded = await asOwner((c) => one<{ id: string }>(c, `select id from os.question_papers where org_id = $1 and status = 'hod_review' order by created_at limit 1`, [demoOrg]));
    const sees = async (email: string) => (await as(email, (c) => q(c, `select id from os.question_papers where id = $1`, [seeded.id]))).length;
    expect(await sees(teacher)).toBe(1); // setter
    expect(await sees(scienceHod)).toBe(1); // reviewer
    expect(await sees(otherTeacher)).toBe(0);
    expect(await sees(principal)).toBe(0); // not named, before exam date
  });

  it('confidential incidents need the confidential permission', async () => {
    const reporter = 'vikram.teacher12@demo.school';
    const visible = await as(reporter, (c) => q<{ confidential: boolean }>(c, `select confidential from core.incidents`));
    expect(visible.some((r) => r.confidential)).toBe(false);
    const vp = await as('vp@demo.school', (c) => q<{ confidential: boolean }>(c, `select confidential from core.incidents`));
    expect(vp.some((r) => r.confidential)).toBe(true);
  });

  it('appraisal scores are hidden from the teacher until released', async () => {
    expect((await as(teacher, (c) => q(c, `select id from os.appraisal_scores`))).length).toBe(0);
    await asOwner((c) => c.query(`update os.appraisal_cycles set released = true where org_id = $1`, [demoOrg]));
    expect((await as(teacher, (c) => q(c, `select id from os.appraisal_scores`))).length).toBe(1);
    await asOwner((c) => c.query(`update os.appraisal_cycles set released = false where org_id = $1`, [demoOrg]));
  });

  it('notifications are personal', async () => {
    const mine = await as(teacher, (c) => q(c, `select id from core.notifications`));
    const me = await user(teacher);
    const others = await as(otherTeacher, (c) => q<{ staff_id: string }>(c, `select staff_id from core.notifications`));
    expect(mine.length).toBeGreaterThan(0);
    expect(others.every((n) => n.staff_id !== me.staffId)).toBe(true);
  });

  it('a module switched off for a branch closes its os rows, even for the principal', async () => {
    const before = await as(principal, (c) => one<{ n: number }>(c, `select count(*)::int as n from os.tasks`));
    expect(before.n).toBeGreaterThan(0);
    await asOwner((c) => c.query(`update os.module_flags set enabled = false where module_key = 'tasks' and branch_id = (select id from core.branches where code = 'GACH' and org_id = $1)`, [demoOrg]));
    const after = await as(principal, (c) => one<{ n: number }>(c, `select count(*)::int as n from os.tasks`));
    expect(after.n).toBe(0);
    await asOwner((c) => c.query(`update os.module_flags set enabled = true where module_key = 'tasks'`));
  });

  it('changing a role permission takes effect immediately (OS role and the derived platform role)', async () => {
    const before = await as(otherTeacher, (c) => one<{ n: number }>(c, `select count(*)::int as n from core.staff_attendance`));
    await asOwner((c) => c.query(`update os.role_permissions set scope = 'branch' where module = 'staff_attendance' and action = 'view' and role_id in (select id from os.roles where org_id = $1 and key = 'class_teacher')`, [demoOrg]));
    const after = await as(otherTeacher, (c) => one<{ n: number }>(c, `select count(*)::int as n from core.staff_attendance`));
    expect(after.n).toBeGreaterThan(before.n);
    await asOwner((c) => c.query(`update os.role_permissions set scope = 'own' where module = 'staff_attendance' and action = 'view' and role_id in (select id from os.roles where org_id = $1 and key = 'class_teacher')`, [demoOrg]));
  });

  it('os.has_permission() agrees with the policies', async () => {
    const t = await user(teacher);
    const o = await user(otherTeacher);
    const hod = await user(scienceHod);
    const target = (owner: string, org = demoOrg) => `jsonb_build_object('org_id', '${org}', 'branch_id', (select branch_id from core.staff where id = '${t.staffId}'), 'owner_id', '${owner}')`;
    const asTeacher = await as(teacher, (c) =>
      one<{ own: boolean; peer: boolean; cross: boolean }>(
        c,
        `select os.has_permission($1, 'leave', 'view', ${target(t.staffId)}) as own, os.has_permission($1, 'leave', 'view', ${target(o.staffId)}) as peer,
                os.has_permission($1, 'leave', 'view', ${target(t.staffId, otherOrg)}) as cross`,
        [t.userId],
      ),
    );
    const asHod = await as(scienceHod, (c) => one<{ ok: boolean }>(c, `select os.has_permission($1, 'leave', 'approve', ${target(t.staffId)}) as ok`, [hod.userId]));
    expect({ ...asTeacher, hod: asHod.ok }).toEqual({ own: true, peer: false, hod: true, cross: false });
    // another user's permissions cannot be probed
    expect((await as(teacher, (c) => one<{ ok: boolean }>(c, `select os.has_permission($1, 'leave', 'approve', ${target(t.staffId)}) as ok`, [hod.userId]))).ok).toBe(false);
  });

  it('audit log records who changed what', async () => {
    const t = await user(teacher);
    await asUser({ userId: t.userId, staffId: t.staffId, device: 'test-device' }, (c) => c.query(`update os.tasks set description = 'audited change' where owner_id = $1 and source = 'self'`, [t.staffId]));
    const row = await asOwner((c) => one<{ actor_user_id: string; schema_name: string; after: { description: string } }>(c, `select * from audit.log where schema_name = 'os' and table_name = 'tasks' and actor_user_id = $1 order by created_at desc limit 1`, [t.userId]));
    expect(row.schema_name).toBe('os');
    expect(row.after.description).toBe('audited change');
  });
});

describe('product isolation for the OS (plan section 8, T2-T4)', () => {
  const principal = 'principal@demo.school';
  const setSub = (org: string, status: string) => asOwner((c) => c.query(`update core.subscriptions set status = $2 where org_id = $1 and product_key = 'os'`, [org, status]));
  const osRows = async (email: string) => {
    const counts: Record<string, number> = {};
    await as(email, async (c) => {
      for (const t of orgTables.filter((x) => x.schema === 'os')) counts[t.table] = (await one<{ n: number }>(c, `select count(*)::int as n from ${T(t)}`)).n;
    });
    return Object.values(counts).reduce((s, n) => s + n, 0);
  };

  it('T2: an org without the OS product reads zero os rows and cannot insert, though its rows exist', async () => {
    expect(await osRows(principal)).toBeGreaterThan(0);
    await setSub(demoOrg, 'cancelled');
    try {
      expect(await osRows(principal)).toBe(0);
      const p = await user(principal);
      const branch = await asOwner((c) => one<{ id: string }>(c, `select branch_id as id from core.staff where id = $1`, [p.staffId]));
      await expect(as(principal, (c) => c.query(`insert into os.tasks (org_id, branch_id, title, owner_id) values ($1, $2, 'x', $3)`, [demoOrg, branch.id, p.staffId]))).rejects.toMatchObject({ code: '42501' });
    } finally {
      await setSub(demoOrg, 'active');
    }
  });

  it('T3: a user without OS access (grant revoked) reads zero os rows; shared master data stays per its own rules', async () => {
    const p = await user(principal);
    await asOwner((c) => c.query(`update core.user_product_access set revoked_at = now() where user_id = $1 and product_key = 'os'`, [p.userId]));
    try {
      expect(await osRows(principal)).toBe(0);
      // no product at all left for this user: core master data closes too
      expect((await as(principal, (c) => q(c, `select id from core.sections`))).length).toBe(0);
    } finally {
      await asOwner((c) => c.query(`update core.user_product_access set revoked_at = null where user_id = $1 and product_key = 'os' and revoked_at is not null`, [p.userId]));
    }
    expect(await osRows(principal)).toBeGreaterThan(0);
  });

  it('T4: a suspended subscription blocks the next request; past_due keeps it on', async () => {
    await setSub(demoOrg, 'suspended');
    try {
      expect(await osRows(principal)).toBe(0);
    } finally {
      await setSub(demoOrg, 'past_due');
    }
    expect(await osRows(principal)).toBeGreaterThan(0);
    await setSub(demoOrg, 'active');
  });

  it('the org system actor of one org reads nothing of another org', async () => {
    const leaks = await asOwner((c) => one<{ id: string }>(c, `select os.system_user_id($1) as id`, [demoOrg])).then(({ id }) =>
      asUser({ userId: id }, async (c) => {
        const out: string[] = [];
        for (const t of orgTables) if ((await one<{ n: number }>(c, `select count(*)::int as n from ${T(t)} where org_id = $1`, [otherOrg])).n) out.push(t.table);
        return out;
      }),
    );
    expect(leaks).toEqual([]);
  });
});
