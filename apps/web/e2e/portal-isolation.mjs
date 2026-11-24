#!/usr/bin/env node
/**
 * Isolation proof for the portals, over the real Data API (PostgREST) and in the browser:
 *   - a parent reads only the own child's fees, receipts, report cards, attendance, bus and messages: never another family's
 *     (same school) and never another school's;
 *   - a student reads only the own row;
 *   - the portal functions refuse another family's or another school's child;
 *   - nothing is readable without a valid token;
 *   - every Data API answer the parent screens receive in the browser holds only the own child's rows.
 */
import { BASE, STACK, devSession, launch, openAs, reporter, rest, shot, text, world } from './portal-lib.mjs';

const R = reporter('portal isolation');
const A = world.learnerA;
const OTHER = world.otherA; // another family, same school
const B = world.learnerB; // another school
const tok = async (email) => (await devSession(email)).access_token;
const parent = await tok('guardian@a.test');
const other = await tok('other-parent@a.test');
const student = await tok('student@a.test');
const parentB = await tok('guardian@b.test');
const adminA = await tok('admin@a.test');
const ids = (rows, key = 'student_id') => [...new Set((rows ?? []).map((r) => r[key]))].sort();

console.log('Data API as the parent of the learner in school A');
const tables = [['erp', 'fee_demands'], ['erp', 'receipts'], ['erp', 'report_cards'], ['erp', 'payment_orders'], ['erp', 'gate_passes'], ['erp', 'conversations'], ['erp', 'student_transport'], ['erp', 'issued_documents'], ['erp', 'store_orders'], ['erp', 'assessment_results'], ['erp', 'growth_records'], ['core', 'student_attendance_marks'], ['core', 'students']];
for (const [profile, t] of tables) {
  const key = t === 'students' ? 'id' : 'student_id';
  const r = await rest(parent, `${t}?select=${key}`, { profile });
  R.ok(r.status === 200 && Array.isArray(r.json), `${profile}.${t}: 200`);
  const got = ids(r.json, key);
  R.ok(got.length > 0 && got.every((x) => x === A), `${profile}.${t}: only the own child (${got.length} id${got.length === 1 ? '' : 's'}: ${got.map((x) => (x === A ? 'own' : x.slice(0, 6))).join(',')})`);
}
const names = (await rest(adminA, `students?select=id,full_name&id=in.(${OTHER})`, { profile: 'core' })).json;
const otherName = names?.[0]?.full_name;
R.ok(Boolean(otherName), 'the other family\'s child has a name to look for in pages');
const namesB = (await rest(await tok('admin@b.test'), `students?select=id,full_name&id=in.(${B})`, { profile: 'core' })).json;
const nameB = namesB?.[0]?.full_name;

console.log('asking for other families and other schools by id');
for (const [profile, t] of [['erp', 'fee_demands'], ['erp', 'receipts'], ['erp', 'report_cards'], ['erp', 'conversations'], ['core', 'student_attendance_marks']]) {
  for (const [who, id] of [['other family', OTHER], ['other school', B]]) {
    const r = await rest(parent, `${t}?student_id=eq.${id}&select=id`, { profile });
    R.eq(r.json, [], `${profile}.${t} filtered to the ${who}'s child: nothing`);
  }
}
R.eq((await rest(parent, `students?id=eq.${B}&select=id`, { profile: 'core' })).json, [], 'core.students: the other school\'s child is invisible');
R.ok(!JSON.stringify((await rest(parent, 'organizations?select=name', { profile: 'core' })).json).includes('Riverdale'), 'core.organizations: only the own school');

console.log('portal functions refuse other children');
const otherCard = (await rest(adminA, `report_cards?student_id=eq.${OTHER}&status=eq.published&select=id`)).json?.[0]?.id;
const refused = async (label, r) => R.ok(r.status >= 400 && r.status < 500, `${label}: refused (${r.status} ${String(r.json?.message ?? '').slice(0, 40)})`);
await refused('portal_directory(other family)', await rest(parent, 'rpc/portal_directory', { method: 'POST', body: { p_student: OTHER } }));
await refused('portal_directory(other school)', await rest(parent, 'rpc/portal_directory', { method: 'POST', body: { p_student: B } }));
await refused('portal_results(other family)', await rest(parent, 'rpc/portal_results', { method: 'POST', body: { p_student: OTHER } }));
await refused('create_payment_order(other family)', await rest(parent, 'rpc/create_payment_order', { method: 'POST', body: { p_student: OTHER, p_allocations: [{ demand_id: world.erpA.dOther1, amount: 100 }] } }));
await refused('create_payment_order(own child, other family\'s fee)', await rest(parent, 'rpc/create_payment_order', { method: 'POST', body: { p_student: A, p_allocations: [{ demand_id: world.erpA.dOther1, amount: 100 }] } }));
await refused('open_report_card(other family)', await rest(parent, 'rpc/open_report_card', { method: 'POST', body: { p_id: otherCard } }));
await refused('book_ptm_slot(other family)', await rest(parent, 'rpc/book_ptm_slot', { method: 'POST', body: { p_slot: world.erpA.ptmSlot ?? '00000000-0000-0000-0000-000000000000', p_student: OTHER } }));
await refused('my_gate_pass_otp(other family\'s pass)', await rest(parent, 'rpc/my_gate_pass_otp', { method: 'POST', body: { p_pass: world.erpA.passes.other } }));
await refused('request_gate_pass(other family)', await rest(parent, 'rpc/request_gate_pass', { method: 'POST', body: { p_student: OTHER, p_reason: 'x' } }));
await refused('insert gate pass for the other family\'s child', await rest(parent, 'gate_passes', { method: 'POST', body: { student_id: OTHER, reason: 'x' } }));
await refused('insert fee demand (money is staff-only)', await rest(parent, 'fee_demands', { method: 'POST', body: { student_id: A, label: 'x', amount: 1, due_date: '2026-12-01' } }));
await refused('insert receipt (money is written by functions only)', await rest(parent, 'receipts', { method: 'POST', body: { student_id: A, total: 1 } }));
await refused('settle_payment_order (server-only function)', await rest(parent, 'rpc/settle_payment_order', { method: 'POST', body: { p_order: world.erpA.dLearner2, p_gateway_payment_id: 'x', p_paid_amount: 1 } }));
await refused('verify_document (server-only function)', await rest(parent, 'rpc/verify_document', { method: 'POST', body: { p_code: 'RC-0123456789' } }));
const w = await rest(parent, `fee_demands?id=eq.${world.erpA.dLearner2}`, { method: 'PATCH', body: { paid: 3000, status: 'paid' }, prefer: 'return=representation' });
R.ok(w.status === 403 || (Array.isArray(w.json) && w.json.length === 0), `a parent cannot mark a fee paid (${w.status})`);

