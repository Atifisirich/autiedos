'use client';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { CrmError, post, useCrm } from '@/lib/crm/api';
import { inr } from '@/lib/crm/fmt';

type Pay = { purpose: string; amount: number; status: string; receipt_no: string | null; paid_at: string | null; student: string; school: string; color: string; demo: boolean };

/**
 * Payment link page. No gateway account is connected in this build, so the checkout is a clearly labelled simulator that
 * only exists when the server runs with DEMO_PAYMENTS=1; a real gateway replaces the two buttons and confirms through
 * its verified webhook.
 */
export default function PayPage() {
  const { token } = useParams<{ token: string }>();
  const { data: p, error, reload } = useCrm<Pay>(`/pay/${token}`);
  const [msg, setMsg] = useState('');
  if (error) return <Frame>This payment link is not valid any more. Please ask the school for a new one.</Frame>;
  if (!p) return <Frame>Loading…</Frame>;
  async function demo(result: 'success' | 'failure') {
    setMsg('');
    try {
      await post(`/pay/${token}`, { result });
      reload();
    } catch (e) {
      setMsg(e instanceof CrmError ? e.message : 'Could not complete the demo payment.');
    }
  }
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-100 p-4">
      <div className="w-full max-w-sm overflow-hidden rounded-xl bg-white shadow">
        <div className="px-6 py-5 text-white" style={{ background: p.color }}>
          <p className="text-sm opacity-90">{p.school}</p>
          <h1 className="text-xl font-semibold">{p.purpose}</h1>
        </div>
        <div className="space-y-4 p-6 text-center">
          <p className="muted">For {p.student}</p>
          <p className="text-4xl font-semibold text-slate-900">{inr(p.amount)}</p>
          {p.status === 'paid' ? (
            <div role="status" className="rounded-md bg-green-50 p-4 text-green-900">
              <p className="font-semibold">Payment received</p>
              <p className="text-sm">Receipt {p.receipt_no}</p>
            </div>
          ) : (
            <>
              {p.status === 'failed' && (
                <p role="alert" className="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-800">
                  The last attempt did not go through. No money was taken. Please try again.
                </p>
              )}
              {!p.demo && <p className="rounded-md bg-slate-50 px-3 py-3 text-sm text-slate-800">Online payment is not switched on for this school yet. Please pay at the school office and quote this page.</p>}
              {p.demo && (
                <div className="space-y-2">
                  <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">Demo checkout: no payment gateway is connected, so no real money moves.</p>
                  <button className="btn btn-primary btn-lg w-full" onClick={() => demo('success')}>
                    Simulate a successful payment
                  </button>
                  <button className="btn w-full" onClick={() => demo('failure')}>
                    Simulate a failed payment
                  </button>
                  {msg && (
                    <p role="alert" className="text-sm text-rose-700">
                      {msg}
                    </p>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </main>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return <main className="flex min-h-screen items-center justify-center p-4 text-center text-slate-800">{children}</main>;
}
