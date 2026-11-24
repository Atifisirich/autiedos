import Link from 'next/link';
import { requireCap, type Ctx } from '@/lib/erp/ctx';
import { erp } from '@/lib/erp/db';
import { NO_ID } from '@/lib/erp/q';
import { Page, Card, Empty, Badge, Tabs, Meter, Field } from '@/components/erp/ui';
import { inr, fdate, go, str, today } from '@/lib/erp/fmt';

export const metadata = { title: 'Accounting' };
async function addExpense(fd: FormData) {
  'use server';
  const ctx = await requireCap('accounting');
  const amount = Number(str(fd, 'amount') ?? 0);
  const { data: e, error } = await erp(ctx.sb).from('expenses').insert({ description: str(fd, 'description'), account_id: str(fd, 'account_id'), vendor_id: str(fd, 'vendor_id'), amount, bill_no: str(fd, 'bill_no'), is_petty_cash: fd.get('petty') === 'on', branch_id: ctx.branchId ?? ctx.orgUser.home_branch_id, requested_by: ctx.user.id }).select('id').single();
  if (error) go('/erp/accounting?tab=expenses', error.message, 'err');
  const { data: b } = await erp(ctx.sb).from('budgets').select('amount').eq('account_id', str(fd, 'account_id') ?? NO_ID).eq('academic_year_id', ctx.year?.id ?? NO_ID).is('deleted_at', null).limit(1).maybeSingle();
  const r = await erp(ctx.sb).rpc('submit_approval', { p_type: 'expense', p_object: (e as { id: string }).id, p_title: `Expense: ${str(fd, 'description')}`, p_amount: amount, p_summary: str(fd, 'bill_no') ? `Bill ${str(fd, 'bill_no')}` : null, p_impact: b ? `Against a budget of ${inr((b as { amount: number }).amount)} for this head.` : 'No budget is set for this head.', p_payload: {} });
  go('/erp/accounting?tab=expenses', r.error ? r.error.message : 'Expense sent for approval.', r.error ? 'err' : 'ok');
}
/** Pay an approved expense: posts a double-entry voucher (Dr expense, Cr cash or bank). */
async function payExpense(fd: FormData) {
  'use server';
  const ctx = await requireCap('accounting', 'write');
  const { data: ex } = await erp(ctx.sb).from('expenses').select('*').eq('id', str(fd, 'id')!).single();
  const e = ex as { id: string; status: string; description: string; amount: number; account_id: string | null; is_petty_cash: boolean; branch_id: string | null } | null;
  if (!e || e.status !== 'approved') go('/erp/accounting?tab=expenses', 'Only approved expenses can be paid.', 'err');
  const { data: acc } = await erp(ctx.sb).from('accounts').select('id, code').in('code', ['1000', '1010']);
  const cr = ((acc ?? []) as { id: string; code: string }[]).find((a) => a.code === (e!.is_petty_cash ? '1000' : '1010'))?.id;
  if (!cr || !e!.account_id) go('/erp/accounting?tab=expenses', 'The expense needs an expense head, and the cash or bank account must exist.', 'err');
  const { data: v, error } = await erp(ctx.sb).from('vouchers').insert({ voucher_no: `EXP-${Date.now().toString().slice(-7)}`, type: 'payment', narration: e!.description, ref_type: 'expense', ref_id: e!.id, branch_id: e!.branch_id }).select('id').single();
  if (error) go('/erp/accounting?tab=expenses', error.message, 'err');
  const vid = (v as { id: string }).id;
  const { error: le } = await erp(ctx.sb).from('voucher_lines').insert([{ voucher_id: vid, account_id: e!.account_id, debit: e!.amount, branch_id: e!.branch_id }, { voucher_id: vid, account_id: cr, credit: e!.amount, branch_id: e!.branch_id }]);
  if (le) go('/erp/accounting?tab=expenses', le.message, 'err');
  await erp(ctx.sb).from('expenses').update({ status: 'paid' }).eq('id', e!.id);
  go('/erp/accounting?tab=expenses', 'Paid and posted to the ledger.');
}

