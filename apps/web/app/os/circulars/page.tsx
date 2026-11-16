'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useApp } from '@/lib/app';
import { useApi } from '@/lib/api';
import { Badge, Card, DateText, Input, LinkButton, PageHeader, Table } from '@/components/ui';

export default function Circulars() {
  const { t, can } = useApp();
  const router = useRouter();
  const [q, setQ] = useState('');
  const list = useApi<any[]>(`/circulars${q ? `?q=${encodeURIComponent(q)}` : ''}`);
  return (
    <div>
      <PageHeader title={t('nav.circulars')} actions={can('circulars', 'create') && <LinkButton href="/os/circulars/new">{t('circulars.new')}</LinkButton>} />
      <Card actions={<Input aria-label={t('common.search')} placeholder={t('common.search')} value={q} onChange={(e) => setQ(e.target.value)} className="w-56" />}>
        <Table rows={list.data} onRow={(r) => router.push(`/os/circulars/${r.id}`)} columns={[
          { key: 'title', header: t('common.title'), render: (r) => <span className={!r.read_at && r.author_id ? 'font-semibold' : ''}>{r.important && <Badge tone="red">{t('circulars.important')}</Badge>} {r.title}</span> },
          { key: 'author_name', header: t('circulars.from') },
          { key: 'sent_at', header: t('circulars.sent'), render: (r) => (r.sent_at ? <DateText value={r.sent_at} withTime /> : <Badge>{t(`status.${r.status}`)}</Badge>) },
          { key: 'tags', header: t('circulars.tags'), render: (r) => (r.tags ?? []).map((x: string) => <Badge key={x}>{x}</Badge>) },
          { key: 'mine', header: t('common.status'), render: (r) => (r.acknowledged_at ? <Badge tone="green">{t('circulars.acknowledged')}</Badge> : r.read_at ? <Badge>{t('circulars.read')}</Badge> : <Badge tone="amber">{t('circulars.unread')}</Badge>) },
          { key: 'reach', header: t('circulars.reach'), render: (r) => `${r.read_count}/${r.recipients}` },
        ]} />
      </Card>
    </div>
  );
}
