'use client';
import { use, useState } from 'react';
import Link from 'next/link';
import { useApp } from '@/lib/app';
import { post, useApi } from '@/lib/api';
import { Button, Card, DateText, ErrorBox, Field, Input, Loading, PageHeader, Stat, StatusBadge, Table, Textarea, useAction } from '@/components/ui';

export default function EventDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { t, me, can } = useApp();
  const ev = useApi<any>(`/events/${id}`);
  const a = useAction();
  const [r, setR] = useState({ went_well: '', improve: '', attendance: '' });
  if (!ev.data) return ev.error ? <ErrorBox error={ev.error} /> : <Loading />;
  const x = ev.data;
  const total = (x.budget ?? []).reduce((s: number, b: any) => s + Number(b.amount ?? 0), 0);
  return (
    <div>
      <PageHeader title={x.name} subtitle={<span className="flex items-center gap-2"><StatusBadge status={x.status} /><DateText value={x.event_date} /> · {x.owner_name ?? ''}{x.template_name && ` · ${x.template_name}`}</span>} />
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label={t('events.readiness')} value={`${x.readiness}%`} tone={x.readiness >= 80 ? 'green' : x.readiness >= 50 ? 'amber' : 'red'} />
        <Stat label={t('nav.tasks')} value={x.tasks.length} />
        <Stat label={t('events.budget')} value={total.toLocaleString('en-IN')} />
        {x.budget_approval_request_id && <Stat label={t('events.budgetApproval')} value={t('common.open')} href={`/os/approvals/${x.budget_approval_request_id}`} />}
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2" title={t('nav.tasks')}>
          <Table rows={x.tasks} columns={[{ key: 'title', header: t('common.title'), render: (r) => <Link className="text-brand-700" href={`/os/tasks/${r.id}`}>{r.title}</Link> }, { key: 'owner_name', header: t('tasks.owner') }, { key: 'due_at', header: t('tasks.due'), render: (r) => <DateText value={r.due_at} /> }, { key: 'status', header: t('common.status'), render: (r) => <StatusBadge status={r.status} /> }]} />
        </Card>
        <div className="space-y-4">
          <Card title={t('events.committees')}><ul className="list-disc pl-5 text-sm">{(x.committees ?? []).map((c: any, i: number) => <li key={i}>{typeof c === 'string' ? c : `${c.name}${c.members ? ` (${c.members.length})` : ''}`}</li>)}</ul></Card>
          <Card title={t('events.budget')}><Table rows={x.budget} rowKey={(b) => b.line} columns={[{ key: 'line', header: t('events.line') }, { key: 'amount', header: t('helpdesk.cost'), render: (b) => Number(b.amount).toLocaleString('en-IN') }]} /></Card>
          {x.review ? (
            <Card title={t('events.review')}><p className="text-sm"><b>{t('events.wentWell')}:</b> {x.review.went_well}</p><p className="text-sm"><b>{t('events.improve')}:</b> {x.review.improve}</p></Card>
          ) : (
            (x.owner_id === me?.staff.id || can('events', 'edit')) && new Date(x.event_date) <= new Date() && (
              <Card title={t('events.review')}>
                <Field label={t('events.wentWell')}><Textarea value={r.went_well} onChange={(e) => setR({ ...r, went_well: e.target.value })} /></Field>
                <Field label={t('events.improve')}><Textarea value={r.improve} onChange={(e) => setR({ ...r, improve: e.target.value })} /></Field>
                <Field label={t('events.attendance')}><Input type="number" value={r.attendance} onChange={(e) => setR({ ...r, attendance: e.target.value })} /></Field>
                <Button disabled={!r.went_well || a.busy} onClick={async () => (await a.run(() => post(`/events/${id}/review`, { went_well: r.went_well, improve: r.improve, attendance: r.attendance ? Number(r.attendance) : undefined }))) && ev.reload()}>{t('common.save')}</Button>
                <ErrorBox error={a.error} />
              </Card>
            )
          )}
        </div>
      </div>
    </div>
  );
}
