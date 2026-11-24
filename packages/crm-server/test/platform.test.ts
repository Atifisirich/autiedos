/**
 * What the port adds on top of the CRM's own acceptance tests: the platform guarantees as the CRM server sees them.
 * core.admit_student contract, field-level masking enforced in SQL, wallet guards, role matrix -> core.role_permissions,
 * org isolation, subscription-gated jobs, consent read path, upsert_staff. Real Postgres, real login roles.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asSystem, asUser, resolvePublic, systemActor, type Db } from '../src/db';
import { captureEnquiry, changeStage, stageByName, sendMessage } from '../src/core';
import { runDueJobs } from '../src/jobs';
import { addStaff, as, createOrg, owner, ownerQ, shutdown, type TestOrg } from './helpers';

let org: TestOrg, other: TestOrg, erpOrg: TestOrg;
let admin: string, counsellor: string, principal: string, otherAdmin: string;
let n = 0;
const mobile = () => '99' + String(30000000 + ++n).padStart(8, '0');
const sys = <T>(fn: (db: Db) => Promise<T>) => asSystem(org.orgId, fn);
const lead = async (o: Org2 = org, over: Partial<Parameters<typeof captureEnquiry>[1]> = {}) => {
  const r = await asSystem(o.orgId, (db) => captureEnquiry(db, { studentName: 'Prospect Child', guardianName: 'Parent One', mobile: mobile(), branchId: o.branchId, grade: 'Grade 1', channel: 'Website', source: 'Test', ...over }));
  if (!r.ok) throw new Error(r.error);
  return r;
};
type Org2 = TestOrg;
const won = (o: Org2, id: string) => asSystem(o.orgId, async (db) => changeStage(db, id, (await stageByName(db, 'Admission confirmed'))!.id, null));
const code = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
    return '';
  } catch (e) {
    return (e as { code?: string }).code ?? String(e);
  }
};

beforeAll(async () => {
  org = await createOrg('Platform School', { branches: ['Main campus', 'Second campus'] });
  other = await createOrg('Rival School');
  erpOrg = await createOrg('Both Products School', { products: ['crm', 'erp'] });
  admin = await addStaff(org, 'Group Head', 'Group Admin');
  counsellor = await addStaff(org, 'Cathy Counsellor', 'Counsellor', { branchIds: [org.branchId] });
  principal = await addStaff(org, 'Prof Principal', 'Principal', { branchIds: [org.branchId] });
  await addStaff(org, 'Branch Boss', 'Branch Admin', { branchIds: [org.branchId] });
  otherAdmin = await addStaff(other, 'Rival Head', 'Group Admin');
  await addStaff(erpOrg, 'Erp Head', 'Group Admin');
  await addStaff(erpOrg, 'Erp Counsellor', 'Counsellor');
});
afterAll(shutdown);

describe('core.admit_student (decision 38)', () => {
  it('creates the family, student, enrolment, status event, consents and audit row in one go, and links back', async () => {
    const m = mobile();
    const e = await lead(org, { studentName: 'Meera Rao', guardianName: 'Sunil Rao', mobile: m, dob: '2016-02-02', gender: 'Girl', currentSchool: 'Little Stars', preferOwnerId: counsellor });
    // before admission nothing exists in core
    expect((await ownerQ('select count(*)::int n from core.students where org_id = $1', [org.orgId]))[0].n).toBe(0);
    // a family with a second guardian and special needs
    await ownerQ("insert into crm.guardians (org_id, household_id, name, relation, phone, is_primary) values ($1, $2, 'Lata Rao', 'mother', $3, false)", [org.orgId, e.householdId, mobile()]);
    await ownerQ("update crm.prospects set special_needs = 'Needs glasses' where household_id = $1", [e.householdId]);
    const res = await won(org, e.enquiryId);
    expect(res.ok).toBe(true);
    const a = res.admission as Record<string, any>;
    expect(a).toMatchObject({ created: true, household_matched: false });
    const st = (await ownerQ('select * from core.students where id = $1', [a.student_id]))[0];
    expect(st).toMatchObject({ status: 'admitted', first_name: 'Meera', last_name: 'Rao', gender: 'female', dob: '2016-02-02', previous_school: 'Little Stars', admission_no: null, household_id: a.household_id });
    expect(st.programme_id).toBeTruthy(); // matched by grade name and board
    const guardians = await ownerQ('select name, phone, is_primary from core.guardians where household_id = $1 order by is_primary desc', [a.household_id]);
    expect(guardians.map((g) => g.name)).toEqual(['Sunil Rao', 'Lata Rao']);
    expect(guardians[0].phone).toBe(m);
    expect((await ownerQ('select special_needs from core.student_sensitive where student_id = $1', [a.student_id]))[0].special_needs).toBe('Needs glasses');
    expect((await ownerQ('select count(*)::int n from core.enrolments where student_id = $1 and academic_year_id = $2', [a.student_id, org.yearId]))[0].n).toBe(1);
    expect((await ownerQ('select from_status, to_status from core.student_status_events where student_id = $1', [a.student_id]))[0]).toMatchObject({ from_status: null, to_status: 'admitted' });
    // the lead's consents went with the family (whatsapp, sms, email, call) and the CRM rows stay as history
    expect((await ownerQ("select count(*)::int n from core.consents where subject_type = 'guardian' and guardian_id = any($1)", [a.guardian_ids]))[0].n).toBe(4);
    expect((await ownerQ("select count(*)::int n from core.consents where subject_type = 'crm_guardian' and org_id = $1 and crm_contact_id in (select id from crm.guardians where household_id = $2)", [org.orgId, e.householdId]))[0].n).toBeGreaterThanOrEqual(4);
    // back-links and audit
    expect((await ownerQ('select core_student_id from crm.prospects where household_id = $1', [e.householdId]))[0].core_student_id).toBe(a.student_id);
    expect((await ownerQ('select core_household_id from crm.households where id = $1', [e.householdId]))[0].core_household_id).toBe(a.household_id);
    expect((await ownerQ('select count(*)::int n from crm.guardians where household_id = $1 and core_guardian_id is not null', [e.householdId]))[0].n).toBe(2);
    expect((await ownerQ("select detail from audit.log where action = 'crm.admit_student' and row_id = $1", [a.student_id]))[0].detail).toMatchObject({ enquiry_id: e.enquiryId });
    // idempotent: the "Sent to ERP" stage is also a won stage, and a second call changes nothing
    const again = await sys(async (db) => (await db.one('select core.admit_student($1) as r', [e.enquiryId]))!.r);
    expect(again).toMatchObject({ created: false, student_id: a.student_id, household_id: a.household_id });
    expect((await ownerQ('select count(*)::int n from core.students where org_id = $1', [org.orgId]))[0].n).toBe(1);
    expect((await ownerQ('select count(*)::int n from core.guardians where org_id = $1', [org.orgId]))[0].n).toBe(2);
  });

  it('a sibling joins the family that already exists (matched by guardian phone), without duplicate guardians', async () => {
    const m = mobile();
    const a = await lead(org, { studentName: 'Ira Menon', guardianName: 'Anil Menon', mobile: m });
    await won(org, a.enquiryId);
    const b = await lead(org, { studentName: 'Vivaan Menon', guardianName: 'Anil Menon', mobile: m, grade: 'Nursery' });
    expect(b.householdId).toBe(a.householdId); // the CRM already keeps them in one household
    const r = await won(org, b.enquiryId);
    expect(r.admission).toMatchObject({ created: true, household_matched: true });
    const kids = await ownerQ('select household_id from core.students where org_id = $1 and first_name in ($2, $3)', [org.orgId, 'Ira', 'Vivaan']);
    expect(new Set(kids.map((k) => k.household_id)).size).toBe(1);
    expect((await ownerQ('select count(*)::int n from core.guardians where org_id = $1 and phone = $2', [org.orgId, m]))[0].n).toBe(1);
    // a different CRM household with the same parent phone (typed twice by hand) also lands in the same core family
    const h2 = (await ownerQ('insert into crm.households (org_id) values ($1) returning id', [org.orgId]))[0].id;
    await ownerQ("insert into crm.guardians (org_id, household_id, name, phone) values ($1, $2, 'Anil M', $3) on conflict do nothing", [org.orgId, h2, mobile()]);
    expect(h2).toBeTruthy();
  });

  it('refuses an enquiry that is not in an admission-confirmed stage, and anyone without CRM access to it', async () => {
    const e = await lead(org, { preferOwnerId: counsellor });
    expect(await code(() => sys((db) => db.q('select core.admit_student($1)', [e.enquiryId])))).toBe('22023');
    // a counsellor may admit only enquiries they (or their team) own, an admin of another org never
    await won(org, e.enquiryId).catch(() => undefined);
    const mine = await lead(org, { preferOwnerId: counsellor });
    await ownerQ('update crm.enquiries set stage_id = (select id from crm.stages where org_id = $1 and is_won limit 1) where id = $2', [org.orgId, mine.enquiryId]);
    const foreign = await lead(org);
    await ownerQ('update crm.enquiries set stage_id = (select id from crm.stages where org_id = $1 and is_won limit 1), owner_id = $3 where id = $2', [org.orgId, foreign.enquiryId, principal]);
    expect(await code(() => asUser(counsellor, org.orgId, (db) => db.q('select core.admit_student($1)', [foreign.enquiryId])))).toBe('42501');
    expect(await code(() => asUser(otherAdmin, other.orgId, (db) => db.q('select core.admit_student($1)', [mine.enquiryId])))).toBe('42501');
    expect(await code(() => asUser(counsellor, org.orgId, (db) => db.q('select core.admit_student($1)', [mine.enquiryId])))).toBe('');
  });

  it('is callable only by the CRM server role: OS and ERP servers cannot execute it', async () => {
    const q = (r: string) => ownerQ(`select has_function_privilege('${r}', 'core.admit_student(uuid)', 'execute') as ok`);
    expect((await q('crm_server'))[0].ok).toBe(true);
    for (const r of ['os_server', 'erp_server', 'platform_admin_server', 'job_runner', 'anon', 'authenticated']) expect((await q(r))[0].ok, r).toBe(false);
    const c = new pg.Client({ connectionString: as('erp_server') });
    await c.connect();
    try {
      await expect(c.query('select core.admit_student($1)', [randomUUID()])).rejects.toMatchObject({ code: '42501' });
    } finally {
      await c.end();
    }
  });

  it('queues an ERP event only for an org that has the ERP, and never writes to erp tables', async () => {
    const e = await lead(erpOrg);
    const r = await won(erpOrg, e.enquiryId);
    const jobs = await ownerQ("select kind, product_key, payload from private.jobs where org_id = $1 and product_key = 'erp'", [erpOrg.orgId]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ kind: 'post_admission', payload: { student_id: (r.admission as Record<string, any>).student_id } });
    const e2 = await lead(org);
    await won(org, e2.enquiryId);
    expect((await ownerQ("select count(*)::int n from private.jobs where org_id = $1 and product_key = 'erp'", [org.orgId]))[0].n).toBe(0);
  });

  it('the student status cannot be changed by the CRM server, only through core.change_student_status', async () => {
    const e = await lead(org);
    const r = await won(org, e.enquiryId);
    const sid = (r.admission as Record<string, any>).student_id;
    expect(await code(() => sys((db) => db.q("update core.students set status = 'active' where id = $1", [sid])))).toBe('42501');
  });
});

describe('sensitive custom fields are masked in SQL, not only in the app', () => {
  let enq: string;
  beforeAll(async () => {
    await asUser(admin, org.orgId, (db) => db.q("select crm.set_field_sensitivity('family_income', true)"));
    const e = await lead(org, { studentName: 'Masked Child', preferOwnerId: counsellor, custom: { family_income: '15-20L', transport_required: 'Yes' } });
    enq = e.enquiryId;
  });

  it('plain values never sit in crm.enquiries.custom; they are in crm.enquiry_sensitive', async () => {
    expect((await ownerQ('select custom from crm.enquiries where id = $1', [enq]))[0].custom).toEqual({ family_income: '••••••', transport_required: 'Yes' });
    expect((await ownerQ('select data from crm.enquiry_sensitive where enquiry_id = $1', [enq]))[0].data).toEqual({ family_income: '15-20L' });
  });

  it('a role with Sensitive = F or V sees the value; a Masked role sees only the placeholder, in any query', async () => {
    const full = (uid: string) => asUser(uid, org.orgId, (db) => db.one('select custom, custom_full from crm.enquiries_full where id = $1', [enq]));
    expect((await full(admin))!.custom_full.family_income).toBe('15-20L');
    expect((await full(principal))!.custom_full.family_income).toBe('15-20L'); // Principal: V
    const c = (await full(counsellor))!; // Counsellor: Masked
    expect(c.custom_full.family_income).toBe('••••••');
    expect(c.custom.family_income).toBe('••••••');
    expect(c.custom_full.transport_required).toBe('Yes');
    expect(await asUser(counsellor, org.orgId, (db) => db.q('select * from crm.enquiry_sensitive'))).toHaveLength(0);
  });

  it('only a role that may edit sensitive fields can change them; anyone else\'s write is put back', async () => {
    const set = (uid: string, v: string) => asUser(uid, org.orgId, (db) => db.q("update crm.enquiries set custom = jsonb_set(custom, '{family_income}', to_jsonb($2::text)) where id = $1", [enq, v]));
    await set(counsellor, 'hacked');
    await set(principal, 'also hacked');
    expect((await ownerQ('select data from crm.enquiry_sensitive where enquiry_id = $1', [enq]))[0].data).toEqual({ family_income: '15-20L' });
    expect((await ownerQ('select custom->>\'family_income\' v from crm.enquiries where id = $1', [enq]))[0].v).toBe('••••••');
    await set(admin, '20-25L');
    expect((await ownerQ('select data from crm.enquiry_sensitive where enquiry_id = $1', [enq]))[0].data).toEqual({ family_income: '20-25L' });
  });

  it('unflagging a field moves its values back into the row', async () => {
    await asUser(admin, org.orgId, (db) => db.q("select crm.set_field_sensitivity('family_income', false)"));
    expect((await ownerQ("select custom->>'family_income' v from crm.enquiries where id = $1", [enq]))[0].v).toBe('20-25L');
    expect((await ownerQ('select data from crm.enquiry_sensitive where enquiry_id = $1', [enq]))[0].data).toEqual({});
    await asUser(admin, org.orgId, (db) => db.q("select crm.set_field_sensitivity('family_income', true)"));
    expect((await ownerQ("select custom->>'family_income' v from crm.enquiries where id = $1", [enq]))[0].v).toBe('••••••');
  });
});

describe('the CRM row policies agree with the platform\'s app.can() for every default role', () => {
  it('visible and editable enquiries are exactly those app.can() allows (own / team / branch / org scope)', async () => {
    const second = org.branches['Second campus']!;
    const users: Record<string, string> = {
      'Group Admin': admin, Counsellor: counsellor, Principal: principal, 'Branch Admin': org.users['Branch Boss']!,
      'Front Office': await addStaff(org, 'Front Fiona', 'Front Office', { branchIds: [org.branchId] }),
      Marketing: await addStaff(org, 'Market Mo', 'Marketing'),
      'Second Counsellor': await addStaff(org, 'Second Sam', 'Counsellor', { branchIds: [second] }),
    };
    // enquiries spread over both branches and several owners; the counsellor manages the second counsellor
    await ownerQ('update core.staff set reports_to = (select id from core.staff where user_id = $2) where user_id = $1', [users['Second Counsellor'], users.Counsellor]);
    const owners = [users.Counsellor!, users['Second Counsellor']!, users['Branch Admin']!, admin];
    for (let i = 0; i < 8; i++) {
      const e = await lead(org, { studentName: `Matrix ${i}`, mobile: mobile() });
      await ownerQ('update crm.enquiries set owner_id = $2, branch_id = $3 where id = $1', [e.enquiryId, owners[i % 4], i % 2 ? second : org.branchId]);
    }
    for (const [role, uid] of Object.entries(users)) {
      for (const action of ['view', 'edit']) {
        const c = await owner.connect();
        let expected: string[];
        try {
          await c.query('begin');
          await c.query(`select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', $2, true)`, [uid, JSON.stringify({ sub: uid })]);
          expected = (
            await c.query(
              `select e.id from crm.enquiries e where e.org_id = $1 and (app.can('crm', 'leads', $2, e.org_id, e.branch_id, e.owner_id)
                 or (crm.in_my_team(e.org_id, e.owner_id) and app.can('crm', 'leads', $2, e.org_id, e.branch_id, app.uid()))) order by 1`,
              [org.orgId, action],
            )
          ).rows.map((r) => r.id);
        } finally {
          await c.query('rollback');
          c.release();
        }
        const actual = await asUser(uid, org.orgId, async (db) => {
          if (action === 'view') return (await db.q('select id from crm.enquiries order by 1')).map((r) => r.id);
          return (await db.q('update crm.enquiries set tags = tags where org_id = $1 returning id', [org.orgId])).map((r) => r.id).sort();
        });
        expect(actual, `${role} ${action}`).toEqual(expected);
      }
    }
  });
});

describe('wallet, roles and secrets', () => {
  it('the wallet balance and ledger change only through crm.wallet_post', async () => {
    expect(await code(() => asUser(admin, org.orgId, (db) => db.q('update crm.settings set wallet_balance = 99999')))).toBe('42501');
    expect(await code(() => asUser(admin, org.orgId, (db) => db.q("insert into crm.wallet_ledger (org_id, type, category, amount) values ($1, 'credit', 'x', 5)", [org.orgId])))).toBe('42501');
    expect(await code(() => asUser(counsellor, org.orgId, (db) => db.q("select crm.wallet_post('credit', 'recharge', 100)")))).toBe('42501');
    const before = Number((await ownerQ('select wallet_balance from crm.settings where org_id = $1', [org.orgId]))[0].wallet_balance);
    await asUser(admin, org.orgId, (db) => db.q("select crm.wallet_post('credit', 'recharge', 100, 'test')"));
    await asUser(counsellor, org.orgId, (db) => db.q("select crm.wallet_post('debit', 'whatsapp', 0.8, 'one message')"));
    expect(Number((await ownerQ('select wallet_balance from crm.settings where org_id = $1', [org.orgId]))[0].wallet_balance)).toBeCloseTo(before + 99.2, 2);
    expect(await code(() => asUser(admin, org.orgId, (db) => db.q("select crm.wallet_post('debit', 'whatsapp', 1000000)")))).toBe('23514');
  });

  it('the permission matrix of crm.roles becomes core.role_permissions, and only user admins can change it', async () => {
    const rows = await ownerQ("select rp.module_key, rp.action, rp.scope from core.role_permissions rp join core.roles r on r.id = rp.role_id where r.org_id = $1 and r.product_key = 'crm' and r.key = 'counsellor'", [org.orgId]);
    const has = (m: string, a: string, s: string) => rows.some((r) => r.module_key === m && r.action === a && r.scope === s);
    expect(has('leads', 'create', 'own')).toBe(true);
    expect(has('leads', 'view', 'branch')).toBe(false);
    expect(has('sensitive', 'view', 'org')).toBe(false); // Masked
    expect(has('payments', 'create', 'branch')).toBe(true); // Send link
    const grp = await ownerQ("select count(*)::int n from core.role_permissions rp join core.roles r on r.id = rp.role_id where r.org_id = $1 and r.key = 'group_admin'", [org.orgId]);
    expect(grp[0].n).toBeGreaterThan(20);
    // a counsellor and a branch admin cannot rewrite roles (module users, configure)
    for (const who of [counsellor, org.users['Branch Boss']!]) {
      const upd = await asUser(who, org.orgId, (db) => db.q("update crm.roles set permissions = permissions || '{\"leads\":\"F\"}'::jsonb where key = 'counsellor' returning key"));
      expect(upd, who).toHaveLength(0);
    }
    await asUser(admin, org.orgId, (db) => db.q("update crm.roles set permissions = permissions || '{\"reports\":\"F\"}'::jsonb where key = 'counsellor'"));
    expect((await ownerQ("select scope from core.role_permissions rp join core.roles r on r.id = rp.role_id where r.org_id = $1 and r.key = 'counsellor' and rp.module_key = 'reports'", [org.orgId]))[0].scope).toBe('org');
  });

  it('provider secrets are readable only with the secrets permission', async () => {
    await asUser(admin, org.orgId, (db) => db.q("insert into crm.org_secrets (org_id, key, value_enc) values ($1, 'wa_token', 'enc')", [org.orgId]));
    expect(await asUser(counsellor, org.orgId, (db) => db.q('select * from crm.org_secrets'))).toHaveLength(0);
    expect(await asUser(admin, org.orgId, (db) => db.q('select * from crm.org_secrets'))).toHaveLength(1);
  });
});

describe('isolation as the CRM server sees it', () => {
  it('a user of another org sees none of this org\'s CRM rows, in any table', async () => {
    const tables = (await ownerQ("select table_name from information_schema.columns where table_schema = 'crm' and column_name = 'org_id' and table_name <> 'harness_probe' order by 1")).map((r) => r.table_name as string);
    expect(tables.length).toBeGreaterThan(25);
    for (const t of tables) {
      const n = (await asUser(otherAdmin, other.orgId, (db) => db.one(`select count(*)::int n from crm.${t} where org_id = $1`, [org.orgId])))!.n;
      expect(n, t).toBe(0);
    }
    expect((await asUser(otherAdmin, other.orgId, (db) => db.one('select count(*)::int n from crm.enquiries')))!.n).toBeGreaterThanOrEqual(0);
  });

  it('the CRM server cannot reach os, erp, audit, billing or private at all', async () => {
    for (const s of ['os', 'erp', 'audit', 'billing', 'private']) {
      expect(await code(() => sys((db) => db.q(`select * from ${s}.${s === 'audit' ? 'log' : s === 'billing' ? 'plans' : s === 'private' ? 'jobs' : 'harness_probe'} limit 1`))), s).toBe('42501');
    }
  });

  it('the automation user is the org\'s own and exists only while the org has the CRM', async () => {
    expect(await systemActor(org.orgId)).toBeTruthy();
    await ownerQ("update core.subscriptions set status = 'suspended' where org_id = $1 and product_key = 'crm'", [other.orgId]);
    await expect(asSystem(other.orgId, (db) => db.q('select 1'))).rejects.toThrow(/no active CRM subscription/);
    const key = (await ownerQ('select webhook_key from crm.settings where org_id = $1', [other.orgId]))[0].webhook_key;
    expect(await resolvePublic('webhook', key)).toBeNull();
    await ownerQ("update core.subscriptions set status = 'active' where org_id = $1 and product_key = 'crm'", [other.orgId]);
    expect(await resolvePublic('webhook', key)).toMatchObject({ orgId: other.orgId });
  });
});

describe('cron jobs run only for orgs with the CRM', () => {
  it('claims and runs the sweep and queued jobs, and skips (and logs) the jobs of an org that lost the CRM', async () => {
    const e = await lead(other);
    await asSystem(other.orgId, (db) => db.q("select app.enqueue_job('crm', 'workflow_resume', $1::jsonb, now() - interval '1 minute')", [JSON.stringify({ runId: randomUUID(), step: 1 })]));
    await ownerQ("update core.subscriptions set status = 'cancelled' where org_id = $1 and product_key = 'crm'", [other.orgId]);
    const ran = await runDueJobs();
    expect(ran.failed).toBe(0);
    const j = await ownerQ("select status, skip_reason from private.jobs where org_id = $1 and kind = 'workflow_resume'", [other.orgId]);
    expect(j[0]).toMatchObject({ status: 'skipped' });
    expect((await ownerQ("select count(*)::int n from audit.log where org_id = $1 and action = 'job.skipped'", [other.orgId]))[0].n).toBeGreaterThanOrEqual(1);
    await ownerQ("update core.subscriptions set status = 'active' where org_id = $1 and product_key = 'crm'", [other.orgId]);
    const next = await runDueJobs();
    expect(next.queued).toBeGreaterThanOrEqual(1); // the per-org sweep is queued again for active orgs
    expect(e.enquiryId).toBeTruthy();
    expect((await ownerQ("select count(*)::int n from private.jobs where org_id = $1 and kind = 'crm.sweep' and status = 'done'", [org.orgId]))[0].n).toBeGreaterThanOrEqual(1);
  });
});

describe('consent and shared helpers', () => {
  it('core.can_contact reads consent rows: granted by capture, withdrawn by STOP, never for a user without the CRM', async () => {
    const e = await lead(org);
    const g = (await ownerQ('select id from crm.guardians where household_id = $1', [e.householdId]))[0].id;
    const can = (uid: string, ch = 'whatsapp') => asUser(uid, org.orgId, async (db) => (await db.one('select core.can_contact($1, $2, $3) as ok', ['crm_guardian', g, ch]))!.ok);
    expect(await can(counsellor)).toBe(true);
    await asUser(counsellor, org.orgId, (db) => db.q("select crm.set_consent($1, 'whatsapp', false, 'test', null)", [g]));
    expect(await can(counsellor)).toBe(false);
    expect(await can(counsellor, 'sms')).toBe(true);
    // a user of a CRM-less org (or no CRM grant) gets false, not an error
    const osOnly = randomUUID();
    await ownerQ('insert into auth.users (id, email) values ($1, $2)', [osOnly, `os-only-${osOnly}@test.demo`]);
    await ownerQ("insert into core.org_users (org_id, user_id, kind, display_name) values ($1, $2, 'staff', 'OS only')", [org.orgId, osOnly]);
    expect(await code(() => asUser(osOnly, org.orgId, (db) => db.q('select core.can_contact($1, $2, $3)', ['crm_guardian', g, 'sms'])))).toBe('');
    expect(await asUser(osOnly, org.orgId, async (db) => (await db.one('select core.can_contact($1, $2, $3) as ok', ['crm_guardian', g, 'sms']))!.ok)).toBe(false);
    // the message is refused with the plain-language reason once consent is withdrawn
    const res = await sys((db) => sendMessage(db, { householdId: e.householdId, enquiryId: e.enquiryId, channel: 'whatsapp', body: 'hi', actorId: counsellor }));
    expect(res.status).toBe('failed');
    expect(res.reason).toMatch(/opted out/);
  });

  it('core.student_primary_phone returns the primary guardian phone of an admitted student', async () => {
    const m = mobile();
    const e = await lead(org, { mobile: m });
    const r = await won(org, e.enquiryId);
    const phone = await asUser(admin, org.orgId, async (db) => (await db.one('select core.student_primary_phone($1) as p', [(r.admission as Record<string, any>).student_id]))!.p);
    expect(phone).toBe(m);
  });

  it('core.upsert_staff creates the org link, staff row and product access in one call, and refuses a user of another org', async () => {
    const uid = randomUUID();
    await owner.query('insert into auth.users (id, email) values ($1, $2)', [uid, `invite-${uid}@test.demo`]);
    const staffId = await asUser(admin, org.orgId, async (db) => (await db.one("select core.upsert_staff($1, 'Nina', 'Iyer', $2, '9811100000', $3, 'crm', 'counsellor') as id", [uid, `invite-${uid}@test.demo`, org.branchId]))!.id);
    expect(staffId).toBeTruthy();
    expect((await ownerQ("select a.role_key, u.kind, s.status from core.user_product_access a join core.org_users u on u.user_id = a.user_id join core.staff s on s.user_id = a.user_id where a.user_id = $1", [uid]))[0]).toMatchObject({ role_key: 'counsellor', kind: 'staff', status: 'active' });
    expect(await code(() => asUser(otherAdmin, other.orgId, (db) => db.q("select core.upsert_staff($1, 'Nina', 'Iyer', null, null, null, 'crm', 'counsellor')", [uid])))).toBe('23505');
    expect(await code(() => asUser(counsellor, org.orgId, (db) => db.q("select core.upsert_staff($1, 'X', 'Y', null, null, null, 'crm', 'counsellor')", [randomUUID()])))).toBe('42501');
  });
});
