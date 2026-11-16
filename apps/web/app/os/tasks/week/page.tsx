'use client';
/** Plan my week: drag tasks onto days and free periods. */
import { useState } from 'react';
import { addDays } from '@autoed/shared';
import { useApp } from '@/lib/app';
import { post, useApi } from '@/lib/api';
import { Card, DateText, PageHeader, cx } from '@/components/ui';

function monday(d = new Date()): string {
  const x = new Date(d);
  const day = x.getDay() || 7;
  x.setDate(x.getDate() - day + 1);
  return x.toISOString().slice(0, 10);
}

export default function PlanWeek() {
  const { t } = useApp();
  const [start] = useState(monday());
  const days = Array.from({ length: 6 }, (_, i) => addDays(start, i));
  const tasks = useApi<{ id: string; title: string; status: string; due_at: string | null; start_at?: string | null }[]>(`/tasks?view=mine&status=open`);
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [planned, setPlanned] = useState<Record<string, string>>({});
  const dayOf = (id: string, due: string | null, st?: string | null) => planned[id] ?? (st ?? due)?.slice(0, 10) ?? null;
  return (
    <div>
      <PageHeader title={t('tasks.planWeek')} subtitle={t('tasks.planWeekHint')} />
      <div className="grid gap-3 lg:grid-cols-7">
        <Card title={t('tasks.unscheduled')}>
          <ul className="space-y-2">
            {(tasks.data ?? [])
              .filter((x) => !days.includes(dayOf(x.id, x.due_at, x.start_at) ?? ''))
              .map((x) => (
                <li key={x.id} draggable onDragStart={() => setDrag(x.id)} className="cursor-grab rounded border bg-white p-2 text-sm shadow-sm">
                  {x.title}
                </li>
              ))}
          </ul>
        </Card>
        {days.map((d) => (
          <div
            key={d}
            onDragOver={(e) => (e.preventDefault(), setOver(d))}
            onDragLeave={() => setOver(null)}
            onDrop={async () => {
              setOver(null);
              if (!drag) return;
              setPlanned((p) => ({ ...p, [drag]: d }));
              await post(`/tasks/${drag}/schedule`, { start_at: new Date(`${d}T09:00:00+05:30`).toISOString() }).catch(() => undefined);
              setDrag(null);
            }}
            className={cx('min-h-[200px] rounded-lg border bg-slate-50 p-2', over === d && 'border-brand-500 bg-brand-50')}
          >
            <div className="mb-2 text-xs font-semibold text-slate-600">
              <DateText value={d} />
            </div>
            <ul className="space-y-2">
              {(tasks.data ?? [])
                .filter((x) => dayOf(x.id, x.due_at, x.start_at) === d)
                .map((x) => (
                  <li key={x.id} draggable onDragStart={() => setDrag(x.id)} className="cursor-grab rounded border bg-white p-2 text-sm shadow-sm">
                    {x.title}
                  </li>
                ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}
