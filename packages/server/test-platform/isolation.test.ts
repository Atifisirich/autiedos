/**
 * Isolation harness, plan section 8 (T1-T12) on an empty platform (platform migrations only).
 * Every check runs as a real database role with request.jwt.claims set, like the product servers do.
 *
 * Not covered here (see docs/platform-foundation.md "What the harness does not cover"):
 *   T8  only at policy level on storage.objects (no Storage API locally);
 *   T10 replaced by "a second org link is rejected" (decision 37: one person = one client);
 *   T12 Supabase security advisor needs a Supabase project (none is touched from here).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  count, errorCode, loginAs, orgTables, owner, ownerQuery, PRODUCT_SCHEMAS, qi, ROLE_SCHEMAS, RPC_ONLY_TABLES, tx,
  type RequestRole,
} from './helpers';
import { buildWorld, type World } from './fixture';

let w: World;
let tables: { schema: string; table: string }[] = [];
const OTHER_ORG = 'select * from %T where org_id is distinct from $1';

beforeAll(async () => {
  w = await buildWorld();
  tables = await orgTables(['core', 'crm', 'os', 'erp', 'audit', 'billing']);
}, 300000);

afterAll(async () => {
  await owner.end();
});

const sel = (t: { schema: string; table: string }, tpl = OTHER_ORG) => tpl.replace('%T', qi(t.schema, t.table));

async function setSub(org: string, product: string, patch: string) {
  await ownerQuery(`update core.subscriptions set ${patch} where org_id = $1 and product_key = $2`, [org, product]);
}

describe('fixture is not vacuous', () => {
  it('found org-scoped tables in every schema', () => {
    const schemas = new Set(tables.map((t) => t.schema));
    expect([...schemas].sort()).toEqual(['audit', 'billing', 'core', 'crm', 'erp', 'os']);
  });

  it('every org-scoped table has rows for org A and org B (add fixture rows for new tables)', async () => {
    const empty: string[] = [];
    for (const t of tables) {
      for (const o of [w.A.id, w.B.id]) {
        const n = Number((await ownerQuery(`select count(*)::int as n from ${qi(t.schema, t.table)} where org_id = $1`, [o]))[0]!.n);
        if (n === 0) empty.push(`${t.schema}.${t.table}@${o === w.A.id ? 'A' : 'B'}`);
      }
    }
    expect(empty).toEqual([]);
  });
});

describe('T1 org A never sees org B, on every table of every schema', () => {
  it('as authenticated: admin of A reads zero rows of other orgs, admin of B likewise', async () => {
    const leaks: string[] = [];
    for (const t of tables) {
      if (await count('authenticated', w.u.aAdmin, sel(t), [w.A.id])) leaks.push(`A->${t.schema}.${t.table}`);
      if (await count('authenticated', w.u.bAdmin, sel(t), [w.B.id])) leaks.push(`B->${t.schema}.${t.table}`);
    }
    expect(leaks).toEqual([]);
  });

  it('as authenticated: admin of A does see its own rows in every table (policies are not deny-all)', async () => {
    const blind: string[] = [];
    for (const t of tables) {
      if (RPC_ONLY_TABLES.includes(`${t.schema}.${t.table}`)) continue; // closed on purpose, covered in erp.test.ts
      if (!(await count('authenticated', w.u.aAdmin, sel(t, 'select * from %T where org_id = $1'), [w.A.id]))) blind.push(`${t.schema}.${t.table}`);
    }
    expect(blind).toEqual([]);
  });

  it('as each server role (with A admin claims) on the schemas it may reach: zero rows of other orgs', async () => {
    const leaks: string[] = [];
    for (const [role, schemas] of Object.entries(ROLE_SCHEMAS)) {
      for (const t of tables.filter((x) => schemas.includes(x.schema))) {
        if (await count(role as RequestRole, w.u.aAdmin, sel(t), [w.A.id])) leaks.push(`${role}:${t.schema}.${t.table}`);
      }
    }
    expect(leaks).toEqual([]);
  });

  it('updates and deletes aimed at org B rows touch nothing', async () => {
    const touched: string[] = [];
    for (const t of tables) {
      const col = t.schema === 'core' && t.table === 'organizations' ? 'name' : 'org_id'; // org_id is generated there
      for (const stmt of [`update ${qi(t.schema, t.table)} set ${col} = ${col} where org_id = $1`, `delete from ${qi(t.schema, t.table)} where org_id = $1`]) {
        try {
          const n = await tx('authenticated', w.u.aAdmin, async (c) => (await c.query(stmt, [w.B.id])).rowCount);
          if (n) touched.push(`${stmt.split(' ')[0]} ${t.schema}.${t.table}`);
        } catch (e) {
          // no grant for that statement: also a denial
          expect((e as { code?: string }).code).toBe('42501');
        }
      }
    }
    expect(touched).toEqual([]);
  });

  it('inserting rows into org B is rejected (product table, identity, access grant, branch)', async () => {
    const B = w.B.id;
    expect(await errorCode('authenticated', w.u.aAdmin, `insert into crm.harness_probe (org_id, title) values ($1, 'x')`, [B])).toBe('42501');
    expect(await errorCode('crm_server', w.u.aAdmin, `insert into crm.harness_probe (org_id, title) values ($1, 'x')`, [B])).toBe('42501');
    expect(await errorCode('authenticated', w.u.aAdmin, `insert into core.branches (org_id, name, code) values ($1, 'x', 'x9')`, [B])).toBe('42501');
    expect(await errorCode('authenticated', w.u.aAdmin, `insert into core.roles (org_id, product_key, key, name) values ($1, 'crm', 'evil', 'x')`, [B])).toBe('42501');
    expect(await errorCode('authenticated', w.u.aAdmin, `insert into core.org_users (org_id, user_id, kind, display_name) values ($1, $2, 'staff', 'x')`, [B, w.u.nobody])).toBe('42501');
    // and the same statements for its own org succeed (the denial above is about the org, not the table)
    expect(await errorCode('authenticated', w.u.aAdmin, `insert into crm.harness_probe (org_id, title) values ($1, 'x')`, [w.A.id])).toBe('');
    expect(await errorCode('authenticated', w.u.aAdmin, `insert into core.branches (org_id, name, code) values ($1, 'x', 'x9')`, [w.A.id])).toBe('');
  });

  it('a signed-in user with no org link and no claims at all see nothing', async () => {
    for (const t of tables) {
      expect(await count('authenticated', w.u.nobody, `select * from ${qi(t.schema, t.table)}`), `${t.schema}.${t.table}`).toBe(0);
      expect(await count('authenticated', null, `select * from ${qi(t.schema, t.table)}`), `${t.schema}.${t.table}`).toBe(0);
    }
  });
});

describe('T2 an org with only CRM cannot read OS or ERP tables', () => {
  it('reads zero rows in every os.* and erp.* table even though rows exist for it', async () => {
    const planted = Number((await ownerQuery(`select count(*)::int as n from os.harness_probe where org_id = $1`, [w.C.id]))[0]!.n);
    expect(planted).toBeGreaterThan(0);
    for (const t of tables.filter((x) => x.schema === 'os' || x.schema === 'erp')) {
      expect(await count('authenticated', w.u.cAdmin, `select * from ${qi(t.schema, t.table)}`), `${t.schema}.${t.table}`).toBe(0);
    }
    expect(await count('authenticated', w.u.cAdmin, `select * from crm.harness_probe`)).toBeGreaterThan(0);
  });

  it('inserts into os and erp are rejected', async () => {
    for (const s of ['os', 'erp']) {
      expect(await errorCode('authenticated', w.u.cAdmin, `insert into ${s}.harness_probe (org_id, title) values ($1, 'x')`, [w.C.id])).toBe('42501');
    }
  });

  it('cannot enqueue a job for a product it does not have', async () => {
    expect(await errorCode('authenticated', w.u.cAdmin, `select app.enqueue_job('os', 'demo')`)).toBe('42501');
    expect(await errorCode('authenticated', w.u.cAdmin, `select app.enqueue_job('crm', 'demo')`)).toBe('');
  });
});

describe('T3 a user granted only OS cannot read CRM', () => {
  it('crm.* returns zero rows while os.* works, in an org that has both', async () => {
    const crmRows = Number((await ownerQuery(`select count(*)::int as n from crm.harness_probe where org_id = $1`, [w.D.id]))[0]!.n);
    expect(crmRows).toBeGreaterThan(0);
    for (const t of tables.filter((x) => x.schema === 'crm')) {
      expect(await count('authenticated', w.u.dOsOnly, `select * from ${qi(t.schema, t.table)}`)).toBe(0);
    }
    expect(await count('authenticated', w.u.dOsOnly, `select * from os.harness_probe`)).toBeGreaterThan(0);
    expect(await count('authenticated', w.u.dCrmAdmin, `select * from os.harness_probe`)).toBe(0);
  });

  it('a CRM-only admin cannot give themselves OS access or create OS roles', async () => {
    expect(await errorCode('authenticated', w.u.dCrmAdmin, `insert into core.user_product_access (org_id, user_id, product_key, role_key) values ($1, $2, 'os', 'admin')`, [w.D.id, w.u.dCrmAdmin])).toBe('42501');
    expect(await errorCode('authenticated', w.u.dCrmAdmin, `insert into core.roles (org_id, product_key, key, name) values ($1, 'os', 'sneaky', 'x')`, [w.D.id])).toBe('42501');
    // but may manage CRM access
    expect(await errorCode('authenticated', w.u.dCrmAdmin, `insert into core.roles (org_id, product_key, key, name) values ($1, 'crm', 'counsellor', 'Counsellor')`, [w.D.id])).toBe('');
  });

  it('a revoked grant stops access on the next request', async () => {
    await ownerQuery(`update core.user_product_access set revoked_at = now() where user_id = $1 and product_key = 'os'`, [w.u.dOsOnly]);
    try {
      expect(await count('authenticated', w.u.dOsOnly, `select * from os.harness_probe`)).toBe(0);
    } finally {
      await ownerQuery(`update core.user_product_access set revoked_at = null where user_id = $1 and product_key = 'os'`, [w.u.dOsOnly]);
    }
    expect(await count('authenticated', w.u.dOsOnly, `select * from os.harness_probe`)).toBeGreaterThan(0);
  });

  it('role scope: a teacher sees own-branch and org-level rows only, and may create only own rows', async () => {
    const rows = await tx('authenticated', w.u.aTeacher, async (c) => (await c.query(`select title from os.harness_probe order by title`)).rows.map((r) => r.title));
    expect(rows).toEqual(['os A a1', 'os A org-level']);
    expect(await count('authenticated', w.u.aTeacher, `select * from crm.harness_probe`)).toBe(0);
    expect(await errorCode('authenticated', w.u.aTeacher, `insert into os.harness_probe (org_id, branch_id, owner_id, title) values ($1, $2, $3, 'mine')`, [w.A.id, w.A.branches.a1, w.u.aTeacher])).toBe('');
    expect(await errorCode('authenticated', w.u.aTeacher, `insert into os.harness_probe (org_id, branch_id, owner_id, title) values ($1, $2, $3, 'not mine')`, [w.A.id, w.A.branches.a1, w.u.aAdmin])).toBe('42501');
  });

  it('guardian users see only their own learner links and no staff data', async () => {
    const links = await tx('authenticated', w.u.aGuardian, async (c) => (await c.query(`select learner_id from core.learner_links`)).rows.map((r) => r.learner_id));
    expect(links).toEqual([w.learnerA]);
    expect(await tx('authenticated', w.u.aGuardian, async (c) => (await c.query(`select app.my_learner_ids() as ids, app.my_member_kind() as k`)).rows[0])).toEqual({ ids: [w.learnerA], k: 'guardian' });
    expect(await count('authenticated', w.u.aGuardian, `select * from erp.harness_probe`)).toBe(0);
    expect(await count('authenticated', w.u.aGuardian, `select * from core.org_users`)).toBe(1); // own row only
  });
});

describe('T4 subscription changes take effect on the next request', () => {
  const osRows = () => count('authenticated', w.u.aAdmin, `select * from os.harness_probe`);
  const crmRows = () => count('authenticated', w.u.aAdmin, `select * from crm.harness_probe`);

  afterAll(async () => {
    for (const p of ['crm', 'os', 'erp']) await setSub(w.A.id, p, `status = 'active', starts_on = current_date - 30, ends_on = null`);
  });

  it('suspended and cancelled turn the product off; trial and past_due keep it on', async () => {
    expect(await osRows()).toBeGreaterThan(0);
    await setSub(w.A.id, 'os', `status = 'suspended'`);
    expect(await osRows()).toBe(0);
    expect(await crmRows()).toBeGreaterThan(0); // other products unaffected
    expect(await errorCode('authenticated', w.u.aAdmin, `insert into os.harness_probe (org_id, title) values ($1, 'x')`, [w.A.id])).toBe('42501');
    await setSub(w.A.id, 'os', `status = 'past_due'`);
    expect(await osRows()).toBeGreaterThan(0);
    await setSub(w.A.id, 'os', `status = 'cancelled'`);
    expect(await osRows()).toBe(0);
    await setSub(w.A.id, 'os', `status = 'trial'`);
    expect(await osRows()).toBeGreaterThan(0);
  });

  it('dates outside starts_on..ends_on turn the product off', async () => {
    await setSub(w.A.id, 'os', `status = 'active', starts_on = current_date - 30, ends_on = current_date - 1`);
    expect(await osRows()).toBe(0);
    await setSub(w.A.id, 'os', `starts_on = current_date + 1, ends_on = null`);
    expect(await osRows()).toBe(0);
    await setSub(w.A.id, 'os', `starts_on = current_date - 30`);
    expect(await osRows()).toBeGreaterThan(0);
  });

  it('with every product suspended, core master data closes too but the org row stays readable', async () => {
    expect(await count('authenticated', w.u.aAdmin, `select * from core.branches`)).toBe(2);
    for (const p of ['crm', 'os', 'erp']) await setSub(w.A.id, p, `status = 'suspended'`);
    expect(await count('authenticated', w.u.aAdmin, `select * from core.branches`)).toBe(0);
    expect(await count('authenticated', w.u.aAdmin, `select * from core.organizations`)).toBe(1);
    expect(await count('authenticated', w.u.aAdmin, `select * from core.subscriptions`)).toBe(3);
    await setSub(w.A.id, 'erp', `status = 'active'`);
    expect(await count('authenticated', w.u.aAdmin, `select * from core.branches`)).toBe(2);
  });

  it('a product switched off for one branch hides that branch\'s rows (decision 34)', async () => {
    for (const p of ['crm', 'os', 'erp']) await setSub(w.A.id, p, `status = 'active'`);
    const titles = await tx('authenticated', w.u.aAdmin, async (c) => (await c.query(`select title from crm.harness_probe order by title`)).rows.map((r) => r.title));
    expect(titles).toEqual(['crm A a1', 'crm A org-level']);
    expect(await errorCode('authenticated', w.u.aAdmin, `insert into crm.harness_probe (org_id, branch_id, title) values ($1, $2, 'x')`, [w.A.id, w.A.branches.a2])).toBe('42501');
    expect(await count('authenticated', w.u.aAdmin, `select * from os.harness_probe where branch_id = $1`, [w.A.branches.a2])).toBe(1);
  });

  it('a closed organisation loses everything', async () => {
    await ownerQuery(`update core.organizations set status = 'closed' where id = $1`, [w.A.id]);
    try {
      for (const t of ['crm.harness_probe', 'core.branches', 'core.organizations']) {
        expect(await count('authenticated', w.u.aAdmin, `select * from ${t}`), t).toBe(0);
      }
    } finally {
      await ownerQuery(`update core.organizations set status = 'active' where id = $1`, [w.A.id]);
    }
  });
});

describe('T5 a product server role cannot touch another product schema (grant missing, not just policy)', () => {
  const cases: [string, string[]][] = [
    ['crm_server', ['os', 'erp', 'audit', 'billing', 'private']],
    ['os_server', ['crm', 'erp', 'audit', 'billing', 'private']],
    ['erp_server', ['crm', 'os', 'audit', 'billing', 'private']],
    ['platform_admin_server', ['crm', 'os', 'erp', 'private']],
    ['job_runner', ['crm', 'os', 'erp', 'audit', 'billing']],
  ];
  for (const [role, denied] of cases) {
    it(`${role} (real login) is denied on ${denied.join(', ')}`, async () => {
      const c = await loginAs(role);
      try {
        for (const s of denied) {
          const table = s === 'private' ? 'jobs' : s === 'audit' ? 'log' : s === 'billing' ? 'invoices' : 'harness_probe';
          await expect(c.query(`select * from ${s}.${table}`), `${role} -> ${s}`).rejects.toMatchObject({ code: '42501' });
        }
        // cannot escape through another role
        await expect(c.query(`set role authenticated`)).rejects.toMatchObject({ code: '42501' });
        await expect(c.query(`set role postgres`)).rejects.toMatchObject({ code: '42501' });
      } finally {
        await c.end();
      }
    });
  }

  it('crm_server (real login) reads crm rows of the claimed user\'s org only, and nothing without claims', async () => {
    const c = await loginAs('crm_server');
    try {
      expect((await c.query(`select * from crm.harness_probe`)).rowCount).toBe(0);
      await c.query('begin');
      await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: w.u.aAdmin, role: 'authenticated' })]);
      const orgs = (await c.query(`select distinct org_id from crm.harness_probe`)).rows.map((r) => r.org_id);
      await c.query('rollback');
      expect(orgs).toEqual([w.A.id]);
    } finally {
      await c.end();
    }
  });
});

describe('T6 anon reaches nothing', () => {
  it('no usage on any platform schema, no privilege on any table or function', async () => {
    const schemas = await ownerQuery(`select s from unnest(array['core','app','audit','billing','private','crm','os','erp']) s where has_schema_privilege('anon', s, 'usage')`);
    expect(schemas).toEqual([]);
    const tablesWithGrant = await ownerQuery(
      `select schemaname, tablename from pg_tables where schemaname in ('core','audit','billing','private','crm','os','erp')
          and (has_table_privilege('anon', quote_ident(schemaname)||'.'||quote_ident(tablename), 'select')
            or has_table_privilege('anon', quote_ident(schemaname)||'.'||quote_ident(tablename), 'insert'))`,
    );
    expect(tablesWithGrant).toEqual([]);
  });

  it('every query as anon is refused', async () => {
    for (const t of [...tables.map((x) => `${x.schema}.${x.table}`), 'private.jobs', 'core.products', 'billing.plans']) {
      expect(await errorCode('anon', null, `select 1 from ${t} limit 1`), t).toBe('42501');
    }
    expect(await errorCode('anon', null, `select app.current_org_id()`)).toBe('42501');
  });
});

describe('T8 storage objects (policy level; no Storage API locally)', () => {
  beforeAll(async () => {
    const put = (bucket: string, org: string, name: string) => ownerQuery(`insert into storage.objects (bucket_id, name) values ($1, $2)`, [bucket, `${org}/${name}`]);
    await put('crm-files', w.A.id, 'a.pdf');
    await put('os-files', w.A.id, 'a.pdf');
    await put('core-files', w.A.id, 'logo.png');
    await put('crm-files', w.B.id, 'b.pdf');
    await put('crm-files', w.D.id, 'd.pdf');
    await put('os-files', w.D.id, 'd.pdf');
    await ownerQuery(`insert into storage.objects (bucket_id, name) values ('crm-files', 'not-a-uuid/x.pdf')`);
  });
  const names = (user: string) => tx('authenticated', user, async (c) => (await c.query(`select bucket_id || ':' || split_part(name, '/', 2) as n from storage.objects order by 1`)).rows.map((r) => r.n));

  it('org A sees only its own objects; org B objects and odd paths are hidden', async () => {
    expect(await names(w.u.aAdmin)).toEqual(['core-files:logo.png', 'crm-files:a.pdf', 'os-files:a.pdf']);
  });
  it('a user granted only OS sees the os bucket but not the crm bucket of the same org', async () => {
    expect(await names(w.u.dOsOnly)).toEqual(['os-files:d.pdf']);
  });
  it('uploads: own org and product only', async () => {
    expect(await errorCode('authenticated', w.u.aAdmin, `insert into storage.objects (bucket_id, name) values ('crm-files', $1)`, [`${w.A.id}/new.pdf`])).toBe('');
    expect(await errorCode('authenticated', w.u.aAdmin, `insert into storage.objects (bucket_id, name) values ('crm-files', $1)`, [`${w.B.id}/new.pdf`])).toBe('42501');
    expect(await errorCode('authenticated', w.u.cAdmin, `insert into storage.objects (bucket_id, name) values ('os-files', $1)`, [`${w.C.id}/new.pdf`])).toBe('42501');
  });
});

describe('T9 support "view as" needs an open session and is audited', () => {
  it('without a session the platform admin sees no client product or master data', async () => {
    for (const t of ['crm.harness_probe', 'os.harness_probe', 'erp.harness_probe', 'core.branches', 'core.org_users']) {
      expect(await count('authenticated', w.u.platform, `select * from ${t}`), t).toBe(0);
    }
  });

  it('opening a session is refused for non-admins, without a reason, or for too long', async () => {
    expect(await errorCode('authenticated', w.u.aAdmin, `select app.start_support_session($1, 'looking at a ticket 42')`, [w.A.id])).toBe('42501');
    expect(await errorCode('authenticated', w.u.platform, `select app.start_support_session($1, 'short')`, [w.A.id])).toBe('22023');
    expect(await errorCode('authenticated', w.u.platform, `select app.start_support_session($1, 'looking at a ticket 42', 600)`, [w.A.id])).toBe('22023');
  });

  it('an open session shows that org only, read-only, and is written to audit.log; ending it closes access', async () => {
    await tx('authenticated', w.u.platform, async (c) => {
      const sid = (await c.query(`select app.start_support_session($1, 'ticket 42: attendance missing', 30) as id`, [w.A.id])).rows[0].id;
      const n = async (sql: string) => Number((await c.query(`select count(*)::int as n from (${sql}) x`)).rows[0].n);
      expect(await n(`select * from crm.harness_probe`)).toBe(2); // a2 has CRM switched off
      expect(await n(`select * from os.harness_probe`)).toBe(3);
      expect(await n(`select * from crm.harness_probe where org_id <> '${w.A.id}'`)).toBe(0);
      expect(await n(`select * from core.branches`)).toBe(2);
      const audit = (await c.query(`select action, actor_user_id, detail->>'reason' as reason from audit.log where support_session_id = $1`, [sid])).rows;
      expect(audit).toContainEqual({ action: 'support_session.start', actor_user_id: w.u.platform, reason: 'ticket 42: attendance missing' });
      await c.query('savepoint s1');
      await expect(c.query(`insert into crm.harness_probe (org_id, title) values ($1, 'by support')`, [w.A.id])).rejects.toMatchObject({ code: '42501' });
      await c.query('rollback to savepoint s1');
      await c.query(`select app.end_support_session()`);
      expect(await n(`select * from crm.harness_probe`)).toBe(0);
      expect((await c.query(`select count(*)::int as n from audit.log where support_session_id = $1 and action = 'support_session.end'`, [sid])).rows[0].n).toBe(1);
    });
  });

  it('an expired session gives no access', async () => {
    await tx('authenticated', w.u.platform, async (c) => {
      const sid = (await c.query(`select app.start_support_session($1, 'ticket 43: check timetable', 30) as id`, [w.A.id])).rows[0].id;
      await c.query(`reset role`);
      await c.query(`update core.support_sessions set started_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' where id = $1`, [sid]);
      await c.query(`set local role authenticated`);
      expect((await c.query(`select count(*)::int as n from crm.harness_probe`)).rows[0].n).toBe(0);
    });
  });

  it('writes in a read-write session carry the session id in audit.log; the client admin sees the support log', async () => {
    await tx('authenticated', w.u.platform, async (c) => {
      const sid = (await c.query(`select app.start_support_session($1, 'ticket 44: fix a wrong title', 30, false) as id`, [w.A.id])).rows[0].id;
      const row = (await c.query(`insert into crm.harness_probe (org_id, branch_id, title) values ($1, $2, 'fixed by support') returning id`, [w.A.id, w.A.branches.a1])).rows[0].id;
      const a = (await c.query(`select action, support_session_id from audit.log where table_name = 'harness_probe' and row_id = $1`, [row])).rows;
      expect(a).toEqual([{ action: 'insert', support_session_id: sid }]);
    });
    expect(await count('authenticated', w.u.aAdmin, `select * from core.support_sessions`)).toBeGreaterThan(0);
    expect(await count('authenticated', w.u.aTeacher, `select * from core.support_sessions`)).toBe(0);
  });
});

describe('T10 (replaced, decision 37) one person belongs to exactly one client', () => {
  it('a second org link for the same user is rejected', async () => {
    await expect(ownerQuery(`insert into core.org_users (org_id, user_id, kind, display_name) values ($1, $2, 'parent', 'x')`, [w.B.id, w.u.aAdmin]))
      .rejects.toMatchObject({ code: '23505', constraint: 'org_users_one_org_per_user' });
  });
  it('product access cannot be granted to a user in another org', async () => {
    await expect(ownerQuery(`insert into core.user_product_access (org_id, user_id, product_key, role_key) values ($1, $2, 'os', 'admin')`, [w.B.id, w.u.cAdmin]))
      .rejects.toMatchObject({ code: '23503' });
  });
  it('app.my_org_id() returns the single org', async () => {
    expect(await tx('authenticated', w.u.aAdmin, async (c) => (await c.query(`select app.my_org_id() as o`)).rows[0].o)).toBe(w.A.id);
  });
});

describe('T11 jobs of an org without the product are skipped and logged', () => {
  it('claim_jobs runs only jobs whose org still has the product', async () => {
    const ins = `insert into private.jobs (org_id, product_key, kind) values ($1, $2, 'digest') returning id`;
    const ok = (await ownerQuery(ins, [w.A.id, 'os']))[0]!.id;
    const noProduct = (await ownerQuery(ins, [w.C.id, 'os']))[0]!.id;
    const otherProduct = (await ownerQuery(ins, [w.C.id, 'crm']))[0]!.id;
    const c = await loginAs('job_runner');
    try {
      await expect(c.query(`select * from private.jobs`)).rejects.toMatchObject({ code: '42501' });
      const claimed = (await c.query(`select id, status from private.claim_jobs('os', 'worker-1', 50)`)).rows;
      expect(claimed).toEqual([{ id: ok, status: 'running' }]);
      await c.query(`select private.finish_job($1, true)`, [ok]);
    } finally {
      await c.end();
    }
    const st = await ownerQuery<{ id: string; status: string; skip_reason: string | null }>(`select id, status, skip_reason from private.jobs where id = any($1) order by status`, [[ok, noProduct, otherProduct]]);
    expect(st).toEqual([
      { id: ok, status: 'done', skip_reason: null },
      { id: otherProduct, status: 'queued', skip_reason: null },
      { id: noProduct, status: 'skipped', skip_reason: 'org has no active os subscription' },
    ]);
    const log = await ownerQuery(`select org_id, action from audit.log where row_id = $1`, [noProduct]);
    expect(log).toEqual([{ org_id: w.C.id, action: 'job.skipped' }]);
  });

  it('product servers and users cannot read the queue directly', async () => {
    for (const role of ['authenticated', 'crm_server', 'os_server'] as const) {
      expect(await errorCode(role, w.u.aAdmin, `select * from private.jobs`)).toBe('42501');
    }
  });
});

describe('T12 Supabase security advisor', () => {
  it.skip('needs a Supabase project (get_advisors security); not run locally, see docs/platform-foundation.md', () => undefined);
});

describe('login security (decision 36)', () => {
  it('five failed passwords lock the account; success resets; users cannot call it themselves', async () => {
    const st = await tx('os_server', null, async (c) => {
      const n: number[] = [];
      for (let i = 0; i < 5; i += 1) {
        n.push((await c.query(`select (app.record_login_event($1, 'password', false, 'bad password')).failed_attempts as n`, [w.u.aTeacher])).rows[0].n);
      }
      const locked = (await c.query(`select app.login_allowed($1) as ok`, [w.u.aTeacher])).rows[0].ok;
      const reset = (await c.query(`select (app.record_login_event($1, 'password', true)).failed_attempts as n`, [w.u.aTeacher])).rows[0].n;
      const after = (await c.query(`select app.login_allowed($1) as ok`, [w.u.aTeacher])).rows[0].ok;
      // without user claims the server role itself cannot read the table
      const visible = (await c.query(`select count(*)::int as n from core.user_security`)).rows[0].n;
      return { n, locked, reset, after, visible };
    });
    expect(st).toEqual({ n: [1, 2, 3, 4, 5], locked: false, reset: 0, after: true, visible: 0 });
    expect(await errorCode('authenticated', w.u.aTeacher, `select app.record_login_event($1, 'password', true)`, [w.u.aTeacher])).toBe('42501');
  });

  it('rate limit counts per window', async () => {
    const r = await tx('crm_server', null, async (c) => {
      const out: boolean[] = [];
      for (let i = 0; i < 3; i += 1) out.push((await c.query(`select app.rate_limit_hit('otp:+910000', 2, 60) as ok`)).rows[0].ok);
      return out;
    });
    expect(r).toEqual([true, true, false]);
  });
});

describe('the RLS generator', () => {
  it('refuses tables without org_id, product tables outside their schema and unknown modules', async () => {
    const ddl = async (sql: string) => {
      const c = await owner.connect();
      try {
        await c.query('begin');
        await c.query(sql);
        return '';
      } catch (e) {
        return (e as Error).message;
      } finally {
        await c.query('rollback');
        c.release();
      }
    };
    expect(await ddl(`create table crm.t1 (id uuid); select app.apply_rls('crm','t1','product','crm','harness')`)).toMatch(/no org_id/);
    expect(await ddl(`create table crm.t2 (id uuid, org_id uuid); select app.apply_rls('crm','t2','product','os','harness')`)).toMatch(/must live in its product schema/);
    expect(await ddl(`create table crm.t3 (id uuid, org_id uuid); select app.apply_rls('crm','t3','product','crm','nope')`)).toMatch(/not in core.product_modules/);
    expect(await ddl(`create table core.t4 (id uuid, org_id uuid); select app.apply_rls('core','t4','product','crm','harness')`)).toMatch(/must live in its product schema/);
  });

  it("kind 'product_config': branch users read, only configure permission writes, config history kept", async () => {
    const c = await owner.connect();
    try {
      await c.query('begin');
      await c.query(`create table os.harness_settings (id uuid primary key default gen_random_uuid(), org_id uuid not null, branch_id uuid, value text)`);
      await c.query(`select app.apply_rls('os', 'harness_settings', 'product_config', 'os', 'harness')`);
      await c.query(`insert into os.harness_settings (org_id, branch_id, value) values ($1, $2, 'a1'), ($1, $3, 'a2'), ($4, $5, 'b1')`, [w.A.id, w.A.branches.a1, w.A.branches.a2, w.B.id, w.B.branches.b1]);
      const as = async (user: string, sql: string, params: unknown[] = []) => {
        await c.query('savepoint p');
        await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: user })]);
        await c.query('set local role authenticated');
        try {
          return (await c.query(sql, params)).rows;
        } catch (e) {
          return (e as { code: string }).code;
        } finally {
          await c.query('rollback to savepoint p');
        }
      };
      expect(await as(w.u.aTeacher, `select value from os.harness_settings order by 1`)).toEqual([{ value: 'a1' }]);
      expect(await as(w.u.aAdmin, `select value from os.harness_settings order by 1`)).toEqual([{ value: 'a1' }, { value: 'a2' }]);
      expect(await as(w.u.aTeacher, `insert into os.harness_settings (org_id, branch_id, value) values ($1, $2, 'x')`, [w.A.id, w.A.branches.a1])).toBe('42501');
      expect(await as(w.u.aAdmin, `insert into os.harness_settings (org_id, branch_id, value) values ($1, $2, 'x') returning value`, [w.A.id, w.A.branches.a1])).toEqual([{ value: 'x' }]);
      const hist = await c.query(`select count(*)::int as n from audit.config_history where schema_name = 'os' and table_name = 'harness_settings'`);
      expect(hist.rows[0].n).toBe(3);
    } finally {
      await c.query('rollback');
      c.release();
    }
  });
});

describe('every product schema is covered by the probes', () => {
  it('each product schema has at least one org-scoped table in the harness', () => {
    for (const s of PRODUCT_SCHEMAS) expect(tables.some((t) => t.schema === s), s).toBe(true);
  });
});
