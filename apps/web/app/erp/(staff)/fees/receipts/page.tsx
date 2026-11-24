import Link from 'next/link';
import { requireCap } from '@/lib/erp/ctx';
import { erp } from '@/lib/erp/db';
import { lookup } from '@/lib/erp/lookup';
import { Page, Card, Empty, Badge, Stat } from '@/components/erp/ui';
import { PrintButton } from '@/components/erp/client';
import { inr, today, fdate } from '@/lib/erp/fmt';

export const metadata = { title: 'Receipts' };
type R = { id: string; receipt_no: string; date: string; total: number; status: string; collected_by_name: string | null; channel: string; student_id: string | null; payments: { mode: string; amount: number }[] };
/** Receipt register and day sheet in one screen with a date range. */
export default async function Receipts({ searchParams }: { searchParams: Promise<{ from?: string; to?: string }> }) {
  const sp = await searchParams;
  const ctx = await requireCap('fees');
  const from = sp.from ?? today(), to = sp.to ?? from;
  let q = erp(ctx.sb).from('receipts').select('id, receipt_no, date, total, status, collected_by_name, channel, student_id, payments:receipt_payments(mode, amount)').gte('date', from).lte('date', to).is('deleted_at', null).order('receipt_no', { ascending: false }).limit(2000);
  if (ctx.branchId) q = q.or(`branch_id.eq.${ctx.branchId},branch_id.is.null`);
  const { data } = await q;
  const rows = (data ?? []) as unknown as R[];
  const st = await lookup(ctx, 'students', rows.map((r) => r.student_id));
  const valid = rows.filter((r) => r.status === 'valid');
  const modes = new Map<string, number>(); for (const r of valid) for (const p of r.payments) modes.set(p.mode, (modes.get(p.mode) ?? 0) + Number(p.amount));
  return (
    <Page title="Receipts and day sheet" sub={from === to ? fdate(from) : `${fdate(from)} to ${fdate(to)}`} actions={<><form className="flex gap-2"><input type="date" name="from" defaultValue={from} className="input !w-auto" aria-label="From" /><input type="date" name="to" defaultValue={to} className="input !w-auto" aria-label="To" /><button className="btn-ghost">Show</button></form><PrintButton /></>}>
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-5"><Stat label="Total collected" value={inr(valid.reduce((t, r) => t + Number(r.total), 0))} hint={`${valid.length} receipts`} />{[...modes].map(([m, v]) => <Stat key={m} label={m.replace('_', ' ')} value={inr(v)} />)}</div>
      <Card>{rows.length === 0 ? <Empty title="No receipts in this period" /> : <table className="tbl"><thead><tr><th>Receipt</th><th>Date</th><th>Student</th><th>Modes</th><th>By</th><th className="text-right">Amount</th><th>Status</th></tr></thead>
        <tbody>{rows.map((r) => <tr key={r.id}><td><Link className="link font-medium" href={`/erp/receipt/${r.id}`}>{r.receipt_no}</Link></td><td>{fdate(r.date)}</td><td>{st.name(r.student_id)}</td><td>{r.payments.map((p) => p.mode.replace('_', ' ')).join(', ')}</td><td>{r.collected_by_name}</td><td className="text-right tabular-nums">{inr(r.total)}</td><td><Badge>{r.status}</Badge></td></tr>)}</tbody></table>}</Card>
    </Page>
  );
}
