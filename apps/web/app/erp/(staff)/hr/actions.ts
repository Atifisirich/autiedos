'use server';
import { getCtx } from '@/lib/erp/ctx';
import { core, erp } from '@/lib/erp/db';
import { go, str, numv, today } from '@/lib/erp/fmt';
import { computePayslip, type Structure, countWorking, addDays } from '@autoed/shared/erp';
import { holidays } from '@/lib/erp/calendar';

const dayCount = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000) + 1;

export async function applyLeave(fd: FormData) {
  const ctx = await getCtx();
  const staffId = str(fd, 'staff_id') ?? ctx.staff?.id ?? null;
  const back = str(fd, 'back') ?? '/erp/me';
  if (!staffId) go(back, 'Your login is not linked to a staff record. Ask your admin to link it.', 'err');
  const from = str(fd, 'from_date')!, to = str(fd, 'to_date') ?? from;
  if (to < from) go(back, 'The end date is before the start date.', 'err');
  const half = fd.get('half_day') === 'on';
  const days = half ? 0.5 : dayCount(from, to);
  const { data: st } = await core(ctx.sb).from('staff').select('first_name, last_name, branch_id').eq('id', staffId!).single();
  const { data: lr, error } = await core(ctx.sb).from('leave_requests').insert({ staff_id: staffId, branch_id: (st as { branch_id: string | null } | null)?.branch_id ?? ctx.branchId, leave_type_id: str(fd, 'leave_type_id'), start_date: from, end_date: to, half_day: half ? 'first' : 'none', days, reason: str(fd, 'reason'), status: 'pending' }).select('id').single();
  if (error) go(back, error.message, 'err');
  // Show the approver the impact: how many class periods are affected (journey "Staff leave and cover").
  const { count } = await core(ctx.sb).from('timetable_entries').select('id', { count: 'exact', head: true }).eq('staff_id', staffId!).is('deleted_at', null);
  const perDay = Math.round((count ?? 0) / 6);
  const s = st as { first_name: string; last_name: string | null } | null;
  const r = await erp(ctx.sb).rpc('submit_approval', { p_type: 'leave', p_object: lr!.id, p_title: `Leave: ${s?.first_name} ${s?.last_name ?? ''} · ${from}${to !== from ? ` to ${to}` : ''}`, p_summary: str(fd, 'reason'), p_impact: `${days} day${days === 1 ? '' : 's'}. About ${Math.round(perDay * days)} class periods need cover; the planner will suggest substitutes on approval.`, p_payload: { staff_id: staffId } });
  go(back, r.error ? r.error.message : 'Leave request sent for approval.', r.error ? 'err' : 'ok');
}

export async function regularise(fd: FormData) {
  const ctx = await getCtx();
  const staffId = ctx.staff?.id;
  if (!staffId) go('/erp/me', 'Your login is not linked to a staff record.', 'err');
  const r = await erp(ctx.sb).rpc('submit_approval', { p_type: 'attendance_regularisation', p_object: null, p_title: `Attendance regularisation · ${ctx.name} · ${str(fd, 'date')}`, p_summary: str(fd, 'reason'), p_payload: { staff_id: staffId, date: str(fd, 'date'), requested_status: str(fd, 'requested_status') ?? 'present' } });
  go('/erp/me', r.error ? r.error.message : 'Regularisation request sent.', r.error ? 'err' : 'ok');
}

/** Geo-tagged mobile check-in (ATT-07). The location is stored with the record for the geo-fence report. */
export async function checkIn(fd: FormData) {
  const ctx = await getCtx();
  const staffId = ctx.staff?.id;
  if (!staffId) go('/erp/me', 'Your login is not linked to a staff record.', 'err');
  const d = today();
  const { data: ex } = await core(ctx.sb).from('staff_attendance').select('id, check_in_at').eq('staff_id', staffId!).eq('date', d).is('deleted_at', null).maybeSingle();
  const now = new Date().toISOString();
  if (ex) await core(ctx.sb).from('staff_attendance').update({ check_out_at: now }).eq('id', (ex as { id: string }).id);
  else await core(ctx.sb).from('staff_attendance').insert({ staff_id: staffId, date: d, status: 'present', source: 'app', check_in_at: now, check_in_lat: numv(fd, 'lat'), check_in_lng: numv(fd, 'lng'), branch_id: ctx.staff?.branch_id ?? ctx.branchId });
  go('/erp/me', ex ? 'Checked out.' : 'Checked in. Have a good day.');
}

