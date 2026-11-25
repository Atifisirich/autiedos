#!/usr/bin/env node
/**
 * Browser test of the custom records engine (docs/custom-records.md) on a production build with AUTH_PROVIDER=dev
 * NEXT_PUBLIC_AUTH_PROVIDER=dev and the seeded demo school:
 *  1. chairman@demo.school (management) creates "Hostel visitor log" in the object builder: text, student, date
 *     (today by default) and choice fields, a rule for Class Teachers (see own, add, edit own) and a workflow;
 *  2. adds two visitors through the record form (student picked with the search box), moves one to "Closed";
 *  3. exports the list as CSV (download checked: header + two rows) and the export is in audit.log;
 *  4. a class teacher sees the register but none of the chairman's entries, no export button, adds an entry and then
 *     sees only that one; opening a chairman entry by URL is refused;
 *  5. no page errors, console errors, HTTP 5xx or untranslated keys (en, and the list in hi / te).
 * Usage: BASE_URL=http://localhost:4301 DATABASE_URL=postgres://postgres@localhost:54322/records CHROMIUM_PATH=/opt/pw-browsers/chromium node apps/web/e2e/records.mjs
 */
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const pg = require('pg');

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const DB = process.env.DATABASE_URL ?? 'postgres://postgres@localhost:54322/postgres';
const CHAIRMAN = 'chairman@demo.school';
const TEACHER = process.env.RECORDS_TEACHER ?? 'deepa.teacher9@demo.school';
const KEY = 'hostel_visitor_log';

const problems = [];
const notes = [];
const db = new pg.Client({ connectionString: DB });
await db.connect();
const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];

// ---------------------------------------------------------------- fixture: a clean start for this register
const org = (await one(`select id from core.organizations where slug = 'demo'`)).id;
await db.query(`delete from core.approval_requests where org_id = $1 and linked_type = 'custom_record'`, [org]);
await db.query(`delete from core.custom_objects where org_id = $1 and key = $2`, [org, KEY]);
await db.query(`delete from private.rate_limits where key like 'login:%' or key like 'otp:%'`);
const teacherRole = (await one(`select a.role_key from core.user_product_access a join auth.users u on u.id = a.user_id where u.email = $1 and a.product_key = 'os' and a.revoked_at is null`, [TEACHER])).role_key;

