/**
 * AI school designer tables (20261127100001_core_designer.sql) at the RLS level: only org management (setup.configure
 * at branch scope or wider, in any product) and platform staff inside an open support session for the org reach
 * core.design_changesets / design_changeset_items; writing needs a read-write session; a changeset is written in the
 * signed-in person's own name with their own session id. The generic T1-T7 checks cover the tables too (fixture rows).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { count, errorCode, owner, ownerQuery, tx } from './helpers';
import { buildWorld, type World } from './fixture';

let w: World;
const CS = `select * from core.design_changesets`;
const ITEMS = `select * from core.design_changeset_items`;
const insertCs = (author: string, kind: string, session: string | null) =>
  `insert into core.design_changesets (org_id, prompt, author_user_id, author_kind, support_session_id) values (app.current_org_id(), 'x', '${author}', '${kind}', ${session ? `'${session}'` : 'null'})`;

beforeAll(async () => {
  w = await buildWorld();
}, 300000);

afterAll(async () => {
  await ownerQuery(`update core.support_sessions set ended_at = now() where ended_at is null`);
  await owner.end();
});

async function openSession(readOnly: boolean): Promise<string> {
  await ownerQuery(`update core.support_sessions set ended_at = now() where platform_user_id = $1 and ended_at is null`, [w.u.platform]);
  const r = await ownerQuery<{ id: string }>(
    `insert into core.support_sessions (org_id, platform_user_id, reason, read_only, started_at, expires_at) values ($1, $2, 'designer harness: school visit', $3, now(), now() + interval '30 minutes') returning id`,
    [w.A.id, w.u.platform, readOnly],
  );
  return r[0]!.id;
}

describe('designer tables: who reads and writes', () => {
  it('org management of A reads only A; B reads only B; a teacher and a portal user read nothing', async () => {
    expect(await count('authenticated', w.u.aAdmin, CS)).toBe(1);
    expect(await count('authenticated', w.u.aAdmin, `${CS} where org_id = $1`, [w.B.id])).toBe(0);
    expect(await count('authenticated', w.u.bAdmin, `${ITEMS} where org_id = $1`, [w.A.id])).toBe(0);
    expect(await count('os_server', w.u.aAdmin, ITEMS)).toBe(1);
    expect(await count('authenticated', w.u.aTeacher, CS)).toBe(0);
    expect(await count('authenticated', w.u.aGuardian, CS)).toBe(0);
    expect(await count('authenticated', w.u.cAdmin, CS)).toBe(0);
  });

  it('management writes in its own name only; a teacher cannot write; nobody deletes history', async () => {
    expect(await errorCode('os_server', w.u.aAdmin, insertCs(w.u.aAdmin, 'org_admin', null))).toBe('');
    expect(await errorCode('os_server', w.u.aAdmin, insertCs(w.u.aTeacher, 'org_admin', null))).toBe('42501');
    expect(await errorCode('os_server', w.u.aAdmin, insertCs(w.u.aAdmin, 'relationship_manager', '00000000-0000-0000-0000-000000000001'))).toBe('42501');
    expect(await errorCode('os_server', w.u.aTeacher, insertCs(w.u.aTeacher, 'org_admin', null))).toBe('42501');
    expect(await tx('os_server', w.u.aAdmin, async (c) => (await c.query(`delete from core.design_changesets`).catch((e: { code: string }) => ({ rowCount: e.code })) ).rowCount)).toBe('42501');
  });

  it('platform staff: nothing without a session; read-only session reads but cannot write; read-write session writes as itself', async () => {
    expect(await count('authenticated', w.u.platform, CS)).toBe(0);
    const ro = await openSession(true);
    expect(await count('os_server', w.u.platform, CS)).toBe(1);
    expect(await errorCode('os_server', w.u.platform, insertCs(w.u.platform, 'relationship_manager', ro))).toBe('42501');
    const rw = await openSession(false);
    expect(await errorCode('os_server', w.u.platform, insertCs(w.u.platform, 'relationship_manager', rw))).toBe('');
    // a made-up session id, another author, or posing as school management is refused
    expect(await errorCode('os_server', w.u.platform, insertCs(w.u.platform, 'relationship_manager', ro))).toBe('42501');
    expect(await errorCode('os_server', w.u.platform, insertCs(w.u.aAdmin, 'relationship_manager', rw))).toBe('42501');
    expect(await errorCode('os_server', w.u.platform, insertCs(w.u.platform, 'org_admin', null))).toBe('42501');
    // the session is for org A only
    expect(await count('os_server', w.u.platform, `${CS} where org_id = $1`, [w.B.id])).toBe(0);
    await ownerQuery(`update core.support_sessions set ended_at = now() where id = $1`, [rw]);
    expect(await count('os_server', w.u.platform, CS)).toBe(0);
  });

  it('app.designer_allowed mirrors the rule and is not callable by anon', async () => {
    const allowed = (u: string, write: boolean) => count('authenticated', u, `select 1 where app.designer_allowed(app.current_org_id(), ${write})`);
    expect(await allowed(w.u.aAdmin, true)).toBe(1);
    expect(await allowed(w.u.aTeacher, false)).toBe(0);
    expect(await allowed(w.u.dCrmAdmin, true)).toBe(1); // management through the CRM role ('*' / '*' / org)
    expect(await errorCode('anon', null, `select app.designer_allowed(null, false)`)).toBe('42501');
  });
});