/** Monthly payroll run (HR-04): attendance and leave decide loss of pay; rules compute statutory deductions. */
export async function runPayroll(fd: FormData) {
  const ctx = await getCtx();
  const month = (str(fd, 'month') ?? today().slice(0, 7)) + '-01';
  const end = addDays(new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1)).toISOString().slice(0, 10), -1);
  const branch = ctx.branchId ?? ctx.orgUser.home_branch_id ?? ctx.branches[0]?.id;
  const b = ctx.branches.find((x) => x.id === branch);
  const { data: existing } = await erp(ctx.sb).from('payroll_runs').select('id, status').eq('month', month).eq('branch_id', branch ?? '').is('deleted_at', null).maybeSingle();
  const ex = existing as { id: string; status: string } | null;
  if (ex && ex.status !== 'draft') go('/erp/hr/payroll', 'This month is already locked. Corrections go into next month as arrears.', 'err');
  const [{ data: staff }, { data: structs }, { data: att }, hol, { data: loans }, { data: adj }, { data: lts }, { data: leaves }] = await Promise.all([
    core(ctx.sb).from('staff').select('id, joined_on').eq('status', 'active').eq('branch_id', branch ?? '').is('deleted_at', null),
    erp(ctx.sb).from('salary_structures').select('*').eq('active', true).is('deleted_at', null).order('effective_from', { ascending: false }),
    core(ctx.sb).from('staff_attendance').select('staff_id, status, date').gte('date', month).lte('date', end).is('deleted_at', null).limit(50000),
    holidays(ctx, branch),
    erp(ctx.sb).from('staff_loans').select('*').eq('status', 'active').is('deleted_at', null), erp(ctx.sb).from('payroll_adjustments').select('*').eq('month', month).is('deleted_at', null),
    core(ctx.sb).from('leave_types').select('id, paid').is('deleted_at', null), core(ctx.sb).from('leave_requests').select('staff_id, leave_type_id, start_date, end_date, half_day').eq('status', 'approved').lte('start_date', end).gte('end_date', month).is('deleted_at', null),
  ]);
  const workingDays = countWorking(month, end, b?.working_days, hol);
  const unpaid = new Set(((lts ?? []) as { id: string; paid: boolean }[]).filter((l) => !l.paid).map((l) => l.id));
  let run = ex?.id;
  if (!run) { const { data: r, error } = await erp(ctx.sb).from('payroll_runs').insert({ month, branch_id: branch, working_days: workingDays }).select('id').single(); if (error) go('/erp/hr/payroll', error.message, 'err'); run = (r as { id: string }).id; }
  await erp(ctx.sb).from('payslips').delete().eq('run_id', run!);
  type St = Structure & { staff_id: string; effective_from: string };
  const slips = []; let tg = 0, td = 0, tn = 0, skipped = 0;
  for (const s of (staff ?? []) as { id: string }[]) {
    const st = ((structs ?? []) as St[]).find((x) => x.staff_id === s.id && x.effective_from <= end);
    if (!st) { skipped++; continue; }
    const mine = ((att ?? []) as { staff_id: string; status: string }[]).filter((a) => a.staff_id === s.id);
    let lop = mine.filter((a) => a.status === 'absent').length + mine.filter((a) => a.status === 'half_day').length * 0.5;
    for (const l of ((leaves ?? []) as { staff_id: string; leave_type_id: string; start_date: string; end_date: string; half_day: string }[]).filter((x) => x.staff_id === s.id && unpaid.has(x.leave_type_id))) lop += l.half_day !== 'none' ? 0.5 : dayCount(l.start_date < month ? month : l.start_date, l.end_date > end ? end : l.end_date);
    const a = (type: string) => ((adj ?? []) as { staff_id: string; type: string; amount: number }[]).filter((x) => x.staff_id === s.id && x.type === type).reduce((t, x) => t + Number(x.amount), 0);
    const emi = ((loans ?? []) as { staff_id: string; emi: number; balance: number }[]).filter((l) => l.staff_id === s.id).reduce((t, l) => t + Math.min(Number(l.emi), Number(l.balance)), 0);
    const p = computePayslip({ basic: Number(st.basic), hra: Number(st.hra), da: Number(st.da), special_allowance: Number(st.special_allowance), other_allowance: Number(st.other_allowance), pf_applicable: st.pf_applicable, esi_applicable: st.esi_applicable, pt_applicable: st.pt_applicable, tds_monthly: Number(st.tds_monthly) },
      { workingDays, lopDays: lop, bonus: a('bonus'), arrears: a('arrears'), reimbursement: a('reimbursement'), otherDeduction: a('deduction'), loanEmi: emi, state: ctx.org.state ?? 'Telangana' });
    slips.push({ run_id: run, staff_id: s.id, month, working_days: workingDays, paid_days: p.paidDays, lop_days: p.lopDays, earnings: p.earnings, deductions: p.deductions, gross: p.gross, total_deductions: p.totalDeductions, net: p.net, employer_pf: p.employerPf, employer_esi: p.employerEsi });
    tg += p.gross; td += p.totalDeductions; tn += p.net;
  }
  if (slips.length) { const { error } = await erp(ctx.sb).from('payslips').insert(slips); if (error) go('/erp/hr/payroll', error.message, 'err'); }
  await erp(ctx.sb).from('payroll_runs').update({ working_days: workingDays, total_gross: tg, total_deductions: td, total_net: tn }).eq('id', run!);
  go(`/erp/hr/payroll?run=${run}`, `Payroll computed for ${slips.length} staff.${skipped ? ` ${skipped} skipped because they have no salary structure.` : ''} Review, then lock.`);
}

