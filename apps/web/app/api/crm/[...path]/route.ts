/**
 * Catch-all for the AutoEd CRM API. The web app (cookie) and the mobile app (bearer) call the same framework-free
 * `handle(req)` of @autoed/crm-server: every request runs in the database as the signed-in person (crm_server login +
 * request.jwt.claims), never as the table owner. The platform session cookie is the one the OS uses (`os_session`),
 * so one sign-in works across products.
 */
import { NextRequest, NextResponse } from 'next/server';
import { handle } from '@autoed/crm-server/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const COOKIE = 'os_session';

async function route(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => (headers[k] = v));
  const cookie = req.cookies.get(COOKIE)?.value;
  if (!headers.authorization && cookie) headers.authorization = `Bearer ${cookie}`;
  let body: unknown = {};
  let rawBody: string | undefined;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    // The raw text is kept: Meta signs the exact bytes of its webhook calls.
    rawBody = await req.text();
    try {
      body = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      body = {};
    }
  }
  const res = await handle({
    method: req.method,
    path: `/${path.map(encodeURIComponent).join('/')}`.replace(/%2F/g, '/'),
    query: Object.fromEntries(req.nextUrl.searchParams),
    headers,
    body,
    rawBody,
    ip: req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local',
  });
  let out: NextResponse;
  if (res.text) {
    out = new NextResponse(res.text.body, {
      status: res.status,
      headers: { 'content-type': res.text.contentType, 'cache-control': 'private, no-store', ...(res.text.filename ? { 'content-disposition': `attachment; filename="${res.text.filename}"` } : {}) },
    });
  } else {
    out = NextResponse.json(res.json ?? null, { status: res.status, headers: { 'cache-control': 'no-store' } });
  }
  if (res.setSession !== undefined) {
    if (res.setSession) out.cookies.set(COOKIE, res.setSession.token, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/', expires: new Date(res.setSession.expires_at) });
    else out.cookies.delete(COOKIE);
  }
  return out;
}

export { route as GET, route as POST, route as PUT, route as PATCH, route as DELETE };
