'use client';
/** Day close: each open task due today is done, not done with reason, or carried forward. */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useApp } from '@/lib/app';
import { post, useApi } from '@/lib/api';
import { Button, Card, DateText, ErrorBox, PageHeader, Select, Table, useAction } from '@/components/ui';

export default function DayClose() {
  const { t } = useApp();
  const list = useApi<{ id: string; title: string; due_at: string; proof_required: string }[]>('/tasks/day-close');
  const [choice, setChoice] = useState<Record<string, { outcome: string; reason?: string }>>({});
  const a = useAction();
  const router = useRouter();
  const [result, setResult] = useState<{ task_id: string; ok: boolean; error?: string }[] | null>(null);
  return (
    <div>
      <PageHeader title={t('dayClose.title')} subtitle={t('dayClose.subtitle')} />
      <Card>
        <Table
          rows={list.data}
          empty={t('dayClose.nothing')}
          columns={[
            { key: 'title', header: t('tasks.title') },
            { key: 'due_at', header: t('tasks.due'), render: (r) => <DateText value={r.due_at} withTime /> },
            {
              key: 'outcome',
              header: t('dayClose.outcome'),
              render: (r) => (
                <div className="flex flex-wrap gap-2">
                  <Select aria-label={t('dayClose.outcome')} value={choice[r.id]?.outcome ?? ''} onChange={(e) => setChoice((c) => ({ ...c, [r.id]: { outcome: e.target.value } }))} placeholder={t('common.choose')} options={[{ value: 'done', label: t('dayClose.done') }, { value: 'not_done', label: t('dayClose.notDone') }, { value: 'carry_forward', label: t('dayClose.carry') }]} className="w-44" />
                  {choice[r.id]?.outcome === 'not_done' && <Select aria-label={t('tasks.reason')} value={choice[r.id]?.reason ?? ''} onChange={(e) => setChoice((c) => ({ ...c, [r.id]: { outcome: 'not_done', reason: e.target.value } }))} placeholder={t('tasks.reason')} options={['no_time', 'not_possible', 'not_needed', 'other'].map((x) => ({ value: x, label: t(`notDone.${x}`) }))} className="w-44" />}
                  {result?.find((x) => x.task_id === r.id && !x.ok) && <span className="text-xs text-red-600">{t('dayClose.needsProof')}</span>}
                </div>
              ),
            },
          ]}
        />
        <ErrorBox error={a.error} />
        {!!list.data?.length && (
          <Button
            className="mt-3"
            disabled={a.busy || !Object.keys(choice).length}
            onClick={async () => {
              const items = Object.entries(choice).filter(([, v]) => v.outcome && (v.outcome !== 'not_done' || v.reason)).map(([task_id, v]) => ({ task_id, outcome: v.outcome, reason: v.reason }));
              const r = await a.run(() => post<{ results: { task_id: string; ok: boolean; error?: string }[] }>('/tasks/day-close', { items }));
              if (r) {
                setResult(r.results);
                if (r.results.every((x) => x.ok)) router.push('/os');
                else await list.reload();
              }
            }}
          >
            {t('dayClose.submit')}
          </Button>
        )}
      </Card>
    </div>
  );
}