// ---------------------------------------------------------------- browser helpers
const exe = process.env.CHROMIUM_PATH ?? (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const browser = await chromium.launch(exe ? { executablePath: exe } : {});
async function context(label, lang = 'en') {
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript((l) => localStorage.setItem('os_lang', l), lang);
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
  const page = await ctx.newPage();
  const state = { where: '' };
  page.on('pageerror', (e) => problems.push(`${label} ${state.where}: page error ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && problems.push(`${label} ${state.where}: console ${m.text().slice(0, 200)}`));
  page.on('response', (r) => {
    if (r.status() >= 500) problems.push(`${label} ${state.where}: ${r.status()} ${r.url()}`);
  });
  const go = async (path) => {
    state.where = path;
    await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
  };
  return { ctx, page, go, state };
}
const check = (cond, msg) => cond || problems.push(msg);
async function untranslated(page, label) {
  const raw = await page.evaluate(() => [...document.body.innerText.matchAll(/\b[a-z][A-Za-z]+\.[a-z][A-Za-z_.]+\b/g)].map((m) => m[0]).filter((k) => !/\.(school|dev|com|in|csv)$/.test(k)));
  if (raw.length) problems.push(`${label}: untranslated keys ${[...new Set(raw)].slice(0, 5).join(', ')}`);
}
async function signIn(page, go, email) {
  await go('/login');
  await page.fill('input[name=identity]', email);
  await Promise.all([page.waitForURL(`${BASE}/`), page.click('button:not([type=button])')]);
  await page.waitForSelector('[data-testid=product-list]');
}
async function pickFirst(page, name, term = '') {
  await page.fill(`input[name=${name}]`, term);
  const opt = page.locator('[role=listbox] [role=option] button').first();
  await opt.waitFor();
  const label = (await opt.innerText()).trim();
  await opt.click();
  return label;
}

try {
  // ---------------------------------------------------------------- 1. chairman builds the register
  const ch = await context('chairman');
  await signIn(ch.page, ch.go, CHAIRMAN);
  check(await ch.page.locator('[data-testid=landing-records]').count(), 'landing: no link to custom registers');
  await ch.page.click('[data-testid=landing-records]');
  await ch.page.waitForSelector('[data-testid=new-object]');
  ch.state.where = '/records';
  await untranslated(ch.page, 'records home');
  await ch.page.click('[data-testid=new-object]');
  await ch.page.waitForSelector('[data-testid=object-builder]');
  ch.state.where = '/records/new';
  await ch.page.fill('input[name=label_plural]', 'Hostel visitor log');
  await ch.page.fill('input[name=label_singular]', 'Visitor');
  check((await ch.page.inputValue('input[name=key]')) === KEY, `builder: key ${await ch.page.inputValue('input[name=key]')}`);
  await ch.page.fill('input[name=field-0-label]', 'Visitor name');
  const addField = async (i, label, type) => {
    await ch.page.click('[data-testid=add-field]');
    await ch.page.fill(`input[name=field-${i}-label]`, label);
    await ch.page.selectOption(`select[name=field-${i}-type]`, type);
  };
  await addField(1, 'Student', 'learner');
  await ch.page.check('input[name=field-1-required]');
  await addField(2, 'Visit date', 'date');
  await ch.page.locator('[data-testid=field-row]').nth(2).getByLabel('Today by default').check();
  await addField(3, 'Purpose', 'choice');
  await ch.page.fill('textarea[name=field-3-options]', 'Parent visit\nDelivery\nOther');
  await ch.page.click('[data-testid=add-permission]');
  const rule = ch.page.locator('[data-testid=permission-row]').first();
  await rule.locator('select').nth(0).selectOption(`os:${teacherRole}`);
  await rule.locator('select').nth(1).selectOption('own');
  await rule.locator('select').nth(2).selectOption('own');
  await rule.locator('select').nth(3).selectOption('none');
  await ch.page.check('[data-testid=use-states]');
  await untranslated(ch.page, 'builder');
  await Promise.all([ch.page.waitForURL(`${BASE}/records/${KEY}`), ch.page.click('[data-testid=save-object]')]);
  await ch.page.waitForSelector('[data-testid=record-total]');
  ch.state.where = `/records/${KEY}`;
  const obj = await one(`select fields, permissions, states from core.custom_objects where org_id = $1 and key = $2`, [org, KEY]);
  check(obj?.fields?.length === 4, `object: ${obj?.fields?.length} fields`);
  check(obj?.permissions?.[0]?.role === teacherRole && obj.permissions[0].view === 'own' && obj.permissions[0].create === true, `object permissions ${JSON.stringify(obj?.permissions)}`);
  check(obj?.states?.initial === 'open', 'object: workflow missing');

  // ---------------------------------------------------------------- 2. two visitors, one closed
  const addVisitor = async (name, purpose) => {
    await ch.go(`/records/${KEY}/new`);
    await ch.page.waitForSelector('[data-testid=record-form]');
    await ch.page.fill('input[name=f-visitor_name]', name);
    const student = await pickFirst(ch.page, 'f-student');
    await ch.page.selectOption('select[name=f-purpose]', purpose);
    await Promise.all([ch.page.waitForURL(new RegExp(`/records/${KEY}/[0-9a-f-]{36}$`)), ch.page.click('[data-testid=save-record]')]);
    await ch.page.waitForSelector('[data-testid=record-title]');
    check((await ch.page.innerText('[data-testid=record-title]')).trim() === name, `detail title for ${name}`);
    check((await ch.page.innerText('[data-field=student]')).trim() === student, `detail student label for ${name}`);
    check(/\d/.test(await ch.page.innerText('[data-field=visit_date]')), 'visit date default today');
    return ch.page.url().split('/').pop();
  };
  const r1 = await addVisitor('Ramesh Kumar (uncle)', 'Parent visit');
  // a required field left empty is refused with the database message
  await ch.go(`/records/${KEY}/new`);
  await ch.page.fill('input[name=f-visitor_name]', 'No student');
  await ch.page.click('[data-testid=save-record]');
  await ch.page.waitForSelector('[data-testid=form-error]');
  check(/Student is required/.test(await ch.page.innerText('[data-testid=form-error]')), 'required error not shown');
  const r2 = await addVisitor('Courier', 'Delivery');
  await ch.go(`/records/${KEY}/${r2}`);
  await ch.page.locator('[data-testid=transitions] button').first().click();
  await ch.page.waitForFunction(() => document.querySelector('[data-testid=record-state]')?.textContent?.trim() === 'Closed');
  check((await ch.page.locator('[data-testid=history] li').count()) >= 2, 'history: created + state');
  await ch.go(`/records/${KEY}`);
  await ch.page.waitForSelector('[data-testid=record-table]');
  check((await ch.page.innerText('[data-testid=record-total]')).includes('2'), `list total ${await ch.page.innerText('[data-testid=record-total]')}`);
  await untranslated(ch.page, 'list');

  // ---------------------------------------------------------------- 3. CSV export (audited)
  const [download] = await Promise.all([ch.page.waitForEvent('download'), ch.page.click('[data-testid=export-csv]')]);
  const csv = readFileSync(await download.path(), 'utf8').replace(/^﻿/, '').trim().split(/\r?\n/);
  check(csv[0] === 'Visitor name,Student,Visit date,Purpose,State,Created,Updated', `csv header ${csv[0]}`);
  check(csv.length === 3, `csv rows ${csv.length - 1}`);
  check(csv.some((l) => l.startsWith('Courier,') && l.includes(',Closed,')), 'csv: closed courier row');
  const audit = await one(`select detail from audit.log where org_id = $1 and action = 'records.export' order by created_at desc limit 1`, [org]);
  check(audit?.detail?.rows === 2, `audit export ${JSON.stringify(audit?.detail)}`);

  // languages on the list
  for (const lang of ['hi', 'te']) {
    const c = await context(`chairman-${lang}`, lang);
    await signIn(c.page, c.go, CHAIRMAN);
    await c.go(`/records/${KEY}`);
    await c.page.waitForSelector('[data-testid=record-table]');
    await untranslated(c.page, `list ${lang}`);
    await c.ctx.close();
  }
  await ch.ctx.close();

  // ---------------------------------------------------------------- 4. permission check as a teacher
  const te = await context('teacher');
  await signIn(te.page, te.go, TEACHER);
  await te.go('/records');
  await te.page.waitForSelector('[data-testid=object-list]');
  check((await te.page.locator('[data-testid=new-object]').count()) === 0, 'teacher sees "New register"');
  check((await te.page.locator(`[data-object=${KEY}]`).count()) === 1, 'teacher does not see the register');
  await te.go(`/records/${KEY}`);
  await te.page.waitForSelector('[data-testid=record-total]');
  check((await te.page.innerText('[data-testid=record-total]')).trim().startsWith('0'), `teacher sees chairman entries: ${await te.page.innerText('[data-testid=record-total]')}`);
  check((await te.page.locator('[data-testid=export-csv]').count()) === 0, 'teacher has export');
  check((await te.page.locator('[data-testid=edit-object]').count()) === 0, 'teacher can edit the definition');
  await te.page.click('[data-testid=add-record]');
  await te.page.waitForSelector('[data-testid=record-form]');
  te.state.where = `/records/${KEY}/new (teacher)`;
  await te.page.fill('input[name=f-visitor_name]', 'Teacher guest');
  await pickFirst(te.page, 'f-student');
  await Promise.all([te.page.waitForURL(new RegExp(`/records/${KEY}/[0-9a-f-]{36}$`)), te.page.click('[data-testid=save-record]')]);
  await te.go(`/records/${KEY}`);
  await te.page.waitForSelector('[data-testid=record-table]');
  const rows = await te.page.locator('[data-testid=record-table] tbody tr').allInnerTexts();
  check(rows.length === 1 && rows[0].includes('Teacher guest'), `teacher list ${JSON.stringify(rows)}`);
  await te.go(`/records/${KEY}/${r1}`);
  await te.page.waitForSelector('[role=alert]');
  check(/Not found/.test(await te.page.innerText('[role=alert]')), 'teacher opened a chairman entry');
  const api = await te.page.evaluate(async (k) => (await fetch(`/api/records/objects/${k}/export.csv`)).status, KEY);
  check(api === 403, `teacher export API ${api}`);
  const create = await te.page.evaluate(async () => (await fetch('/api/records/objects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: 'sneaky', label_singular: 'x', label_plural: 'x', fields: [{ key: 'a', label: 'A', type: 'text' }] }) })).status);
  check(create === 403, `teacher create object API ${create}`);
  await te.ctx.close();
} catch (e) {
  problems.push(`aborted: ${e.stack ?? e}`);
} finally {
  await browser.close();
  await db.end();
}

for (const n of notes) console.log(`note: ${n}`);
if (problems.length) {
  console.error(problems.join('\n'));
  console.error(`\nrecords e2e: ${problems.length} problem(s)`);
  process.exit(1);
}
console.log('records e2e: OK (builder, records, workflow, CSV export + audit, teacher permissions, en/hi/te)');
