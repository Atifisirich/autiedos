import { NextResponse, type NextRequest } from 'next/server';
import { getCtx } from '@/lib/erp/ctx';
import { core, erp } from '@/lib/erp/db';

export const dynamic = 'force-dynamic';

/** Global search across students, staff and receipts, within the caller's permissions (row level security does the filtering). */
export async function GET(request: NextRequest) {
  const q = (request.nextUrl.searchParams.get('q') ?? '').trim().replace(/[%,()]/g, ' ');
  if (q.length < 2) return NextResponse.json([]);
  const ctx = await getCtx();
  const like = `%${q}%`;
  const [st, sf, rc] = await Promise.all([
    core(ctx.sb).from('students').select('id, first_name, last_name, admission_no, status').is('deleted_at', null).or(`first_name.ilike.${like},last_name.ilike.${like},admission_no.ilike.${like}`).limit(6),
    ctx.can('staff') ? core(ctx.sb).from('staff').select('id, first_name, last_name, employee_code').is('deleted_at', null).or(`first_name.ilike.${like},last_name.ilike.${like},employee_code.ilike.${like}`).limit(4) : Promise.resolve({ data: [] }),
    ctx.can('fees') ? erp(ctx.sb).from('receipts').select('id, receipt_no, total').ilike('receipt_no', like).limit(4) : Promise.resolve({ data: [] }),
  ]);
  type S = { id: string; first_name: string; last_name: string | null; admission_no?: string | null; status?: string; employee_code?: string | null };
  return NextResponse.json([
    ...((st.data ?? []) as S[]).map((s) => ({ label: `${s.first_name} ${s.last_name ?? ''}`.trim(), sub: `Student · ${s.admission_no ?? s.status}`, href: `/erp/students/${s.id}` })),
    ...((sf.data ?? []) as S[]).map((s) => ({ label: `${s.first_name} ${s.last_name ?? ''}`.trim(), sub: `Staff · ${s.employee_code ?? ''}`, href: `/erp/hr/staff/${s.id}` })),
    ...((rc.data ?? []) as { id: string; receipt_no: string; total: number }[]).map((r) => ({ label: r.receipt_no, sub: `Receipt · Rs ${Number(r.total).toLocaleString('en-IN')}`, href: `/erp/receipt/${r.id}` })),
  ]);
}
