/**
 * Demo school for the browser checks (and for looking around): `Greenfield Demo School` with two branches, a starter pack,
 * five people with different roles and about forty enquiries across the pipeline.
 *
 *   DATABASE_URL=postgres://postgres@localhost:54322/crmui CRM_DATABASE_URL=postgres://crm_server@localhost:54322/crmui tsx e2e/crm-seed.mts
 *
 * Setup is written as the table owner (DATABASE_URL), like a migration; every enquiry goes through the CRM's own capture code
 * as the school's automation user, so the demo data is what the product would have produced. Re-running replaces the school.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { asSystem, closePools } from '../../../packages/crm-server/src/db';
import { addTask, captureEnquiry, changeStage, logActivity, receiveMessage, stageByName } from '../../../packages/crm-server/src/core';
import { roleKey, seedStarterPack } from '../../../packages/crm-server/src/provision';

const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres@localhost:54322/crmui', max: 3 });
const slug = 'greenfield-demo';

async function main() {
  await owner.query('delete from core.organizations where slug = $1', [slug]);
  const orgId = randomUUID();
  await owner.query(`insert into core.organizations (id, name, slug, kind) values ($1, 'Greenfield Demo School', $2, 'school')`, [orgId, slug]);
  const main = randomUUID(), north = randomUUID();
  for (const [id, name, code] of [[main, 'Main campus', 'GFMAIN'], [north, 'North campus', 'GFNORTH']] as const) {
    await owner.query(`insert into core.branches (id, org_id, name, code, state_code, city) values ($1, $2, $3, $4, '36', 'Hyderabad')`, [id, orgId, name, code]);
  }
  await owner.query(`insert into core.subscriptions (org_id, product_key, status, plan_key) values ($1, 'crm', 'active', 'crm_monthly')`, [orgId]);
  const { roles } = await seedStarterPack(orgId, { branchId: main, pack: 'cbse_day', formSlug: 'greenfield-enquiry', wallet: 2000 });
  await owner.query(`update crm.settings set settings = settings || '{"brand_color":"#0f6e6e","privacy_notice":"We use these details only to respond to your admission enquiry."}'::jsonb where org_id = $1`, [orgId]);

  const people: [string, string, string, string[]][] = [
    ['Aisha Admin', 'admin@demo.test', 'Group Admin', []],
    ['Meera Counsellor', 'meera@demo.test', 'Counsellor', [main]],
    ['Rahul Counsellor', 'rahul@demo.test', 'Counsellor', [main, north]],
    ['Divya Desk', 'desk@demo.test', 'Front Office', [main]],
    ['Anil Accounts', 'accounts@demo.test', 'Accounts', []],
  ];
  const ids: Record<string, string> = {};
  for (const [name, email, role, branches] of people) {
    const uid = randomUUID();
    ids[email] = uid;
    const home = branches[0] ?? null;
    await owner.query('insert into auth.users (id, email) values ($1, $2)', [uid, email]);
    await owner.query(`insert into core.org_users (org_id, user_id, kind, display_name, home_branch_id) values ($1, $2, 'staff', $3, $4)`, [orgId, uid, name, home]);
    for (const b of branches.slice(1)) await owner.query('insert into core.user_branch_access (org_id, user_id, branch_id) values ($1, $2, $3)', [orgId, uid, b]);
    const [first, ...rest] = name.split(' ');
    await owner.query(`insert into core.staff (org_id, branch_id, user_id, first_name, last_name, email, status, staff_type) values ($1, $2, $3, $4, $5, $6, 'active', 'admin')`, [orgId, home, uid, first, rest.join(' '), email]);
    await owner.query(`insert into core.user_product_access (org_id, user_id, product_key, role_key) values ($1, $2, 'crm', $3)`, [orgId, uid, roles[role] ?? roleKey(role)]);
    await owner.query('insert into crm.counsellor_settings (org_id, user_id, daily_capacity) values ($1, $2, 25)', [orgId, uid]);
  }
  // routing: the two counsellors take turns
  await owner.query('delete from crm.assignment_rules where org_id = $1', [orgId]);
  await owner.query(`insert into crm.assignment_rules (org_id, name, seq, method, user_ids) values ($1, 'Counsellors, round robin', 1, 'round_robin', $2::jsonb)`, [orgId, JSON.stringify([ids['meera@demo.test'], ids['rahul@demo.test']])]);
  // a sensitive custom field and a dropdown one
  await owner.query(`insert into core.custom_fields (org_id, product_key, entity, key, label, field_type, options, seq) values
    ($1, 'crm', 'enquiry', 'transport_required', 'Transport required', 'select', '["Yes","No","Not sure"]', 1),
    ($1, 'crm', 'enquiry', 'family_income_band', 'Family income band', 'select', '["Under 5L","5-10L","Over 10L"]', 2)`, [orgId]);
  await owner.query(`insert into crm.field_settings (org_id, entity, key, sensitive) values ($1, 'enquiry', 'family_income_band', true)`, [orgId]);

  const first = ['Aarav', 'Diya', 'Kabir', 'Anaya', 'Vihaan', 'Ishita', 'Reyansh', 'Myra', 'Arjun', 'Saanvi', 'Krish', 'Navya', 'Rohan', 'Tara', 'Ayaan', 'Kiara', 'Dev', 'Zara', 'Neel', 'Pari'];
  const last = ['Reddy', 'Sharma', 'Khan', 'Rao', 'Iyer', 'Gupta', 'Nair', 'Das', 'Mehta', 'Verma'];
  const grades = ['Nursery', 'LKG', 'UKG', 'Grade 1', 'Grade 2', 'Grade 3', 'Grade 4', 'Grade 5'];
  const stagesToReach = ['New', 'New', 'Contact attempted', 'Connected', 'Interested', 'Visit scheduled', 'Visit done', 'Form started', 'Form submitted', 'Fee paid', 'Not interested'];
  let m = 9100000000;
  await asSystem(orgId, async (db) => {
    const src = await db.q('select id from crm.sources where org_id = $1 order by channel, name', [orgId]);
    for (let i = 0; i < 40; i++) {
      const student = `${first[i % first.length]} ${last[(i * 3) % last.length]}`;
      const res = await captureEnquiry(db, {
        studentName: student, guardianName: `${first[(i + 7) % first.length]} ${last[(i * 3) % last.length]}`, mobile: String(++m + (i % 7) * 11), branchId: i % 4 === 3 ? north : main, grade: grades[i % grades.length],
        sourceId: src[i % src.length]!.id, channel: 'Direct', source: 'Seed', consent: { source: 'Seed' }, custom: i % 3 === 0 ? { transport_required: 'Yes' } : {},
      });
      if (!res.ok) continue;
      const to = stagesToReach[i % stagesToReach.length]!;
      if (to !== 'New') {
        const st = await stageByName(db, to);
        if (st) await changeStage(db, res.enquiryId, st.id, null, { closure_reason: 'Fee too high' });
      }
      if (i % 5 === 0) await logActivity(db, { householdId: res.householdId, enquiryId: res.enquiryId, type: 'call', outcome: 'connected', content: 'Spoke to the parent. Wants a campus visit.', actorId: ids['meera@demo.test']! });
      if (i % 6 === 1) await receiveMessage(db, res.householdId, 'whatsapp', 'Hello, what are the fees for next year?');
      if (i % 7 === 2) await addTask(db, { enquiryId: res.enquiryId, title: 'Send the fee structure', dueAt: new Date(Date.now() - 3 * 3600e3) });
    }
  });
  await owner.query('analyze');
  console.log(`seeded ${slug}: sign in as ${Object.keys(ids).join(', ')} (email only, AUTH_PROVIDER=dev)`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePools();
    await owner.end();
  });
