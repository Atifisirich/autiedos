import { NextResponse } from 'next/server';
import { getCtx } from '@/lib/erp/ctx';
import { erp } from '@/lib/erp/db';

export const dynamic = 'force-dynamic';
const x = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
type V = { voucher_no: string; date: string; type: string; narration: string | null; lines: { debit: number; credit: number; account_id: string }[] };
/** Tally Prime voucher import file (ACC-04). Import in Tally via Import Data > Vouchers. */
export async function GET() {
  const ctx = await getCtx();
  if (!ctx.can('accounting')) return new NextResponse('Not allowed', { status: 403 });
  const [{ data }, { data: acc }] = await Promise.all([
    erp(ctx.sb).from('vouchers').select('voucher_no, date, type, narration, lines:voucher_lines(debit, credit, account_id)').is('deleted_at', null).order('date').limit(5000),
    erp(ctx.sb).from('accounts').select('id, name').is('deleted_at', null),
  ]);
  const name = new Map(((acc ?? []) as { id: string; name: string }[]).map((a) => [a.id, a.name]));
  const type: Record<string, string> = { receipt: 'Receipt', payment: 'Payment', journal: 'Journal', contra: 'Contra' };
  const V = (data ?? []) as unknown as V[];
  const body = V.map((v) => `<TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER VCHTYPE="${type[v.type] ?? 'Journal'}" ACTION="Create"><DATE>${String(v.date).replace(/-/g, '')}</DATE><VOUCHERTYPENAME>${type[v.type] ?? 'Journal'}</VOUCHERTYPENAME><VOUCHERNUMBER>${x(v.voucher_no)}</VOUCHERNUMBER><NARRATION>${x(v.narration)}</NARRATION>${v.lines.map((l) => `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${x(name.get(l.account_id))}</LEDGERNAME><ISDEEMEDPOSITIVE>${Number(l.debit) > 0 ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE><AMOUNT>${Number(l.debit) > 0 ? -Number(l.debit) : Number(l.credit)}</AMOUNT></ALLLEDGERENTRIES.LIST>`).join('')}</VOUCHER></TALLYMESSAGE>`).join('');
  const xml = `<?xml version="1.0"?><ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME></REQUESTDESC><REQUESTDATA>${body}</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
  await erp(ctx.sb).rpc('log_export', { p_report: 'Tally voucher export', p_rows: V.length });
  return new NextResponse(xml, { headers: { 'content-type': 'application/xml', 'content-disposition': 'attachment; filename="tally-vouchers.xml"', 'cache-control': 'private, no-store' } });
}
