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
 *  6. no page errors, console errors or HTTP 5xx anywhere.
 * Usage: BASE_URL=http://localhost:3921 CHROMIUM_PATH=/opt/pw-browsers/chromium-1243/chrome-linux64/chrome node apps/web/e2e/designer.mjs
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
  check(true, 'ERP request answered as "not possible yet"');
  await untranslated(page, 'chairman /designer en');
  await ctx.close();
}

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
