'use client';
import { use, useState } from 'react';
import Link from 'next/link';
import { fmtDate, inr, loadOrder } from '@autoed/shared/erp-portal';
import { usePortal } from '@/lib/erp-portal/session';
import { useLoad } from '@/lib/erp-portal/use-load';
import { Btn, Card, Notice, PageHead } from '@/components/erp-portal/ui';
import { WithData } from '@/components/erp-portal/screen';

/**
 * Checkout of a payment order created by erp.create_payment_order. There is no gateway yet: this is the MOCK provider's page.
 * "Pay" asks the ERP server (/api/erp-portal/pay/<order>) to settle the order; the server, not the browser, calls
 * erp.settle_payment_order (server-only). With a real Razorpay account the same order is paid in the gateway's checkout and the
 * settlement arrives by webhook; this page then shows the order status only.
 */
export default function PayPage({ params }: { params: Promise<{ order: string }> }) {
  const { order } = use(params);
  const { sb, L, lang } = usePortal();
  const q = useLoad(`order:${order}`, async () => (await loadOrder(sb!, order)) ?? Promise.reject(new Error('not found')), [order]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);

  async function act(action: 'settle' | 'fail') {
    setBusy(true); setMsg(null);
    try {
      const { data } = await sb!.auth.getSession();
      const res = await fetch(`/api/erp-portal/pay/${order}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${data.session?.access_token ?? ''}` }, body: JSON.stringify({ action }) });
      const body = (await res.json().catch(() => ({}))) as { status?: string };
      if (res.status === 501) setMsg({ tone: 'bad', text: L('fees.pay.unavailable') });
      else if (!res.ok) setMsg({ tone: 'bad', text: L('c.error') });
      else setMsg(body.status === 'paid' ? { tone: 'good', text: L('fees.pay.done') } : { tone: 'bad', text: L('fees.pay.failed') });
      await q.reload();
    } catch {
      setMsg({ tone: 'bad', text: L('c.error') });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <p className="mb-2"><Link href="/erp/parent/fees" className="text-base text-[var(--pt-primary)] underline">‹ {L('nav.fees')}</Link></p>
      <PageHead title={L('fees.pay.title')} />
      <WithData q={q}>
        {(o) => (
          <div className="space-y-4">
            <Card title={L('fees.pay.order')}>
              <dl className="space-y-1 text-base">
                <div className="flex justify-between"><dt>{L('fees.amount')}</dt><dd className="text-xl font-bold" data-testid="order-amount">{inr(o.amount)}</dd></div>
                <div className="flex justify-between"><dt>{L('fees.pay.items')}</dt><dd>{o.allocations.length}</dd></div>
                <div className="flex justify-between"><dt>{L('fees.pay.order')}</dt><dd className="text-sm text-slate-700">{fmtDate(o.created_at, lang, true)}</dd></div>
              </dl>
              <p className="mt-3 text-base" data-testid="order-status">{L('fees.pay.status', { status: L(`fees.pay.s.${o.status}`) })}</p>
            </Card>
            {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
            {o.status === 'created' && (
              <Card>
                <Notice>{L('fees.pay.mock')}</Notice>
                <div className="mt-3 space-y-2">
                  <Btn className="w-full" disabled={busy} onClick={() => void act('settle')}>{L('fees.pay.success')}</Btn>
                  <Btn className="w-full" variant="secondary" disabled={busy} onClick={() => void act('fail')}>{L('fees.pay.fail')}</Btn>
                </div>
              </Card>
            )}
            {o.status === 'paid' && <Notice tone="good">{L('fees.pay.done')}</Notice>}
            {o.status === 'failed' && <Notice tone="bad">{L('fees.pay.failed')}</Notice>}
          </div>
        )}
      </WithData>
    </>
  );
}
