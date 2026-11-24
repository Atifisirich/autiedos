// Acceptance criteria from PRD Appendix E (autoedcrm tests/core.test.ts), ported to the platform and run against
// real Postgres as the crm_server login: the same 20 cases, with the CRM tables now in schema `crm`, people in core,
// and tenant isolation done by RLS instead of `tenant_id` filters.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asSystem, asUser, type Db } from '../src/db';
import { addTask, assignOwner, captureEnquiry, changeStage, completeTask, emit, hourIST, needsNextAction, normMobile, receiveMessage, sameStudent, sendMessage, stageByName } from '../src/core';
import { confirmAdmission, saveApplication, settlePayment, startApplication } from '../src/admissions';
import { runDueJobs } from '../src/jobs';
import { testRun, conditionsPass } from '../src/workflows';
import { parseCsv } from '../src/util';
import { addStaff, createOrg, ownerQ, shutdown, type TestOrg } from './helpers';

let org: TestOrg, other: TestOrg;
let branchId: string;
let users: string[] = [];
let n = 0;
const sys = <T>(fn: (db: Db) => Promise<T>) => asSystem(org.orgId, fn);
const mobile = () => '98' + String(10000000 + ++n).padStart(8, '0');
type Over = Partial<Parameters<typeof captureEnquiry>[1]>;
const lead = (over: Over = {}) => sys((db) => captureEnquiry(db, { studentName: 'Asha Verma', guardianName: 'Ritu Verma', mobile: mobile(), branchId, grade: 'Grade 1', channel: 'Website', source: 'Test', ...over }));
const must = <T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> => {
  if (!r.ok) throw new Error('capture failed: ' + JSON.stringify(r));
  return r as Extract<T, { ok: true }>;
};

beforeAll(async () => {
  org = await createOrg('Test School');
  other = await createOrg('Other School');
  branchId = org.branchId;
  for (const [name, leave] of [['Counsellor A', false], ['Counsellor B', false], ['Counsellor C', true]] as const) {
    users.push(await addStaff(org, name, 'Counsellor', { branchIds: [branchId], onLeave: leave }));
  }
  await addStaff(org, 'Admin Head', 'Group Admin');
  await sys(async (db) => {
    await db.q('delete from crm.assignment_rules where org_id = $1', [org.orgId]);
    await db.insert('crm.assignment_rules', { name: 'Round robin', seq: 1, conditions: {}, method: 'round_robin', user_ids: users });
  });
  await addStaff(other, 'Other Counsellor', 'Counsellor', { branchIds: [other.branchId] });
});
afterAll(shutdown);

