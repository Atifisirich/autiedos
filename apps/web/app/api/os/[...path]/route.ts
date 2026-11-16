/**
 * Catch-all for the AutoEd OS API. Web (cookie) and mobile (bearer) call the same handler.
 */
import { NextRequest, NextResponse } from 'next/server';
import { dispatch } from '@autoed/server/api';

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
  let rawBody: Buffer | undefined;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const ct = req.headers.get('content-type') ?? '';
    if (ct.includes('application/json')) body = await req.json().catch(() => ({}));
    else rawBody = Buffer.from(await req.arrayBuffer());
  }
  const res = await dispatch({
    method: req.method,
    path: `/${path.map(encodeURIComponent).join('/')}`.replace(/%2F/g, '/'),
    query: Object.fromEntries(req.nextUrl.searchParams),
    headers,
    body,
    rawBody,
    ip: req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local',
  });
  let out: NextResponse;
  if (res.binary) {
    out = new NextResponse(new Uint8Array(res.binary.buffer), { status: res.status, headers: { 'content-type': res.binary.contentType, ...(res.binary.filename ? { 'content-disposition': `attachment; filename="${res.binary.filename}"` } : {}), 'cache-control': 'private, no-store' } });
  } else if (res.text) {
    out = new NextResponse(res.text.body, { status: res.status, headers: { 'content-type': res.text.contentType } });
  } else {
    out = NextResponse.json(res.json ?? null, { status: res.status, headers: { 'cache-control': 'no-store' } });
  }
  if (res.setSession !== undefined) {
    if (res.setSession) out.cookies.set(COOKIE, res.setSession.token, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/', expires: new Date(res.setSession.expires_at) });
    else out.cookies.delete(COOKIE);
  }
  return out;
}

export { handle as GET, handle as POST, handle as PUT, handle as PATCH, handle as DELETE };