console.log('the other family\'s parent and the parent of school B');
R.ok(!ids((await rest(other, 'fee_demands?select=student_id')).json).includes(A), 'other family: cannot see the first child\'s fees');
R.ok(ids((await rest(other, 'fee_demands?select=student_id')).json).every((x) => x === OTHER), 'other family: sees only its own child\'s fees');
const b = await rest(parentB, 'fee_demands?select=student_id');
R.ok(ids(b.json).length > 0 && ids(b.json).every((x) => x === B), 'school B parent: only school B\'s child');
R.eq((await rest(parentB, `fee_demands?student_id=eq.${A}&select=id`)).json, [], 'school B parent: nothing of school A');

console.log('the student');
R.eq(ids((await rest(student, 'students?select=id', { profile: 'core' })).json, 'id'), [A], 'student: core.students is the own row only (the sibling in the same household is not visible)');
R.ok(ids((await rest(student, 'fee_demands?select=student_id')).json).every((x) => x === A), 'student: erp rows of the own child only');
R.eq((await rest(student, `students?id=eq.${OTHER}&select=id`, { profile: 'core' })).json, [], 'student: another family\'s child is invisible');
R.eq((await rest(student, 'announcement_recipients?select=user_id')).json?.every?.((r) => r.user_id === (world.users.aStudent)), true, 'student: only own circulars');

console.log('no token, forged token');
const anon = await fetch(`${STACK}/rest/v1/fee_demands?select=id`, { headers: { 'accept-profile': 'erp' } });
R.ok([401, 403].includes(anon.status) || (await anon.json()).length === 0, `anonymous: nothing (${anon.status})`);
const forged = await fetch(`${STACK}/rest/v1/fee_demands?select=id`, { headers: { 'accept-profile': 'erp', authorization: `Bearer ${parent.slice(0, -4)}AAAA` } });
R.eq(forged.status, 401, 'forged token: 401');

console.log('in the browser: every Data API answer on the parent screens holds only the own child');
const browser = await launch();
{
  const { ctx, page, problems } = await openAs(browser, 'guardian@a.test');
  const seen = [];
  page.on('response', (r) => {
    if (!r.url().startsWith(`${STACK}/rest/v1/`) || r.request().method() === 'OPTIONS') return;
    seen.push(r.json().then((j) => ({ url: r.url(), rows: Array.isArray(j) ? j : [] }), () => ({ url: r.url(), rows: [] })));
  });
  const pages = ['', '/attendance', '/academics', '/fees', '/homework', '/calendar', '/bus', '/messages', '/requests', '/forms', '/ptm', '/pickup', '/more'];
  let combined = '';
  for (const p of pages) {
    await page.goto(`${BASE}/erp/parent${p}`);
    await page.waitForLoadState('networkidle');
    combined += `\n${await text(page)}`;
  }
  const rows = (await Promise.all(seen)).flatMap((x) => x.rows.map((r) => ({ ...r, __url: x.url })));
  R.ok(rows.length > 50, `the screens received ${rows.length} rows to check`);
  const foreign = rows.filter((r) => (r.student_id && r.student_id !== A) || (r.org_id && r.org_id !== world.orgA));
  R.eq(foreign.map((r) => r.__url.split('/rest/v1/')[1]?.slice(0, 50)), [], 'no row of another child or another school reached the browser');
  R.ok(!combined.includes(otherName) && (!nameB || !combined.includes(nameB)), 'no other child\'s name appears on any parent screen');
  R.ok(combined.includes('Greenfield Public School'), 'the school\'s own name is shown (branding)');
  await shot(page, 'isolation-parent-home');
  R.problems(problems);
  await ctx.close();
}
{
  const { ctx, page, problems } = await openAs(browser, 'student@a.test');
  await page.goto(`${BASE}/erp/student`);
  await page.waitForLoadState('networkidle');
  const t = await text(page);
  R.ok(!t.includes(otherName), 'student screen: no other child');
  await page.goto(`${BASE}/erp/parent`);
  await page.waitForURL(/\/erp\/student/);
  R.ok(page.url().includes('/erp/student'), 'a student who opens the parent portal is sent back to the student portal');
  R.problems(problems);
  await ctx.close();
}
await browser.close();
R.done();
