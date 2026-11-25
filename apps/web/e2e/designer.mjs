#!/usr/bin/env node
/**
 * Browser test of the AI school designer (DECISIONS 56-59, docs/designer.md) on a production build with
 * AUTH_PROVIDER=dev NEXT_PUBLIC_AUTH_PROVIDER=dev, the seeded demo school and the mock AI (no GEMINI_API_KEY):
 *  1. chairman@demo.school signs in, finds the designer from the landing page, types the teacher-absence example,
 *     sees the plain-language preview (approval steps, who is affected, parents reached), tries it on sample data,
 *     publishes it, and sees the new approval type in OS settings (/os/approvals/types);
 *  2. undoes it from the history tab and the approval type is gone again;
 *  3. "Explain my school" and the template gallery render; the ERP example comes back as "not possible yet";
 *  4. Hindi and Telugu screens show no raw i18n keys; at phone width (375 px) nothing scrolls sideways;
 *  5. a teacher is refused politely;
 *  6. CRM school (admin@demo.test, CRM only): only CRM / register examples; "new enquiry follow-up within 24h else escalate
 *     to admission head" is previewed, published (CRM settings and the escalation workflow change, CRM Admin > Workflows
 *     shows it) and undone;
 *  7. ERP school (admin@erp.demo.school): "fee concession above 10% needs director approval" becomes an ERP approval rule,
 *     undone; a custom register ("make a hostel visitor log ... approved by warden") is published, appears in /records,
 *     and undo removes it;
 *  8. no page errors, console errors or HTTP 5xx anywhere.
 * Needs the OS demo (pnpm db:reset) plus the CRM and ERP demo schools in the same database (docs/staging.md):
 *   ERP_DEMO_DOMAIN=erp.demo.school node scripts/seed-erp-demo.mjs; (cd apps/web && CRM_DATABASE_URL=... npx tsx e2e/crm-seed.mts)
 * Runs against `next dev` (a production build refuses the mock AI). With DATABASE_URL set it also checks the tables.
 * Usage: BASE_URL=http://localhost:4321 CHROMIUM_PATH=/opt/pw-browsers/chromium-1243/chrome-linux64/chrome [DATABASE_URL=...] node apps/web/e2e/designer.mjs
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const BASE = process.env.BASE_URL ?? 'http://localhost:3921';
const SHOTS = process.env.SHOTS_DIR ?? '/tmp/claude-0';
const CHAIRMAN = 'chairman@demo.school';
const TEACHER = 'deepa.teacher9@demo.school';
const ABSENCE_NAME = 'Teacher absence over 2 days';

const problems = [];
const passed = [];
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});

async function context(label, opts = {}) {
  const ctx = await browser.newContext(opts.viewport ? { viewport: opts.viewport } : {});
  await ctx.addInitScript((l) => localStorage.setItem('os_lang', l), opts.lang ?? 'en');
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort()); // hermetic
  const page = await ctx.newPage();
  const state = { where: '' };
  page.on('pageerror', (e) => problems.push(`${label} ${state.where}: page error ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && problems.push(`${label} ${state.where}: console ${m.text().slice(0, 200)}`));
  page.on('response', (r) => r.status() >= 500 && problems.push(`${label} ${state.where}: ${r.status()} ${r.url()}`));
  const go = async (path) => {
    state.where = path;
    await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
  };
  return { ctx, page, go, state };
}
const check = (cond, msg) => (cond ? passed.push(msg) : problems.push(`FAILED: ${msg}`));
async function signIn(page, go, email) {
  await go('/login');
  await page.fill('input[name=identity]', email);
  await Promise.all([page.waitForURL(`${BASE}/`), page.click('button:not([type=button])')]);
  await page.waitForSelector('[data-testid=product-list]');
}
async function untranslated(page, label) {
  const raw = await page.evaluate(() => [...document.body.innerText.matchAll(/\b(designer|shell|common|error)\.[a-z][A-Za-z_.]+\b/g)].map((m) => m[0]));
  check(!raw.length, `${label}: no raw i18n keys${raw.length ? ` (found ${[...new Set(raw)].slice(0, 5).join(', ')})` : ''}`);
}
async function noSideScroll(page, label) {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(over <= 1, `${label}: no horizontal scroll at phone width (overflow ${over}px)`);
}

// ---------------------------------------------------------------- 1-3. chairman: plan, preview, sample run, publish, undo
{
  const { ctx, page, go, state } = await context('chairman');
  await signIn(page, go, CHAIRMAN);
  await page.waitForSelector('[data-testid=designer-link]');
  check(true, 'landing shows the designer link to management');
  state.where = '/designer';
  await Promise.all([page.waitForURL(`${BASE}/designer`), page.click('[data-testid=designer-link]')]);
  await page.waitForSelector('textarea[name=prompt]');
  // the first example chip is the teacher-absence request
  await page.click('form button[type=button] >> nth=0');
  const prompt = await page.inputValue('textarea[name=prompt]');
  check(/absent more than 2 days/i.test(prompt), 'example chip fills the absence request');
  await page.click('[data-testid=designer-send]');
  const card = page.locator('[data-testid=plan-card]').last();
  await card.waitFor();
  await page.waitForSelector('[data-testid=plan-card][data-status=validated]', { timeout: 30000 });
  const text = await card.innerText();
  check(text.includes(ABSENCE_NAME), 'preview names the new approval type');
  check(/academic_coordinator approves when days > 2/.test(text), 'preview explains the coordinator step in plain words');
  check(/principal approves when exam_week = yes/.test(text), 'preview explains the exam-week principal step');
  check(/Affects \d+ staff/.test(text), 'preview says who is affected');
  check(/families/.test(text), 'preview says parents are reached');
  await page.screenshot({ path: `${SHOTS}/designer-preview.png`, fullPage: true });

  await card.getByRole('button', { name: 'Try on sample data' }).click();
  await card.locator('[data-testid=dry-run]').waitFor();
  check((await card.locator('[data-testid=dry-run]').innerText()).includes('academic_coordinator → principal'), 'sample run shows the approval chain');

  await card.getByRole('button', { name: 'Publish' }).click();
  await page.waitForSelector('[data-testid=plan-card][data-status=published]');
  check((await card.locator('[data-testid=plan-notice]').innerText()).includes('Published as version'), 'publish confirms the version');
  await page.screenshot({ path: `${SHOTS}/designer-published.png`, fullPage: true });

  await go('/os/approvals/types');
  await page.waitForSelector(`text=${ABSENCE_NAME}`);
  check(true, 'the new approval type is in OS settings');
  await page.screenshot({ path: `${SHOTS}/designer-os-settings.png`, fullPage: true });

  // undo from the history tab
  await go('/designer');
  await page.getByRole('tab', { name: 'History' }).click();
  const row = page.locator('[data-testid=history-row][data-status=published]').first();
  await row.waitFor();
  await row.getByRole('button', { name: 'Open' }).click();
  const opened = page.locator('[data-testid=plan-card]');
  await opened.getByRole('button', { name: 'Undo' }).click();
  await page.waitForSelector('[data-testid=plan-card][data-status=reverted]');
  check(true, 'undo from history');
  await go('/os/approvals/types');
  await page.waitForSelector('text=Purchase'); // the list has loaded
  check((await page.locator(`text=${ABSENCE_NAME}`).count()) === 0, 'after undo the approval type is gone from OS settings');

  // explain, templates, an ERP request
  await go('/designer');
  await page.getByRole('tab', { name: 'My school' }).click();
  await page.waitForSelector('[data-testid=explain] li');
  check((await page.locator('[data-testid=explain]').innerText()).includes('Demo International School'), 'explain my school summarises the school');
  await page.getByRole('tab', { name: 'Templates' }).click();
  await page.waitForSelector('[data-testid=template]');
  check((await page.locator('[data-testid=template]').count()) === 6, 'template gallery lists the six starter templates');
  await page.getByRole('tab', { name: 'Design' }).click();
  await page.fill('textarea[name=prompt]', 'Fee concession above 10% needs director approval');
  await page.click('[data-testid=designer-send]');
  await page.waitForSelector('[data-testid=plan-unsupported]');
  check(true, 'an ERP request of an OS-only school is answered as "not part of your plan"');
  await untranslated(page, 'chairman /designer en');
  await ctx.close();
}

// ---------------------------------------------------------------- 6-7. CRM and ERP schools, a custom register
const pool = process.env.DATABASE_URL ? new (require('pg').Pool)({ connectionString: process.env.DATABASE_URL, max: 2 }) : null;
const sql = async (text, params = []) => (pool ? (await pool.query(text, params)).rows : null);
/** Types a request, waits for a validated plan and returns its card. */
async function planIt(page, prompt) {
  await page.fill('textarea[name=prompt]', prompt);
  await page.click('[data-testid=designer-send]');
  await page.waitForSelector('[data-testid=plan-card][data-status=validated]', { timeout: 30000 });
  return page.locator('[data-testid=plan-card]').last();
}
async function publishAndUndo(page, card, between) {
  await card.getByRole('button', { name: 'Publish' }).click();
  await page.waitForSelector('[data-testid=plan-card][data-status=published]');
  await between();
}
{
  const { ctx, page, go, state } = await context('crm-admin');
  await signIn(page, go, 'admin@demo.test');
  await page.waitForSelector('[data-testid=designer-link]');
  check(true, 'CRM-only management sees the designer link');
  await go('/designer');
  await page.waitForSelector('textarea[name=prompt]');
  const chips = await page.locator('form button[type=button]').allInnerTexts();
  check(chips.some((c) => /follow-up within 24h/i.test(c)) && chips.some((c) => /hostel visitor log/i.test(c)) && !chips.some((c) => /concession|absent more than/i.test(c)), 'a CRM school is offered CRM and register examples only');
  const before = (await sql(`select s.settings->>'first_response_mins' as m from crm.settings s join core.organizations o on o.id = s.org_id where o.slug = 'greenfield-demo'`))?.[0]?.m;
  await page.click('form button[type=button]:has-text("follow-up within 24h")');
  await page.click('[data-testid=designer-send]');
  await page.waitForSelector('[data-testid=plan-card][data-status=validated]', { timeout: 30000 });
  const card = page.locator('[data-testid=plan-card]').last();
  const text = await card.innerText();
  check(/first response within 24 h/.test(text), 'CRM preview: every new enquiry needs a first response within 24 hours');
  check(/Alert admission_head/.test(text), 'CRM preview: the admission head is alerted when it is missed');
  check(/Stops when the parent replies/.test(text), 'CRM preview: stop rules in plain words');
  await page.screenshot({ path: `${SHOTS}/designer-crm-preview.png`, fullPage: true });
  await card.getByRole('button', { name: 'Try on sample data' }).click();
  await card.locator('[data-testid=dry-run]').waitFor();
  await publishAndUndo(page, card, async () => {
    if (pool) check((await sql(`select s.settings->>'first_response_mins' as m from crm.settings s join core.organizations o on o.id = s.org_id where o.slug = 'greenfield-demo'`))[0].m === '1440', 'CRM settings changed: first response within 1440 minutes');
    if (pool) check((await sql(`select w.steps::text as s from crm.workflows w join core.organizations o on o.id = w.org_id where o.slug = 'greenfield-demo' and w.recipe_key = 'untouched'`))[0].s.includes('admission_head'), 'the CRM escalation workflow names the admission head');
    await go('/crm/admin/workflows');
    await page.waitForSelector('text=Untouched escalation');
    check(true, 'the workflow is listed in CRM Admin > Workflows');
    await page.screenshot({ path: `${SHOTS}/designer-crm-admin.png`, fullPage: true });
  });
  await go('/designer');
  await page.getByRole('tab', { name: 'History' }).click();
  const row = page.locator('[data-testid=history-row][data-status=published]').first();
  await row.waitFor();
  await row.getByRole('button', { name: 'Open' }).click();
  await page.locator('[data-testid=plan-card]').getByRole('button', { name: 'Undo' }).click();
  await page.waitForSelector('[data-testid=plan-card][data-status=reverted]');
  if (pool) check((await sql(`select s.settings->>'first_response_mins' as m from crm.settings s join core.organizations o on o.id = s.org_id where o.slug = 'greenfield-demo'`))[0].m === before, 'after undo the CRM response time is back');
  check(true, 'CRM change undone from history');
  await page.getByRole('tab', { name: 'My school' }).click();
  await page.waitForSelector('[data-testid=explain] li');
  check(/CRM: \d+ pipeline stages/.test(await page.locator('[data-testid=explain]').innerText()), 'explain my school covers the CRM');
  await untranslated(page, 'crm /designer en');
  state.where = '';
  await ctx.close();
}
{
  const { ctx, page, go } = await context('erp-admin');
  await signIn(page, go, 'admin@erp.demo.school');
  await go('/designer');
  await page.waitForSelector('textarea[name=prompt]');
  const card = await planIt(page, 'Fee concession above 10% needs director approval');
  const text = await card.innerText();
  check(/concession requests are approved by: group_admin/.test(text), 'ERP preview: concessions above 10% go to the group admin (director)');
  check(/above 10%/.test(text), 'ERP preview names the 10% threshold');
  await page.screenshot({ path: `${SHOTS}/designer-erp-preview.png`, fullPage: true });
  await publishAndUndo(page, card, async () => {
    if (pool) check((await sql(`select r.min_percent::text as p from erp.approval_rules r join core.organizations o on o.id = r.org_id where o.slug = 'demo-school' and r.key = 'concession_above_10' and r.deleted_at is null`))[0]?.p === '10.00', 'the ERP approval rule is live');
  });
  await card.getByRole('button', { name: 'Undo' }).click();
  await page.waitForSelector('[data-testid=plan-card][data-status=reverted]');
  if (pool) check((await sql(`select 1 from erp.approval_rules r join core.organizations o on o.id = r.org_id where o.slug = 'demo-school' and r.key = 'concession_above_10' and r.deleted_at is null`)).length === 0, 'after undo the ERP approval rule is gone');
  check(true, 'ERP change undone');

  // a custom register through the designer (the custom records engine)
  const reg = await planIt(page, 'Make a hostel visitor log with visitor name, student, time in/out, approved by warden');
  const rtext = await reg.innerText();
  check(/Visitor name \(text, required\)/.test(rtext) && /needs approval by erp:warden/.test(rtext), 'register preview: fields and the warden approval');
  await page.screenshot({ path: `${SHOTS}/designer-register-preview.png`, fullPage: true });
  await publishAndUndo(page, reg, async () => {
    await go('/records');
    await page.waitForSelector('text=Hostel visitor log');
    check(true, 'the new register is listed in /records');
    await page.screenshot({ path: `${SHOTS}/designer-register-records.png`, fullPage: true });
  });
  await go('/designer');
  await page.getByRole('tab', { name: 'History' }).click();
  const row = page.locator('[data-testid=history-row][data-status=published]').first();
  await row.waitFor();
  await row.getByRole('button', { name: 'Open' }).click();
  await page.locator('[data-testid=plan-card]').getByRole('button', { name: 'Undo' }).click();
  await page.waitForSelector('[data-testid=plan-card][data-status=reverted]');
  await go('/records');
  await page.waitForLoadState('networkidle');
  check((await page.locator('text=Hostel visitor log').count()) === 0, 'after undo the register is gone from /records');
  await go('/designer');
  await page.getByRole('tab', { name: 'My school' }).click();
  await page.waitForSelector('[data-testid=explain] li');
  check(/ERP: \d+ fee heads/.test(await page.locator('[data-testid=explain]').innerText()), 'explain my school covers the ERP');
  await untranslated(page, 'erp /designer en');
  await ctx.close();
}
await pool?.end();

