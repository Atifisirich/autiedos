import Link from 'next/link';
import { requireCap } from '@/lib/erp/ctx';
import { erp } from '@/lib/erp/db';
import { Page, Card } from '@/components/erp/ui';
import { REPORTS } from '@/lib/erp/reports';

export const metadata = { title: 'Reports' };
export default async function Reports() {
  const ctx = await requireCap('reports');
  const { data: saved } = await erp(ctx.sb).from('saved_reports').select('id, name, family, filters, schedule').is('deleted_at', null).order('created_at', { ascending: false }).limit(20);
  const S = (saved ?? []) as { id: string; name: string; family: string; filters: Record<string, string>; schedule: string }[];
  return (
    <Page title="Reports" sub="About 250 fixed reports are replaced by these families. Each has filters, grouping, drill-down and export." actions={<><Link className="btn-ghost" href="/erp/diary">Principal&apos;s diary</Link><Link className="btn-ghost" href="/erp/insights">Insights</Link></>}>
      {S.length > 0 && <Card title="Saved views" className="mb-4"><ul className="divide-y divide-line text-sm">{S.map((s) => <li key={s.id} className="flex justify-between px-4 py-2"><Link className="link" href={`/erp/reports/${s.family}?${new URLSearchParams(s.filters)}`}>{s.name}</Link><span className="text-muted">{s.schedule !== 'none' ? `emailed ${s.schedule}` : ''}</span></li>)}</ul></Card>}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{Object.entries(REPORTS).filter(([, r]) => !r.cap || ctx.can(r.cap)).map(([k, r]) => <Link key={k} href={`/erp/reports/${k}`} className="card block p-4 hover:bg-paper"><div className="font-medium">{r.title}</div><p className="mt-1 text-xs text-muted">Replaces: {r.replaces}</p></Link>)}</div>
    </Page>
  );
}
