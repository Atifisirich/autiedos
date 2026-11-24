'use client';
/** Meeting: agenda, previous actions carried forward, minutes, attendance, action items that become tasks. */
import { use, useEffect, useState } from 'react';
import { useApp } from '@/lib/app';
import { post, useApi } from '@/lib/api';
import { useLookups, opts } from '@/lib/lookups';
import { Button, Card, Checkbox, DateText, ErrorBox, Input, Loading, PageHeader, Select, StatusBadge, Table, Textarea, useAction } from '@/components/ui';

export default function MeetingDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { t, me } = useApp();
  const lk = useLookups();
  const m = useApi<any>(`/meetings/${id}`);
  const a = useAction();
  const [minutes, setMinutes] = useState('');
  const [att, setAtt] = useState<Record<string, boolean>>({});
  const [actions, setActions] = useState<{ description: string; owner_id: string; due_on: string }[]>([]);
  useEffect(() => {
    if (m.data) { setMinutes(m.data.minutes ?? ''); setAtt(m.data.attendance ?? {}); }
  }, [m.data]);
  if (!m.data) return m.error ? <ErrorBox error={m.error} /> : <Loading />;
  const x = m.data;
  const canEdit = x.organizer_id === me?.staff.id && x.status === 'scheduled';
  const save = async (close: boolean) => (await a.run(() => post(`/meetings/${id}/minutes`, { minutes, attendance: att, actions: actions.filter((y) => y.description && y.owner_id), close }))) && (setActions([]), m.reload());
  const actionTable = (rows: any[]) => <Table rows={rows} columns={[{ key: 'description', header: t('common.description') }, { key: 'owner_name', header: t('tasks.owner') }, { key: 'due_on', header: t('tasks.due'), render: (r) => <DateText value={r.due_on} /> }, { key: 'task_status', header: t('common.status'), render: (r) => <StatusBadge status={r.task_status} /> }]} />;
  return (
    <div>
      <PageHeader title={x.title} subtitle={<span className="flex items-center gap-2"><StatusBadge status={x.status} /><DateText value={x.starts_at} withTime /> · {x.room_name ?? ''} · {x.organizer_name}</span>} />
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card title={t('meetings.agenda')}><p className="whitespace-pre-wrap text-sm">{x.agenda ?? '—'}</p></Card>
          {x.previous_actions.length > 0 && <Card title={t('meetings.previousActions')}>{actionTable(x.previous_actions)}</Card>}
          <Card title={t('meetings.minutes')}>
            {canEdit ? <Textarea rows={10} value={minutes} onChange={(e) => setMinutes(e.target.value)} /> : <p className="whitespace-pre-wrap text-sm">{x.minutes ?? '—'}</p>}
          </Card>
          <Card title={t('meetings.actions')}>
            {actionTable(x.actions)}
            {canEdit && (
              <div className="mt-3 space-y-2">
                {actions.map((ac, i) => (
                  <div key={i} className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                    <Input aria-label={t('common.description')} placeholder={t('common.description')} value={ac.description} onChange={(e) => setActions(actions.map((y, j) => (j === i ? { ...y, description: e.target.value } : y)))} />
                    <Select aria-label={t('tasks.owner')} value={ac.owner_id} onChange={(e) => setActions(actions.map((y, j) => (j === i ? { ...y, owner_id: e.target.value } : y)))} placeholder={t('tasks.owner')} options={opts(lk?.staff, (s) => s.full_name)} />
                    <Input aria-label={t('tasks.due')} type="date" value={ac.due_on} onChange={(e) => setActions(actions.map((y, j) => (j === i ? { ...y, due_on: e.target.value } : y)))} />
                  </div>
                ))}
                <Button size="sm" variant="secondary" onClick={() => setActions([...actions, { description: '', owner_id: '', due_on: new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10) }])}>{t('meetings.addAction')}</Button>
                <p className="text-xs text-slate-500">{t('meetings.actionsHint')}</p>
              </div>
            )}
          </Card>
        </div>
        <Card title={t('meetings.attendance')}>
          <div className="space-y-1">{x.attendees.map((s: any) => <Checkbox key={s.id} label={s.full_name} disabled={!canEdit} checked={!!att[s.id]} onChange={(e) => setAtt({ ...att, [s.id]: e.target.checked })} />)}</div>
          {canEdit && (
            <div className="mt-4 flex flex-wrap gap-2">
              <Button disabled={a.busy} onClick={() => save(false)}>{t('common.save')}</Button>
              <Button variant="secondary" disabled={a.busy} onClick={() => save(true)}>{t('meetings.close')}</Button>
            </div>
          )}
          <ErrorBox error={a.error} />
        </Card>
      </div>
    </div>
  );
}
