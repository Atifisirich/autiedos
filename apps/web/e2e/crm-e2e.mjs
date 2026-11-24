#!/usr/bin/env node
/**
 * CRM end-to-end check through the real UI (the flows of the original scripts/e2e.js): quick add with the duplicate
 * check, the family page, calls, the next-action rule, visits, messages, stages, the public form, the walk-in desk,
 * admin (custom field, workflow test run, import with review and undo), reports drill-down, CSV export, the REST API.
 *
 *   tsx e2e/crm-seed.ts                       # once
 *   BASE_URL=http://localhost:3217 node e2e/crm-e2e.mjs
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BASE, OUT, finish, go, launch, ok, session, settle, shot, stamp, text } from './crm-lib.mjs';

const browser = await launch();
const problems = [];
const id = stamp();
const mobile = '97' + id + '1';

try {
  // ---- Counsellor: quick add, duplicate warning, 360 actions, next-action rule
  const p = await session(browser, 'meera@demo.test', { problems });
  await go(p, '/crm/leads');
  const existing = (await p.locator('table tbody tr td span.muted').first().innerText()).trim();
  await p.keyboard.press('n');
  await p.fill('dialog[open] input[name=mobile]', existing);
  await p.waitForSelector('text=This family is already with us', { timeout: 15000 });
  ok('Quick add shows the duplicate before saving', true);
  await p.fill('dialog[open] input[name=mobile]', mobile);
  await p.waitForSelector('text=This family is already with us', { state: 'detached' });
  await p.fill('dialog[open] input[name=studentName]', 'Tara Example');
  await p.fill('dialog[open] input[name=guardianName]', 'Rohit Example');
  await p.selectOption('dialog[open] select[name=grade]', 'Grade 3');
  await p.selectOption('dialog[open] select[name=sourceId]', { index: 1 });
  await p.click('dialog[open] button.btn-primary');
  await p.waitForURL(/\/crm\/households\//, { timeout: 60000 });
  await settle(p);
  const hhUrl = p.url();
  await p.waitForSelector('h1:has-text("Rohit Example")');
  await p.waitForSelector('text=Owner');
  let body = await text(p);
  ok('Quick add creates the household and opens the family page', body.includes('Rohit Example') && body.includes('Tara Example'));
  ok('New enquiry has an owner and a next action', /Owner\s*\n?\s*(Meera|Rahul) Counsellor/.test(body) && !body.includes('This enquiry has no next action'));
  ok('Sensitive date of birth is masked for a counsellor', (await p.locator('input[name="s_dob"]').count()) === 0);

  await p.click("button[aria-expanded]:has-text('Call')");
  await p.selectOption('select[name=outcome]', 'connected');
  await p.fill('input[name=notes]', 'Wants a campus visit on Saturday');
  await p.click("button:has-text('Log call')");
  await p.waitForSelector('text=Wants a campus visit on Saturday');
  await settle(p);
  body = await text(p);
  ok('Logging a connected call moves New to Connected and writes the timeline', body.includes('Stage moved from New to Connected'));

  // Complete every open task but the last, then check the last one cannot close without a next action.
  for (let i = 0; i < 6 && (await p.locator("button:has-text('✓ Done')").count()) > 1; i++) {
    await p.locator("button:has-text('✓ Done')").first().click();
    await p.fill('dialog[open] input[name=outcome]', 'Done');
    if (await p.locator('dialog[open] input[value=none]').count()) await p.check('dialog[open] input[value=none]');
    await p.click("dialog[open] button:has-text('Complete task')");
    await p.waitForSelector('dialog[open]', { state: 'detached' });
    await settle(p);
  }
  await p.locator("button:has-text('✓ Done')").first().click();
  ok("Last open task offers no 'Nothing more' option", (await p.locator('dialog[open] input[value=none]').count()) === 0);
  await p.fill('dialog[open] input[name=outcome]', 'Spoke to parent');
  await p.check('dialog[open] input[value=stage]');
  ok('Moving stage from the last task only offers stages that need no next action', !(await p.locator('dialog[open] select[name=stageId]').innerText()).includes('Enquiry: Interested'));
  await p.check('dialog[open] input[value=task]');
  await p.click("dialog[open] button:has-text('Complete task')");
  await p.waitForSelector('dialog[open]', { state: 'detached' });
  await settle(p);
  ok('Completing with a next task keeps the enquiry planned', !(await text(p)).includes('This enquiry has no next action'));

  await p.click("button[aria-expanded]:has-text('Book visit')");
  // A slot of its own, so repeated runs do not hit the per-hour visit capacity.
  const slot = new Date(Date.now() + (3 + Math.floor(Math.random() * 300)) * 86400e3 + Math.floor(Math.random() * 8) * 3600e3).toISOString().slice(0, 16);
  await p.fill('input[name=slotAt]', slot);
  await p.click("form button.btn-primary:has-text('Book visit')");
  await p.waitForSelector('text=Stage moved from Connected to Visit scheduled');
  ok('Booking a visit moves the stage and logs it', true);

  await p.click("button[aria-expanded]:has-text('Message')");
  await p.selectOption('select[name=templateId]', { label: 'Fee structure' });
  await p.click("form button.btn-primary:has-text('Send')");
  await p.waitForSelector('text=here is the fee structure for Grade 3');
  ok('Template message is merged and appears on the timeline', true);
  await shot(p, 'e2e-360');

  await p.click("button[aria-expanded]:has-text('Change stage')");
  await p.locator('form select').filter({ hasText: 'Closed: Not interested' }).selectOption({ label: 'Closed: Not interested' });
  ok('Closing asks for a closure reason', (await p.locator('select[name=closure_reason]').count()) === 1);
  await p.selectOption('select[name=closure_reason]', 'Fee too high');
  await p.click("form button.btn-primary:has-text('Move')");
  await p.waitForSelector('text=Reason: Fee too high');
  ok('Closed with reason on the timeline', true);
  ok('Counsellor does not see the admin console', !(await text(p)).includes('Admin console'));
  await go(p, '/crm/admin/users');
  ok('Direct URL to admin is refused for a counsellor', (await text(p)).includes('cannot open this part of the admin console'));

  // ---- Public form: a re-enquiry reopens the closed record
  const anon = await (await browser.newContext()).newPage();
  await anon.goto(BASE + '/crm/f/greenfield-enquiry?utm_source=google&utm_campaign=e2e', { waitUntil: 'networkidle' });
  await anon.fill('input[name=student_name]', 'Tara Example');
  await anon.fill('input[name=guardian_name]', 'Rohit Example');
  await anon.fill('input[name=mobile]', mobile);
  await anon.selectOption('select[name=grade]', 'Grade 3');
  await anon.check('input[name=consent]');
  await anon.waitForTimeout(2200);
  await anon.click("button:has-text('Send enquiry')");
  await anon.waitForSelector('text=Thank you');
  await p.goto(hhUrl, { waitUntil: 'networkidle' });
  body = await text(p);
  ok('Public form re-enquiry lands on the same record, reopens it and tags it', body.includes('Re-enquired') && body.includes('Re-opened automatically'));
  ok('UTM campaign is kept on the source touch', body.includes('Campaign: e2e'));

  // ---- Front office: walk-in on an existing mobile
  const f = await session(browser, 'desk@demo.test', { problems });
  await go(f, '/crm/walkin');
  await f.fill('main input[name=mobile]', mobile);
  await f.waitForSelector('text=This family is already with us');
  await f.fill('main input[name=studentName]', 'Tara Example');
  await f.selectOption('main select[name=grade]', 'Grade 3');
  await f.click("button:has-text('Check in this family')");
  await f.waitForSelector('text=Visitor token');
  ok('Walk-in on a known mobile gives a token and no new household', (await text(f)).includes('Existing family'));
  ok('Front office cannot open reports or the admin console', !(await text(f)).includes('Reports') && !(await text(f)).includes('Admin console'));

  // ---- Admin: custom field live on the record, test run, import with review queue and undo
  const a = await session(browser, 'admin@demo.test', { problems });
  const field = 'Bus stop ' + id;
  await go(a, '/crm/admin/fields');
  await a.locator('main form').first().locator('input[name=label]').fill(field);
  await a.click("button:has-text('Add field')");
  await a.waitForSelector(`input[value="${field}"]`);
  await a.goto(hhUrl, { waitUntil: 'networkidle' });
  ok('A new custom field is live on the family page without a deploy', (await text(a)).includes(field) || (await a.locator('input[name^="cf_"]').count()) > 0);
  ok('Admin sees the date of birth field', (await a.locator('input[name="s_dob"]').count()) === 1);

  await go(a, '/crm/admin/workflows');
  await a.click("a:has-text('Instant welcome')");
  await a.click("button:has-text('Test run on a sample record')");
  await a.waitForSelector('text=Would send on whatsapp');
  ok('Workflow test run shows what would happen without sending', true);
  await shot(a, 'e2e-workflow');

  const csv = join(OUT, 'e2e-import.csv');
  writeFileSync(csv, `Student name,Parent name,Mobile,Grade,Stage,Sub stage\nImport One,Parent One,96${id}1,Grade 2,Follow-up (2026),Campus visit planned\nImport Two,Parent Two,96${id}2,Grade 2,Interested,Hot\nThird,P3,${mobile},Grade 2,,\nBad Row,P4,12345,Grade 2,,\n`);
  await go(a, '/crm/admin/data');
  await a.setInputFiles('input[type=file]', csv);
  await a.fill('input[name=consent_basis]', 'E2E test list');
  await a.click("button:has-text('Import')");
  await a.waitForSelector('text=Duplicate review queue');
  body = await text(a);
  ok('Import: 2 created, duplicate sent to review, bad row explained', body.includes('Duplicate review queue · 1') && body.includes('not a valid 10-digit Indian mobile'));
  await go(a, '/crm/leads?year=all&q=Import%20One');
  ok('Imported stage is mapped (Follow-up / Campus visit planned -> Visit scheduled)', (await text(a)).includes('Visit scheduled'));
  await go(a, '/crm/admin/data');
  await a.click("button:has-text('Undo import')");
  await a.waitForSelector('text=Undone');
  await go(a, '/crm/leads?year=all&q=Import%20One');
  ok('Undo import removes the records it created', (await text(a)).includes('No leads match'));
  await go(a, '/crm/admin/data');
  if (await a.locator("button:has-text('Discard all')").count()) {
    await a.click("button:has-text('Discard all')");
    await settle(a);
  }

  // ---- Reports drill-down and CSV export
  await go(a, '/crm/reports');
  await a.click('main a[href="/crm/leads?phase=enquiry"]');
  await a.waitForURL(/\/crm\/leads\?phase=enquiry/, { timeout: 30000 });
  ok('Report numbers drill down to the lead list', a.url().includes('/crm/leads?'));
  const res = await a.request.get(BASE + '/api/crm/export?open=1');
  const exported = await res.text();
  ok('CSV export works and carries the exporter watermark', res.status() === 200 && exported.includes('Exported by Aisha Admin'));
  ok('Counsellor cannot export', (await p.request.get(BASE + '/api/crm/export?open=1')).status() === 403);

  // ---- REST API with a key
  await go(a, '/crm/admin/integrations');
  await a.locator('input[name=name]').first().fill('E2E key ' + id);
  await a.click("button:has-text('Create key')");
  await a.waitForSelector('text=Copy this key now');
  const key = (await text(a)).match(/aed_[A-Za-z0-9_-]+/g).sort((x, y) => y.length - x.length)[0];
  const post = (b) => fetch(BASE + '/api/crm/v1/enquiries', { method: 'POST', headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' }, body: JSON.stringify(b) });
  const body1 = { student_name: 'Api Child', guardian_name: 'Api Parent', mobile: '95' + id + '9', grade: 'Grade 4', branch: 'Main campus' };
  const r1 = await post(body1);
  const j1 = await r1.json();
  const j2 = await (await post(body1)).json();
  ok('API creates an enquiry, then reports a re-enquiry instead of a duplicate', r1.status === 201 && j1.status === 'created' && j2.status === 're_enquiry' && j2.enquiry_id === j1.enquiry_id, JSON.stringify(j2));
  ok('API rejects a bad key', (await fetch(BASE + '/api/crm/v1/enquiries', { headers: { authorization: 'Bearer nope' } })).status === 401);

  ok('No page errors, console errors or server errors on the way', problems.length === 0, problems.slice(0, 3).join(' | '));
} catch (e) {
  console.error('E2E crashed:', String(e.message ?? e).split('\n').slice(0, 8).join('\n'));
  ok('script ran to the end', false);
} finally {
  await browser.close();
  finish();
}
