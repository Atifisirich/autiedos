#!/usr/bin/env node
/**
 * Parent journey in a 390 px browser: phone-OTP sign-in, home, fees and the online payment order (mock provider), report card with QR
 * and the public verify page, PTM booking, early pickup request and code, messages, leave request, Hindi, offline copy.
 * Fails on page errors, console errors and 5xx. Screenshots go to apps/web/e2e/portal-shots (or SHOT_DIR).
 */
import pg from '../../../packages/server/node_modules/pg/lib/index.js';
import { BASE, launch, openAs, reporter, shot, text, world } from './portal-lib.mjs';

const R = reporter('portal parent');
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const q = async (sql, p = []) => (await db.query(sql, p)).rows;
const browser = await launch();

console.log('sign in with a phone number and a code');
{
  const { ctx, page, problems } = await openAs(browser, null);
  await page.goto(`${BASE}/erp/signin`);
  await shot(page, 'signin');
  await page.getByLabel('Mobile number or e-mail').fill('90000 00001');
  await page.getByRole('button', { name: 'Send code' }).click();
  await page.getByLabel('6-digit code').fill('123456');
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  await page.waitForURL(/\/erp\/parent$/);
  R.ok(true, 'phone OTP leads to the parent home');
  await ctx.close();
  const p2 = await openAs(browser, null);
  await p2.page.goto(`${BASE}/erp/signin`);
  await p2.page.getByLabel('Mobile number or e-mail').fill('other-parent@a.test');
  await p2.page.getByRole('button', { name: 'Use a password instead' }).click();
  await p2.page.getByLabel('Password').fill('wrong');
  await p2.page.getByRole('button', { name: 'Sign in' }).click();
  await p2.page.getByText('That did not work').waitFor();
  R.ok(true, 'a wrong password says "That did not work" and nothing else');
  await p2.page.getByLabel('Password').fill('portal-dev-pass');
  await p2.page.getByRole('button', { name: 'Sign in' }).click();
  await p2.page.waitForURL(/\/erp\/parent$/);
  R.ok(true, 'e-mail and password sign in works');
  R.problems([...problems, ...p2.problems.filter((p) => !/400/.test(p))]);
  await p2.ctx.close();
}

const { ctx, page, problems } = await openAs(browser, 'guardian@a.test');
const go = async (path, name) => { await page.goto(`${BASE}/erp/parent${path}`); await page.waitForLoadState('networkidle'); if (name) await shot(page, name); return text(page); };

