import Link from 'next/link';
import { requireCap } from '@/lib/erp/ctx';
import { erp } from '@/lib/erp/db';
import { lookup } from '@/lib/erp/lookup';
import { Page, Card, Empty, Badge } from '@/components/erp/ui';
import { ConfirmSubmit } from '@/components/erp/client';
import { inr, fdate } from '@/lib/erp/fmt';
import { chequeAction } from '../actions';

export const metadata = { title: 'Cheques' };
type R = { id: string; amount: number; cheque_no: string | null; cheque_bank: string | null; cheque_date: string | null; cheque_status: string | null; deposit_batch: string | null; receipt: { id: string; receipt_no: string; status: string; student_id: string | null } | null };
/** Cheque lifecycle (FEE-07): received, deposited, cleared, bounced. */
export default async function Cheques() {
  const ctx = await requireCap('fees');
  const { data } = await erp(ctx.sb).from('receipt_payments').select('id, amount, cheque_no, cheque_bank, cheque_date, cheque_status, deposit_batch, receipt:receipts(id, receipt_no, status, student_id)').in('mode', ['cheque', 'dd']).is('deleted_at', null).order('created_at', { ascending: false }).limit(500);
  const rows = (data ?? []) as unknown as R[];
  const st = await lookup(ctx, 'students', rows.map((r) => r.receipt?.student_id));
  const can = ctx.can('fees', 'write');
  return (
    <Page title="Cheques and demand drafts" sub="A bounced cheque reverses its receipt, adds the charge you enter and notifies the family and accounts.">
      <Card>{rows.length === 0 ? <Empty title="No cheques received" hint="Cheque and DD payments taken at the counter appear here for deposit and clearance." /> : <table className="tbl"><thead><tr><th>Cheque</th><th>Bank</th><th>Student</th><th>Receipt</th><th className="text-right">Amount</th><th>Status</th><th></th></tr></thead>
        <tbody>{rows.map((r) => <tr key={r.id}><td>{r.cheque_no}<div className="text-xs text-muted">{fdate(r.cheque_date)}</div></td><td>{r.cheque_bank}</td><td>{st.name(r.receipt?.student_id)}</td><td>{r.receipt && <Link className="link" href={`/erp/receipt/${r.receipt.id}`}>{r.receipt.receipt_no}</Link>}</td><td className="text-right tabular-nums">{inr(r.amount)}</td><td><Badge>{r.cheque_status ?? ''}</Badge>{r.deposit_batch && <div className="text-xs text-muted">{r.deposit_batch}</div>}</td>
          <td className="whitespace-nowrap text-right">{can && ['received', 'deposited'].includes(r.cheque_status ?? '') && <form action={chequeAction} className="inline-flex items-center gap-1"><input type="hidden" name="id" value={r.id} />
            {r.cheque_status === 'received' && <button name="action" value="deposited" className="btn-ghost btn-sm">Deposited</button>}
            <button name="action" value="cleared" className="btn-ghost btn-sm">Cleared</button>
            <input name="fine" type="number" placeholder="Charge" className="input !w-20 !py-1 text-xs" aria-label="Bounce charge" />
            <ConfirmSubmit name="action" value="bounced" className="btn-danger btn-sm" message="Mark this cheque as bounced? Its receipt will be reversed.">Bounced</ConfirmSubmit></form>}</td></tr>)}</tbody></table>}</Card>
    </Page>
  );
}
