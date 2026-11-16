'use client';
/** Duty roster: auto-generated fair rotation, swaps via approval, manual override, mark done/missed. */
import { useState } from 'react';
import { useApp } from '@/lib/app';
import { post, useApi } from '@/lib/api';
import { useLookups, opts } from '@/lib/lookups';
import { Badge, Button, Card, DateText, ErrorBox, Field, Input, Modal, PageHeader, Select, StatusBadge, Table, useAction } from '@/components/ui';

export default function Duty() {
  const { t, label, can, me } = useApp();
  const lk = useLookups();
  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(today);
  const to = new Date(new Date(from).getTime() + 6 * 864e5).toISOString().slice(0, 10);
  const list = useApi<any[]>(`/duty?from=${from}&to=${to}`);
  const a = useAction();
  const [swap, setSwap] = useState<any>(null);
  const [other, setOther] = useState('');
  const mine = (r: any) => r.staff_id === me?.staff?.id;
  return (
    <div>
      <PageHeader title={t('nav.duty')} actions={can('duty_roster', 'create') && <Button disabled={a.busy} onClick={async () => (await a.run(() => post('/duty/generate', { from, to }))) && list.reload()}>{t('duty.generate')}</Button>} />
      <Card>
        <div className="mb-3 flex items-end gap-2"><Field label={t('duty.weekFrom')}><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field></div>
        <Table rows={list.data} columns={[
          { key: 'date', header: t('common.date'), render: (r) => <DateText value={r.date} /> },
          { key: 'name', header: t('duty.duty'), render: (r) => label(r.name_i18n, r.name) },
          { key: 'time', header: t('common.time'), render: (r) => `${r.starts_at?.slice(0, 5)}–${r.ends_at?.slice(0, 5)}` },
          { key: 'full_name', header: t('common.person'), render: (r) => <>{r.full_name}{r.manual && <Badge tone="amber">{t('duty.manual')}</Badge>}</> },
          { key: 'status', header: t('common.status'), render: (r) => <StatusBadge status={r.status} /> },
          { key: 'act', header: '', render: (r) => (
            <div className="flex gap-1">
              {mine(r) && r.status === 'assigned' && <Button size="sm" variant="secondary" onClick={() => setSwap(r)}>{t('duty.swap')}</Button>}
              {can('duty_roster', 'edit') && r.status === 'assigned' && (
                <>
                  <Button size="sm" variant="ghost" onClick={async () => (await a.run(() => post(`/duty/${r.id}/mark`, { status: 'done' }))) && list.reload()}>{t('duty.done')}</Button>
                  <Button size="sm" variant="ghost" onClick={async () => (await a.run(() => post(`/duty/${r.id}/mark`, { status: 'missed' }))) && list.reload()}>{t('duty.missed')}</Button>
                </>
              )}
            </div>
          ) },
        ]} />
        <ErrorBox error={a.error} />
      </Card>
      <Modal open={!!swap} onClose={() => setSwap(null)} title={t('duty.swap')}>
        <Field label={t('duty.swapWith')}><Select value={other} onChange={(e) => setOther(e.target.value)} placeholder={t('common.choose')} options={opts(lk?.staff.filter((s) => s.id !== me?.staff?.id), (s) => s.full_name)} /></Field>
        {can('duty_roster', 'edit') && <p className="mb-2 text-xs text-slate-500">{t('duty.overrideHint')}</p>}
        <div className="flex gap-2">
          <Button disabled={!other || a.busy} onClick={async () => (await a.run(() => post('/duty/swap', { assignment_id: swap.id, swap_with_id: other }))) && (setSwap(null), list.reload())}>{t('duty.requestSwap')}</Button>
          {can('duty_roster', 'edit') && <Button variant="secondary" disabled={!other || a.busy} onClick={async () => (await a.run(() => post(`/duty/${swap.id}/override`, { staff_id: other }))) && (setSwap(null), list.reload())}>{t('duty.override')}</Button>}
        </div>
      </Modal>
    </div>
  );
}
