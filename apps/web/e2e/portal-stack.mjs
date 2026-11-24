#!/usr/bin/env node
/**
 * Local stack for the portal e2e scripts: PostgREST against DATABASE_URL (the Data API of decision 51) behind a small
 * DEV-ONLY shim that plays the Supabase gateway:
 *
 *   /rest/v1/*        -> PostgREST (prefix stripped, CORS added)
 *   /auth/v1/otp      -> accepts a phone or e-mail and says "sent" (the code is always 123456)
 *   /auth/v1/verify   -> 123456 gives a session signed with the PostgREST secret
 *   /auth/v1/token    -> password (always `portal-dev-pass`) and refresh_token grants
 *   /__dev/session    -> ?email=... mints a session for a user (tests inject it into localStorage)
 *
 * It exists only here, in e2e. Nothing in apps/web or mobile-parent knows about it: they talk to a Supabase URL and anon key.
 * Usage (long running):  DATABASE_URL=... node apps/web/e2e/portal-stack.mjs   (needs POSTGREST_BIN, default /tmp/claude-0/scratch/pgrst/postgrest)
 * Exports start()/stop() for portal-all.mjs.
 */
import { spawn } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const pg = require(require.resolve('pg', { paths: [new URL('../../../packages/server/', import.meta.url).pathname] }));

export const SECRET = 'portal-e2e-dev-secret-at-least-32-characters-long';
export const DEV_CODE = '123456';
export const DEV_PASSWORD = 'portal-dev-pass';
export const ANON_KEY = 'portal-e2e-anon-key';
const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');

export function sign(claims, expiresInSec = 3600) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({ aud: 'authenticated', role: 'authenticated', iat: now, exp: now + expiresInSec, ...claims });
  return `${head}.${body}.${createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url')}`;
}

export function sessionFor(user, expiresInSec = 3600) {
  const access = sign({ sub: user.id, email: user.email ?? undefined, phone: user.phone ?? undefined }, expiresInSec);
  return {
    access_token: access, token_type: 'bearer', expires_in: expiresInSec, expires_at: Math.floor(Date.now() / 1000) + expiresInSec,
    refresh_token: `rt.${user.id}`, user: { id: user.id, aud: 'authenticated', role: 'authenticated', email: user.email, phone: user.phone ?? '' },
  };
}

