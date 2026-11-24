/**
 * Production sign-in hand-off: the login page signs in with Supabase Auth in the browser and posts the access token here; it is stored
 * in an httpOnly cookie that the ERP server code sends to the Data API as the bearer token. The token is verified by the Data API on
 * every call (RLS is the only barrier), so this route only checks that it looks like a token that has not expired.
 */
import { NextRequest, NextResponse } from 'next/server';
import { TOKEN_COOKIE, jwtPayload } from '@/lib/erp/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const { accessToken } = (await req.json().catch(() => ({}))) as { accessToken?: string };
  const p = accessToken ? jwtPayload(accessToken) : null;
  if (!accessToken || !p?.sub || !p.exp || p.exp * 1000 < Date.now()) return NextResponse.json({ error: 'invalid_token' }, { status: 401 });
  const res = NextResponse.json({ ok: true });
  res.cookies.set(TOKEN_COOKIE, accessToken, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/', expires: new Date(p.exp * 1000) });
  return res;
}
