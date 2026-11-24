#!/usr/bin/env node
/**
 * Opens every CRM screen at desktop (1280 px) and phone (390 px) width, as the roles that use it, screenshots it
 * (device scale 1) and checks it: no console or server errors, no sideways scrolling at phone width, every field and
 * button has an accessible name, a page title and one main landmark.
 *
 *   BASE_URL=http://localhost:3217 [OUT_DIR=/tmp/crm-shots] [SHOTS=1] node e2e/crm-shots.mjs
 * Set SHOTS=0 to run the checks without writing screenshots.
 */
import { BASE, finish, go, launch, ok, session, shot } from './crm-lib.mjs';

const WIDTHS = [1280, 390];
const SHOTS = process.env.SHOTS !== '0';
const browser = await launch();
const problems = [];

/** Fields, buttons and links without a name a screen reader could read. */
const audit = () => {
  const bad = [];
  const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const nameOf = (el) => (el.getAttribute('aria-label') || el.getAttribute('title') || '').trim() || (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent?.trim()) || el.closest('label')?.textContent?.trim() || (el.getAttribute('aria-labelledby') && document.getElementById(el.getAttribute('aria-labelledby'))?.textContent?.trim()) || '';
  for (const el of document.querySelectorAll('input,select,textarea')) {
    if (el.type === 'hidden' || !visible(el)) continue;
    if (el.type === 'checkbox' || el.type === 'radio' ? !nameOf(el) : !nameOf(el) && !el.getAttribute('placeholder')) bad.push(`${el.tagName.toLowerCase()}[name=${el.name || '?'}]`);
  }
  for (const el of document.querySelectorAll('button,a[href]')) {
    if (!visible(el)) continue;
    if (!(el.textContent || '').trim() && !nameOf(el)) bad.push(`${el.tagName.toLowerCase()} without a name`);
  }
  const imgs = [...document.querySelectorAll('img')].filter((i) => !i.getAttribute('alt') && i.getAttribute('role') !== 'presentation').length;
  return { bad: [...new Set(bad)].slice(0, 8), mains: document.querySelectorAll('main').length, title: document.title, imgs, sideways: document.documentElement.scrollWidth > window.innerWidth + 1, scrollWidth: document.documentElement.scrollWidth };
};

async function look(page, path, name, width, { requireMain = true } = {}) {
  await go(page, path);
  await page.waitForTimeout(400);
  const r = await page.evaluate(audit);
  const label = `${name} @${width}`;
  ok(`${label}: no sideways scrolling`, width > 500 || !r.sideways, r.sideways ? `scrollWidth ${r.scrollWidth}` : '');
  ok(`${label}: fields and buttons have names`, r.bad.length === 0 && r.imgs === 0, r.bad.join(', '));
  ok(`${label}: one main landmark and a title`, (!requireMain || r.mains === 1) && !!r.title, `mains=${r.mains} title="${r.title}"`);
  if (SHOTS) await shot(page, `${name}-${width}`);
}

try {
  // Tokens for the public pages: the first family's application link.
  const probe = await session(browser, 'admin@demo.test', { problems });
  const leads = await (await probe.request.get(`${BASE}/api/crm/leads?size=1&view=kanban`)).json();
  const first = leads.data[0];
  const hh = await (await probe.request.get(`${BASE}/api/crm/households/${first.household_id}?e=${first.id}`)).json();
  const applyPath = new URL(hh.publicApplyUrl, BASE).pathname;
  const apps = await (await probe.request.get(`${BASE}/api/crm/applications`)).json();
  const withApp = apps.rows[0];

  const ROUTES = {
    admin: [
      ['home', '/crm'], ['leads', '/crm/leads'], ['leads-kanban', '/crm/leads?view=kanban&phase=enquiry'], ['leads-cards', '/crm/leads?view=cards'], ['family', `/crm/households/${first.household_id}?e=${first.id}`],
      ['inbox', '/crm/inbox?f=all'], ['tasks', '/crm/tasks?who=team'], ['tasks-calendar', '/crm/tasks?view=calendar&who=team'], ['visits', '/crm/visits'], ['applications', '/crm/applications'],
      ...(withApp ? [['application', `/crm/applications/${withApp.enquiry_id}`]] : []), ['campaigns', '/crm/campaigns'], ['reports', '/crm/reports'], ['walkin', '/crm/walkin'], ['account', '/crm/account'], ['admin', '/crm/admin'],
      ...['org', 'users', 'roles', 'fields', 'pipeline', 'sources', 'routing', 'templates', 'forms', 'workflows', 'integrations', 'wallet', 'data', 'audit', 'help'].map((s) => [`admin-${s}`, `/crm/admin/${s}`]),
    ],
    'meera@demo.test': [['counsellor-home', '/crm'], ['counsellor-leads', '/crm/leads'], ['counsellor-reports', '/crm/reports']],
    'desk@demo.test': [['desk-walkin', '/crm/walkin'], ['desk-visits', '/crm/visits']],
  };
  const pub = [['public-form', '/crm/f/greenfield-enquiry'], ['public-apply', applyPath], ['login', '/crm/login']];

  for (const width of WIDTHS) {
    for (const [who, list] of Object.entries(ROUTES)) {
      const email = who === 'admin' ? 'admin@demo.test' : who;
      const page = await session(browser, email, { width, height: width > 500 ? 900 : 844, problems });
      for (const [name, path] of list) await look(page, path, name, width);
      await page.context().close();
    }
    const anon = await (await browser.newContext({ viewport: { width, height: width > 500 ? 900 : 844 }, deviceScaleFactor: 1 })).newPage();
    anon.on('pageerror', (e) => problems.push(`public: ${e.message.slice(0, 160)}`));
    anon.setWhere = () => undefined;
    for (const [name, path] of pub) await look(anon, path, name, width, { requireMain: true });
    await anon.context().close();
  }
  ok('No page errors, console errors or server errors on any screen', problems.length === 0, problems.slice(0, 4).join(' | '));
} catch (e) {
  console.error('crashed:', String(e.message ?? e).split('\n').slice(0, 8).join('\n'));
  ok('script ran to the end', false);
} finally {
  await browser.close();
  finish();
}
