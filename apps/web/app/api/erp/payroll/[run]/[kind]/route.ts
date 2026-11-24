import { NextResponse } from 'next/server';
import { getCtx } from '@/lib/erp/ctx';
import { erp } from '@/lib/erp/db';
import { lookup } from '@/lib/erp/lookup';
import { csv } from '@/lib/erp/fmt';
import { fullNameOf } from '@/lib/erp/q';

export const dynamic = 'force-dynamic';

/** Bank transfer file and statutory (PF / ESI / PT / TDS) report for a locked payroll run. Bank details are read through the logged function. */
export async function GET(_: Request, { params }: { params: Promise<{ run: string; kind: string }> }) {
  const { run, kind } = await params;
  const ctx = await getCtx();
  if (!ctx.can('payroll') || !['bank', 'statutory'].includes(kind)) return new NextResponse('Not allowed', { status: 403 });
  const { data: slips } = await erp(ctx.sb).from('payslips').select('net, gross, deductions, employer_pf, employer_esi, staff_id').eq('run_id', run).is('deleted_at', null);
  const S = (slips ?? []) as { net: number; gross: number; deductions: Record<string, number>; employer_pf: number; employer_esi: number; staff_id: string }[];
  const st = await lookup(ctx, 'staff', S.map((s) => s.staff_id));
  const sens = new Map<string, Record<string, string | null>>();
  for (const s of S) { const r = await erp(ctx.sb).rpc('read_staff_payroll', { p_staff: s.staff_id }); if (r.data) sens.set(s.staff_id, r.data as Record<string, string | null>); }
  await erp(ctx.sb).rpc('log_view', { p_entity: 'payroll_runs', p_id: run, p_note: `${kind} file downloaded` });
  await erp(ctx.sb).rpc('log_export', { p_report: `Payroll ${kind} file`, p_rows: S.length });
  const b = (id: string) => sens.get(id);
  const code = (id: string) => String(st.get(id)?.employee_code ?? '');
  const rows = kind === 'bank'
    ? S.map((s) => ({ 'Employee code': code(s.staff_id), Name: fullNameOf(st.get(s.staff_id) as never), Bank: b(s.staff_id)?.bank_name, 'Account number': b(s.staff_id)?.bank_account, IFSC: b(s.staff_id)?.ifsc, Amount: s.net }))
    : S.map((s) => ({ 'Employee code': code(s.staff_id), Name: fullNameOf(st.get(s.staff_id) as never), UAN: b(s.staff_id)?.uan, 'ESI number': b(s.staff_id)?.esi_no, PAN: b(s.staff_id)?.pan, Gross: s.gross, 'PF (employee)': s.deductions?.['Provident fund'] ?? 0, 'PF (employer)': s.employer_pf, 'ESI (employee)': s.deductions?.ESI ?? 0, 'ESI (employer)': s.employer_esi, 'Professional tax': s.deductions?.['Professional tax'] ?? 0, TDS: s.deductions?.TDS ?? 0 }));
  return new NextResponse(csv(rows), { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="payroll-${kind}.csv"`, 'cache-control': 'private, no-store' } });
}
