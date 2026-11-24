/**
 * Catch-all for the AutoEd platform admin console API. Cookie session `admin_session` (HTTP only), same handler
 * for every method. All logic, the admin check and the database role live in @autoed/server/platform-admin.
 */
import { NextRequest, NextResponse } from 'next/server';
import { dispatchAdmin } from '@autoed/server/platform-admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const COOKIE = 'admin_session';

async function handle(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => (headers[k] = v));
  const cookie = req.cookies.get(COOKIE)?.value;
  if (!headers.authorization && cookie) headers.authorization = `Bearer ${cookie}`;
  let body: unknown = {};
  if (req.method !== 'GET' && req.method !== 'HEAD') body = await req.json().catch(() => ({}));
  const res = await dispatchAdmin({
    method: req.method,
    path: `/${path.map(encodeURIComponent).join('/')}`.replace(/%2F/g, '/'),
    query: Object.fromEntries(req.nextUrl.searchParams),
    headers,
    body,
    ip: req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local',
  });
  const out = NextResponse.json(res.json ?? null, { status: res.status, headers: { 'cache-control': 'private, no-store' } });
  if (res.setSession !== undefined) {
    if (res.setSession) out.cookies.set(COOKIE, res.setSession.token, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/', expires: new Date(res.setSession.expires_at) });
    else out.cookies.delete(COOKIE);
  }
  return out;
}

export { handle as GET, handle as POST, handle as PUT, handle as PATCH, handle as DELETE };
