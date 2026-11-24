/**
 * The Data API path of decision 51: the ERP talks to Postgres through PostgREST as the signed-in user, so RLS is the only
 * barrier. This test starts a real PostgREST against the harness database and calls it with real signed JWTs:
 * a parent, an org A admin, an org B admin, an anonymous caller and a forged token.
 *
 * It runs only when POSTGREST_BIN points at a PostgREST binary (v12+); otherwise it is skipped, and the result must be reported
 * as "not run" (never as passed). Example:
 *   POSTGREST_BIN=/path/to/postgrest pnpm --filter @autoed/server test:platform
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import { DATABASE_URL, owner, ownerQuery } from './helpers';
import { buildWorld, type World } from './fixture';

const BIN = process.env.POSTGREST_BIN;
const PORT = Number(process.env.POSTGREST_PORT ?? 3399);
const ADMIN_PORT = PORT + 1;
const SECRET = 'erp-port-test-secret-at-least-32-characters-long';
const ROLE = 'erpport_authenticator';
const BASE = `http://127.0.0.1:${PORT}`;

const d = BIN ? describe : describe.skip;
let w: World;
let proc: ChildProcess | undefined;

const token = (sub: string, secret = SECRET, role = 'authenticated') =>
  new SignJWT({ role, sub }).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode(secret));

async function api(path: string, jwt: string | null, init: { method?: string; body?: unknown; profile?: string } = {}) {
  const profile = init.profile ?? 'erp';
  const res = await fetch(`${BASE}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      'Accept-Profile': profile, 'Content-Profile': profile, 'Content-Type': 'application/json', Prefer: 'return=representation',
      ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json: json as Record<string, unknown>[] & Record<string, unknown>, text };
}

beforeAll(async () => {
  if (!BIN) return;
  w = await buildWorld();
  await ownerQuery(`do $$ begin
      if not exists (select 1 from pg_roles where rolname = '${ROLE}') then create role ${ROLE} login noinherit nobypassrls; end if;
    end $$`);
  await ownerQuery(`grant authenticated, anon to ${ROLE}`);
  const u = new URL(DATABASE_URL);
  u.username = ROLE;
  u.password = '';
  proc = spawn(BIN, [], {
    env: {
      ...process.env, PGRST_DB_URI: u.toString(), PGRST_DB_SCHEMAS: 'erp,core', PGRST_DB_ANON_ROLE: 'anon', PGRST_JWT_SECRET: SECRET,
      PGRST_SERVER_PORT: String(PORT), PGRST_SERVER_HOST: '127.0.0.1', PGRST_ADMIN_SERVER_PORT: String(ADMIN_PORT), PGRST_DB_POOL: '3',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  proc.stderr?.on('data', (b) => { log += String(b); });
  proc.stdout?.on('data', (b) => { log += String(b); });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${ADMIN_PORT}/ready`)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`PostgREST did not start:\n${log}`);
}, 300000);

afterAll(async () => {
  proc?.kill();
  if (BIN) {
    await ownerQuery(`revoke authenticated, anon from ${ROLE}`).catch(() => undefined);
    await ownerQuery(`drop role if exists ${ROLE}`).catch(() => undefined);
  }
  await owner.end();
});

d('PostgREST (Data API) as parent, staff of two schools, anonymous and forged callers', () => {
  it('serves the erp schema (introspection works against the generated tables and functions)', async () => {
    const r = await fetch(`${BASE}/`, { headers: { 'Accept-Profile': 'erp', Authorization: `Bearer ${await token(w.u.aAdmin)}` } });
    expect(r.status).toBe(200);
    const spec = (await r.json()) as { paths: Record<string, unknown> };
    expect(Object.keys(spec.paths)).toEqual(expect.arrayContaining(['/receipts', '/fee_demands', '/rpc/collect_fee', '/rpc/read_staff_payroll']));
  });

  it('anonymous: nothing, on tables and functions', async () => {
    for (const p of ['/fee_demands', '/receipts', '/masters']) {
      const r = await api(p, null);
      expect([401, 403, 404]).toContain(r.status);
      expect(Array.isArray(r.json) ? r.json.length : 0).toBe(0);
    }
    expect([401, 403, 404]).toContain((await api('/rpc/verify_document', null, { method: 'POST', body: { p_code: 'RC-0123456789' } })).status);
  });

  it('a forged token (wrong secret) or a token for a role other than authenticated is refused', async () => {
    const forged = await api('/fee_demands', await token(w.u.aGuardian, 'x'.repeat(40)));
    expect(forged.status).toBe(401);
    const service = await api('/fee_demands', await token(w.u.aGuardian, SECRET, 'service_role'));
    expect([401, 403]).toContain(service.status); // the authenticator is not a member of service_role
    const noSub = await api('/fee_demands', await new SignJWT({ role: 'authenticated' }).setProtectedHeader({ alg: 'HS256' }).sign(new TextEncoder().encode(SECRET)));
    expect(noSub.status).toBe(200);
    expect(noSub.json).toEqual([]); // authenticated but no user: nothing
  });

  it('a parent reads only the own child\'s fees, receipts, report cards and transport', async () => {
    const jwt = await token(w.u.aGuardian);
    const demands = await api('/fee_demands?select=id,student_id,amount', jwt);
    expect(demands.status).toBe(200);
    expect(new Set(demands.json.map((r) => r.student_id))).toEqual(new Set([w.learnerA]));
    expect(demands.json).toHaveLength(2);
    const receipts = await api('/receipts?select=id,receipt_no,student_id', jwt);
    expect(receipts.json.map((r) => r.id)).toEqual([w.erpA.receipt]);
    const cards = await api('/report_cards?select=term,status', jwt);
    expect(cards.json).toEqual([{ term: 'Term 1', status: 'published' }]);
    const trips = await api('/trips?select=id', jwt);
    expect(trips.json.map((r) => r.id)).toEqual([w.erpA.trip1]);
    // asking for another family's rows by id returns nothing, not an error that leaks existence
    expect((await api(`/fee_demands?id=eq.${w.erpA.dOther1}`, jwt)).json).toEqual([]);
    expect((await api(`/receipts?student_id=eq.${w.coreA.other}`, jwt)).json).toEqual([]);
    expect((await api(`/trips?id=eq.${w.erpA.trip2}`, jwt)).json).toEqual([]);
    // staff-only data
    for (const t of ['fee_followups', 'safeguarding_incidents', 'payslips', 'staff_payroll', 'student_sensitive', 'vouchers', 'accounts']) {
      expect((await api(`/${t}`, jwt)).json, t).toEqual([]);
    }
  });

  it('a parent cannot write money or another family\'s data through the API', async () => {
    const jwt = await token(w.u.aGuardian);
    expect((await api('/receipts', jwt, { method: 'POST', body: { receipt_no: 'HACK-1', total: 1 } })).status).toBe(403);
    expect((await api('/fee_demands', jwt, { method: 'POST', body: { student_id: w.learnerA, head_id: w.erpA.dLearner1, amount: 1, due_date: '2026-12-01' } })).status).toBe(403);
    const patch = await api(`/fee_demands?id=eq.${w.erpA.dLearner2}`, jwt, { method: 'PATCH', body: { paid: 3000 } });
    expect([403, 200]).toContain(patch.status);
    expect(patch.status === 200 ? patch.json : []).toEqual([]); // no row is updated
    expect(Number((await ownerQuery(`select paid from erp.fee_demands where id = $1`, [w.erpA.dLearner2]))[0]!.paid)).toBeLessThan(3000);
    const wrongGate = await api('/gate_passes', jwt, { method: 'POST', body: { student_id: w.coreA.other, reason: 'x', requested_by: w.u.aGuardian, status: 'requested' } });
    expect(wrongGate.status).toBe(403);
    expect((await api('/rpc/read_student_sensitive', jwt, { method: 'POST', body: { p_student: w.coreA.other } })).status).toBe(403);
  });

  it('a parent opens the own child\'s health data and report card through the logged functions', async () => {
    const jwt = await token(w.u.aGuardian);
    const before = Number((await ownerQuery(`select count(*)::int as n from audit.log where action = 'erp.view' and actor_user_id = $1`, [w.u.aGuardian]))[0]!.n);
    const s = await api('/rpc/read_student_sensitive', jwt, { method: 'POST', body: { p_student: w.learnerA } });
    expect(s.status).toBe(200);
    expect(s.json.doctor_name).toBe('Dr Rao');
    const order = await api('/rpc/create_payment_order', jwt, { method: 'POST', body: { p_student: w.learnerA, p_allocations: [{ demand_id: w.erpA.dLearner2, amount: 100 }] } });
    expect(order.status).toBe(200);
    expect(Number((await ownerQuery(`select count(*)::int as n from audit.log where action = 'erp.view' and actor_user_id = $1`, [w.u.aGuardian]))[0]!.n) - before).toBe(1);
    expect((await api('/rpc/settle_payment_order', jwt, { method: 'POST', body: { p_order: order.json, p_gateway_payment_id: 'x', p_paid_amount: 100 } })).status).toBe(403); // server-only
  });

  it('an admin of org B reads only org B, cannot touch org A rows, and cannot call functions with org A ids', async () => {
    const jwt = await token(w.u.bAdmin);
    const mine = await api('/receipts?select=id', jwt);
    expect(mine.status).toBe(200);
    expect(mine.json.length).toBeGreaterThan(0);
    expect(mine.json.map((r) => r.id)).not.toContain(w.erpA.receipt);
    for (const t of ['fee_demands', 'students', 'masters']) {
      const r = await api(`/${t}?select=org_id`, jwt, { profile: t === 'students' ? 'core' : 'erp' });
      expect(new Set(r.json.map((x) => x.org_id)), t).toEqual(new Set([w.B.id]));
    }
    expect((await api(`/fee_demands?id=eq.${w.erpA.dLearner1}`, jwt)).json).toEqual([]);
    expect((await api(`/fee_demands?id=eq.${w.erpA.dLearner1}`, jwt, { method: 'PATCH', body: { note: 'x' } })).json).toEqual([]);
    expect((await api(`/fee_demands?id=eq.${w.erpA.dLearner1}`, jwt, { method: 'DELETE' })).json).toEqual([]);
    expect((await api('/masters', jwt, { method: 'POST', body: { org_id: w.A.id, type: 'house', name: 'planted' } })).status).toBe(403);
    const collect = await api('/rpc/collect_fee', jwt, { method: 'POST', body: { p: { allocations: [{ demand_id: w.erpA.dLearner1, amount: 1 }], payments: [{ mode: 'cash', amount: 1 }] } } });
    expect(collect.status).toBeGreaterThanOrEqual(400);
    expect((await api('/rpc/read_staff_payroll', jwt, { method: 'POST', body: { p_staff: w.coreA.adminStaff } })).status).toBe(403);
    expect((await ownerQuery(`select count(*)::int as n from erp.masters where name = 'planted'`))[0]!.n).toBe(0);
  });

  it('an org A admin collects a fee through the function (the only way to create a receipt) and the immutability rules hold over HTTP', async () => {
    const jwt = await token(w.u.aAdmin);
    const ok = await api('/rpc/collect_fee', jwt, { method: 'POST', body: { p: { idempotency_key: 'http-1', allocations: [{ demand_id: w.erpA.dLearner2, amount: 100 }], payments: [{ mode: 'cash', amount: 100 }] } } });
    expect(ok.status).toBe(200);
    const id = (ok.json as unknown as { receipt_ids: string[] }).receipt_ids[0]!;
    expect((await api(`/receipts?id=eq.${id}`, jwt, { method: 'PATCH', body: { total: 1 } })).status).toBe(403);
    expect((await api(`/receipts?id=eq.${id}`, jwt, { method: 'DELETE' })).json).toEqual([]);
    expect((await api('/receipts', jwt, { method: 'POST', body: { receipt_no: 'MANUAL-1', total: 5 } })).status).toBe(403);
    expect((await api('/staff_payroll', jwt)).json).toEqual([]); // closed even for the admin
    const payroll = await api('/rpc/read_staff_payroll', jwt, { method: 'POST', body: { p_staff: w.coreA.adminStaff } });
    expect(payroll.status).toBe(200);
    expect(payroll.json.bank_name).toBe('SBI');
  });
});
