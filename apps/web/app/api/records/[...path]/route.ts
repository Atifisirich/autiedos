/**
 * Catch-all for the custom records API (docs/custom-records.md). Same platform session cookie (`os_session`) as the
 * products; all logic, the session check and the database roles live in @autoed/server/custom-records.
 */
import { NextRequest, NextResponse } from 'next/server';
import { dispatchRecords } from '@autoed/server/custom-records';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const COOKIE = 'os_session';

async function handle(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => (headers[k] = v));
  const cookie = req.cookies.get(COOKIE)?.value;
  if (!headers.authorization && cookie) headers.authorization = `Bearer ${cookie}`;
  let body: unknown = {};
  if (req.method !== 'GET' && req.method !== 'HEAD') body = await req.json().catch(() => ({}));
  const res = await dispatchRecords({
    method: req.method,
    path: `/${path.map(encodeURIComponent).join('/')}`.replace(/%2F/g, '/'),
    query: Object.fromEntries(req.nextUrl.searchParams),
    headers,
    body,
  });
  if (res.text) {
    return new NextResponse(res.text.body, {
      status: res.status,
      headers: { 'content-type': res.text.contentType, 'cache-control': 'private, no-store', ...(res.text.filename ? { 'content-disposition': `attachment; filename="${res.text.filename}"` } : {}) },
    });
  }
  return NextResponse.json(res.json ?? null, { status: res.status, headers: { 'cache-control': 'private, no-store' } });
}

export { handle as GET, handle as POST, handle as PATCH, handle as DELETE };
