'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  allocationTotal, allocationsFor, childName, createPaymentOrder, demandBalance, demandState, demandTotal, feeSummary, fmtDate, friendlyError, inr, isOpenDemand, istToday, loadFees,
  type Child, type DemandRow,
} from '@autoed/shared/erp-portal';
import { usePortal } from '@/lib/erp-portal/session';
import { useLoad } from '@/lib/erp-portal/use-load';
import { Badge, Btn, Card, Checkbox, Empty, LinkBtn, Notice, PageHead, Stat, type Tone } from '@/components/erp-portal/ui';
import { NeedChild, WithData } from '@/components/erp-portal/screen';

export default function Fees() {
  return <NeedChild>{(c) => <Inner child={c} />}</NeedChild>;
}

const STATE_TONE: Record<string, Tone> = { paid: 'good', overdue: 'bad', due: 'warn', partial: 'info', closed: 'none' };

function Inner({ child }: { child: Child }) {
  const { sb, L, lang } = usePortal();
  const router = useRouter();
  const today = istToday();
  const q = useLoad('fees', () => loadFees(sb!, child.id), [child.id], { childScoped: true });
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pay(demands: DemandRow[]) {
    const alloc = allocationsFor(demands, picked);
    if (!alloc.length) return setError(L('fees.nothingSelected'));
    setBusy(true); setError(null);
    try {
      const order = await createPaymentOrder(sb!, child.id, alloc);
      router.push(`/erp/parent/fees/pay/${order}`);
    } catch (e) {
      setError(friendlyError(e, L('c.error')));
      setBusy(false);
    }
  }

  return (
    <>
      <PageHead title={L('fees.title')} sub={childName(child)} />
      <WithData q={q}>
        {(d) => {
          const fs = feeSummary(d.demands, today);
          const open = d.demands.filter((x) => isOpenDemand(x) && demandBalance(x) > 0);
          const total = allocationTotal(allocationsFor(d.demands, picked));
          const toggle = (id: string, on: boolean) => setPicked((s) => { const n = new Set(s); if (on) n.add(id); else n.delete(id); return n; });
          return (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <Stat label={L('fees.due')} value={inr(fs.due)} tone={fs.overdue > 0 ? 'bad' : 'none'} hint={fs.overdue > 0 ? L('home.overdueOf', { amount: inr(fs.overdue) }) : undefined} />
                <Stat label={L('fees.paidYear')} value={inr(fs.paid)} tone="good" />
                {d.wallet !== null && <Stat label={L('fees.wallet')} value={inr(d.wallet)} />}
              </div>

              {d.orders.length > 0 && open.length > 0 && (
                <Notice>{L('fees.pay.status', { status: L('fees.pay.s.created') })} · <Link className="font-semibold underline" href={`/erp/parent/fees/pay/${d.orders[0]!.id}`}>{inr(d.orders[0]!.amount)}</Link></Notice>
              )}

              <Card title={L('fees.instalments')} flush>
                {d.demands.length === 0 ? <Empty title={L('fees.noFees')} /> : (
                  <>
                    {open.length > 1 && (
                      <div className="border-b border-slate-100 px-4">
                        <Checkbox label={L('fees.selectAll')} checked={open.every((x) => picked.has(x.id))} onChange={(on) => setPicked(on ? new Set(open.map((x) => x.id)) : new Set())} />
                      </div>
                    )}
                    <ul className="divide-y divide-slate-100">
                      {d.demands.map((x) => {
                        const st = demandState(x, today);
                        const payable = isOpenDemand(x) && demandBalance(x) > 0;
                        const label = `${x.head ?? ''} ${x.label ?? ''}`.trim();
                        return (
                          <li key={x.id} className="flex items-start gap-3 px-4 py-3">
                            {payable ? <div className="pt-0.5"><Checkbox label={<span className="sr-only">{L('fees.select', { label })}</span>} checked={picked.has(x.id)} onChange={(on) => toggle(x.id, on)} /></div> : <span className="w-6" aria-hidden />}
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <span className="text-base font-semibold text-slate-900">{label}</span>
                                <Badge tone={STATE_TONE[st]}>{L(`fees.state.${st}`)}</Badge>
                              </div>
                              <div className="text-sm text-slate-700">{L('fees.dueOn', { date: fmtDate(x.due_date, lang, true) })}{Number(x.concession) ? ` · ${L('fees.concession', { amount: inr(x.concession) })}` : ''}{Number(x.fine) ? ` · ${L('fees.fine', { amount: inr(x.fine) })}` : ''}</div>
                              <div className="mt-1 flex justify-between text-base"><span>{L('fees.amount')} {inr(demandTotal(x))}</span><span className="font-semibold">{L('fees.balance')} {inr(demandBalance(x))}</span></div>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                    {open.length > 0 && (
                      <div className="space-y-2 border-t border-slate-100 p-4">
                        {error && <Notice tone="bad">{error}</Notice>}
                        <Btn className="w-full" disabled={busy || total === 0} onClick={() => void pay(d.demands)}>{total > 0 ? L('fees.paySelected', { amount: inr(total) }) : L('fees.nothingSelected')}</Btn>
                        <p className="text-sm text-slate-700">{L('fees.counterNote')}</p>
                      </div>
                    )}
                  </>
                )}
              </Card>

              <Card title={L('fees.receipts')} flush>
                {d.receipts.length === 0 ? <Empty title={L('fees.noReceipts')} /> : (
                  <ul className="divide-y divide-slate-100">
                    {d.receipts.map((r) => (
                      <li key={r.id} className="flex items-center justify-between px-4 py-3 text-base">
                        <span><span className="font-medium">{L('fees.receiptNo', { no: r.receipt_no })}</span> <span className="text-sm text-slate-700">{fmtDate(r.date, lang, true)}</span>{r.status !== 'valid' && <> <Badge tone="bad">{L('fees.reversed')}</Badge></>}</span>
                        <span className="tabular-nums">{inr(r.total)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>

              {d.certificates.length > 0 && (
                <Card title={L('fees.certificates')} flush>
                  <ul className="divide-y divide-slate-100">{d.certificates.map((c) => <li key={c.id} className="flex items-center justify-between px-4 py-3 text-base"><span>{c.title} {c.number}</span>{c.verify_code && <LinkBtn variant="secondary" href={`/erp/verify/${encodeURIComponent(c.verify_code)}`}>{L('requests.verifyDoc')}</LinkBtn>}</li>)}</ul>
                </Card>
              )}
            </div>
          );
        }}
      </WithData>
    </>
  );
}
