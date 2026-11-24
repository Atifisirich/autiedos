#!/usr/bin/env node
/**
 * Runs the portal e2e scripts against a local stack, from nothing:
 *   1. rebuilds the harness world in DATABASE_URL (use your own database: it is emptied) and adds the portal rows,
 *   2. starts PostgREST + the dev auth shim (portal-stack.mjs) on :3650,
 *   3. builds (if needed) and starts the web app on :3751 against it,
 *   4. runs portal-isolation, portal-parent, portal-student and portal-driver (or the names given as arguments),
 *   5. stops everything.
 *
 *   DATABASE_URL=postgres://postgres@localhost:54322/portal node apps/web/e2e/portal-all.mjs [isolation parent student driver]
 *   PORTAL_BUILD=1 forces `next build`; PORTAL_DEV=1 uses `next dev` (slower pages, no service worker).
 * Needs: the PostgREST binary (POSTGREST_BIN, default /tmp/claude-0/scratch/pgrst/postgrest) and Playwright with Chromium.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { start, ANON_KEY } from './portal-stack.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const web = join(here, '..');
const DB = process.env.DATABASE_URL;
if (!DB) throw new Error('DATABASE_URL is required (your own database: it is emptied and rebuilt)');
const PORT = Number(process.env.PORTAL_WEB_PORT ?? 3751);
const stackUrl = 'http://127.0.0.1:3650';
const env = {
  ...process.env, NEXT_PUBLIC_SUPABASE_URL: stackUrl, NEXT_PUBLIC_SUPABASE_ANON_KEY: ANON_KEY, NEXT_PUBLIC_PORTAL_DEV_AUTH: '1',
  ERP_PAYMENTS_PROVIDER: 'mock', ERP_SERVER_DATABASE_URL: DB, ERP_SERVER_SET_ROLE: '1', BASE_URL: `http://127.0.0.1:${PORT}`, STACK_URL: stackUrl, NEXT_TELEMETRY_DISABLED: '1',
};
const only = process.argv.slice(2);
const scripts = (only.length ? only : ['isolation', 'parent', 'student', 'driver']).map((n) => `portal-${n}.mjs`);

console.log('== world');
let r = spawnSync('node', ['--import', 'tsx', join(here, 'portal-world.mjs')], { cwd: root, env, stdio: 'inherit' });
if (r.status !== 0) process.exit(r.status ?? 1);

console.log('== stack');
const stack = await start({ databaseUrl: DB });

let nextProc;
const stop = async () => { nextProc?.kill(); await stack.stop().catch(() => undefined); };
process.on('SIGINT', () => void stop().then(() => process.exit(130)));

try {
  const dev = process.env.PORTAL_DEV === '1';
  // NEXT_PUBLIC_* values are inlined at build time: rebuild when the build was made for another stack address
  const marker = join(web, '.next/portal-build-url');
  const built = existsSync(marker) ? readFileSync(marker, 'utf8') : '';
  if (!dev && (process.env.PORTAL_BUILD === '1' || !existsSync(join(web, '.next/BUILD_ID')) || built !== stackUrl)) {
    console.log('== next build');
    r = spawnSync('pnpm', ['--filter', '@autoed/web', 'build'], { cwd: root, env, stdio: 'inherit' });
    if (r.status !== 0) throw new Error('build failed');
    writeFileSync(marker, stackUrl);
  }
  console.log(`== web (${dev ? 'dev' : 'start'}) on :${PORT}`);
  nextProc = spawn(join(web, 'node_modules/.bin/next'), [dev ? 'dev' : 'start', '-p', String(PORT)], { cwd: web, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  nextProc.stdout.on('data', (b) => { log += String(b); });
  nextProc.stderr.on('data', (b) => { log += String(b); });
  let up = false;
  for (let i = 0; i < 150 && !up; i++) {
    try { up = (await fetch(`${env.BASE_URL}/erp/signin`)).ok; } catch { /* not yet */ }
    if (!up) await new Promise((res) => setTimeout(res, 400));
  }
  if (!up) throw new Error(`web did not start:\n${log.slice(-2000)}`);

  let failed = 0;
  for (const s of scripts) {
    console.log(`\n== ${s}`);
    // asynchronous on purpose: the dev auth shim runs in this process and must keep answering while a script runs
    const code = await new Promise((done) => spawn('node', [join(here, s)], { cwd: root, env, stdio: 'inherit' }).on('exit', (c) => done(c ?? 1)));
    if (code !== 0) failed += 1;
  }
  console.log(failed ? `\n${failed} script(s) FAILED` : '\nall portal e2e scripts passed');
  await stop();
  process.exit(failed ? 1 : 0);
} catch (e) {
  console.error(e);
  await stop();
  process.exit(1);
}
