#!/usr/bin/env node
/** Student portal: sees only self; homework, results; an online test with tab-switch logging, scored in the database. */
import pg from '../../../packages/server/node_modules/pg/lib/index.js';
import { BASE, launch, openAs, reporter, shot, text, world } from './portal-lib.mjs';

const R = reporter('portal student');
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const q = async (sql, p = []) => (await db.query(sql, p)).rows;
const browser = await launch();
const { ctx, page, problems } = await openAs(browser, 'student@a.test');
const otherName = (await q(`select full_name from core.students where id = $1`, [world.otherA]))[0].full_name;

await page.goto(`${BASE}/erp/student`);
await page.waitForLoadState('networkidle');
await shot(page, 'student-home');
R.ok(!(await text(page)).includes(otherName), 'home: only the student');
await page.goto(`${BASE}/erp/student/results`);
await page.waitForLoadState('networkidle');
R.ok(/Unit test 1/.test(await text(page)), 'results: published marks');
await shot(page, 'student-results');
await page.goto(`${BASE}/erp/student/homework`);
await page.waitForLoadState('networkidle');
R.ok(/Chapter 4 exercises/.test(await text(page)), 'homework listed');

console.log('online test with tab-switch logging');
await page.goto(`${BASE}/erp/student/tests`);
await page.getByRole('link', { name: 'Start test' }).click();
await page.getByRole('button', { name: 'Start test' }).click();
await shot(page, 'student-test');
// leave the page twice: hidden, then visible again
for (let i = 0; i < 2; i++) {
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
}
await page.getByTestId('switches').waitFor();
await page.getByLabel('4', { exact: true }).check();
await page.getByLabel('Delhi').check();
page.once('dialog', (d) => d.accept());
await page.getByRole('button', { name: 'Submit test' }).click();
await page.getByTestId('test-score').waitFor();
R.eq(await page.getByTestId('test-score').innerText(), 'You scored 2 out of 2.', 'scored by erp.submit_test');
const [a] = await q(`select score, max_score, tab_switches, submitted_at from erp.test_attempts where test_id = $1 and student_id = $2`, [world.erpA.live, world.learnerA]);
R.ok(Number(a.score) === 2 && a.tab_switches === 2 && a.submitted_at, `attempt stored with ${a?.tab_switches} tab switches logged`);
await shot(page, 'student-test-done');
await page.goto(`${BASE}/erp/student/tests`);
await page.waitForLoadState('networkidle');
R.ok(/Submitted/.test(await text(page)) && !(await page.getByRole('link', { name: 'Start test' }).count()), 'a submitted test cannot be started again');

R.problems(problems);
await ctx.close();
await browser.close();
await db.end();
R.done();