console.log('home and branding');
let t = await go('', 'parent-home');
R.ok(t.includes('Greenfield Public School') && t.includes('Asha Rao'), 'school name and parent name in the header');
R.eq(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--pt-primary').trim()), '#0f766e', 'school colour applied');
R.ok(/Fees due/.test(t) && /₹3,000/.test(t), 'fees due ₹3,000 on home');
t = await go('/attendance', 'parent-attendance');
R.ok(/Attendance/.test(t) && /%/.test(t), 'attendance percentage');
t = await go('/academics', 'parent-academics');
R.ok(/Term 1/.test(t) && /Unit test 1/.test(t) && !/Unit test 2/.test(t), 'published marks only');

console.log('report card and verification');
await page.getByRole('link', { name: /Term 1/ }).first().click();
await page.getByTestId('verify-link').waitFor();
await shot(page, 'parent-report-card');
R.ok((await page.locator('svg[role=img]').count()) > 0, 'QR code drawn');
const href = await page.getByTestId('verify-link').getAttribute('href');
R.ok(/\/erp\/verify\/RC-/.test(href), `verify link ${href.slice(-24)}`);
const pub = await openAs(browser, null);
await pub.page.goto(href);
await pub.page.getByTestId('verify-valid').waitFor();
R.eq(await pub.page.getByTestId('verify-school').innerText(), 'Greenfield Public School', 'public verify page confirms the card without sign-in');
await shot(pub.page, 'verify');
await pub.page.goto(`${BASE}/erp/verify/RC-NOPE-0000000`);
await pub.page.getByText('No document found').waitFor();
R.ok(true, 'unknown code is reported as not found');
R.problems(pub.problems.filter((p) => !/404/.test(p)));
await pub.ctx.close();
R.eq((await q(`select views from erp.report_cards where student_id = $1 and status = 'published'`, [world.learnerA]))[0].views >= 1, true, 'the family view was counted (open_report_card)');

console.log('fees: online payment order with the mock provider');
await go('/fees', 'parent-fees');
const before = (await q(`select count(*)::int n from erp.payment_orders where student_id = $1`, [world.learnerA]))[0].n;
const receiptsBefore = (await q(`select count(*)::int n from erp.receipts where student_id = $1`, [world.learnerA]))[0].n;
await page.getByRole('checkbox').first().check();
await page.getByRole('button', { name: /^Pay ₹/ }).click();
await page.waitForURL(/\/fees\/pay\//);
await page.getByTestId('order-amount').waitFor();
await shot(page, 'parent-pay');
const orderId = page.url().split('/').pop();
const [o] = await q(`select amount, status, allocations from erp.payment_orders where id = $1`, [orderId]);
R.ok(Number(o.amount) === 3000 && o.status === 'created' && !!o.allocations[0].demand_id, 'order created through erp.create_payment_order for the open ₹3,000');
R.ok((await q(`select count(*)::int n from erp.payment_orders where student_id = $1`, [world.learnerA]))[0].n === before + 1, 'one new order');
await page.getByRole('button', { name: /Pay \(simulate success\)/ }).click();
await page.getByText('Payment received').first().waitFor();
const [paid] = await q(`select o.status, o.receipt_id, d.paid, d.status as dstatus from erp.payment_orders o join erp.fee_demands d on d.id = $2 where o.id = $1`, [orderId, world.erpA.dLearner2]);
R.ok(paid.status === 'paid' && paid.receipt_id && Number(paid.paid) === 3000 && paid.dstatus === 'paid', 'settled by the server: receipt posted, fee paid');
R.ok((await q(`select count(*)::int n from erp.receipts where student_id = $1`, [world.learnerA]))[0].n === receiptsBefore + 1, 'receipt visible in the database');
t = await go('/fees');
R.ok(/Receipt RCPT/.test(t) && !/Select all dues/.test(t), 'receipts list updated; nothing left to pay');

console.log('PTM booking');
await go('/ptm', 'parent-ptm');
const slots = await page.getByTestId('ptm-open').getByRole('button', { name: 'Book this slot' }).count();
R.ok(slots >= 1, `${slots} open slot(s) offered; the other family's booked slot is not`);
await page.getByTestId('ptm-open').getByRole('button', { name: 'Book this slot' }).first().click();
await page.getByText('Booked. See you then.').waitFor();
await page.getByTestId('ptm-mine').waitFor();
R.eq((await q(`select count(*)::int n from erp.ptm_slots where student_id = $1 and status = 'booked'`, [world.learnerA]))[0].n, 1, 'slot booked for the child through erp.book_ptm_slot');
await shot(page, 'parent-ptm-booked');

console.log('early pickup');
await go('/pickup');
await page.getByLabel('Reason').fill('Dentist appointment');
await page.getByLabel('Name of the person').fill('Uncle Ravi');
await page.getByRole('button', { name: 'Send request' }).click();
await page.getByText('Request sent to the class teacher').waitFor();
const [gp] = await q(`select g.status, a.status as astatus, a.linked_type from erp.gate_passes g join core.approval_requests a on a.linked_id = g.id where g.reason = 'Dentist appointment'`);
R.ok(gp?.status === 'requested' && gp.astatus === 'pending' && gp.linked_type === 'gate_pass', 'pass requested with its approval request');
await page.getByRole('button', { name: 'Show pickup code' }).first().click();
await page.getByTestId('pickup-otp').waitFor();
R.eq(await page.getByTestId('pickup-otp').innerText(), '123456', 'approved pass shows its code (only to the family)');
await shot(page, 'parent-pickup');

console.log('messages and leave');
await go('/messages');
await page.getByRole('button', { name: 'New message' }).click();
await page.getByLabel('Subject').fill('Doubt in maths');
await page.getByLabel('Message', { exact: true }).fill('Please explain chapter 4.');
await page.getByRole('button', { name: 'Send message' }).click();
await page.waitForURL(/messages\/[0-9a-f-]{36}/);
await page.getByRole('list', { name: 'Doubt in maths' }).getByText('Please explain chapter 4.').waitFor();
R.eq((await q(`select count(*)::int n from erp.conversation_messages where body = 'Please explain chapter 4.'`))[0].n, 1, 'two-way message stored');
await shot(page, 'parent-thread');
await go('/requests');
await page.getByLabel('Reason', { exact: true }).first().fill('Fever');
await page.getByRole('button', { name: 'Send leave request' }).click();
await page.getByText('Leave request sent').waitFor();
R.eq((await q(`select status from core.student_leave_requests where reason = 'Fever'`))[0]?.status, 'pending', 'leave request pending for the class teacher');
await shot(page, 'parent-requests');
await go('/bus', 'parent-bus');
await go('/forms');
await go('/calendar', 'parent-calendar');

console.log('language and offline');
await go('/more');
await page.getByLabel(/Hindi/).check();
R.ok((await text(page)).includes('होम'), 'Hindi labels');
await shot(page, 'parent-hindi');
await page.getByLabel('English').check();
await go('/fees');
await ctx.setOffline(true);
await page.getByRole('link', { name: 'Academics' }).click();
await page.getByText(/No connection/).waitFor({ timeout: 15000 });
await page.getByText('Term 1').first().waitFor();
R.ok(true, 'offline: the last saved report-card list is shown with "No connection"');
await shot(page, 'parent-offline');
await ctx.setOffline(false);

R.problems(problems.filter((p) => !/ERR_INTERNET_DISCONNECTED|Failed to fetch/.test(p)));
await ctx.close();
await browser.close();
await db.end();
R.done();
