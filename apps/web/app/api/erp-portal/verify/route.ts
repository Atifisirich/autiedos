/**
 * Public check of a report card or certificate by its code (the QR link of /erp/verify/<code>). erp.verify_document is granted to
 * the ERP server role only (nothing in the erp schema is open to anon), so this route is the public door: it returns only what the
 * function returns (document type, title, number, status, issue date, school name, student name), rate-limited per address.
 */
import { NextRequest, NextResponse } from 'next/server';
import { asErpServer, erpServerConfigured } from '@/lib/erp-portal/server-db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const hits = new Map<string, number[]>();
function limited(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < 60000);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.clear();
  return recent.length > 20;
}

export async function GET(req: NextRequest) {
  const code = (req.nextUrl.searchParams.get('code') ?? '').trim();
  if (code.length < 10 || code.length > 64 || !/^[A-Za-z0-9._-]+$/.test(code)) return NextResponse.json({ valid: false }, { status: 404 });
  const ip = (req.headers.get('x-forwarded-for') ?? 'unknown').split(',')[0]!.trim();
  if (limited(ip)) return NextResponse.json({ error: 'too many checks, try again in a minute' }, { status: 429 });
  if (!erpServerConfigured()) return NextResponse.json({ error: 'not configured' }, { status: 503 });
  try {
    const d = await asErpServer(async (c) => (await c.query('select erp.verify_document($1) as d', [code])).rows[0]?.d as Record<string, unknown> | null);
    return d ? NextResponse.json({ valid: true, ...d }) : NextResponse.json({ valid: false }, { status: 404 });
  } catch {
    return NextResponse.json({ error: 'unavailable' }, { status: 503 });
  }
}
