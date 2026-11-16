/** Vercel cron entry point (see vercel.json). Requires CRON_SECRET. */
import { NextRequest, NextResponse } from 'next/server';
import { dispatch } from '@autoed/server/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const res = await dispatch({ method: 'GET', path: '/cron/tick', query: {}, headers: { authorization: req.headers.get('authorization') ?? undefined }, body: {} });
  return NextResponse.json(res.json, { status: res.status });
}
