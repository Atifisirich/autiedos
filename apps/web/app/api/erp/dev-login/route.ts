/**
 * DEV-ONLY sign-in for the ERP (see lib/erp/dev-auth.ts). Returns 404 unless ERP_AUTH_PROVIDER=dev. Sets the erp_token cookie that the
 * Data API client sends as the bearer token.
 */
import { NextRequest, NextResponse } from 'next/server';
import { devAuthEnabled, findDevUser, signDevToken } from '@/lib/erp/dev-auth';
import { TOKEN_COOKIE } from '@/lib/erp/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  if (!devAuthEnabled()) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const { email } = (await req.json().catch(() => ({}))) as { email?: string };
  if (!email) return NextResponse.json({ error: 'email_required' }, { status: 400 });
  const user = await findDevUser(email);
  if (!user) return NextResponse.json({ error: 'unknown_user' }, { status: 401 });
  const res = NextResponse.json({ ok: true });
  res.cookies.set(TOKEN_COOKIE, signDevToken(user.id), { httpOnly: true, sameSite: 'lax', secure: false, path: '/', maxAge: 12 * 3600 });
  return res;
}
