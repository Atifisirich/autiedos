#!/usr/bin/env node
/**
 * Builds the isolation-harness world (packages/server/test-platform/fixture.ts: org A, org B, parents, a student, a driver,
 * rows in every erp table) in the database named by DATABASE_URL, adds the portal rows the screens need (attendance marks,
 * homework, calendar, branding, phones, a live online test with questions) and writes the ids to PORTAL_WORLD_FILE.
 *
 *   DATABASE_URL=postgres://postgres@localhost:54322/portal node --import tsx apps/web/e2e/portal-world.mjs
 *
 * The database is emptied first (platform migrations only), so use your own database.
 */
import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import { execSync } from 'node:child_process';
import { join } from 'node:path';

const root = join(new URL('.', import.meta.url).pathname, '..', '..', '..');
// An empty platform first (the harness would do this itself, but its CommonJS __dirname does not work from an ES module).
execSync(`node ${join(root, 'scripts/db.mjs')} reset --platform-only`, { stdio: 'ignore', env: process.env });
const out = process.env.PORTAL_WORLD_FILE ?? new URL('./.portal-world.json', import.meta.url).pathname;
const { buildWorld } = await import('../../../packages/server/test-platform/fixture.ts');
const { owner } = await import('../../../packages/server/test-platform/helpers.ts');

const w = await buildWorld();
const q = (sql, params = []) => owner.query(sql, params);
const one = async (sql, params = []) => (await q(sql, params)).rows[0]?.id;

const day = (offset) => {
  const d = new Date(Date.now() + offset * 86400000);
  return d.toISOString().slice(0, 10);
};

// ---------------------------------------------------------------- phones (the dev auth shim maps phone -> user), branding
await q(`update auth.users set phone = '919000000001' where id = $1`, [w.u.aGuardian]);
await q(`update auth.users set phone = '919000000002' where id = $1`, [w.u.aOtherParent]);
await q(`update auth.users set phone = '919000000003' where id = $1`, [w.u.bGuardian]);
await q(`update core.organizations set name = 'Greenfield Public School', branding = $2::jsonb where id = $1`,
  [w.A.id, JSON.stringify({ primary: '#0f766e', accent: '#f59e0b', tagline: 'Learning with care' })]);
await q(`update core.organizations set name = 'Riverdale Academy', branding = $2::jsonb where id = $1`,
  [w.B.id, JSON.stringify({ primary: '#7c3aed', accent: '#ec4899' })]);
await q(`update core.org_users set display_name = 'Asha Rao' where user_id = $1`, [w.u.aGuardian]);
await q(`update core.org_users set display_name = 'Vikram Shah' where user_id = $1`, [w.u.aOtherParent]);
await q(`update core.org_users set display_name = 'Ravi Kumar' where user_id = $1`, [w.u.aStudent]);

// ---------------------------------------------------------------- per-org portal rows
async function extras(O, core, erp, guardianUser) {
  const org = O.id;
  const branch = Object.values(O.branches)[0];
  // attendance: the last 12 school days for the learner and the other child
  for (let i = 1; i <= 12; i++) {
    const date = day(-i);
    const sess = await one(`insert into core.student_attendance_sessions (org_id, section_id, date, status) values ($1, $2, $3, 'submitted')
                            on conflict (org_id, section_id, date, session_key) do update set status = 'submitted' returning id`, [org, core.section, date]);
    for (const [sid, st] of [[core.learner, i % 5 === 0 ? 'absent' : i % 7 === 0 ? 'late' : 'present'], [core.other, 'present']]) {
      await q(`insert into core.student_attendance_marks (org_id, session_id, student_id, date, session_key, status, source)
               values ($1, $2, $3, $4, 'day', $5, 'teacher') on conflict do nothing`, [org, sess, sid, date, st]);
    }
  }
  // homework for the section and a note for the learner
  await q(`insert into core.class_posts (org_id, type, section_id, subject_id, title, body, due_date, status, allow_submission, published_at)
           values ($1, 'homework', $2, $3, 'Chapter 4 exercises', 'Solve questions 1 to 10.', $4, 'published', true, now())`,
    [org, core.section, core.subj, day(2)]);
  await q(`insert into core.calendar_events (org_id, branch_id, layer, title, starts_on, audience) values ($1, $2, 'event', 'Annual day', $3, 'all')`, [org, branch, day(10)]);
  // org-level helpers
  return { org };
}
await extras(w.A, w.coreA, w.erpA, w.u.aGuardian);
await extras(w.B, w.coreB, w.erpB, w.u.bGuardian);

// ---------------------------------------------------------------- live online test with real questions (org A)
const qs = [];
for (const [text, opts, ans] of [['2 + 2 = ?', ['3', '4', '5'], '4'], ['Capital of India?', ['Delhi', 'Mumbai'], 'Delhi']]) {
  const id = randomUUID();
  await q(`insert into core.question_bank (id, org_id, subject_id, content, marks, status, bloom) values ($1, $2, $3, $4::jsonb, 1, 'approved', 'remember')`,
    [id, w.A.id, w.coreA.subj, JSON.stringify({ text, type: 'mcq', options: opts, answer: ans })]);
  qs.push(id);
}
await q(`update erp.online_tests set question_ids = $2::jsonb, duration_min = 10 where id = $1`, [w.erpA.live, JSON.stringify(qs)]);
// the fixture's "attempt" rows would block a fresh submission: remove them for the learner so the test can be taken
await q(`delete from erp.test_attempts where test_id = $1`, [w.erpA.live]);

const ids = {
  orgA: w.A.id, orgB: w.B.id, learnerA: w.coreA.learner, otherA: w.coreA.other, learnerB: w.coreB.learner,
  sectionA: w.coreA.section, users: w.u, erpA: w.erpA, erpB: w.erpB, driverUser: w.erpA.users.driver, accountsUser: w.erpA.users.accounts,
  questionIds: qs,
};
writeFileSync(out, JSON.stringify(ids, null, 1));
console.log(`portal world written to ${out}`);
await owner.end();
