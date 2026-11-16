'use client';
/** AI credits for the branch: balance, usage by feature and teacher, ledger, top-up requests. */
import { useState } from 'react';
import { useApp } from '@/lib/app';
import { post, useApi } from '@/lib/api';
import { Button, Card, DateText, ErrorBox, Field, Input, PageHeader, Stat, StatusBadge, Table, useAction } from '@/components/ui';

export default function AiCredits() {
  const { t, can } = useApp();
  const [period, setPeriod] = useState(new Date().toISOString().slice(0, 7));
  const s = useApi<any>(`/ai/credits?period=${period}`);
  const a = useAction();
  const [req, setReq] = useState({ credits: '500', note: '' });
  const d = s.data;
  return (
    <div>
      <PageHeader title={t('nav.aiCredits')} actions={<Input type="month" aria-label={t('calendar.month')} value={period} onChange={(e) => setPeriod(e.target.value)} className="w-40" />} />
      {d && (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label={t('ai.balance')} value={d.balance} tone={d.pct >= 90 ? 'red' : d.pct >= 75 ? 'amber' : 'green'} />
            <Stat label={t('ai.granted')} value={d.granted} />
            <Stat label={t('ai.used')} value={`${d.used} (${d.pct}%)`} />
            <Stat label={t('ai.myUse')} value={d.teacher_cap ? `${d.my_used} / ${d.teacher_cap}` : d.my_used} />
          </div>
          {d.by_action && (
            <div className="grid gap-4 lg:grid-cols-2">
              <Card title={t('ai.byFeature')}><Table rows={d.by_action} rowKey={(r) => r.action} columns={[{ key: 'action', header: t('ai.feature'), render: (r) => t(`aiAction.${r.action}`) }, { key: 'uses', header: t('ai.uses') }, { key: 'credits', header: t('ai.credits') }]} /></Card>
              <Card title={t('ai.byTeacher')}><Table rows={d.by_teacher} rowKey={(r) => r.full_name} columns={[{ key: 'full_name', header: t('common.person') }, { key: 'credits', header: t('ai.credits') }]} /></Card>
              <Card title={t('ai.ledger')}><Table rows={d.ledger} columns={[{ key: 'created_at', header: t('common.when'), render: (r) => <DateText value={r.created_at} withTime /> }, { key: 'kind', header: t('common.type'), render: (r) => t(`ledgerKind.${r.kind}`) }, { key: 'action', header: t('ai.feature'), render: (r) => (r.action ? t(`aiAction.${r.action}`) : '—') }, { key: 'full_name', header: t('common.person') }, { key: 'credits', header: t('ai.credits') }]} /></Card>
              <Card title={t('ai.topups')}>
                <Table rows={d.requests} columns={[{ key: 'created_at', header: t('common.when'), render: (r) => <DateText value={r.created_at} /> }, { key: 'credits', header: t('ai.credits') }, { key: 'status', header: t('common.status'), render: (r) => <StatusBadge status={r.status} /> }]} />
                {can('ai', 'configure') && (
                  <div className="mt-3 flex flex-wrap items-end gap-2">
                    <Field label={t('ai.credits')}><Input type="number" min={10} value={req.credits} onChange={(e) => setReq({ ...req, credits: e.target.value })} /></Field>
                    <Field label={t('common.notes')}><Input value={req.note} onChange={(e) => setReq({ ...req, note: e.target.value })} /></Field>
                    <Button disabled={a.busy} onClick={async () => (await a.run(() => post('/ai/topup-request', { credits: Number(req.credits), note: req.note || undefined }))) && s.reload()}>{t('ai.requestTopup')}</Button>
                  </div>
                )}
                <ErrorBox error={a.error} />
              </Card>
            </div>
          )}
        </>
      )}
    </div>
  );
}
