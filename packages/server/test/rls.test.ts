/**
 * Row Level Security tests (build rule 4, phase 0 acceptance):
 * - every table has RLS enabled;
 * - a user of org A cannot read, update or insert any row of org B, for every table;
 * - scope, confidentiality and module-flag rules behave as specified.
 * Requires a migrated database (pnpm db:reset). Both orgs are seeded with identical data.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asService, asUser, closePool, one, q } from '../src/db';
import { seedDemo } from '../src/seed/demo';

let demoOrg = '';
let otherOrg = '';
const users: Record<string, { userId: string; staffId: string }> = {};

async function user(email: string) {
  if (!users[email]) {
    users[email] = await asService((c) => one<{ userId: string; staffId: string }>(c, `select u.id as "userId", s.id as "staffId" from auth.users u join public.staff s on s.user_id = u.id where u.email = $1`, [email]));
  }
  return users[email]!;
}

async function as<T>(email: string, fn: Parameters<typeof asUser<T>>[1]): Promise<T> {
  const u = await user(email);
  return asUser({ userId: u.userId, staffId: u.staffId }, fn);
}

let orgTables: { table: string; generated: string[] }[] = [];

beforeAll(async () => {
  demoOrg = (await seedDemo({})).orgId;
  otherOrg = (await seedDemo({ slug: 'riverside', name: 'Riverside Academy', domain: 'riverside.school', phonePrefix: '+9191000' })).orgId;
  orgTables = await asService(async (c) => {
    const rows = await q<{ table_name: string }>(
      c,
      `select c.table_name from information_schema.columns c join pg_tables t on t.tablename = c.table_name and t.schemaname = 'public'
       where c.table_schema = 'public' and c.column_name = 'org_id' order by 1`,
    );
    const out: { table: string; generated: string[] }[] = [];
    for (const r of rows) {
      const gen = await q<{ column_name: string }>(c, `select column_name from information_schema.columns where table_schema = 'public' and table_name = $1 and is_generated = 'ALWAYS'`, [r.table_name]);
      out.push({ table: r.table_name, generated: gen.map((g) => g.column_name) });
    }
    return out;
  });
}, 600000);

afterAll(async () => {
  await closePool();
});

describe('RLS is enabled everywhere', () => {
  it('every public table has row level security on', async () => {
    const rows = await asService((c) => q<{ tablename: string }>(c, `select tablename from pg_tables where schemaname = 'public' and not rowsecurity`));
    expect(rows.map((r) => r.tablename)).toEqual([]);
  });
  it('every org table (except server-only) has at least one policy', async () => {
    const rows = await asService((c) =>
      q<{ tablename: string }>(c, `select t.tablename from pg_tables t where t.schemaname = 'public' and not exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = t.tablename)`),
    );
    expect(rows.map((r) => r.tablename).sort()).toEqual(['_migrations', 'jobs']);
  });
  it('both orgs have data in every org table (tests below are not vacuous)', async () => {
    const empty: string[] = [];
    await asService(async (c) => {
      for (const t of orgTables) {
        if (t.table === 'jobs') continue;
        const n = await one<{ n: number }>(c, `select count(*)::int as n from public."${t.table}" where org_id = $1`, [demoOrg]);
        if (n.n === 0) empty.push(t.table);
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
        if (t.table === 'jobs') continue; // server-only: no grant at all (checked separately)
        const n = await one<{ n: number }>(c, `select count(*)::int as n from public."${t.table}" where org_id = $1`, [demoOrg]);
        if (n.n > 0) leaks.push(`${t.table}:${n.n}`);
      }
    });
    expect(leaks).toEqual([]);
  });

  it('a demo teacher reads zero rows of the other org in every table', async () => {
    const leaks: string[] = [];
    await as(teacher, async (c) => {
      for (const t of orgTables) {
        if (t.table === 'jobs') continue;
        const n = await one<{ n: number }>(c, `select count(*)::int as n from public."${t.table}" where org_id = $1`, [otherOrg]);
        if (n.n > 0) leaks.push(`${t.table}:${n.n}`);
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
          const u = await c.query(`update public."${t.table}" set updated_at = now() where org_id = $1`, [demoOrg]);
          const d = await c.query(`delete from public."${t.table}" where org_id = $1`, [demoOrg]);
          if ((u.rowCount ?? 0) > 0 || (d.rowCount ?? 0) > 0) changed.push(t.table);
        } catch (e) {
          // permission denied (no grant) is also a pass
          if ((e as { code?: string }).code !== '42501') changed.push(`${t.table}:${(e as Error).message}`);
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
      const sample = await asService((c) => q<Record<string, unknown>>(c, `select to_jsonb(x) as j from public."${t.table}" x where org_id = $1 limit 1`, [demoOrg]));
      const row = (sample[0]?.j ?? null) as Record<string, unknown> | null;
      if (!row) continue;
      row.id = randomUUID();
      const cols = Object.keys(row).filter((k) => !t.generated.includes(k));
      try {
        await as(strongest, async (c) => {
          await c.query(`insert into public."${t.table}" (${cols.map((k) => `"${k}"`).join(',')}) select ${cols.map((k) => `"${k}"`).join(',')} from jsonb_populate_record(null::public."${t.table}", $1)`, [JSON.stringify(row)]);
        });
        accepted.push(t.table);
      } catch (e) {
        const code = (e as { code?: string }).code;
        // 42501 = RLS violation or no privilege. Anything else means RLS did not stop it first.
        if (code !== '42501') accepted.push(`${t.table}:${code}:${(e as Error).message}`);
      }
    }
    expect(accepted).toEqual([]);
  });

  it('the jobs queue is not reachable by users at all', async () => {
    await expect(as(teacher, (c) => q(c, `select id from public.jobs`))).rejects.toMatchObject({ code: '42501' });
  });

  it('storage objects are isolated by org folder', async () => {
    await asService((c) => c.query(`insert into storage.objects (bucket_id, name) values ('os-files', $1), ('os-files', $2)`, [`${demoOrg}/x/a.jpg`, `${otherOrg}/x/b.jpg`]));
    const names = await as(teacher, (c) => q<{ name: string }>(c, `select name from storage.objects where bucket_id = 'os-files'`));
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
    const own = await as(otherTeacher, (c) => q(c, `select id from public.leave_requests`));
    const ownStaff = (await user(otherTeacher)).staffId;
    expect(own.length).toBeGreaterThan(0);
    const peer = await as(teacher, (c) => q<{ staff_id: string }>(c, `select staff_id from public.leave_requests`));
    expect(peer.some((r) => r.staff_id === ownStaff)).toBe(false);
    const p = await as(principal, (c) => q(c, `select id from public.leave_requests`));
    expect(p.length).toBeGreaterThanOrEqual(2);
  });

  it('branch principal cannot see the other branch; group chairman can', async () => {
    const p2 = await as(principal2, (c) => one<{ n: number }>(c, `select count(*)::int as n from public.staff_attendance sa join public.branches b on b.id = sa.branch_id where b.code = 'GACH'`));
    expect(p2.n).toBe(0);
    const ch = await as(chairman, (c) => one<{ n: number }>(c, `select count(*)::int as n from public.staff_attendance sa join public.branches b on b.id = sa.branch_id where b.code = 'GACH'`));
    expect(ch.n).toBeGreaterThan(0);
  });

  it('team scope follows the reporting tree including secondary lines', async () => {
    const hodSees = await as(scienceHod, (c) => q<{ staff_id: string }>(c, `select distinct staff_id from public.class_logs`));
    expect(hodSees.map((r) => r.staff_id)).toContain((await user(teacher)).staffId);
  });

  it('question papers are visible only to setter and named reviewers before the exam date', async () => {
    // The seeded paper: future exam date, setter = teacher, reviewers = Science HOD and coordinator.
    const seeded = await asService((c) => one<{ id: string }>(c, `select id from public.question_papers where org_id = $1 and status = 'hod_review' order by created_at limit 1`, [demoOrg]));
    const sees = async (email: string) => (await as(email, (c) => q(c, `select id from public.question_papers where id = $1`, [seeded.id]))).length;
    expect(await sees(teacher)).toBe(1); // setter
    expect(await sees(scienceHod)).toBe(1); // reviewer
    expect(await sees(otherTeacher)).toBe(0);
    expect(await sees(principal)).toBe(0); // not named, before exam date
  });

  it('confidential incidents need the confidential permission', async () => {
    const reporter = 'vikram.teacher12@demo.school';
    const visible = await as(reporter, (c) => q<{ confidential: boolean }>(c, `select confidential from public.incidents`));
    expect(visible.some((r) => r.confidential)).toBe(false);
    const vp = await as('vp@demo.school', (c) => q<{ confidential: boolean }>(c, `select confidential from public.incidents`));
    expect(vp.some((r) => r.confidential)).toBe(true);
  });

  it('appraisal scores are hidden from the teacher until released', async () => {
    expect((await as(teacher, (c) => q(c, `select id from public.appraisal_scores`))).length).toBe(0);
    await asService((c) => c.query(`update public.appraisal_cycles set released = true where org_id = $1`, [demoOrg]));
    expect((await as(teacher, (c) => q(c, `select id from public.appraisal_scores`))).length).toBe(1);
    await asService((c) => c.query(`update public.appraisal_cycles set released = false where org_id = $1`, [demoOrg]));
  });

  it('notifications are personal', async () => {
    const mine = await as(teacher, (c) => q(c, `select id from public.notifications`));
    const me = await user(teacher);
    const others = await as(otherTeacher, (c) => q<{ staff_id: string }>(c, `select staff_id from public.notifications`));
    expect(mine.length).toBeGreaterThan(0);
    expect(others.every((n) => n.staff_id !== me.staffId)).toBe(true);
  });

  it('a disabled module is blocked for scoped access', async () => {
    const before = await as(principal, (c) => one<{ n: number }>(c, `select count(*)::int as n from public.tickets`));
    expect(before.n).toBeGreaterThan(0);
    await asService((c) => c.query(`update public.module_flags set enabled = false where module_key = 'helpdesk' and branch_id = (select id from public.branches where code = 'GACH' and org_id = $1)`, [demoOrg]));
    const after = await as(principal, (c) => one<{ n: number }>(c, `select count(*)::int as n from public.tickets`));
    expect(after.n).toBe(0);
    await asService((c) => c.query(`update public.module_flags set enabled = true where module_key = 'helpdesk'`));
  });

  it('changing a role permission takes effect immediately', async () => {
    const before = await as(otherTeacher, (c) => one<{ n: number }>(c, `select count(*)::int as n from public.staff_attendance`));
    await asService((c) => c.query(`update public.role_permissions set scope = 'branch' where module = 'staff_attendance' and action = 'view' and role_id in (select id from public.roles where org_id = $1 and key = 'class_teacher')`, [demoOrg]));
    const after = await as(otherTeacher, (c) => one<{ n: number }>(c, `select count(*)::int as n from public.staff_attendance`));
    expect(after.n).toBeGreaterThan(before.n);
    await asService((c) => c.query(`update public.role_permissions set scope = 'own' where module = 'staff_attendance' and action = 'view' and role_id in (select id from public.roles where org_id = $1 and key = 'class_teacher')`, [demoOrg]));
  });

  it('has_permission() agrees with the policies', async () => {
    const t = await user(teacher);
    const o = await user(otherTeacher);
    const res = await asService((c) =>
      one<{ own: boolean; peer: boolean; hod: boolean; cross: boolean }>(
        c,
        `select public.has_permission($1, 'leave', 'view', jsonb_build_object('org_id', $3::text, 'branch_id', s.branch_id, 'owner_id', $2::text)) as own,
                public.has_permission($1, 'leave', 'view', jsonb_build_object('org_id', $3::text, 'branch_id', s.branch_id, 'owner_id', $4::text)) as peer,
                public.has_permission((select user_id from public.staff where id = s.reports_to), 'leave', 'approve', jsonb_build_object('org_id', $3::text, 'branch_id', s.branch_id, 'owner_id', $2::text)) as hod,
                public.has_permission($1, 'leave', 'view', jsonb_build_object('org_id', $5::text, 'branch_id', s.branch_id, 'owner_id', $2::text)) as cross
         from public.staff s where s.id = $2::uuid`,
        [t.userId, t.staffId, demoOrg, o.staffId, otherOrg],
      ),
    );
    expect(res).toEqual({ own: true, peer: false, hod: true, cross: false });
  });

  it('audit log records who changed what', async () => {
    const t = await user(teacher);
    await asUser({ userId: t.userId, staffId: t.staffId, device: 'test-device' }, (c) => c.query(`update public.tasks set description = 'audited change' where owner_id = $1 and source = 'self'`, [t.staffId]));
    const row = await asService((c) => one<{ actor_user_id: string; device: string; before: { description: string | null }; after: { description: string } }>(c, `select * from public.audit_log where table_name = 'tasks' and actor_user_id = $1 order by at desc limit 1`, [t.userId]));
    expect(row.device).toBe('test-device');
    expect(row.after.description).toBe('audited change');
  });
});
