'use client';
import Link from 'next/link';
import { useAdmin, useAdminApi } from '../_lib/admin';
import { Badge, Card, DataTable, Notice, PageTitle } from '../_lib/ui';

/** Every view-as session across clients, newest first (the audit trail of AutoEd staff access). */
export default function SupportPage() {
  const { t, errorText, dateTime } = useAdmin();
  const s = useAdminApi<any[]>('/support-sessions');
  return (
    <>
      <PageTitle title={t('console.support.title')} subtitle={t('console.support.subtitle')} />
      <Notice error={s.error ? errorText(s.error) : null} />
      <Card>
        <DataTable
          caption={t('console.support.title')}
          rows={s.loading && !s.data ? null : (s.data ?? [])}
          rowKey={(r: any) => r.id}
          columns={[
            { key: 'org', header: t('console.audit.client'), render: (r: any) => <Link className="text-brand-700 underline" href={`/admin/clients/${r.org_id}`}>{r.org_name}</Link> },
            { key: 'who', header: t('console.viewAs.staff'), render: (r: any) => r.admin_name ?? t('console.none') },
            { key: 'reason', header: t('console.reason'), render: (r: any) => r.reason },
            { key: 'mode', header: t('console.viewAs.mode'), render: (r: any) => (r.read_only ? t('console.viewAs.readOnly') : t('console.viewAs.readWrite')) },
            { key: 'start', header: t('console.viewAs.started'), render: (r: any) => dateTime(r.started_at) },
            { key: 'end', header: t('console.viewAs.endedAt'), render: (r: any) => dateTime(r.ended_at ?? r.expires_at) },
            { key: 'state', header: t('console.clients.status'), render: (r: any) => <Badge tone={r.state === 'open' ? 'amber' : 'gray'}>{t(`console.sessionState.${r.state}`)}</Badge> },
          ]}
        />
      </Card>
    </>
  );
}
