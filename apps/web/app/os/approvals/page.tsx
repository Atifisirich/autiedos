'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useApp } from '@/lib/app';
import { useApi } from '@/lib/api';
import { Card, DateText, LinkButton, PageHeader, StatusBadge, Table, Tabs } from '@/components/ui';

export default function Approvals() {
  const { t, label, can } = useApp();
  const router = useRouter();
  const [view, setView] = useState('pending_me');
  const list = useApi<any[]>(`/approvals?view=${view}`);
  return (
    <div>
      <PageHeader title={t('nav.approvals')} actions={<>{can('approvals', 'configure') && <LinkButton href="/os/approvals/types" variant="secondary">{t('approvals.types')}</LinkButton>}<LinkButton href="/os/approvals/new">{t('approvals.new')}</LinkButton></>} />
      <Tabs value={view} onChange={setView} tabs={[{ value: 'pending_me', label: t('approvals.pendingMe') }, { value: 'mine', label: t('approvals.mine') }, { value: 'decided_by_me', label: t('approvals.decided') }, ...(can('approvals', 'view', 5) ? [{ value: 'all', label: t('common.all') }] : [])]} />
      <Card>
        <Table rows={list.data} onRow={(r) => router.push(`/os/approvals/${r.id}`)} columns={[{ key: 'title', header: t('common.request') }, { key: 'type', header: t('common.type'), render: (r) => label(r.name_i18n, r.type_name) }, { key: 'applicant_name', header: t('approvals.applicant') }, { key: 'status', header: t('common.status'), render: (r) => <StatusBadge status={r.status} /> }, { key: 'created_at', header: t('common.created'), render: (r) => <DateText value={r.created_at} withTime /> }, { key: 'age', header: t('approvals.age'), render: (r) => t('approvals.hours', { n: Math.round(r.age_hours) }) }]} />
      </Card>
    </div>
  );
}