export async function lockPayroll(fd: FormData) {
  const ctx = await getCtx();
  const run = str(fd, 'run')!;
  const { data: rr } = await erp(ctx.sb).from('payroll_runs').select('*').eq('id', run).single();
  const r = rr as { id: string; status: string; month: string; branch_id: string | null; total_gross: number; total_net: number; total_deductions: number } | null;
  if (!r || r.status !== 'draft') go('/erp/hr/payroll', 'This run is already locked.', 'err');
  const { error } = await erp(ctx.sb).from('payroll_runs').update({ status: 'locked', locked_at: new Date().toISOString() }).eq('id', run);
  if (error) go(`/erp/hr/payroll?run=${run}`, error.message, 'err');
  // Recover loans, mark adjustments applied, post the salary voucher, tell staff.
  const [{ data: slips }, { data: loans }] = await Promise.all([erp(ctx.sb).from('payslips').select('staff_id, deductions').eq('run_id', run), erp(ctx.sb).from('staff_loans').select('*').eq('status', 'active')]);
  const L = (loans ?? []) as { id: string; staff_id: string; balance: number }[];
  for (const s of (slips ?? []) as { staff_id: string; deductions: Record<string, number> }[]) {
    const emi = Number(s.deductions['Loan / advance recovery'] ?? 0); if (!emi) continue; let left = emi;
    for (const l of L.filter((x) => x.staff_id === s.staff_id)) { const take = Math.min(left, Number(l.balance)); if (take <= 0) continue; await erp(ctx.sb).from('staff_loans').update({ balance: Number(l.balance) - take, status: Number(l.balance) - take <= 0 ? 'closed' : 'active' }).eq('id', l.id); left -= take; }
  }
  await erp(ctx.sb).from('payroll_adjustments').update({ applied: true }).eq('month', r!.month);
  const { data: acc } = await erp(ctx.sb).from('accounts').select('id, code').in('code', ['5000', '1010', '2100']);
  const A = (c: string) => ((acc ?? []) as { id: string; code: string }[]).find((a) => a.code === c)?.id;
  let posted = false;
  if (ctx.can('accounting', 'write') && A('5000') && A('1010') && A('2100')) {
    const { data: v } = await erp(ctx.sb).from('vouchers').insert({ voucher_no: `PAY-${String(r!.month).slice(0, 7)}`, date: today(), type: 'journal', narration: `Salaries for ${String(r!.month).slice(0, 7)}`, ref_type: 'payroll_run', ref_id: run, branch_id: r!.branch_id }).select('id').single();
    if (v) {
      const { error: ve } = await erp(ctx.sb).from('voucher_lines').insert([{ voucher_id: (v as { id: string }).id, account_id: A('5000'), debit: r!.total_gross, branch_id: r!.branch_id }, { voucher_id: (v as { id: string }).id, account_id: A('1010'), credit: r!.total_net, branch_id: r!.branch_id }, { voucher_id: (v as { id: string }).id, account_id: A('2100'), credit: r!.total_deductions, branch_id: r!.branch_id }]);
      posted = !ve;
    }
  }
  const { data: users } = await core(ctx.sb).from('staff').select('user_id').in('id', ((slips ?? []) as { staff_id: string }[]).map((s) => s.staff_id)).not('user_id', 'is', null);
  const un = ((users ?? []) as { user_id: string }[]);
  if (un.length) await core(ctx.sb).from('notifications').insert(un.map((u) => ({ user_id: u.user_id, product_key: 'erp', event_key: 'payslip', title: `Payslip for ${String(r!.month).slice(0, 7)} is ready`, link: '/erp/me' })));
  go(`/erp/hr/payroll?run=${run}`, `Payroll locked.${posted ? ' The salary voucher is posted.' : ''} Payslips are in the staff app and the bank file is ready to download.`);
}

export async function toggleChecklist(fd: FormData) {
  const ctx = await getCtx();
  const id = str(fd, 'staff')!, key = str(fd, 'key')!;
  const { data: c } = await erp(ctx.sb).from('onboarding_checklists').select('id, items').eq('staff_id', id).is('deleted_at', null).maybeSingle();
  const row = c as { id: string; items: Record<string, boolean> } | null;
  const items = { ...(row?.items ?? {}) }; items[key] = !items[key];
  const completed = Object.values(items).every(Boolean);
  if (row) await erp(ctx.sb).from('onboarding_checklists').update({ items, completed }).eq('id', row.id); else await erp(ctx.sb).from('onboarding_checklists').insert({ staff_id: id, items: { [key]: true } });
  go(`/erp/hr/staff/${id}`, 'Checklist updated.');
}
