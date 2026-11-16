'use client';
import { use } from 'react';
import Link from 'next/link';
import { useApp } from '@/lib/app';
import { post, useApi } from '@/lib/api';
import { Badge, Button, Card, DateText, ErrorBox, Loading, PageHeader, StatusBadge, Table, useAction } from '@/components/ui';

export default function IncidentDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { t, can, me } = useApp();
  const x = useApi<any>(`/incidents/${id}`);
  const a = useAction();
  if (!x.data) return x.error ? <ErrorBox error={x.error} /> : <Loading />;
  const i = x.data;
  return (
    <div>
      <PageHeader title={t(`incidentType.${i.type}`)} subtitle={<span className="flex flex-wrap items-center gap-2"><StatusBadge status={i.status} /><Badge>{t(`severity.${i.severity}`)}</Badge>{i.confidential && <Badge tone="red">{t('incidents.confidential')}</Badge>}<DateText value={i.occurred_at} withTime /> · {t('incidents.reportedBy', { name: i.reported_by_name ?? '' })}</span>} actions={i.status !== 'closed' && (i.owner_id === me?.staff.id || can('incidents', 'edit')) && <Button disabled={a.busy} onClick={async () => (await a.run(() => post(`/incidents/${id}/close`))) && x.reload()}>{t('incidents.close')}</Button>} />
      <ErrorBox error={a.error} />
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card title={t('common.description')}><p className="whitespace-pre-wrap text-sm">{i.description}</p>{i.action_taken && <><h3 className="mt-3 text-sm font-semibold">{t('incidents.actionTaken')}</h3><p className="whitespace-pre-wrap text-sm">{i.action_taken}</p></>}</Card>
          <Card title={t('incidents.followUps')}><Table rows={i.tasks} columns={[{ key: 'title', header: t('common.title'), render: (r) => <Link className="text-brand-700" href={`/os/tasks/${r.id}`}>{r.title}</Link> }, { key: 'owner_name', header: t('tasks.owner') }, { key: 'due_at', header: t('tasks.due'), render: (r) => <DateText value={r.due_at} /> }, { key: 'status', header: t('common.status'), render: (r) => <StatusBadge status={r.status} /> }]} /></Card>
        </div>
        <Card title={t('incidents.students')}>
          <ul className="space-y-1 text-sm">{i.students.map((s: any) => <li key={s.id}>{s.full_name} <span className="text-xs text-slate-500">{s.section}</span></li>)}</ul>
          <p className="mt-3 text-xs text-slate-500">{t('tasks.owner')}: {i.owner_name ?? '—'}</p>
        </Card>
      </div>
    </div>
  );
}
