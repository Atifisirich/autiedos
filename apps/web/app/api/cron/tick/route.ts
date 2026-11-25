/** Vercel cron entry point (see vercel.json). Requires CRON_SECRET. */
import { NextRequest, NextResponse } from 'next/server';
import { dispatch } from '@autoed/server/api';
import { defaultRecordsDb, runRecordReminders } from '@autoed/server/custom-records';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const res = await dispatch({ method: 'GET', path: '/cron/tick', query: {}, headers: { authorization: req.headers.get('authorization') ?? undefined }, body: {} });
  // custom-record reminders (job_runner only), after the OS tick has accepted the cron secret
  if (res.status === 200 && res.json && typeof res.json === 'object') {
    const records = await runRecordReminders(defaultRecordsDb()).catch((e: Error) => ({ error: e.message }));
    return NextResponse.json({ ...(res.json as object), records }, { status: res.status });
  }
  return NextResponse.json(res.json, { status: res.status });
}