// ---------------------------------------------------------------- 4. Hindi, Telugu, phone width
for (const lang of ['hi', 'te']) {
  const { ctx, page, go } = await context(`chairman-${lang}`, { lang, viewport: { width: 375, height: 800 } });
  await signIn(page, go, CHAIRMAN);
  await go('/designer');
  await page.waitForSelector('textarea[name=prompt]');
  await untranslated(page, `/designer ${lang}`);
  await noSideScroll(page, `/designer ${lang}`);
  await page.getByRole('tab').nth(1).click();
  await page.waitForSelector('[data-testid=template]');
  await untranslated(page, `/designer templates ${lang}`);
  await noSideScroll(page, `/designer templates ${lang}`);
  await page.screenshot({ path: `${SHOTS}/designer-${lang}-phone.png`, fullPage: true });
  await ctx.close();
}

// ---------------------------------------------------------------- 5. teacher refused
{
  const { ctx, page, go } = await context('teacher');
  await signIn(page, go, TEACHER);
  check((await page.locator('[data-testid=designer-link]').count()) === 0, 'a teacher does not see the designer link');
  await go('/designer');
  await page.waitForSelector('[data-testid=designer-denied]');
  check(true, 'a teacher opening /designer is refused politely');
  await ctx.close();
}

await browser.close();
for (const p of passed) console.log(`ok   ${p}`);
if (problems.length) {
  for (const p of problems) console.error(`FAIL ${p}`);
  process.exit(1);
}
console.log(`\ndesigner e2e: ${passed.length} checks passed, no page errors, console errors or 5xx.`);
