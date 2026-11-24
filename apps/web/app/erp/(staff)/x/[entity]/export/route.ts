import { NextResponse, type NextRequest } from 'next/server';
import { getCtx } from '@/lib/erp/ctx';
import { entity, attachRefs, listQuery, show, type Row } from '@/lib/erp/crud';
import { erp } from '@/lib/erp/db';
import { csv } from '@/lib/erp/fmt';

export const dynamic = 'force-dynamic';

/** CSV export with permission control and an export log (PRV-04). */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ entity: string }> }) {
  const { entity: key } = await params;
  const ent = entity(key);
  const ctx = await getCtx();
  if (!ent || !ctx.can(ent.cap) || !ctx.can('reports')) return new NextResponse('Not allowed', { status: 403 });
  let q = listQuery(ctx, ent).order('created_at', { ascending: false }).limit(5000);
  if (ent.year && ctx.year) q = q.or(`academic_year_id.eq.${ctx.year.id},academic_year_id.is.null`);
  const { data } = await q;
  const raw = await attachRefs(ctx, ent, (data ?? []) as unknown as Row[]);
  const rows = raw.map((r) => Object.fromEntries(ent.fields.filter((f) => f.t !== 'uuid').map((f) => [f.label, show(ent, f, r)])));
  await erp(ctx.sb).rpc('log_export', { p_report: ent.title, p_rows: rows.length });
  return new NextResponse(`Exported by ${ctx.name} on ${new Date().toISOString()}\n` + csv(rows), { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${key}.csv"` } });
}
