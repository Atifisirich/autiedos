import { NextResponse, type NextRequest } from 'next/server';
import { getCtx } from '@/lib/erp/ctx';
import { erp } from '@/lib/erp/db';
import { REPORTS } from '@/lib/erp/reports';
import { csv, today } from '@/lib/erp/fmt';

export const dynamic = 'force-dynamic';

/** CSV export of a report family with permission control and an export log (PRV-04). */
export async function GET(request: NextRequest, { params }: { params: Promise<{ family: string }> }) {
  const { family } = await params;
  const rep = REPORTS[family];
  const ctx = await getCtx();
  if (!rep || !ctx.can('reports') || (rep.cap && !ctx.can(rep.cap))) return new NextResponse('Not allowed', { status: 403 });
  const sp = request.nextUrl.searchParams;
  const rows = await rep.run(ctx, { from: sp.get('from') ?? ctx.year?.starts_on ?? today(), to: sp.get('to') ?? today(), section: sp.get('section') || undefined, group: sp.get('group') ?? rep.groups?.[0]?.[0] });
  await erp(ctx.sb).rpc('log_export', { p_report: rep.title, p_rows: rows.length });
  return new NextResponse(`${rep.title} · exported by ${ctx.name} on ${new Date().toISOString()}\n` + csv(rows), { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${family}.csv"`, 'cache-control': 'private, no-store' } });
}
