#!/usr/bin/env node
/**
 * Browser smoke test: signs in as each demo role (dev login) and opens every screen in /os,
 * failing on uncaught page errors, console errors or API 5xx responses.
 * Usage: BASE_URL=http://localhost:3100 node apps/web/e2e/smoke.mjs
 */
import { createRequire } from 'node:module';

// Uses the Playwright install on the machine (or the project's, if added as a dependency).
const { chromium } = createRequire(import.meta.url)('playwright');

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const ROUTES = ['/os', '/os/tasks', '/os/tasks/new', '/os/tasks/week', '/os/tasks/day-close', '/os/checklists', '/os/attendance', '/os/student-attendance', '/os/leave', '/os/approvals', '/os/approvals/new', '/os/approvals/types', '/os/timetable', '/os/substitution', '/os/duty', '/os/lesson-plans', '/os/lesson-plans/new', '/os/lesson-plans/annual', '/os/lesson-plans/library', '/os/coverage', '/os/class-log', '/os/exams', '/os/exams/papers', '/os/exams/blueprints', '/os/observation', '/os/observation/appraisal', '/os/helpdesk', '/os/helpdesk/new', '/os/circulars', '/os/circulars/new', '/os/calendar', '/os/meetings', '/os/events', '/os/incidents', '/os/compliance', '/os/reports', '/os/reports/task_performance', '/os/inbox', '/os/ai-credits', '/os/settings', '/os/setup', '/os/setup/staff', '/os/setup/roles', '/os/setup/org-chart', '/os/setup/config', '/os/setup/config/leave_types', '/os/setup/modules'];
const USERS = (process.env.SMOKE_USERS ?? 'principal@demo.school,deepa.teacher9@demo.school').split(',');
const LANGS = (process.env.SMOKE_LANGS ?? 'en,hi,te').split(',');

const browser = await chromium.launch();
const problems = [];
for (const email of USERS) {
  for (const lang of LANGS) {
    const ctx = await browser.newContext();
    await ctx.addInitScript((l) => localStorage.setItem('os_lang', l), lang);
    await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort()); // keep the test hermetic
    const page = await ctx.newPage();
    let where = '';
    page.on('pageerror', (e) => problems.push(`${email} ${lang} ${where}: page error ${e.message}`));
    page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && problems.push(`${email} ${lang} ${where}: console ${m.text().slice(0, 200)}`));
    page.on('response', (r) => r.url().includes('/api/os/') && r.status() >= 500 && problems.push(`${email} ${lang} ${where}: ${r.status()} ${r.url()}`));
    const login = await page.request.post(`${BASE}/api/os/auth/dev-login`, { data: { email } });
    if (!login.ok()) {
      problems.push(`${email}: login failed ${login.status()}`);
      await ctx.close();
      continue;
    }
    for (const r of ROUTES) {
      where = r;
      await page.goto(`${BASE}${r}`, { waitUntil: 'networkidle' });
      const raw = await page.evaluate(() => [...document.body.innerText.matchAll(/\b[a-z][A-Za-z]+\.[a-z][A-Za-z_.]+\b/g)].map((m) => m[0]).filter((k) => !/\.(school|dev|com|in|ics|xlsx|docx|pdf)$/.test(k)));
      if (raw.length) problems.push(`${email} ${lang} ${r}: untranslated keys ${[...new Set(raw)].slice(0, 5).join(', ')}`);
    }
    if (lang === 'en') await page.screenshot({ path: `/tmp/claude-0/smoke-${email.split('@')[0]}.png`, fullPage: false });
    await ctx.close();
  }
}
await browser.close();
if (problems.length) {
  console.error(problems.join('\n'));
  console.error(`\n${problems.length} problem(s)`);
  process.exit(1);
}
console.log(`smoke OK: ${USERS.length} users × ${LANGS.length} languages × ${ROUTES.length} screens`);
