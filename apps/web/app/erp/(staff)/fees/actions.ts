'use server';
import { getCtx } from '@/lib/erp/ctx';
import { core, erp } from '@/lib/erp/db';
import { go, str, numv, today, inr } from '@/lib/erp/fmt';
import { balance, billable, lateFine, type Demand, type FineRule } from '@autoed/shared/erp';

/** Counter collection: one call to erp.collect_fee, the only way to create a receipt (it posts receipts, allocations, payments and the voucher). */
export async function collectFee(fd: FormData) {
  const ctx = await getCtx();
  const student = str(fd, 'student')!;
  const allocations = [...fd.entries()].filter(([k, v]) => k.startsWith('a_') && Number(v) > 0).map(([k, v]) => ({ demand_id: k.slice(2), amount: Number(v) }));
  const total = allocations.reduce((t, a) => t + a.amount, 0);
  if (!allocations.length) go(`/erp/fees/counter?student=${student}`, 'Enter an amount against at least one fee.', 'err');
  const payments = [1, 2, 3].map((n) => ({ mode: str(fd, `mode${n}`), amount: numv(fd, `amount${n}`), reference: str(fd, `ref${n}`), cheque_no: str(fd, `cheque_no${n}`), cheque_bank: str(fd, `cheque_bank${n}`), cheque_date: str(fd, `cheque_date${n}`) })).filter((p) => p.mode && (p.amount ?? 0) > 0);
  // A single mode with no amount typed means "the whole bill in this mode".
  if (payments.length === 0 && str(fd, 'mode1')) payments.push({ mode: str(fd, 'mode1'), amount: total, reference: str(fd, 'ref1'), cheque_no: str(fd, 'cheque_no1'), cheque_bank: str(fd, 'cheque_bank1'), cheque_date: str(fd, 'cheque_date1') });
  const { data, error } = await erp(ctx.sb).rpc('collect_fee', { p: { allocations, payments, date: str(fd, 'date') ?? today(), note: str(fd, 'note'), idempotency_key: str(fd, 'key') } });
  if (error) go(`/erp/fees/counter?student=${student}`, error.message, 'err');
  const r = data as { receipt_ids: string[]; duplicate?: boolean };
  go(`/erp/receipt/${r.receipt_ids.join(',')}`, r.duplicate ? 'This payment was already saved. Showing the existing receipt.' : `Receipt issued for ${inr(total)}.`);
}

export async function savePlan(fd: FormData) {
  const ctx = await getCtx();
  const { data, error } = await erp(ctx.sb).from('fee_plans').insert({ name: str(fd, 'name'), programme_id: str(fd, 'programme_id'), category: str(fd, 'category'), academic_year_id: ctx.year?.id, branch_id: ctx.branchId ?? ctx.orgUser.home_branch_id ?? ctx.branches[0]?.id }).select('id').single();
  go(error ? '/erp/fees/structure' : `/erp/fees/structure?plan=${data!.id}`, error ? error.message : 'Plan created. Add its instalments.', error ? 'err' : 'ok');
}
export async function savePlanItem(fd: FormData) {
  const ctx = await getCtx();
  const plan = str(fd, 'plan_id')!;
  const { error } = await erp(ctx.sb).from('fee_plan_items').insert({ plan_id: plan, head_id: str(fd, 'head_id'), instalment: str(fd, 'instalment'), amount: numv(fd, 'amount'), due_date: str(fd, 'due_date') });
  go(`/erp/fees/structure?plan=${plan}`, error ? error.message : 'Instalment added.', error ? 'err' : 'ok');
}
export async function deletePlanItem(fd: FormData) {
  const ctx = await getCtx();
  const plan = str(fd, 'plan_id')!;
  const { count } = await erp(ctx.sb).from('fee_demands').select('id', { count: 'exact', head: true }).eq('plan_item_id', str(fd, 'id')!);
  if (count) go(`/erp/fees/structure?plan=${plan}`, 'Demands were already raised from this instalment, so it cannot be removed.', 'err');
  await erp(ctx.sb).from('fee_plan_items').delete().eq('id', str(fd, 'id')!);
  go(`/erp/fees/structure?plan=${plan}`, 'Removed.');
}

