#!/usr/bin/env node
/**
 * CRM end-to-end, part two (the flows of the original scripts/e2e-admissions.js): application to confirmed admission with a
 * student created in the school's core records, the parent's phone-width pages, payments, inbox, campaign, Kanban,
 * rollover, plus role-limited views and a masked sensitive field.
 *
 *   BASE_URL=http://localhost:3217 [DATABASE_URL=postgres://postgres@localhost:54322/crmui] node e2e/crm-e2e-admissions.mjs
 * With DATABASE_URL set (an owner connection used only to LOOK, never to change anything) it also checks the core student row.
 */
import { createRequire } from 'node:module';
import { BASE, finish, go, launch, ok, session, settle, shot, stamp, text } from './crm-lib.mjs';

const browser = await launch();
const problems = [];
const id = stamp();

try {
  const a = await session(browser, 'admin@demo.test', { problems });

  // New family, then the whole admission path.
  await go(a, '/crm/leads');
  await a.keyboard.press('n');
  await a.fill('dialog[open] input[name=mobile]', '94' + id + '3');
  await a.fill('dialog[open] input[name=studentName]', 'Admit Flow ' + id);
  await a.fill('dialog[open] input[name=guardianName]', 'Parent Flow');
  await a.selectOption('dialog[open] select[name=grade]', 'Grade 5');
  await a.selectOption('dialog[open] select[name=sourceId]', { index: 1 });
  await a.click('dialog[open] button.btn-primary');
  await a.waitForURL(/\/crm\/households\//);
  await a.waitForSelector('h1:has-text("Parent Flow")');
  const hhUrl = a.url();
  // the sensitive field is not on the quick-add form: an admin sets it on the family page
  await a.selectOption('select[name=cf_family_income_band]', '5-10L');
  await a.click("button:has-text('Save details')");
  await a.waitForSelector('text=Updated Family income band');
  const enquiryId = new URL(hhUrl).searchParams.get('e');
  await a.click("button[aria-expanded]:has-text('Form / payment')");
  await a.click("button:has-text('Start application')");
  await a.waitForSelector('text=Stage moved from New to Form started');
  ok('Starting an application assigns a number and moves the stage', /APP-\d\d-\d{4}/.test(await text(a)));

  // A counsellor who does not own this record cannot open it; sensitive values are masked for roles without the right.
  const other = await session(browser, 'meera@demo.test', { problems });
  const owner = (await text(a)).match(/Owner\s*\n?\s*(\w+) Counsellor/)?.[1];
  ok('The new enquiry went to a counsellor by the routing rule', !!owner);
  const theirs = owner === 'Meera' ? other : await session(browser, 'rahul@demo.test', { problems });
  const notTheirs = owner === 'Meera' ? await session(browser, 'rahul@demo.test', { problems }) : other;
  await go(notTheirs, new URL(hhUrl).pathname + new URL(hhUrl).search);
  ok('A counsellor cannot open a colleague\'s family', (await text(notTheirs)).includes('not available to you'));
  await go(theirs, new URL(hhUrl).pathname + new URL(hhUrl).search);
  await theirs.waitForSelector('h1:has-text("Parent Flow")');
  const income = theirs.locator('input[aria-label^="Family income band"]');
  ok('Sensitive family income band is masked for the owner counsellor', (await income.count()) === 1 && (await income.inputValue()) === '••••••');
  await go(a, new URL(hhUrl).pathname + new URL(hhUrl).search);
  await a.waitForSelector('h1:has-text("Parent Flow")');
  ok('The admin sees the real value', (await a.locator('select[name=cf_family_income_band]').inputValue()) === '5-10L');

  // Parent fills the form on the public link, at phone width.
  await go(a, `/crm/applications/${enquiryId}`);
  await a.waitForSelector('text=Parent link');
  const token = (await text(a)).match(/\/crm\/apply\/([A-Za-z0-9_-]+)/)[1];
  const parent = await (await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 })).newPage();
  await parent.goto(`${BASE}/crm/apply/${token}`, { waitUntil: 'networkidle' });
  await parent.click("button:has-text('Submit application')");
  await parent.waitForSelector('text=Some required answers are missing');
  ok('Parent cannot submit an incomplete application', true);
  for (const [k, v] of [['mother_tongue', 'Telugu'], ['medical', 'None'], ['father_name', 'Parent Flow'], ['mother_name', 'Mother Flow'], ['address', '12 Lake Road'], ['pincode', '500084']]) await parent.fill(`input[name=${k}]`, v);
  await parent.selectOption('select[name=transport]', 'Yes');
  await parent.click("button:has-text('Save and continue later')");
  await parent.waitForSelector('text=Saved.');
  await parent.reload({ waitUntil: 'networkidle' });
  ok("Save and resume keeps the parent's answers", (await parent.inputValue('input[name=father_name]')) === 'Parent Flow');
  await parent.check('input[name=declaration]');
  await parent.click("button:has-text('Submit application')");
  await parent.waitForSelector('text=Your application is submitted');
  await shot(parent, 'e2e-parent-apply');
  ok('Parent submits the application on a phone-width screen', (await parent.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)));
  await parent.setInputFiles('input[type=file] >> nth=0', { name: 'birth-certificate.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 demo') });
  await parent.click("button:has-text('Send') >> nth=0");
  await parent.waitForSelector('text=Received, being checked');
  ok('Parent can send a document from the link', true);

  // Parent pays the registration fee through the link (failure, then success).
  await go(a, hhUrl.replace(BASE, ''));
  await a.click("button[aria-expanded]:has-text('Form / payment')");
  await a.selectOption("form select[name=mode]", 'link');
  await a.click("form button.btn-primary:has-text('Continue')");
  await a.waitForSelector('text=Payment link sent on WhatsApp');
  await go(a, `/crm/applications/${enquiryId}`);
  await a.waitForSelector('text=link http');
  const payToken = (await text(a)).match(/\/crm\/pay\/([A-Za-z0-9_-]+)/)[1];
  await parent.goto(`${BASE}/crm/pay/${payToken}`, { waitUntil: 'networkidle' });
  await parent.click("button:has-text('Simulate a failed payment')");
  await parent.waitForSelector('text=No money was taken');
  await parent.click("button:has-text('Simulate a successful payment')");
  await parent.waitForSelector('text=Payment received');
  ok('Failed payment is explained, retry succeeds and issues a receipt', /RCPT-\d{5}/.test(await text(parent)));
  await shot(parent, 'e2e-parent-pay');

  // Staff: cannot confirm early; verify documents, take the admission fee, confirm.
  await go(a, `/crm/applications/${enquiryId}`);
  await a.waitForSelector("button:has-text('Confirm admission')");
  ok('Confirm admission is locked until the checklist is complete', await a.locator("button:has-text('Confirm admission')").isDisabled());
  ok('Payment moved the stage to Fee paid', (await text(a)).includes('Fee paid'));
  for (let i = 0; i < 12 && (await a.locator('main form:has(input[type=file])').count()); i++) {
    const before = await a.locator('main form:has(input[type=file])').count();
    const add = a.locator('main form:has(input[type=file])').first();
    await add.locator('input[type=file]').setInputFiles({ name: `doc-${i}.pdf`, mimeType: 'application/pdf', buffer: Buffer.from('%PDF demo') });
    await add.locator('button').click();
    await a.waitForFunction((n) => document.querySelectorAll('main form input[type=file]').length < n, before, { timeout: 15000 });
  }
  for (let i = 0; i < 12 && (await a.locator("button:has-text('Verify')").count()); i++) {
    const before = await a.locator("button:has-text('Verify')").count();
    await a.locator("button:has-text('Verify')").first().click();
    await a.waitForFunction((n) => [...document.querySelectorAll('button')].filter((b) => b.textContent === 'Verify').length < n, before, { timeout: 15000 });
  }
  ok('All documents verified', /Documents verified \((\d+) of \1\)/.test(await text(a)), (await text(a)).match(/Documents verified \(\d+ of \d+\)/)?.[0]);
  await a.selectOption('aside select[aria-label=Purpose]', 'Admission fee');
  await a.selectOption('aside select[aria-label=Mode]', 'cheque');
  await a.click("button:has-text('Request / record')");
  await a.waitForSelector('text=Payment recorded and receipt issued');
  await a.waitForSelector("button:has-text('Confirm admission'):not([disabled])");
  await a.click("button:has-text('Confirm admission')");
  await a.waitForSelector('text=Admission confirmed');
  await shot(a, 'e2e-application');
  await go(a, hhUrl.replace(BASE, ''));
  await a.waitForSelector('text=Timeline');
  const body = await text(a);
  ok('Admission confirmed; welcome workflow ran; no next action demanded', body.includes('Admission confirmed') && body.includes('admission to Grade 5 is confirmed') && !body.includes('This enquiry has no next action'));

  if (process.env.DATABASE_URL) {
    const pg = createRequire(import.meta.url)('pg');
    const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    const r = await c.query("select s.status, s.first_name from core.students s join crm.prospects p on p.core_student_id = s.id join crm.enquiries e on e.prospect_id = p.id where e.id = $1", [enquiryId]);
    await c.end();
    ok('A student now exists in the school core records (core.admit_student)', r.rows.length === 1 && r.rows[0].status === 'admitted', JSON.stringify(r.rows));
  }

  // Inbox: simulated parent reply shows up, reply sends, STOP opts out.
  await go(a, '/crm/inbox?f=all');
  await a.waitForSelector('text=Demo: simulate a parent reply');
  await a.fill('main form input[name=body]', 'Is the bus available from Miyapur? ' + id);
  await a.click("button:has-text('Receive reply')");
  await a.waitForSelector(`text=Is the bus available from Miyapur? ${id}`);
  await a.fill('main textarea[name=body]', 'Yes, route 4 covers Miyapur. ' + id);
  await a.click("main button.btn-primary:has-text('Send')");
  await a.waitForSelector(`text=Yes, route 4 covers Miyapur. ${id}`);
  ok('Inbox: parent reply received and answered in the thread', true);
  await shot(a, 'e2e-inbox');
  await a.fill('main form input[name=body]', 'STOP');
  await a.click("button:has-text('Receive reply')");
  await a.waitForSelector('[role=log] >> text=STOP');
  await a.fill('main textarea[name=body]', 'One more message');
  await a.click("main button.btn-primary:has-text('Send')");
  await a.waitForSelector('text=opted out of WhatsApp');
  ok('Inbox: STOP opts the parent out and the next send is blocked with a reason', true);

  // Campaign draft with audience count and cost, then send.
  await go(a, '/crm/campaigns');
  await a.fill('main input[name=name]', 'E2E campaign ' + id);
  await a.selectOption('main select[name=audience]', 'open=1');
  await a.click("button:has-text('Create draft')");
  await a.waitForSelector(`text=E2E campaign ${id}`);
  ok('Campaign draft shows audience size and cost before sending', (await text(a)).includes('Estimated cost'));
  await a.locator('section', { hasText: 'E2E campaign ' + id }).locator("button:has-text('Send now')").click();
  await a.waitForSelector('text=Campaign sent to', { timeout: 120000 });
  ok('Campaign sends and reports delivered counts', true);

  // Kanban drag from Connected to Interested.
  await go(a, '/crm/leads?view=kanban&phase=enquiry');
  const card = a.locator("section[aria-label='Connected'] article").first();
  const name = await card.locator('a').innerText();
  await card.dragTo(a.locator("section[aria-label='Interested']"));
  await a.waitForFunction((n) => [...document.querySelectorAll("section[aria-label='Interested'] article a")].some((x) => x.textContent === n), name, { timeout: 30000 }).catch(() => undefined);
  ok('Kanban: dragging a card changes its stage', (await a.locator("section[aria-label='Interested']").innerText()).includes(name));
  await shot(a, 'e2e-kanban');

  // Rollover: new year, carried-forward prospects, one pipeline.
  await go(a, '/crm/admin/org');
  const newYear = await a.inputValue('input[name=name][defaultValue], form:has-text("Rollover wizard") input[name=name]');
  await a.click("button:has-text('Create year')");
  await a.waitForSelector('text=carried forward as prospects');
  await settle(a);
  ok('Rollover creates the next academic year and carries families forward', (await a.locator('header select[aria-label="Academic year"]').innerText()).includes(newYear) || (await a.locator('aside select[aria-label="Academic year"]').innerText()).includes(newYear), newYear);

  ok('No page errors, console errors or server errors on the way', problems.length === 0, problems.slice(0, 3).join(' | '));
} catch (e) {
  console.error('E2E crashed:', String(e.message ?? e).split('\n').slice(0, 8).join('\n'));
  ok('script ran to the end', false);
} finally {
  await browser.close();
  finish();
}
