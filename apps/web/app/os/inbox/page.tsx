'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useApp } from '@/lib/app';
import { post, useApi } from '@/lib/api';
import { Badge, Button, Card, DateText, Empty, PageHeader, Tabs, cx } from '@/components/ui';

export default function Inbox() {
  const { t } = useApp();
  const router = useRouter();
  const [tab, setTab] = useState('unread');
  const list = useApi<any[]>(`/inbox${tab === 'unread' ? '?unread=1' : ''}`);
  const open = async (n: any) => {
    if (!n.read_at) await post('/inbox/read', { ids: [n.id] }).catch(() => undefined);
    if (n.link) router.push(n.link);
    else list.reload();
  };
  return (
    <div>
      <PageHeader title={t('nav.inbox')} actions={<Button variant="secondary" onClick={async () => (await post('/inbox/read', { ids: 'all' }), list.reload())}>{t('inbox.markAllRead')}</Button>} />
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'unread', label: t('inbox.unread') }, { value: 'all', label: t('common.all') }]} />
      <Card>
        {list.data?.length === 0 && <Empty>{t('inbox.empty')}</Empty>}
        <ul className="divide-y divide-slate-100">
          {(list.data ?? []).map((n) => (
            <li key={n.id}>
              <button type="button" onClick={() => open(n)} className={cx('w-full py-3 text-left', !n.read_at && 'font-medium')}>
                <div className="flex items-center gap-2">{n.priority === 'urgent' && <Badge tone="red">{t('priority.urgent')}</Badge>}<span>{n.title}</span></div>
                {n.body && <p className="text-sm font-normal text-slate-600">{n.body}</p>}
                <p className="text-xs font-normal text-slate-400"><DateText value={n.created_at} withTime /></p>
              </button>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
