'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useApp } from '@/lib/app';
import { useApi } from '@/lib/api';
import { Card, DateText, LinkButton, PageHeader, StatusBadge, Table, Tabs } from '@/components/ui';

export default function Checklists() {
  const { t, label, can } = useApp();
  const [tab, setTab] = useState('today');
  const runs = useApi<any[]>(tab === 'today' ? '/checklists/runs' : null);
  const tpls = useApi<any[]>(tab === 'templates' ? '/checklists/templates' : null);
  const rep = useApi<any>(tab === 'reports' ? '/checklists/reports' : null);
  return (
    <div>
      <PageHeader title={t('nav.checklists')} actions={can('checklists', 'configure') ? <LinkButton href="/os/setup/config/checklists" variant="secondary">{t('checklists.manage')}</LinkButton> : undefined} />
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'today', label: t('checklists.mine') }, ...(can('checklists', 'view', 2) ? [{ value: 'templates', label: t('checklists.templates') }, { value: 'reports', label: t('common.reports') }] : [])]} />
      {tab === 'today' && (
        <Card>
          <Table rows={runs.data} empty={t('checklists.none')} columns={[{ key: 'name', header: t('common.name'), render: (r) => <Link className="font-medium text-brand-700" href={`/os/checklists/${r.id}`}>{label(r.name_i18n, r.name)}</Link> }, { key: 'loc', header: t('common.location'), render: (r) => r.room_name ?? r.location_text ?? '—' }, { key: 'due_at', header: t('tasks.due'), render: (r) => <DateText value={r.due_at} withTime /> }, { key: 'status', header: t('common.status'), render: (r) => <StatusBadge status={r.status} /> }]} />
        </Card>
      )}
      {tab === 'templates' && (
        <div className="space-y-3">
          {(tpls.data ?? []).map((tp) => (
            <Card key={tp.id} title={label(tp.name_i18n, tp.name)} actions={<span className="text-xs text-slate-500">{t(`frequency.${tp.schedule.frequency}`)} · {tp.schedule.time} · {tp.owner_role_name ?? tp.owner_staff_name ?? '—'}</span>}>
              <ol className="list-decimal space-y-1 pl-5 text-sm">
                {tp.items.map((i: any) => (
                  <li key={i.id}>
                    {label(i.label_i18n, i.label)} <span className="text-xs text-slate-500">({t(`itemType.${i.item_type}`)}{i.on_fail ? ` · ${t(`onFail.${i.on_fail.action}`)}` : ''})</span>
                  </li>
                ))}
              </ol>
            </Card>
          ))}
        </div>
      )}
      {tab === 'reports' && rep.data && (
        <div className="space-y-4">
          <Card title={t('checklists.completion')}>
            <Table rows={rep.data.completion} rowKey={(r) => r.name} columns={[{ key: 'name', header: t('common.name') }, { key: 'runs', header: t('checklists.runs') }, { key: 'completed', header: t('status.completed') }, { key: 'missed', header: t('status.missed') }]} />
          </Card>
          <Card title={t('checklists.failures')}>
            <Table rows={rep.data.failures} rowKey={(r, i) => `${r.label}${i}`} columns={[{ key: 'checklist', header: t('nav.checklists') }, { key: 'label', header: t('checklists.item') }, { key: 'failures', header: t('checklists.failCount') }]} />
          </Card>
          <Card title={t('checklists.photos')}>
            <ul className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
              {rep.data.photos.map((p: any, i: number) => (
                <li key={i} className="rounded border p-2">
                  {p.name} · {p.label} · <DateText value={p.run_date} />
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}
    </div>
  );
}
