/**
 * scripts/migrate-crm-to-platform.mjs against the CRM's own demo seed.
 *
 * Needs a source database holding the CRM schema `autoed` loaded with the CRM's seed (see docs/crm-port.md, "Runbook"):
 *   SOURCE_DATABASE_URL=postgres://postgres@localhost:54322/crmsource pnpm --filter @autoed/crm-server test
 * Without SOURCE_DATABASE_URL the suite is skipped (CI has no CRM source database).
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asSystem, asUser } from '../src/db';
import { loadCtx } from '../src/auth';
import { listLeads, countLeads } from '../src/leads';
import { captureEnquiry } from '../src/core';
import { OWNER_URL, ownerQ, shutdown } from './helpers';

const SOURCE = process.env.SOURCE_DATABASE_URL;
const SCRIPT = join(__dirname, '..', '..', '..', 'scripts', 'migrate-crm-to-platform.mjs');
const run = (...args: string[]) => {
  try {
    const out = execFileSync('node', [SCRIPT, '--json', ...args], { env: { ...process.env, DATABASE_URL: OWNER_URL, SOURCE_DATABASE_URL: SOURCE!, APP_SECRET: 'test-secret' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, report: JSON.parse(out) };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, report: err.stdout ? JSON.parse(err.stdout) : null, stderr: err.stderr };
  }
};

describe.skipIf(!SOURCE)('CRM -> platform data migration (CRM demo seed)', () => {
  const src = new pg.Client({ connectionString: SOURCE });
  const s = async (sql: string, p: unknown[] = []) => (await src.query(sql, p)).rows;
  let tenants: { id: string; name: string }[];

  beforeAll(async () => {
    await src.connect();
    await src.query('set search_path = autoed');
    tenants = await s('select id, name from tenants order by name');
  });
  afterAll(async () => {
    await src.end();
    await shutdown();
  });

  it('--dry-run loads everything, reports, and rolls back', async () => {
    const r = run('--dry-run');
    expect(r.code, r.stderr).toBe(0);
    expect(r.report.ok).toBe(true);
    expect(r.report.committed).toBe(false);
    expect((await ownerQ('select count(*)::int n from core.organizations where id = any($1)', [tenants.map((t) => t.id)]))[0].n).toBe(0);
  });

  it('loads the demo seed: every table matches the source by count and checksum', async () => {
    const r = run();
    expect(r.code, r.stderr).toBe(0);
    expect(r.report.committed).toBe(true);
    const bad = r.report.checks.filter((c: { ok: boolean }) => !c.ok);
    expect(bad).toEqual([]);
    expect(r.report.checks.length).toBeGreaterThan(35);
    for (const t of tenants) {
      const want = async (sql: string) => (await s(sql, [t.id]))[0].n as number;
      const got = async (sql: string) => (await ownerQ(sql, [t.id]))[0].n as number;
      expect(await got('select count(*)::int n from crm.enquiries where org_id = $1'), t.name).toBe(await want('select count(*)::int n from enquiries where tenant_id = $1'));
      expect(await got('select count(*)::int n from crm.guardians where org_id = $1')).toBe(await want('select count(*)::int n from guardians where tenant_id = $1'));
      expect(await got('select count(*)::int n from crm.follow_ups where org_id = $1')).toBe(await want('select count(*)::int n from tasks where tenant_id = $1'));
      expect(await got('select count(*)::int n from crm.activities where org_id = $1')).toBe(await want('select count(*)::int n from activities where tenant_id = $1'));
      expect(await got('select count(*)::int n from core.students where org_id = $1')).toBe(await want('select count(distinct e.student_id)::int n from enquiries e join stages s on s.id = e.stage_id where s.is_won and e.tenant_id = $1'));
    }
  });

  it('is re-runnable: a second run inserts nothing and still reports OK', async () => {
    const before = (await ownerQ('select count(*)::int n from crm.enquiries'))[0].n;
    const r = run();
    expect(r.code, r.stderr).toBe(0);
    const inserted = Object.entries(r.report.tables as Record<string, { inserted: number }>).filter(([, v]) => v.inserted > 0);
    expect(inserted).toEqual([]);
    expect((await ownerQ('select count(*)::int n from crm.enquiries'))[0].n).toBe(before);
    expect(r.report.ok).toBe(true);
  });

  it('keeps the CRM rules working on the migrated data (RLS scope, masking, new leads, admission)', async () => {
    const [greenfield] = tenants.filter((t) => t.name === 'Greenfield Schools');
    const idOf = async (email: string) => (await s('select id from users where email = $1', [email]))[0].id as string;
    const anita = await idOf('anita@greenfield.demo'); // Group Admin: sees the whole org
    const priya = await idOf('priya@greenfield.demo'); // Counsellor: own records, Sensitive = Masked
    const ctxAnita = (await loadCtx(anita))!;
    expect(ctxAnita.roleName).toBe('Group Admin');
    expect(ctxAnita.orgId).toBe(greenfield!.id);
    const all = (await s('select count(*)::int n from enquiries e where e.tenant_id = $1 and e.year_id = (select id from academic_years where tenant_id = $1 and is_default)', [greenfield!.id]))[0].n;
    expect(await asUser(anita, ctxAnita.orgId, (db) => countLeads(db, ctxAnita, {}))).toBe(all);
    const ctxPriya = (await loadCtx(priya))!;
    expect(ctxPriya.roleName).toBe('Counsellor');
    const mine = (await s('select count(*)::int n from enquiries where owner_id = $1 and year_id = (select id from academic_years where tenant_id = $2 and is_default)', [priya, greenfield!.id]))[0].n;
    expect(await asUser(priya, ctxPriya.orgId, (db) => countLeads(db, ctxPriya, {}))).toBe(mine);
    // sensitive values: five enquiries got a family_income in the source before the load
    const withIncome = (await ownerQ("select id from crm.enquiry_sensitive where org_id = $1 and data ? 'family_income' limit 1", [greenfield!.id]))[0];
    if (withIncome) {
      const row = (r: { custom_full: Record<string, string> }[]) => r[0]!.custom_full.family_income;
      expect(row(await asUser(anita, ctxAnita.orgId, (db) => db.q('select custom_full from crm.enquiries_full where id = (select enquiry_id from crm.enquiry_sensitive limit 1)') as never))).toBe('10-15L');
    }
    // a new enquiry on the migrated org is routed by the migrated rules and creates a family, a child and a task
    const branch = (await ownerQ('select id from core.branches where org_id = $1 order by name limit 1', [greenfield!.id]))[0].id;
    const res = await asSystem(greenfield!.id, (db) => captureEnquiry(db, { studentName: 'Post Migration', guardianName: 'New Parent', mobile: '9876500011', branchId: branch, grade: 'Grade 1' }));
    expect(res.ok).toBe(true);
    const leads = await asUser(anita, ctxAnita.orgId, (db) => listLeads(db, ctxAnita, { q: 'post migration' }));
    expect(leads).toHaveLength(1);
  });

  it('puts the admitted children into core, one per won enquiry, with their families', async () => {
    const [greenfield] = tenants.filter((t) => t.name === 'Greenfield Schools');
    const n = (await ownerQ("select count(*)::int n from core.students where org_id = $1 and status = 'admitted'", [greenfield!.id]))[0].n;
    expect(n).toBeGreaterThan(20);
    const orphans = (await ownerQ('select count(*)::int n from core.students s where s.org_id = $1 and (s.household_id is null or not exists (select 1 from core.guardians g where g.household_id = s.household_id))', [greenfield!.id]))[0].n;
    expect(orphans).toBe(0);
    const consents = (await ownerQ("select count(*)::int n from core.consents where org_id = $1 and subject_type = 'guardian'", [greenfield!.id]))[0].n;
    expect(consents).toBeGreaterThanOrEqual(n * 4);
  });
});