export async function start({ databaseUrl = process.env.DATABASE_URL, pgrstPort = 3399, port = 3400, bin = process.env.POSTGREST_BIN ?? '/tmp/claude-0/scratch/pgrst/postgrest' } = {}) {
  const db = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  const ROLE = 'portal_authenticator';
  await db.query(`do $$ begin if not exists (select 1 from pg_roles where rolname = '${ROLE}') then create role ${ROLE} login noinherit nobypassrls; end if; end $$`);
  await db.query(`grant authenticated, anon to ${ROLE}`);
  const u = new URL(databaseUrl);
  u.username = ROLE;
  u.password = '';
  const proc = spawn(bin, [], {
    env: { ...process.env, PGRST_DB_URI: u.toString(), PGRST_DB_SCHEMAS: 'erp,core', PGRST_DB_ANON_ROLE: 'anon', PGRST_JWT_SECRET: SECRET,
      PGRST_SERVER_PORT: String(pgrstPort), PGRST_SERVER_HOST: '127.0.0.1', PGRST_ADMIN_SERVER_PORT: String(pgrstPort + 100), PGRST_DB_POOL: '4' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  proc.stderr.on('data', (b) => { log += String(b); });
  proc.stdout.on('data', (b) => { log += String(b); });
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    try { ready = (await fetch(`http://127.0.0.1:${pgrstPort + 100}/ready`)).ok; } catch { /* not up yet */ }
    if (!ready) await new Promise((r) => setTimeout(r, 200));
  }
  if (!ready) throw new Error(`PostgREST did not start:\n${log}`);

  const cors = {
    'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS',
    'access-control-expose-headers': '*', 'access-control-max-age': '600',
  };
  const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json', ...cors }); res.end(JSON.stringify(body)); };
  const readBody = (req) => new Promise((r) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => r(Buffer.concat(c))); });
  const findUser = async ({ email, phone, id }) => (await db.query(
    `select id, email, phone from auth.users where ($1::text is not null and lower(email) = lower($1)) or ($2::text is not null and regexp_replace(phone, '\\D', '', 'g') = regexp_replace($2, '\\D', '', 'g')) or ($3::uuid is not null and id = $3)`,
    [email ?? null, phone ?? null, id ?? null])).rows[0];

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    try {
      if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
      if (url.pathname.startsWith('/rest/v1/')) {
        const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await readBody(req);
        const headers = { ...req.headers }; delete headers.host; delete headers['content-length'];
        const r = await fetch(`http://127.0.0.1:${pgrstPort}/${url.pathname.slice('/rest/v1/'.length)}${url.search}`, { method: req.method, headers, body });
        const out = Buffer.from(await r.arrayBuffer());
        const h = Object.fromEntries([...r.headers.entries()].filter(([k]) => !['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(k)));
        res.writeHead(r.status, { ...h, ...cors });
        return res.end(out);
      }
      if (url.pathname === '/auth/v1/otp' && req.method === 'POST') {
        const b = JSON.parse((await readBody(req)).toString() || '{}');
        const user = await findUser(b);
        if (!user && !b.create_user) return json(res, 400, { code: 400, error_code: 'otp_disabled', msg: 'Signups not allowed for otp' });
        return json(res, 200, {});
      }
      if (url.pathname === '/auth/v1/verify' && req.method === 'POST') {
        const b = JSON.parse((await readBody(req)).toString() || '{}');
        const user = await findUser(b);
        if (!user || b.token !== DEV_CODE) return json(res, 403, { code: 403, error_code: 'otp_expired', msg: 'Token has expired or is invalid' });
        return json(res, 200, sessionFor(user));
      }
      if (url.pathname === '/auth/v1/token' && req.method === 'POST') {
        const b = JSON.parse((await readBody(req)).toString() || '{}');
        const grant = url.searchParams.get('grant_type');
        if (grant === 'password') {
          const user = await findUser(b);
          if (!user || b.password !== DEV_PASSWORD) return json(res, 400, { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
          return json(res, 200, sessionFor(user));
        }
        if (grant === 'refresh_token') {
          const user = await findUser({ id: String(b.refresh_token ?? '').replace(/^rt\./, '') });
          if (!user) return json(res, 400, { code: 400, error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token' });
          return json(res, 200, sessionFor(user));
        }
      }
      if (url.pathname === '/auth/v1/logout') { res.writeHead(204, cors); return res.end(); }
      if (url.pathname === '/auth/v1/user') {
        const tok = (req.headers.authorization ?? '').replace(/^Bearer /, '');
        const user = await findUser({ id: JSON.parse(Buffer.from(tok.split('.')[1] ?? 'e30', 'base64url').toString()).sub });
        return user ? json(res, 200, { id: user.id, email: user.email, phone: user.phone ?? '', aud: 'authenticated', role: 'authenticated' }) : json(res, 401, { msg: 'invalid' });
      }
      if (url.pathname === '/__dev/session') {
        const user = await findUser({ email: url.searchParams.get('email'), phone: url.searchParams.get('phone') });
        const ttl = Number(url.searchParams.get('ttl') ?? 3600);
        return user ? json(res, 200, sessionFor(user, ttl)) : json(res, 404, { msg: 'no such user' });
      }
      json(res, 404, { msg: 'not found' });
    } catch (e) {
      json(res, 500, { msg: String(e?.message ?? e) });
    }
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${port}`, pgrst: `http://127.0.0.1:${pgrstPort}`,
    async stop() {
      server.close(); proc.kill();
      await db.query(`revoke authenticated, anon from ${ROLE}`).catch(() => undefined);
      await db.query(`drop role if exists ${ROLE}`).catch(() => undefined);
      await db.end();
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const s = await start();
  console.log(`portal stack up: ${s.url} (anon key ${ANON_KEY}); Ctrl-C to stop`);
  process.on('SIGINT', async () => { await s.stop(); process.exit(0); });
  process.on('SIGTERM', async () => { await s.stop(); process.exit(0); });
}
void randomUUID;