type Acc = { id: string; code: string; name: string; type: string; dr: number; cr: number };
/** Double-entry ledger with branch cost centres (ACC-01..06). Fee receipts, reversals, payroll and expenses post here. */
export default async function Accounting({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { tab = 'ledger' } = await searchParams;
  const ctx = await requireCap('accounting');
  const [{ data: accounts }, { data: lines }] = await Promise.all([erp(ctx.sb).from('accounts').select('id, code, name, type').is('deleted_at', null).order('code'), erp(ctx.sb).from('voucher_lines').select('account_id, debit, credit, branch_id').is('deleted_at', null).limit(100000)]);
  const L = ((lines ?? []) as { account_id: string; debit: number; credit: number; branch_id: string | null }[]).filter((l) => !ctx.branchId || l.branch_id === ctx.branchId);
  const bal = new Map<string, { dr: number; cr: number }>(); for (const l of L) { const x = bal.get(l.account_id) ?? { dr: 0, cr: 0 }; x.dr += Number(l.debit); x.cr += Number(l.credit); bal.set(l.account_id, x); }
  const A: Acc[] = ((accounts ?? []) as Omit<Acc, 'dr' | 'cr'>[]).map((a) => ({ ...a, dr: bal.get(a.id)?.dr ?? 0, cr: bal.get(a.id)?.cr ?? 0 }));
  const net = (t: string) => A.filter((a) => a.type === t).reduce((x, a) => x + (['asset', 'expense'].includes(t) ? a.dr - a.cr : a.cr - a.dr), 0);
  const can = ctx.can('accounting', 'write');
  return (
    <Page title="Accounting, expenses and budgets" sub={ctx.branchId ? 'Showing the selected branch as a cost centre.' : 'Consolidated across branches.'} actions={<><Link className="btn-ghost" href="/api/erp/tally">Tally XML export</Link><Link className="btn-ghost" href="/erp/x/accounts">Chart of accounts</Link><Link className="btn-ghost" href="/erp/x/deposits">Deposits and liabilities</Link></>}>
      <Tabs current={tab === 'ledger' ? '/erp/accounting' : `/erp/accounting?tab=${tab}`} tabs={[{ href: '/erp/accounting', label: 'Trial balance' }, { href: '/erp/accounting?tab=statements', label: 'Statements' }, { href: '/erp/accounting?tab=expenses', label: 'Expenses' }, { href: '/erp/accounting?tab=budgets', label: 'Budget vs actual' }, { href: '/erp/accounting?tab=vouchers', label: 'Vouchers' }]} />
      {tab === 'ledger' && <Card>{A.length === 0 ? <Empty title="No chart of accounts" /> : <table className="tbl"><thead><tr><th>Code</th><th>Account</th><th>Type</th><th className="text-right">Debit</th><th className="text-right">Credit</th></tr></thead><tbody>{A.filter((a) => a.dr || a.cr).map((a) => <tr key={a.id}><td>{a.code}</td><td>{a.name}</td><td>{a.type}</td><td className="text-right tabular-nums">{a.dr > a.cr ? inr(a.dr - a.cr) : ''}</td><td className="text-right tabular-nums">{a.cr > a.dr ? inr(a.cr - a.dr) : ''}</td></tr>)}
        <tr><td colSpan={3} className="font-semibold">Total</td><td className="text-right font-semibold tabular-nums">{inr(A.reduce((t, a) => t + Math.max(0, a.dr - a.cr), 0))}</td><td className="text-right font-semibold tabular-nums">{inr(A.reduce((t, a) => t + Math.max(0, a.cr - a.dr), 0))}</td></tr></tbody></table>}{A.every((a) => !a.dr && !a.cr) && <Empty title="No entries yet" hint="Collect a fee, pay an expense or lock a payroll run; each posts a balanced voucher." />}</Card>}
      {tab === 'statements' && <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Income and expenditure"><table className="tbl"><tbody>{A.filter((a) => a.type === 'income' && a.cr - a.dr).map((a) => <tr key={a.id}><td>{a.name}</td><td className="text-right tabular-nums">{inr(a.cr - a.dr)}</td></tr>)}<tr><td className="font-semibold">Total income</td><td className="text-right font-semibold tabular-nums">{inr(net('income'))}</td></tr>{A.filter((a) => a.type === 'expense' && a.dr - a.cr).map((a) => <tr key={a.id}><td>{a.name}</td><td className="text-right tabular-nums">{inr(a.dr - a.cr)}</td></tr>)}<tr><td className="font-semibold">Total expenditure</td><td className="text-right font-semibold tabular-nums">{inr(net('expense'))}</td></tr><tr><td className="font-semibold">Surplus / (deficit)</td><td className="text-right font-semibold tabular-nums">{inr(net('income') - net('expense'))}</td></tr></tbody></table></Card>
        <Card title="Balance sheet"><table className="tbl"><tbody>{A.filter((a) => a.type === 'asset' && a.dr - a.cr).map((a) => <tr key={a.id}><td>{a.name}</td><td className="text-right tabular-nums">{inr(a.dr - a.cr)}</td></tr>)}<tr><td className="font-semibold">Total assets</td><td className="text-right font-semibold tabular-nums">{inr(net('asset'))}</td></tr>{A.filter((a) => ['liability', 'equity'].includes(a.type) && a.cr - a.dr).map((a) => <tr key={a.id}><td>{a.name}</td><td className="text-right tabular-nums">{inr(a.cr - a.dr)}</td></tr>)}<tr><td>Surplus for the period</td><td className="text-right tabular-nums">{inr(net('income') - net('expense'))}</td></tr><tr><td className="font-semibold">Liabilities and funds</td><td className="text-right font-semibold tabular-nums">{inr(net('liability') + net('equity') + net('income') - net('expense'))}</td></tr></tbody></table></Card></div>}
      {tab === 'expenses' && <Expenses ctx={ctx} A={A} can={can} />}{tab === 'budgets' && <Budgets ctx={ctx} A={A} can={can} />}{tab === 'vouchers' && <Vouchers ctx={ctx} />}
    </Page>
  );
}

async function Expenses({ ctx, A, can }: { ctx: Ctx; A: Acc[]; can: boolean }) {
  const [{ data: ex }, { data: vendors }] = await Promise.all([erp(ctx.sb).from('expenses').select('id, description, date, amount, status, bill_no, is_petty_cash, account_id, vendor_id').is('deleted_at', null).order('date', { ascending: false }).limit(100), erp(ctx.sb).from('vendors').select('id, name').is('deleted_at', null).order('name')]);
  const V = new Map(((vendors ?? []) as { id: string; name: string }[]).map((v) => [v.id, v.name]));
  const AN = new Map(A.map((a) => [a.id, a.name]));
  return <div className="grid gap-4 lg:grid-cols-3"><Card title="Request an expense"><form action={addExpense} className="space-y-3 p-4"><Field label="Description"><input name="description" required className="input" /></Field><Field label="Expense head"><select name="account_id" className="input" required>{A.filter((a) => a.type === 'expense').map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field><Field label="Vendor"><select name="vendor_id" className="input"><option value="">—</option>{[...V].map(([id, n]) => <option key={id} value={id}>{n}</option>)}</select></Field><div className="grid grid-cols-2 gap-2"><Field label="Amount"><input name="amount" type="number" min={1} required className="input" /></Field><Field label="Bill number"><input name="bill_no" className="input" /></Field></div><label className="flex items-center gap-2 text-sm"><input type="checkbox" name="petty" className="h-4 w-4" /> Petty cash</label><button className="btn w-full">Send for approval</button></form></Card>
    <Card title="Expenses" className="lg:col-span-2">{((ex ?? []) as unknown[]).length === 0 ? <Empty title="No expenses yet" /> : <table className="tbl"><thead><tr><th>Expense</th><th>Head</th><th>Date</th><th className="text-right">Amount</th><th>Status</th><th></th></tr></thead><tbody>{(ex as { id: string; description: string; date: string; amount: number; status: string; account_id: string | null; vendor_id: string | null }[]).map((e) => <tr key={e.id}><td>{e.description}<div className="text-xs text-muted">{e.vendor_id ? V.get(e.vendor_id) : ''}</div></td><td>{e.account_id ? AN.get(e.account_id) : ''}</td><td>{fdate(e.date)}</td><td className="text-right tabular-nums">{inr(e.amount)}</td><td><Badge>{e.status}</Badge></td><td>{can && e.status === 'approved' && <form action={payExpense}><input type="hidden" name="id" value={e.id} /><button className="btn-ghost btn-sm">Pay</button></form>}</td></tr>)}</tbody></table>}</Card></div>;
}
async function Budgets({ ctx, A, can }: { ctx: Ctx; A: Acc[]; can: boolean }) {
  const { data: b } = await erp(ctx.sb).from('budgets').select('id, amount, alert_percent, account_id').eq('academic_year_id', ctx.year?.id ?? NO_ID).is('deleted_at', null);
  const B = (b ?? []) as { id: string; amount: number; alert_percent: number; account_id: string }[];
  return <Card title="Budget vs actual" actions={can ? <Link className="link text-sm" href="/erp/x/budgets/new?back=/erp/accounting?tab=budgets">Add budget</Link> : undefined}>{B.length === 0 ? <Empty title="No budgets set" hint="Set an annual budget per head and branch. Actuals update live from the ledger, with an alert at the threshold." /> : <table className="tbl"><thead><tr><th>Head</th><th className="text-right">Budget</th><th className="text-right">Actual</th><th className="w-1/3">Used</th></tr></thead><tbody>{B.map((x) => { const a = A.find((y) => y.id === x.account_id); const actual = a ? Math.abs(a.dr - a.cr) : 0; const p = Number(x.amount) ? Math.round((actual / Number(x.amount)) * 100) : 0; return <tr key={x.id}><td>{a?.name}</td><td className="text-right tabular-nums">{inr(x.amount)}</td><td className="text-right tabular-nums">{inr(actual)}</td><td><Meter value={actual} max={Number(x.amount)} tone={p >= 100 ? 'red' : p >= x.alert_percent ? 'amber' : 'brand'} /><span className="text-xs text-muted">{p}%</span></td></tr>; })}</tbody></table>}</Card>;
}
async function Vouchers({ ctx }: { ctx: Ctx }) {
  const { data: v } = await erp(ctx.sb).from('vouchers').select('id, voucher_no, date, type, narration, lines:voucher_lines(debit)').is('deleted_at', null).order('created_at', { ascending: false }).limit(100);
  const V = (v ?? []) as unknown as { id: string; voucher_no: string; date: string; type: string; narration: string | null; lines: { debit: number }[] }[];
  return <Card>{V.length === 0 ? <Empty title="No vouchers yet" /> : <table className="tbl"><thead><tr><th>Voucher</th><th>Date</th><th>Type</th><th>Narration</th><th className="text-right">Amount</th></tr></thead><tbody>{V.map((x) => <tr key={x.id}><td>{x.voucher_no}</td><td>{fdate(x.date)}</td><td>{x.type}</td><td>{x.narration}</td><td className="text-right tabular-nums">{inr(x.lines.reduce((t, l) => t + Number(l.debit), 0))}</td></tr>)}</tbody></table>}<p className="border-t border-line px-4 py-2 text-xs text-muted">Vouchers are never edited or deleted; corrections are reversal entries. As at {fdate(today())}.</p></Card>;
}
