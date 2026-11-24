#!/usr/bin/env node
// Starts a local PostgREST (Data API) against DATABASE_URL for the ERP screens. Development and the smoke test only; the binary is not in the repo.
//   POSTGREST_BIN=/tmp/claude-0/scratch/pgrst/postgrest DATABASE_URL=postgres://postgres@localhost:54322/erpui \
//   ERP_JWT_SECRET=<32+ chars> node scripts/erp-dev-postgrest.mjs        (listens on 127.0.0.1:3400, admin port 3401)
// The web app reads ERP_DATA_API_URL=http://127.0.0.1:3400, ERP_JWT_SECRET (same value) and ERP_AUTH_PROVIDER=dev.
import { spawn } from 'node:child_process';
import pg from 'pg';

const BIN = process.env.POSTGREST_BIN ?? '/tmp/claude-0/scratch/pgrst/postgrest';
const url = process.env.DATABASE_URL ?? 'postgres://postgres@localhost:54322/erpui';
const secret = process.env.ERP_JWT_SECRET ?? 'erp-dev-secret-at-least-32-characters-long!';
const port = Number(process.env.POSTGREST_PORT ?? 3400);
const role = 'erpui_authenticator';

const admin = new pg.Client({ connectionString: url });
await admin.connect();
await admin.query(`do $$ begin if not exists (select 1 from pg_roles where rolname = '${role}') then create role ${role} login noinherit nobypassrls; end if; end $$`);
await admin.query(`grant authenticated, anon, erp_server to ${role}`); // erp_server: only the public document check (/erp/verify) uses it
await admin.end();
const u = new URL(url);
u.username = role;
u.password = '';
const child = spawn(BIN, [], {
  env: { ...process.env, PGRST_DB_URI: u.toString(), PGRST_DB_SCHEMAS: 'erp,core,audit', PGRST_DB_ANON_ROLE: 'anon', PGRST_JWT_SECRET: secret, PGRST_SERVER_PORT: String(port),
    PGRST_SERVER_HOST: '127.0.0.1', PGRST_ADMIN_SERVER_PORT: String(port + 1), PGRST_DB_POOL: '10', PGRST_DB_MAX_ROWS: '20000' },
  stdio: 'inherit',
});
process.on('SIGTERM', () => child.kill());
process.on('SIGINT', () => child.kill());
child.on('exit', (code) => process.exit(code ?? 0));
