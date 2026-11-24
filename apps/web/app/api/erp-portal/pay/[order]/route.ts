/**
 * Mock payment provider for the family portal (no gateway call, no money). The browser asks to "pay" or "cancel" an order it
 * created with erp.create_payment_order; this route checks that the order is the caller's (a read through the Data API with the
 * caller's own token, so row-level security decides) and only then calls the server-only functions
 * erp.settle_payment_order / erp.fail_payment_order as the ERP server role.
 *
 * Mock settlement creates a real receipt, so it must never be on in production by accident: it is available only when
 * ERP_PAYMENTS_PROVIDER=mock (the default outside production). With a real provider this route answers 501 and the gateway's
 * webhook settles the order instead.
 */
import { NextRequest, NextResponse } from 'next/server';
import { asErpServer, erpServerConfigured, mockPaymentsEnabled } from '@/lib/erp-portal/server-db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: NextRequest, { params }: { params: Promise<{ order: string }> }) {
  const { order } = await params;
  if (!UUID.test(order)) return NextResponse.json({ error: 'bad order' }, { status: 400 });
  if (!mockPaymentsEnabled()) return NextResponse.json({ error: 'online payment is not available' }, { status: 501 });
  if (!erpServerConfigured()) return NextResponse.json({ error: 'not configured' }, { status: 503 });

  const auth = req.headers.get('authorization') ?? '';
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!/^Bearer \S+$/.test(auth) || !url || !anon) return NextResponse.json({ error: 'sign in required' }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { action?: string };
  if (body.action !== 'settle' && body.action !== 'fail') return NextResponse.json({ error: 'bad action' }, { status: 400 });

  // the caller's own view of the order: RLS returns it only to the family of the child (or to staff who may see fees)
  const r = await fetch(`${url.replace(/\/+$/, '')}/rest/v1/payment_orders?id=eq.${order}&select=id,amount,status`, {
    headers: { apikey: anon, authorization: auth, 'accept-profile': 'erp' },
    cache: 'no-store',
  }).catch(() => null);
  const rows = r && r.ok ? ((await r.json().catch(() => [])) as { id: string; amount: number | string; status: string }[]) : [];
  const o = rows[0];
  if (!o) return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (o.status !== 'created') return NextResponse.json({ status: o.status });

  try {
    if (body.action === 'settle') {
      await asErpServer((c) => c.query('select erp.settle_payment_order($1, $2, $3)', [order, `mock_${order}`, Number(o.amount)]));
      return NextResponse.json({ status: 'paid' });
    }
    await asErpServer((c) => c.query('select erp.fail_payment_order($1)', [order]));
    return NextResponse.json({ status: 'failed' });
  } catch (e) {
    return NextResponse.json({ error: String((e as { message?: string }).message ?? e).slice(0, 200) }, { status: 409 });
  }
}
