'use client';
/** Events from templates: tasks, committees and budget are created automatically. */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useApp } from '@/lib/app';
import { post, useApi } from '@/lib/api';
import { useLookups, opts } from '@/lib/lookups';
import { Button, Card, DateText, ErrorBox, Field, Input, Modal, PageHeader, Select, StatusBadge, Table, useAction } from '@/components/ui';

export default function Events() {
  const { t, label, can } = useApp();
  const router = useRouter();
  const lk = useLookups();
  const list = useApi<any[]>('/events');
  const a = useAction();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ template_id: '', name: '', event_date: '', owner_id: '' });
  return (
    <div>
      <PageHeader title={t('nav.events')} actions={can('events', 'create') && <Button onClick={() => setOpen(true)}>{t('events.new')}</Button>} />
      <Card>
        <Table rows={list.data} onRow={(r) => router.push(`/os/events/${r.id}`)} columns={[{ key: 'name', header: t('common.name') }, { key: 'event_date', header: t('common.date'), render: (r) => <DateText value={r.event_date} /> }, { key: 'readiness', header: t('events.readiness'), render: (r) => (r.readiness != null ? `${Math.round(r.readiness * 100)}%` : '—') }, { key: 'status', header: t('common.status'), render: (r) => <StatusBadge status={r.status} /> }]} />
      </Card>
      <Modal open={open} onClose={() => setOpen(false)} title={t('events.new')}>
        <div className="space-y-3">
          <Field label={t('events.template')}><Select value={f.template_id} onChange={(e) => { const tpl = lk?.event_templates.find((x) => x.id === e.target.value); setF({ ...f, template_id: e.target.value, name: f.name || (tpl ? label(tpl.name_i18n, tpl.name) : '') }); }} placeholder={t('events.blank')} options={opts(lk?.event_templates, (x) => label(x.name_i18n, x.name))} /></Field>
          <Field label={t('common.name')}><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label={t('common.date')}><Input type="date" value={f.event_date} onChange={(e) => setF({ ...f, event_date: e.target.value })} /></Field>
          <Field label={t('events.owner')}><Select value={f.owner_id} onChange={(e) => setF({ ...f, owner_id: e.target.value })} placeholder={t('appraisal.myself')} options={opts(lk?.staff, (s) => s.full_name)} /></Field>
          <p className="text-xs text-slate-500">{t('events.templateHint')}</p>
          <ErrorBox error={a.error} />
          <Button disabled={f.name.length < 2 || !f.event_date || a.busy} onClick={async () => { const r = await a.run(() => post<{ id: string }>('/events', { template_id: f.template_id || null, name: f.name, event_date: f.event_date, owner_id: f.owner_id || null })); if (r) router.push(`/os/events/${r.id}`); }}>{t('common.save')}</Button>
        </div>
      </Modal>
    </div>
  );
}