/** Raise demands from a plan for every active student it applies to, or one student. Re-running never duplicates (FEE-02). */
export async function generateDemands(fd: FormData) {
  const ctx = await getCtx();
  const planId = str(fd, 'plan_id')!, only = str(fd, 'student_id');
  const [{ data: plan }, { data: items }] = await Promise.all([erp(ctx.sb).from('fee_plans').select('*').eq('id', planId).single(), erp(ctx.sb).from('fee_plan_items').select('*').eq('plan_id', planId).is('deleted_at', null)]);
  const I = (items ?? []) as { id: string; head_id: string; instalment: string; amount: number; due_date: string }[];
  if (!plan || !I.length) go(`/erp/fees/structure?plan=${planId}`, 'Add instalments to the plan first.', 'err');
  let q = core(ctx.sb).from('students').select('id, branch_id, joined_on, programme_id').eq('status', 'active').is('deleted_at', null);
  if (only) q = q.eq('id', only);
  else { if (plan!.programme_id) q = q.eq('programme_id', plan!.programme_id); if (plan!.branch_id) q = q.eq('branch_id', plan!.branch_id); }
  const { data: students } = await q.limit(10000);
  const S = (students ?? []) as { id: string; branch_id: string; joined_on: string | null }[];
  if (!S.length) go(`/erp/fees/structure?plan=${planId}`, 'No active students match this plan.', 'err');
  const have = new Set<string>();
  for (let i = 0; i < S.length; i += 100) {
    const { data: existing } = await erp(ctx.sb).from('fee_demands').select('student_id, plan_item_id').in('plan_item_id', I.map((x) => x.id)).in('student_id', S.slice(i, i + 100).map((s) => s.id)).is('deleted_at', null);
    for (const e of (existing ?? []) as { student_id: string; plan_item_id: string }[]) have.add(`${e.student_id}:${e.plan_item_id}`);
  }
  const rows = S.flatMap((s) => I.filter((i) => !have.has(`${s.id}:${i.id}`) && billable(i.due_date, s.joined_on)).map((i) => ({
    student_id: s.id, branch_id: s.branch_id, academic_year_id: plan!.academic_year_id, head_id: i.head_id, plan_item_id: i.id, label: `${plan!.name} · ${i.instalment}`, amount: i.amount, due_date: i.due_date })));
  for (let i = 0; i < rows.length; i += 500) { const { error } = await erp(ctx.sb).from('fee_demands').insert(rows.slice(i, i + 500)); if (error) go(`/erp/fees/structure?plan=${planId}`, error.message, 'err'); }
  go(only ? `/erp/students/${only}?tab=fees` : `/erp/fees/structure?plan=${planId}`, `${rows.length} fee demands raised for ${S.length} students. Students who left or joined later are skipped by rule.`);
}

export async function addDemand(fd: FormData) {
  const ctx = await getCtx();
  const student = str(fd, 'student_id')!;
  const { data: s } = await core(ctx.sb).from('students').select('branch_id').eq('id', student).single();
  const { error } = await erp(ctx.sb).from('fee_demands').insert({ student_id: student, branch_id: s?.branch_id, academic_year_id: ctx.year?.id, head_id: str(fd, 'head_id'), label: str(fd, 'label'), amount: numv(fd, 'amount'), due_date: str(fd, 'due_date') ?? today() });
  go(`/erp/fees/counter?student=${student}`, error ? error.message : 'Fee added.', error ? 'err' : 'ok');
}

export async function applyLateFees() {
  const ctx = await getCtx();
  const rule = ((ctx.org.settings ?? {}) as { late_fee?: FineRule }).late_fee ?? { type: 'none' as const };
  if (rule.type === 'none') go('/erp/fees/dues', 'No late-fee rule is set. Set one in Admin console → Organisation and settings.', 'err');
  const d = today();
  const { data } = await erp(ctx.sb).from('fee_demands').select('id, amount, concession, fine, paid, due_date').in('status', ['due', 'partial']).lt('due_date', d).is('deleted_at', null).limit(10000);
  let n = 0;
  for (const dem of (data ?? []) as Demand[]) {
    const fine = lateFine(dem, d, rule);
    if (fine !== Number(dem.fine)) { await erp(ctx.sb).from('fee_demands').update({ fine }).eq('id', dem.id); n++; }
  }
  go('/erp/fees/dues', `Late fees updated on ${n} instalments.`);
}

export async function logFollowup(fd: FormData) {
  const ctx = await getCtx();
  const student = str(fd, 'student_id')!;
  const type = str(fd, 'type') ?? 'call';
  await erp(ctx.sb).from('fee_followups').insert({ student_id: student, type, note: str(fd, 'note'), promise_date: str(fd, 'promise_date'), promise_amount: numv(fd, 'promise_amount'), by_name: ctx.name, by_user_id: ctx.user.id });
  if (type === 'message') {
    const { data: s } = await core(ctx.sb).from('students').select('first_name, household_id').eq('id', student).single();
    const { data: gs } = await core(ctx.sb).from('guardians').select('user_id').eq('household_id', (s as { household_id: string } | null)?.household_id ?? '00000000-0000-0000-0000-000000000000').not('user_id', 'is', null);
    const amount = str(fd, 'amount');
    const notes = ((gs ?? []) as { user_id: string }[]).map((g) => ({ user_id: g.user_id, product_key: 'erp', event_key: 'fee_due', title: `Fee reminder for ${(s as { first_name: string } | null)?.first_name}`, body: `Rs ${amount} is pending. You can pay in the app.`, link: '/erp/parent/fees', dedupe_key: `fee:${student}:${today()}:${g.user_id}` }));
    if (notes.length) await core(ctx.sb).from('notifications').upsert(notes, { onConflict: 'org_id,user_id,dedupe_key', ignoreDuplicates: true }); // never two reminders for the same trigger
  }
  go('/erp/fees/dues', type === 'message' ? 'Reminder sent.' : 'Follow-up logged.');
}

