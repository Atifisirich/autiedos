'use client';
/** Org chart: drag a person onto their new manager. Cycles are rejected by the server. */
import { useMemo, useState } from 'react';
import { useApp } from '@/lib/app';
import { post, useApi } from '@/lib/api';
import { ErrorBox, PageHeader, Card, cx, useAction } from '@/components/ui';

interface Node { id: string; full_name: string; reports_to: string | null; position: string | null; department: string | null }

export default function OrgChart() {
  const { t } = useApp();
  const chart = useApi<Node[]>('/org-chart');
  const a = useAction();
  const [drag, setDrag] = useState<string | null>(null);
  const kids = useMemo(() => {
    const m = new Map<string | null, Node[]>();
    const ids = new Set((chart.data ?? []).map((n) => n.id));
    for (const n of chart.data ?? []) {
      const k = n.reports_to && ids.has(n.reports_to) ? n.reports_to : null;
      m.set(k, [...(m.get(k) ?? []), n]);
    }
    return m;
  }, [chart.data]);
  const move = async (to: string | null) => {
    if (drag && drag !== to && (await a.run(() => post('/org-chart/move', { staff_id: drag, reports_to: to })))) chart.reload();
    setDrag(null);
  };
  const render = (parent: string | null, depth: number): React.ReactNode => (
    <ul className={cx(depth > 0 && 'ml-6 border-l border-slate-200 pl-3')}>
      {(kids.get(parent) ?? []).map((n) => (
        <li key={n.id} className="my-1">
          <div draggable onDragStart={() => setDrag(n.id)} onDragOver={(e) => e.preventDefault()} onDrop={(e) => (e.stopPropagation(), move(n.id))} className={cx('inline-block cursor-move rounded border bg-white px-2 py-1 text-sm', drag === n.id ? 'border-brand-600' : 'border-slate-200')}>
            <span className="font-medium">{n.full_name}</span> <span className="text-xs text-slate-500">{n.position}{n.department && ` · ${n.department}`}</span>
          </div>
          {render(n.id, depth + 1)}
        </li>
      ))}
    </ul>
  );
  return (
    <div>
      <PageHeader title={t('setup.orgChart')} />
      <Card>
        <p className="mb-2 text-xs text-slate-500">{t('setup.orgChartHint')}</p>
        <div onDragOver={(e) => e.preventDefault()} onDrop={() => move(null)} className="mb-2 rounded border border-dashed border-slate-300 p-2 text-xs text-slate-500">{t('setup.dropTop')}</div>
        <ErrorBox error={a.error} />
        {render(null, 0)}
      </Card>
    </div>
  );
}