describe('capture and duplicates', () => {
  it('normalises Indian mobiles and matches similar student names', () => {
    expect(normMobile('+91 98765-43210')).toBe('9876543210');
    expect(sameStudent({ name: 'Aarav Reddy' }, { name: 'aarav  reddy' })).toBe(true);
    expect(sameStudent({ name: 'Aarav Reddy' }, { name: 'Aarav Redy' })).toBe(true);
    expect(sameStudent({ name: 'Aarav Reddy' }, { name: 'Diya Reddy' })).toBe(false);
    expect(sameStudent({ name: 'Aarav Reddy', dob: '2020-01-01' }, { name: 'Aarav Reddy', dob: '2021-01-01' })).toBe(false);
  });

  it('DUP-01 / DM-01: an existing mobile adds a re-enquiry touch, never a second household', async () => {
    const m = mobile();
    const a = must(await lead({ studentName: 'Kabir Rao', guardianName: 'Sunil Rao', mobile: m, grade: 'UKG', source: 'Form' }));
    const b = must(await lead({ studentName: 'Kabir Rao', guardianName: 'S Rao', mobile: '+91' + m, grade: 'UKG', channel: 'Walk-in', source: 'Front desk walk-in' }));
    expect(b.status).toBe('re_enquiry');
    expect(b.householdId).toBe(a.householdId);
    expect(b.enquiryId).toBe(a.enquiryId);
    expect((await ownerQ('select count(*)::int n from crm.guardians where org_id = $1 and phone = $2', [org.orgId, m]))[0].n).toBe(1);
    expect((await ownerQ('select count(*)::int n from crm.source_touches where enquiry_id = $1', [a.enquiryId]))[0].n).toBe(2);
    expect((await ownerQ('select reenquired from crm.enquiries where id = $1', [a.enquiryId]))[0].reenquired).toBe(true);
  });

  it('DM-02: a new child on a known mobile becomes a sibling with the family\'s counsellor', async () => {
    const m = mobile();
    const a = must(await lead({ studentName: 'Ira Shah', guardianName: 'Neha Shah', mobile: m, grade: 'Grade 2' }));
    const b = must(await lead({ studentName: 'Vivaan Shah', guardianName: 'Neha Shah', mobile: m, grade: 'Nursery' }));
    expect(b.status).toBe('sibling_added');
    expect(b.householdId).toBe(a.householdId);
    expect(b.enquiryId).not.toBe(a.enquiryId);
    expect(b.ownerId).toBe(a.ownerId);
  });

  it('rejects an invalid mobile in plain language', async () => {
    const r = await lead({ mobile: '12345' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/valid 10-digit/);
  });

  it('keeps tenants isolated: the same mobile in another school is a different family', async () => {
    const m = mobile();
    const a = must(await lead({ mobile: m }));
    const b = must(await asSystem(other.orgId, (db) => captureEnquiry(db, { studentName: 'Asha Verma', guardianName: 'Ritu Verma', mobile: m, branchId: other.branchId })));
    expect(b.status).toBe('created');
    expect(b.householdId).not.toBe(a.householdId);
  });
});

describe('assignment', () => {
  it('ASG-03: round robin over three with one on leave gives ten leads as five and five', async () => {
    const count = async () => Object.fromEntries((await ownerQ('select owner_id, count(*)::int n from crm.enquiries where org_id = $1 group by owner_id', [org.orgId])).map((r) => [r.owner_id, r.n]));
    const before = await count();
    for (let i = 0; i < 10; i++) await lead({ studentName: 'Student ' + i });
    const after = await count();
    const got = (id: string) => (after[id] ?? 0) - (before[id] ?? 0);
    expect(got(users[0]!)).toBe(5);
    expect(got(users[1]!)).toBe(5);
    expect(got(users[2]!)).toBe(0);
  });

  it('ASG-06: the simulator explains the decision without assigning', async () => {
    const p = (await ownerQ('select pointer from crm.assignment_rules where org_id = $1', [org.orgId]))[0].pointer;
    const r = await sys((db) => assignOwner(db, { branchId }, true));
    expect(r.reason).toMatch(/Round robin/);
    expect((await ownerQ('select pointer from crm.assignment_rules where org_id = $1', [org.orgId]))[0].pointer).toBe(p);
  });

  it('respects daily capacity', async () => {
    await ownerQ('update crm.counsellor_settings set daily_capacity = 0 where user_id = $1', [users[0]]);
    const r = must(await lead({ studentName: 'Capacity Check' }));
    await ownerQ('update crm.counsellor_settings set daily_capacity = 25 where user_id = $1', [users[0]]);
    expect(r.ownerId).toBe(users[1]);
  });
});

describe('next action and stages', () => {
  it('DM-03 / TSK-03: a new enquiry has one owner, one stage and a next action', async () => {
    const r = must(await lead({ studentName: 'Next Action' }));
    await sys(async (db) => {
      expect(await needsNextAction(db, r.enquiryId)).toBe(false);
      const tasks = await db.q("select id from crm.follow_ups where enquiry_id = $1 and status = 'open'", [r.enquiryId]);
      expect(tasks.length).toBeGreaterThan(0);
      let res = { needsNext: false };
      for (const k of tasks) res = await completeTask(db, k.id, null, 'Spoke to parent');
      expect(res.needsNext).toBe(true);
      await addTask(db, { enquiryId: r.enquiryId, title: 'Follow-up', dueAt: new Date(Date.now() + 3600e3) });
      expect(await needsNextAction(db, r.enquiryId)).toBe(false);
    });
  });

  it('L360-05: closing asks for a reason, then cancels open tasks and needs no next action', async () => {
    const r = must(await lead({ studentName: 'Closing Case' }));
    await sys(async (db) => {
      const closed = (await stageByName(db, 'Not interested'))!;
      const miss = await changeStage(db, r.enquiryId, closed.id, null);
      expect(miss.ok).toBe(false);
      expect(miss.missing).toEqual(['closure_reason']);
      expect((await changeStage(db, r.enquiryId, closed.id, null, { closure_reason: 'Fee too high' })).ok).toBe(true);
      expect((await db.one("select count(*)::int n from crm.follow_ups where enquiry_id = $1 and status = 'open'", [r.enquiryId]))!.n).toBe(0);
      expect(await needsNextAction(db, r.enquiryId)).toBe(false);
      expect((await db.one("select count(*)::int n from crm.activities where enquiry_id = $1 and type = 'stage_change'", [r.enquiryId]))!.n).toBe(1);
    });
  });

  it('DUP-02: a re-enquiry re-opens a closed enquiry', async () => {
    const m = mobile();
    const a = must(await lead({ mobile: m, studentName: 'Reopen Me' }));
    await sys(async (db) => changeStage(db, a.enquiryId, (await stageByName(db, 'Not interested'))!.id, null, { closure_reason: 'Undecided' }));
    await lead({ mobile: m, studentName: 'Reopen Me' });
    const e = (await ownerQ('select s.name, s.is_closed from crm.enquiries e join crm.stages s on s.id = e.stage_id where e.id = $1', [a.enquiryId]))[0];
    expect(e.is_closed).toBe(false);
    await sys(async (db) => expect(await needsNextAction(db, a.enquiryId)).toBe(false));
  });
});

describe('messaging', () => {
  it('L360-03: an undeliverable WhatsApp message is explained in plain words with a next step', async () => {
    const r = must(await lead({ mobile: '9812345600', studentName: 'No WhatsApp' }));
    const res = await sys((db) => sendMessage(db, { householdId: r.householdId, enquiryId: r.enquiryId, channel: 'whatsapp', body: 'Hello' }));
    expect(res.status).toBe('failed');
    expect(res.reason).toBe('This number cannot receive WhatsApp messages. Try SMS or call.');
    const a = (await ownerQ("select content from crm.activities where enquiry_id = $1 and type = 'whatsapp' and meta->>'status' = 'failed' order by created_at desc limit 1", [r.enquiryId]))[0];
    expect(a.content).toMatch(/^Not delivered: This number cannot receive WhatsApp/);
  });

  it('CMPL-07: STOP opts the parent out and later sends are blocked; the wallet is only charged for delivered messages', async () => {
    const r = must(await lead({ studentName: 'Opt Out' }));
    const bal = async () => Number((await ownerQ('select wallet_balance from crm.settings where org_id = $1', [org.orgId]))[0].wallet_balance);
    const b0 = await bal();
    expect((await sys((db) => sendMessage(db, { householdId: r.householdId, enquiryId: r.enquiryId, channel: 'whatsapp', body: 'Hi' }))).status).toBe('delivered');
    expect(await bal()).toBeCloseTo(b0 - 0.8, 2);
    await sys((db) => receiveMessage(db, r.householdId, 'whatsapp', 'STOP'));
    const res = await sys((db) => sendMessage(db, { householdId: r.householdId, enquiryId: r.enquiryId, channel: 'whatsapp', body: 'Hi again' }));
    expect(res.status).toBe('failed');
    expect(res.reason).toMatch(/opted out/);
    expect(await bal()).toBeCloseTo(b0 - 0.8, 2);
  });
});

describe('workflows', () => {
  it('AUT-05: when the parent replies, pending steps are cancelled and the run log says why', async () => {
    const r = must(await lead({ studentName: 'Workflow Case' }));
    await sys((db) => emit(db, 'missed_call', r.enquiryId));
    const run = (await ownerQ("select r.* from crm.workflow_runs r join crm.workflows w on w.id = r.workflow_id where r.enquiry_id = $1 and w.recipe_key = 'missed_call'", [r.enquiryId]))[0];
    expect(run.status).toBe('running');
    await sys((db) => receiveMessage(db, r.householdId, 'whatsapp', 'Please call me at 5'));
    await ownerQ("update private.jobs set run_at = now() - interval '1 minute' where org_id = $1 and status = 'queued' and payload->>'runId' = $2", [org.orgId, run.id]);
    const ran = await runDueJobs();
    expect(ran.kinds.workflow_resume).toBeGreaterThanOrEqual(1);
    const after = (await ownerQ('select status, log from crm.workflow_runs where id = $1', [run.id]))[0];
    expect(after.status).toBe('cancelled');
    expect(JSON.stringify(after.log)).toMatch(/the parent replied/);
    expect((await ownerQ("select count(*)::int n from core.notifications where org_id = $1 and title like 'Missed call not returned%'", [org.orgId]))[0].n).toBe(0);
  });

  it('does not start the same workflow twice for one record, and test runs change nothing', async () => {
    const r = must(await lead({ studentName: 'Twice' }));
    await sys(async (db) => {
      await emit(db, 'missed_call', r.enquiryId);
      await emit(db, 'missed_call', r.enquiryId);
    });
    expect((await ownerQ("select count(*)::int n from crm.workflow_runs r join crm.workflows w on w.id = r.workflow_id where r.enquiry_id = $1 and w.recipe_key = 'missed_call'", [r.enquiryId]))[0].n).toBe(1);
    const wf = (await ownerQ("select id from crm.workflows where org_id = $1 and recipe_key = 'instant_welcome'", [org.orgId]))[0];
    const msgs = (await ownerQ('select count(*)::int n from crm.messages where org_id = $1', [org.orgId]))[0].n;
    const test = await sys((db) => testRun(db, wf.id, r.enquiryId));
    expect(test.status).toBe('tested');
    expect(JSON.stringify(test.log)).toMatch(/Would send/);
    expect((await ownerQ('select count(*)::int n from crm.messages where org_id = $1', [org.orgId]))[0].n).toBe(msgs);
  });
});

describe('admission', () => {
  it('ENR-01: confirm admission only when form, documents and fee are complete', async () => {
    const r = must(await lead({ studentName: 'Admit Me', dob: '2015-01-01' }));
    await sys(async (db) => {
      await startApplication(db, r.enquiryId, null);
      expect((await db.one('select application_no from crm.enquiries where id = $1', [r.enquiryId]))!.application_no).toMatch(/^APP-\d\d-\d{4}$/);
      const early = await saveApplication(db, r.enquiryId, { father_name: 'A' }, { submit: true, declaration: true }, null);
      expect(early.ok).toBe(false);
      const full = { mother_tongue: 'Hindi', medical: 'None', father_name: 'A', mother_name: 'B', address: '1 Road', pincode: '500001', transport: 'No' };
      expect((await saveApplication(db, r.enquiryId, full, { submit: true, declaration: true }, null)).ok).toBe(true);
      const not = await confirmAdmission(db, r.enquiryId, null);
      expect(not.ok).toBe(false);
      expect(not.error).toMatch(/Documents verified/);
      await db.q("update crm.enquiry_documents set status = 'verified' where enquiry_id = $1", [r.enquiryId]);
      const reg = await db.one("select id from crm.payments where enquiry_id = $1 and purpose = 'Registration fee'", [r.enquiryId]);
      const paid = await settlePayment(db, reg!.id, true, null);
      expect(paid!.receipt_no).toMatch(/^RCPT-\d{5}$/);
      const fee = await db.insert('crm.payments', { enquiry_id: r.enquiryId, purpose: 'Admission fee', amount: 25000 });
      await settlePayment(db, fee.id, true, null);
      const done = await confirmAdmission(db, r.enquiryId, null);
      expect(done.ok).toBe(true);
      expect(done.admission?.student_id).toBeTruthy(); // decision 38: the core student exists only now
      const e = await db.one('select s.is_won from crm.enquiries e join crm.stages s on s.id = e.stage_id where e.id = $1', [r.enquiryId]);
      expect(e!.is_won).toBe(true);
    });
    const stu = (await ownerQ("select s.status, s.first_name, s.crm_prospect_id from core.students s join crm.prospects p on p.core_student_id = s.id join crm.enquiries e on e.prospect_id = p.id where e.id = $1", [r.enquiryId]))[0];
    expect(stu).toMatchObject({ status: 'admitted', first_name: 'Admit' });
  });
});

describe('csv', () => {
  it('parses quoted fields, escaped quotes and CRLF', () => {
    expect(parseCsv('Student name,Mobile\r\n"Rao, Aarav",9876543210\n"He said ""hi""",1')).toEqual([['Student name', 'Mobile'], ['Rao, Aarav', '9876543210'], ['He said "hi"', '1']]);
  });
});

describe('message safeguards and team scope', () => {
  it('MSG-05: automated messages wait for quiet hours to end, and are capped per family per day', async () => {
    const h = hourIST();
    // the enquiry is created outside quiet hours so its own welcome message does not count here
    await sys((db) => db.q("update crm.settings set settings = settings || $2::jsonb where org_id = $1", [org.orgId, { quiet_hours: { from: (h + 10) % 24, to: (h + 11) % 24 } }]));
    const r = must(await lead({ studentName: 'Quiet Hours' }));
    await sys((db) => db.q("update crm.settings set settings = settings || $2::jsonb where org_id = $1", [org.orgId, { quiet_hours: { from: h, to: (h + 1) % 24 } }]));
    const held = await sys((db) => sendMessage(db, { householdId: r.householdId, enquiryId: r.enquiryId, channel: 'sms', body: 'Automated hello' }));
    expect(held.status).toBe('queued');
    expect((await ownerQ("select count(*)::int n from private.jobs where org_id = $1 and kind = 'send_message' and payload->>'householdId' = $2", [org.orgId, r.householdId]))[0].n).toBe(1);
    const manual = await sys((db) => sendMessage(db, { householdId: r.householdId, enquiryId: r.enquiryId, channel: 'sms', body: 'Hello from staff', actorId: users[0] }));
    expect(manual.status).toBe('delivered');
    await sys((db) => db.q("update crm.settings set settings = settings || $2::jsonb where org_id = $1", [org.orgId, { quiet_hours: { from: (h + 2) % 24, to: (h + 3) % 24 }, max_auto_per_day: 1 }]));
    const r2 = must(await lead({ studentName: 'Cap Check' }));
    await ownerQ('delete from crm.messages where household_id = $1', [r2.householdId]);
    expect((await sys((db) => sendMessage(db, { householdId: r2.householdId, enquiryId: r2.enquiryId, channel: 'sms', body: 'one' }))).status).toBe('delivered');
    const second = await sys((db) => sendMessage(db, { householdId: r2.householdId, enquiryId: r2.enquiryId, channel: 'sms', body: 'two' }));
    expect(second.status).toBe('failed');
    expect(second.reason).toMatch(/already got 1 automated/);
    await sys((db) => db.q("update crm.settings set settings = settings || $2::jsonb where org_id = $1", [org.orgId, { max_auto_per_day: 4 }]));
  });

  it('RB-02: someone limited to their own records also sees their team\'s (decided by the row policies, not by the query)', async () => {
    const outsider = await addStaff(org, 'Outsider', 'Counsellor', { branchIds: [branchId] });
    const e = must(await lead({ studentName: 'Outsider Lead' }));
    await ownerQ('update crm.enquiries set owner_id = $2 where id = $1', [e.enquiryId, outsider]);
    const seen = async (uid: string) => (await asUser(uid, org.orgId, (db) => db.q('select distinct owner_id from crm.enquiries'))).map((x) => x.owner_id).sort();
    // counsellor A (leads = O) sees only their own records
    expect(await seen(users[0]!)).toEqual([users[0]]);
    // B reports to A: A now sees B's records too, still not the outsider's; B does not see A's
    await ownerQ('update core.staff set reports_to = (select id from core.staff where user_id = $2) where user_id = $1', [users[1], users[0]]);
    expect(await seen(users[0]!)).toEqual([users[0], users[1]!].sort());
    expect(await seen(users[1]!)).toEqual([users[1]]);
    await ownerQ('update core.staff set reports_to = null where user_id = $1', [users[1]]);
    expect(await seen(users[0]!)).toEqual([users[0]]);
  });
});

describe('workflow conditions', () => {
  it('can test standard and custom fields', () => {
    const e = { grade: 'Grade 1', custom: { transport_required: 'Yes' } };
    expect(conditionsPass([{ field: 'custom.transport_required', op: 'in', value: ['Yes'] }], e)).toBe(true);
    expect(conditionsPass([{ field: 'custom.transport_required', op: 'ne', value: 'Yes' }], e)).toBe(false);
    expect(conditionsPass([{ field: 'grade', op: 'in', value: ['Grade 2', 'Grade 3'] }], e)).toBe(false);
  });
});