export async function requestReversal(fd: FormData) {
  const ctx = await getCtx();
  const id = str(fd, 'id')!;
  const { data: r } = await erp(ctx.sb).from('receipts').select('receipt_no, total, student_id').eq('id', id).single();
  const { error } = await erp(ctx.sb).rpc('submit_approval', { p_type: 'receipt_reversal', p_object: id, p_title: `Cancel receipt ${r?.receipt_no}`, p_summary: str(fd, 'reason'), p_amount: r?.total, p_payload: { reason: str(fd, 'reason') }, p_student: r?.student_id, p_impact: `Rs ${Number(r?.total).toLocaleString('en-IN')} goes back to dues and a reversal voucher is posted.` });
  go(`/erp/receipt/${id}`, error ? error.message : 'Cancellation sent for approval. The receipt stays valid until it is approved.', error ? 'err' : 'ok');
}

export async function chequeAction(fd: FormData) {
  const ctx = await getCtx();
  const id = str(fd, 'id')!, action = str(fd, 'action');
  if (action === 'bounced') {
    const { error } = await erp(ctx.sb).rpc('bounce_cheque', { p_payment: id, p_fine: numv(fd, 'fine') ?? 0 });
    go('/erp/fees/cheques', error ? error.message : 'Cheque marked bounced. The receipt was reversed and the family notified.', error ? 'err' : 'ok');
  }
  const patch: Record<string, unknown> = { cheque_status: action };
  if (action === 'deposited') patch.deposit_batch = `DEP-${today()}`;
  const { error } = await erp(ctx.sb).from('receipt_payments').update(patch).eq('id', id);
  go('/erp/fees/cheques', error ? error.message : 'Updated.', error ? 'err' : 'ok');
}

/** Bank statement lines pasted as CSV: date, description, amount, reference. Matches by reference and amount (FEE-08). */
export async function importBankLines(fd: FormData) {
  const ctx = await getCtx();
  const batch = `B-${Date.now()}`;
  const lines = (str(fd, 'csv') ?? '').split('\n').map((l) => l.split(',').map((c) => c.trim())).filter((c) => c.length >= 3 && !isNaN(Number(c[2])) && /^\d{4}-\d{2}-\d{2}$/.test(c[0]!));
  if (!lines.length) go('/erp/fees/reconciliation', 'No valid lines found. Use: 2026-06-10, description, 15000, reference', 'err');
  const { data: ins, error } = await erp(ctx.sb).from('bank_lines').insert(lines.map((c) => ({ date: c[0], description: c[1], amount: Number(c[2]), reference: c[3] ?? null, import_batch: batch }))).select('id, amount, reference');
  if (error) go('/erp/fees/reconciliation', error.message, 'err');
  const { data: pays } = await erp(ctx.sb).from('receipt_payments').select('id, amount, reference, cheque_no, gateway_payment_id').is('bank_line_id', null).neq('mode', 'cash').is('deleted_at', null).limit(5000);
  const P = (pays ?? []) as { id: string; amount: number; reference: string | null; cheque_no: string | null; gateway_payment_id: string | null }[];
  let matched = 0;
  for (const l of (ins ?? []) as { id: string; amount: number; reference: string | null }[]) {
    if (!l.reference) continue;
    const hit = P.find((p) => Number(p.amount) === Number(l.amount) && [p.reference, p.cheque_no, p.gateway_payment_id].includes(l.reference));
    if (hit) { await erp(ctx.sb).from('bank_lines').update({ status: 'matched', matched_payment_id: hit.id }).eq('id', l.id); await erp(ctx.sb).from('receipt_payments').update({ bank_line_id: l.id }).eq('id', hit.id); hit.reference = null; hit.cheque_no = null; hit.gateway_payment_id = null; matched++; }
  }
  go('/erp/fees/reconciliation', `${ins?.length} lines imported, ${matched} matched automatically.`);
}
export async function matchBankLine(fd: FormData) {
  const ctx = await getCtx();
  const line = str(fd, 'line')!, action = str(fd, 'action');
  if (action === 'ignore') await erp(ctx.sb).from('bank_lines').update({ status: 'ignored' }).eq('id', line);
  else { const pay = str(fd, 'payment'); if (pay) { await erp(ctx.sb).from('bank_lines').update({ status: 'matched', matched_payment_id: pay }).eq('id', line); await erp(ctx.sb).from('receipt_payments').update({ bank_line_id: line }).eq('id', pay); } }
  go('/erp/fees/reconciliation', 'Updated.');
}
void balance;
