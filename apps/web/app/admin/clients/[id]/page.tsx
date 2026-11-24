'use client';
import { use, useState } from 'react';
import Link from 'next/link';
import { useAdmin, useAdminApi } from '../../_lib/admin';
import { Badge, Health, Notice, PageTitle, Tabs } from '../../_lib/ui';
import { AuditViewer } from '../../_lib/audit-viewer';
import { OverviewTab } from './_tabs/overview';
import { SubscriptionsTab } from './_tabs/subscriptions';
import { UsersTab } from './_tabs/users';
import { SupportTab } from './_tabs/support';
import { BillingTab } from './_tabs/billing';

const TABS = ['overview', 'subscriptions', 'users', 'support', 'billing', 'audit'] as const;
type Tab = (typeof TABS)[number];

export default function ClientPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { t, errorText } = useAdmin();
  const [tab, setTab] = useState<Tab>('overview');
  const detail = useAdminApi<any>(`/clients/${id}`);
  const d = detail.data;

  return (
    <>
      <PageTitle
        title={d ? d.client.name : t('console.loading')}
        subtitle={d ? `${t(`console.kind.${d.client.kind}`)} · ${d.client.slug}` : undefined}
        actions={
          <Link href="/admin" className="inline-flex min-h-[44px] items-center text-sm text-brand-700 underline">
            {t('console.back')}
          </Link>
        }
      />
      <Notice error={detail.error ? errorText(detail.error) : null} />
      {d && (
        <>
          <p className="mb-4 flex flex-wrap items-center gap-2 text-sm">
            <Badge tone={d.client.client_status === 'active' ? 'green' : 'red'}>{t(`console.clientStatus.${d.client.client_status}`)}</Badge>
            <Health level={d.client.health.level} reasons={d.client.health.reasons} />
          </p>
          <Tabs label={t('console.tabs.label')} active={tab} onChange={(k) => setTab(k as Tab)} tabs={TABS.map((k) => ({ key: k, label: t(`console.tab.${k}`) }))} />
          <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="space-y-4">
            {tab === 'overview' && <OverviewTab detail={d} reload={detail.reload} />}
            {tab === 'subscriptions' && <SubscriptionsTab orgId={id} detail={d} reload={detail.reload} />}
            {tab === 'users' && <UsersTab orgId={id} detail={d} />}
            {tab === 'support' && <SupportTab orgId={id} />}
            {tab === 'billing' && <BillingTab orgId={id} detail={d} />}
            {tab === 'audit' && <AuditViewer orgId={id} />}
          </div>
        </>
      )}
    </>
  );
}
