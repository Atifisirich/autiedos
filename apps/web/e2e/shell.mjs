#!/usr/bin/env node
/**
 * Browser test of the web shell and the unified sign-in (docs/adr/shell-and-login.md), on a production build with
 * AUTH_PROVIDER=dev NEXT_PUBLIC_AUTH_PROVIDER=dev and the seeded demo school:
 *  1. an OS-only user (dev sign-in through the login form) sees only OS on the landing, "not part of your plan"
 *     for ERP and CRM, and a switcher with one product;
 *  2. an OS + ERP user sees two options; the switcher in the OS header lists both and opens ERP;
 *  3. password: set one, sign out, sign in with it; a wrong one is refused; must-change sends the user to the
 *     password page and every product route waits until a new one is saved;
 *  4. no page errors, no console errors, no HTTP 5xx, no untranslated keys (en, hi, te on the landing).
 * The fixture (owner connection, DATABASE_URL) gives the demo org ERP and grants it to the principal only.
 * Usage: BASE_URL=http://localhost:3801 DATABASE_URL=postgres://postgres@localhost:54322/shell node apps/web/e2e/shell.mjs
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const pg = require('pg');

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const DB = process.env.DATABASE_URL ?? 'postgres://postgres@localhost:54322/postgres';
const OS_ONLY = process.env.SHELL_OS_USER ?? 'deepa.teacher9@demo.school';
const OS_ERP = process.env.SHELL_OS_ERP_USER ?? 'principal@demo.school';
const PASSWORD = 'Tamarind-Window-58';
const NEW_PASSWORD = 'Monsoon-Ledger-73';

const problems = [];
const notes = [];
const db = new pg.Client({ connectionString: DB });
await db.connect();
const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];

// ---------------------------------------------------------------- fixture
const org = (await one(`select id from core.organizations where slug = 'demo'`)).id;
await db.query(`insert into core.subscriptions (org_id, product_key, status) select $1, 'erp', 'active' where not exists (select 1 from core.subscriptions where org_id = $1 and product_key = 'erp')`, [org]);
await db.query(`update core.subscriptions set status = 'active', ends_on = null where org_id = $1 and product_key = 'erp'`, [org]);
await db.query(`insert into core.roles (org_id, product_key, key, name) values ($1, 'erp', 'shell_e2e', 'Shell e2e') on conflict do nothing`, [org]);
const erpUser = (await one(`select id from auth.users where email = $1`, [OS_ERP])).id;
const osUser = (await one(`select id from auth.users where email = $1`, [OS_ONLY])).id;
await db.query(`insert into core.user_product_access (org_id, user_id, product_key, role_key) select $1, $2, 'erp', 'shell_e2e' where not exists (select 1 from core.user_product_access where user_id = $2 and product_key = 'erp' and revoked_at is null)`, [org, erpUser]);
await db.query(`update core.user_product_access set revoked_at = now() where user_id = $1 and product_key = 'erp' and revoked_at is null`, [osUser]);
// the OS-only user starts with no password and a clean lockout / rate-limit state
await db.query(`delete from auth.dev_passwords where user_id = $1`, [osUser]);
await db.query(`update core.user_security set password_set_at = null, password_changed_at = null, must_change_password = false, failed_attempts = 0, locked_until = null where user_id = $1`, [osUser]);
await db.query(`delete from private.rate_limits where key like 'login:%' or key like 'otp:%' or key like 'pwchange:%'`);

// ---------------------------------------------------------------- browser helpers
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
async function context(label, lang = 'en') {
  const ctx = await browser.newContext();
  await ctx.addInitScript((l) => localStorage.setItem('os_lang', l), lang);
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort()); // hermetic
  const page = await ctx.newPage();
  const state = { where: '' };
  page.on('pageerror', (e) => problems.push(`${label} ${state.where}: page error ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && problems.push(`${label} ${state.where}: console ${m.text().slice(0, 200)}`));
  page.on('response', (r) => {
    if (r.status() >= 500) problems.push(`${label} ${state.where}: ${r.status()} ${r.url()}`);
    if (r.status() === 404 && r.request().resourceType() === 'document') {
      const path = new URL(r.url()).pathname;
      if (path.startsWith('/erp') || path.startsWith('/crm')) notes.push(`${label}: ${path} answered 404 (that product's staff screens are not in this branch yet)`);
      else problems.push(`${label} ${state.where}: 404 ${r.url()}`);
    }
  });
  const go = async (path) => {
    state.where = path;
    await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
  };
  return { ctx, page, go, state };
}
const check = (cond, msg) => cond || problems.push(msg);
async function untranslated(page, label) {
  const raw = await page.evaluate(() => [...document.body.innerText.matchAll(/\b[a-z][A-Za-z]+\.[a-z][A-Za-z_.]+\b/g)].map((m) => m[0]).filter((k) => !/\.(school|dev|com|in|ics|xlsx|docx|pdf)$/.test(k)));
  if (raw.length) problems.push(`${label}: untranslated keys ${[...new Set(raw)].slice(0, 5).join(', ')}`);
}
async function demoSignIn(page, go, email) {
  await go('/login');
  await page.fill('input[name=identity]', email);
  await Promise.all([page.waitForURL(`${BASE}/`), page.click('button:not([type=button])')]);
  await page.waitForSelector('[data-testid=product-list]');
}
const products = (page) => page.$$eval('[data-testid=product-list] a[data-product]', (as) => as.map((a) => a.getAttribute('data-product')));
async function switcherItems(page) {
  await page.waitForSelector('[data-testid=product-switcher] button');
  await page.click('[data-testid=product-switcher] button');
  await page.waitForSelector('[data-testid=product-switcher] nav a[data-product]');
  return page.$$eval('[data-testid=product-switcher] nav a[data-product]', (as) => as.map((a) => a.getAttribute('data-product')));
}

// ---------------------------------------------------------------- 1. OS-only user
{
  const { ctx, page, go } = await context('os-only');
  await demoSignIn(page, go, OS_ONLY);
  const list = await products(page);
  check(JSON.stringify(list) === '["os"]', `os-only: landing shows ${JSON.stringify(list)}, expected ["os"]`);
  check((await page.textContent('[data-testid=school-brand]'))?.includes('Demo International School'), 'os-only: school name missing from the landing');
  await untranslated(page, 'os-only /');
  await page.screenshot({ path: '/tmp/claude-0/shell-landing-os-only.png' });
  for (const p of ['erp', 'crm']) {
    await go(`/go/${p}`);
    check(!!(await page.$('[data-testid=not-in-plan]')), `os-only: /go/${p} did not show "not part of your plan"`);
    await untranslated(page, `os-only /go/${p}`);
  }
  await page.screenshot({ path: '/tmp/claude-0/shell-not-in-plan.png' });
  await go('/');
  await Promise.all([page.waitForURL(`${BASE}/os`), page.click('[data-testid=product-list] a[data-product=os]')]);
  const items = await switcherItems(page);
  check(JSON.stringify(items) === '["os"]', `os-only: switcher lists ${JSON.stringify(items)}, expected ["os"]`);
  await ctx.close();
}

// ---------------------------------------------------------------- 2. OS + ERP user, switcher
{
  const { ctx, page, go, state } = await context('os+erp');
  await demoSignIn(page, go, OS_ERP);
  const list = await products(page);
  check(JSON.stringify(list) === '["os","erp"]', `os+erp: landing shows ${JSON.stringify(list)}, expected ["os","erp"]`);
  await page.screenshot({ path: '/tmp/claude-0/shell-landing-os-erp.png' });
  state.where = '/ -> os';
  await Promise.all([page.waitForURL(`${BASE}/os`), page.click('[data-testid=product-list] a[data-product=os]')]);
  const items = await switcherItems(page);
  check(JSON.stringify(items) === '["os","erp"]', `os+erp: switcher lists ${JSON.stringify(items)}, expected ["os","erp"]`);
  check((await page.getAttribute('[data-testid=product-switcher] a[data-product=os]', 'aria-current')) === 'page', 'os+erp: switcher does not mark OS as current');
  await page.screenshot({ path: '/tmp/claude-0/shell-switcher-open.png' });
  state.where = 'switcher -> erp';
  await Promise.all([page.waitForURL(/\/erp(\/|$)/), page.click('[data-testid=product-switcher] a[data-product=erp]')]);
  check(new URL(page.url()).pathname.startsWith('/erp'), `os+erp: switcher did not open ERP (at ${page.url()})`);
  await go('/go/erp');
  await page.waitForURL(/\/erp(\/|$)/);
  await go('/go/crm');
  check(!!(await page.$('[data-testid=not-in-plan]')), 'os+erp: /go/crm did not show "not part of your plan"');
  await ctx.close();
}

// ---------------------------------------------------------------- 3. passwords
{
  const { ctx, page, go, state } = await context('password');
  await demoSignIn(page, go, OS_ONLY);
  await go('/account/password');
  check(!(await page.$('input[autocomplete=current-password]')), 'password: first password should not ask for a current one');
  await page.fill('[data-testid=password-form] input[autocomplete=new-password] >> nth=0', 'short');
  check((await page.textContent('#pw-hint'))?.length > 0, 'password: no live rule hint');
  await page.fill('[data-testid=password-form] input[autocomplete=new-password] >> nth=0', PASSWORD);
  await page.fill('[data-testid=password-form] input[autocomplete=new-password] >> nth=1', PASSWORD);
  state.where = 'set password';
  await Promise.all([page.waitForURL(/\/(go\/os|os)$/), page.click('[data-testid=password-form] button:not([type=button])')]);
  // sign out from the OS header, then sign in with the password
  await page.waitForSelector('header button:has-text("Sign out")');
  await Promise.all([page.waitForURL(`${BASE}/login`), page.click('header button:has-text("Sign out")')]);
  await page.click('button[data-mode=password]');
  await page.fill('input[name=identity]', OS_ONLY);
  await page.fill('input[name=password]', 'not-the-password');
  state.where = 'wrong password';
  await page.click('button:not([type=button])');
  await page.waitForSelector('form [role=alert]');
  check(/did not work/i.test((await page.textContent('form [role=alert]')) ?? ''), 'password: wrong password shows no error');
  await page.fill('input[name=password]', PASSWORD);
  state.where = 'password sign-in';
  await Promise.all([page.waitForURL(`${BASE}/`), page.click('button:not([type=button])')]);
  await page.waitForSelector('[data-testid=product-list]');
  const ev = await one(`select method, success from core.login_events where user_id = $1 order by created_at desc limit 1`, [osUser]);
  check(ev?.method === 'password' && ev?.success === true, `password: last login event is ${JSON.stringify(ev)}`);

  // must change: the school asks for a new password
  await db.query(`update core.user_security set must_change_password = true where user_id = $1`, [osUser]);
  await go('/os');
  await page.waitForURL(`${BASE}/account/password`);
  check(!!(await page.$('[data-testid=password-form] [role=status]')), 'must-change: no notice on the password page');
  await page.screenshot({ path: '/tmp/claude-0/shell-must-change.png' });
  await page.fill('[data-testid=password-form] input[autocomplete=new-password] >> nth=0', NEW_PASSWORD);
  await page.fill('[data-testid=password-form] input[autocomplete=new-password] >> nth=1', NEW_PASSWORD);
  state.where = 'must-change save';
  await Promise.all([page.waitForURL(/\/(go\/os|os)$/), page.click('[data-testid=password-form] button:not([type=button])')]);
  await page.waitForSelector('[data-testid=product-switcher] button');
  const sec = await one(`select must_change_password from core.user_security where user_id = $1`, [osUser]);
  check(sec?.must_change_password === false, 'must-change: flag still set after saving');
  await ctx.close();
}

// ---------------------------------------------------------------- 4. landing in hi / te
for (const lang of ['hi', 'te']) {
  const { ctx, page, go } = await context(`landing-${lang}`, lang);
  await go('/login');
  await untranslated(page, `${lang} /login`);
  await page.fill('input[name=identity]', OS_ERP);
  await Promise.all([page.waitForURL(`${BASE}/`), page.click('button:not([type=button])')]);
  await page.waitForSelector('[data-testid=product-list]');
  await untranslated(page, `${lang} /`);
  await page.screenshot({ path: `/tmp/claude-0/shell-landing-${lang}.png` });
  await ctx.close();
}

await browser.close();
await db.end();
for (const n of [...new Set(notes)]) console.log(`note: ${n}`);
if (problems.length) {
  console.error(problems.join('\n'));
  console.error(`\n${problems.length} problem(s)`);
  process.exit(1);
}
console.log('shell OK: OS-only user sees only OS, OS+ERP user sees two options, switcher works, password set/sign-in/must-change, no page or console errors');
