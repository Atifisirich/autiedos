/**
 * Helpers of the portal e2e scripts (portal-*.mjs): browser with a 390 px phone viewport, a signed-in session injected the way
 * supabase-js stores it (dev shim of portal-stack.mjs: nothing like this exists in the app), page-error / 5xx collection, REST
 * calls with a user's token, and a tiny reporter. Scripts exit non-zero on any failed check or collected problem.
 */
import { createRequire } from 'node:module';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const { chromium } = createRequire(import.meta.url)('playwright');
const here = dirname(fileURLToPath(import.meta.url));

export const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3751';
export const STACK = process.env.STACK_URL ?? 'http://127.0.0.1:3650';
export const SHOTS = process.env.SHOT_DIR ?? join(here, 'portal-shots');
export const world = JSON.parse(readFileSync(process.env.PORTAL_WORLD_FILE ?? join(here, '.portal-world.json'), 'utf8'));
mkdirSync(SHOTS, { recursive: true });

export const launch = () => chromium.launch();

export async function devSession(email, ttl) {
  const r = await fetch(`${STACK}/__dev/session?email=${encodeURIComponent(email)}${ttl ? `&ttl=${ttl}` : ''}`);
  if (!r.ok) throw new Error(`no dev session for ${email}`);
  return r.json();
}

/** Problems found while a page runs: uncaught errors, console errors, failed requests with a 5xx. */
export function watch(page, problems, label = '') {
  page.on('pageerror', (e) => problems.push(`${label} page error: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/Failed to load resource/.test(t) && /(fonts\.g|ERR_INTERNET|net::ERR_FAILED|ERR_BLOCKED|ERR_ABORTED|offline)/.test(t + (m.location()?.url ?? ''))) return;
    if (/Failed to load resource: the server responded with a status of (401|403|404|406)/.test(t)) return; // asserted by the scripts that expect them
    problems.push(`${label} console error: ${t.slice(0, 240)}`);
  });
  page.on('response', (r) => { if (r.status() >= 500) problems.push(`${label} ${r.status()} ${r.url()}`); });
}

/** A phone-sized, signed-in page. `email` null gives a signed-out page. */
export async function openAs(browser, email, { lang = 'en', width = 390, height = 844, permissions = [], geolocation, ttl } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: lang === 'en' ? 'en-IN' : `${lang}-IN`, permissions, geolocation });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  const session = email ? await devSession(email, ttl) : null;
  await ctx.addInitScript(({ session, lang }) => {
    try {
      if (session && !localStorage.getItem('autoed-portal-auth')) localStorage.setItem('autoed-portal-auth', JSON.stringify(session));
      if (!localStorage.getItem('portal_lang')) localStorage.setItem('portal_lang', lang);
    } catch { /* blocked */ }
  }, { session, lang });
  const page = await ctx.newPage();
  const problems = [];
  watch(page, problems, email ?? 'anon');
  return { ctx, page, problems, session };
}

export async function shot(page, name) {
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
}

/** A Data API call as a user (token from devSession). */
export async function rest(token, path, { profile = 'erp', method = 'GET', body, prefer } = {}) {
  const r = await fetch(`${STACK}/rest/v1/${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'accept-profile': profile, 'content-profile': profile, authorization: `Bearer ${token}`, apikey: 'x', ...(prefer ? { prefer } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text };
}

export function reporter(name) {
  const failures = [];
  let n = 0;
  return {
    ok(cond, msg) { n += 1; if (cond) console.log(`  ok   ${msg}`); else { failures.push(msg); console.log(`  FAIL ${msg}`); } },
    eq(a, b, msg) { this.ok(JSON.stringify(a) === JSON.stringify(b), `${msg}${JSON.stringify(a) === JSON.stringify(b) ? '' : ` (got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)})`}`); },
    problems(list) { for (const p of list) { n += 1; failures.push(p); console.log(`  PROBLEM ${p}`); } if (!list.length) { n += 1; console.log('  ok   no page errors, console errors or 5xx responses'); } },
    done() {
      console.log(`${failures.length ? 'FAILED' : 'PASSED'} ${name}: ${n - failures.length}/${n} checks`);
      process.exit(failures.length ? 1 : 0);
    },
  };
}

export const text = (page) => page.evaluate(() => document.body.innerText);
