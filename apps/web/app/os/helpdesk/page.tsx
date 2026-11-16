'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useApp } from '@/lib/app';
import { useApi } from '@/lib/api';
import { Badge, Card, DateText, LinkButton, PageHeader, StatusBadge, Table, Tabs } from '@/components/ui';

export default function Helpdesk() {
  const { t, label, can } = useApp();
  const router = useRouter();
  const [view, setView] = useState('mine');
  const list = useApi<any[]>(view !== 'reports' ? `/tickets?view=${view}` : null);
  const rep = useApi<any>(view === 'reports' ? '/tickets/reports' : null);
  return (
    <div>
      <PageHeader title={t('nav.helpdesk')} actions={<LinkButton href="/os/helpdesk/new">{t('helpdesk.raise')}</LinkButton>} />
      <Tabs value={view} onChange={setView} tabs={[{ value: 'mine', label: t('helpdesk.raisedByMe') }, { value: 'assigned', label: t('helpdesk.assignedToMe') }, ...(can('helpdesk', 'view', 3) ? [{ value: 'all', label: t('common.all') }, { value: 'reports', label: t('nav.reports') }] : [])]} />
      {view !== 'reports' ? (
        <Card>
          <Table rows={list.data} onRow={(r) => router.push(`/os/helpdesk/${r.id}`)} columns={[{ key: 'title', header: t('common.title') }, { key: 'category', header: t('common.category'), render: (r) => label(r.name_i18n, r.category) }, { key: 'room_name', header: t('helpdesk.location') }, { key: 'owner_name', header: t('tasks.owner') }, { key: 'priority', header: t('tasks.priority'), render: (r) => <Badge tone={r.priority === 'urgent' ? 'red' : r.priority === 'high' ? 'amber' : 'gray'}>{t(`priority.${r.priority}`)}</Badge> }, { key: 'due_at', header: t('tasks.due'), render: (r) => <DateText value={r.due_at} withTime /> }, { key: 'status', header: t('common.status'), render: (r) => <StatusBadge status={r.status} /> }]} />
        </Card>
      ) : (
        rep.data && (
          <div className="grid gap-4 lg:grid-cols-3">
            <Card title={t('helpdesk.byCategory')}><Table rows={rep.data.by_category} rowKey={(r) => r.name} columns={[{ key: 'name', header: t('common.category') }, { key: 'tickets', header: t('helpdesk.tickets') }, { key: 'avg_hours', header: t('helpdesk.avgHours') }, { key: 'breaches', header: t('helpdesk.breaches') }]} /></Card>
            <Card title={t('helpdesk.byLocation')}><Table rows={rep.data.by_location} rowKey={(r) => r.location} columns={[{ key: 'location', header: t('helpdesk.location') }, { key: 'tickets', header: t('helpdesk.tickets') }]} /></Card>
            <Card title={t('helpdesk.repeats')}><Table rows={rep.data.repeats} rowKey={(r) => `${r.place}:${r.category}`} columns={[{ key: 'place', header: t('helpdesk.location') }, { key: 'category', header: t('common.category') }, { key: 'times', header: t('helpdesk.times') }]} /></Card>
          </div>
        )
      )}
    </div>
  );
}
