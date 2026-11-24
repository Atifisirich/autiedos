#!/usr/bin/env node
// Local database helper: reset | migrate | status  [--platform-only]
// Applies supabase/local/shim.sql (local only) then every file in supabase/migrations in order,
// tracking applied files in public._migrations. In production use `supabase db push`.
// --platform-only applies only the *_platform_*.sql migrations: an empty platform (core, app, audit,
// billing, private, crm/os/erp probes) without the legacy OS tables. Used by the isolation harness.
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const url = process.env.DATABASE_URL ?? 'postgres://postgres@localhost:54322/postgres';
const args = process.argv.slice(2);
const cmd = args.find((a) => !a.startsWith('--')) ?? 'migrate';
const platformOnly = args.includes('--platform-only') || process.env.MIGRATIONS === 'platform';
// Schemas owned by the migrations. Roles are cluster-wide and shared with other databases: never dropped.
const SCHEMAS = ['public', 'app', 'auth', 'storage', 'core', 'audit', 'billing', 'private', 'crm', 'os', 'erp'];

async function main() {
  if (cmd === 'reset') {
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    // One statement per schema: dropping them all in one transaction needs a lock per dropped table and index and runs out of
    // shared memory (max_locks_per_transaction) once core, os, crm and erp are all present.
    for (const n of SCHEMAS) await admin.query(`drop schema if exists ${n} cascade`);
    await admin.query('create schema public; grant all on schema public to public;');
    await admin.end();
  }
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const isLocal = /localhost|127\.0\.0\.1/.test(url);
  if (isLocal) await client.query(readFileSync(join(root, 'supabase/local/shim.sql'), 'utf8'));
  await client.query('create table if not exists public._migrations (name text primary key, applied_at timestamptz not null default now())');
  await client.query('alter table public._migrations enable row level security');
  const done = new Set((await client.query('select name from public._migrations')).rows.map((r) => r.name));
  const files = readdirSync(join(root, 'supabase/migrations')).filter((f) => f.endsWith('.sql'))
    .filter((f) => !platformOnly || new RegExp(process.env.MIGRATION_FILTER || '_platform_|_core_master_|_compliance|_crm_|_erp_|_os_').test(f)).sort();
  for (const f of files) {
    if (done.has(f)) continue;
    if (cmd === 'status') { console.log('pending', f); continue; }
    const sql = readFileSync(join(root, 'supabase/migrations', f), 'utf8');
    try {
      await client.query('begin');
      await client.query(sql);
      await client.query('insert into public._migrations(name) values ($1)', [f]);
      await client.query('commit');
      console.log('applied', f);
    } catch (e) {
      await client.query('rollback');
      console.error(`FAILED ${f}: ${e.message}`);
      if (e.position) {
        const pos = Number(e.position);
        console.error(sql.slice(Math.max(0, pos - 300), pos + 100));
      }
      process.exitCode = 1;
      break;
    }
  }
  await client.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
