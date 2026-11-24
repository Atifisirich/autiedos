/**
 * Shared bits of the CRM browser scripts (apps/web/e2e/crm-*.mjs).
 *
 *   BASE_URL     the running web app (default http://localhost:3000); start it with the CRM environment
 *                (CRM_DATABASE_URL, JOB_DATABASE_URL, AUTH_JWT_SECRET, AUTH_PROVIDER=dev, DEMO_PAYMENTS=1)
 *   CRM_SEED     the people from `tsx e2e/crm-seed.ts` (admin@demo.test, meera@demo.test, ...)
 *   OUT_DIR      where screenshots go (default /tmp/crm-shots)
 *
 * Playwright comes from the project when installed there, else from the machine (NODE_PATH or /opt/node-tools).
 */
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const req = createRequire(import.meta.url);
function loadPlaywright() {
  for (const p of ['playwright', '/opt/node-tools/node_modules/playwright']) {
    try {
      return req(p);
    } catch {
      /* try the next place */
    }
  }
  throw new Error('Playwright is not installed. Set NODE_PATH to a node_modules that has it.');
}
export const { chromium } = loadPlaywright();

export const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
export const OUT = process.env.OUT_DIR ?? '/tmp/crm-shots';
mkdirSync(OUT, { recursive: true });

/** The preinstalled Chromium when Playwright's own download is missing. */
function chromePath() {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers';
  if (!existsSync(root)) return undefined;
  const dir = readdirSync(root).find((d) => /^chromium-\d+$/.test(d));
  const exe = dir && join(root, dir, 'chrome-linux64', 'chrome');
  return exe && existsSync(exe) ? exe : undefined;
}
export async function launch() {
  try {
    return await chromium.launch();
  } catch {
    return chromium.launch({ executablePath: chromePath(), args: ['--no-sandbox'] });
  }
}

export const results = { failures: 0, passed: 0 };
export function ok(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (cond) results.passed++;
  else results.failures++;
}
export function finish() {
  console.log(results.failures ? `\n${results.failures} check(s) failed, ${results.passed} passed` : `\nAll ${results.passed} checks passed`);
  process.exit(results.failures ? 1 : 0);
}

/**
 * A signed-in page. Collects page errors, console errors and 5xx answers of /api/crm into `problems`; the caller decides
 * what to do with them (the scripts fail on any).
 */
export async function session(browser, email, { width = 1280, height = 900, problems = [] } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  const page = await ctx.newPage();
  let where = '';
  page.on('pageerror', (e) => problems.push(`${email} ${where}: page error ${e.message.slice(0, 200)}`));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && problems.push(`${email} ${where}: console ${m.text().slice(0, 200)}`));
  page.on('response', (r) => r.url().includes('/api/crm/') && r.status() >= 500 && problems.push(`${email} ${where}: ${r.status()} ${r.url()}`));
  page.on('dialog', (d) => d.accept());
  page.setWhere = (w) => (where = w);
  const login = await page.request.post(`${BASE}/api/crm/auth/dev-login`, { data: { email } });
  if (!login.ok()) throw new Error(`login failed for ${email}: ${login.status()} ${await login.text()}`);
  return page;
}
export const settle = (page) => page.waitForLoadState('networkidle');
export const text = (page) => page.locator('body').innerText();
export const shot = (page, name) => page.screenshot({ path: join(OUT, name + '.png') });
export const go = async (page, path) => {
  page.setWhere?.(path);
  await page.goto(BASE + path, { waitUntil: 'networkidle' });
};
export const stamp = () => String(Date.now()).slice(-7);
