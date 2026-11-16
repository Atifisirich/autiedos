'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useApp } from '@/lib/app';
import { post, useApi } from '@/lib/api';
import { useLookups, opts } from '@/lib/lookups';
import { Button, Card, DateText, ErrorBox, Field, Grid, Input, Modal, PageHeader, Select, StatusBadge, Table, Textarea, useAction } from '@/components/ui';

export default function Meetings() {
  const { t, can } = useApp();
  const router = useRouter();
  const lk = useLookups();
  const list = useApi<any[]>('/meetings');
  const a = useAction();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ title: '', agenda: '', starts_at: '', ends_at: '', room_id: '', attendee_ids: [] as string[], repeat: '', count: 4 });
  return (
    <div>
      <PageHeader title={t('nav.meetings')} actions={can('meetings', 'create') && <Button onClick={() => setOpen(true)}>{t('meetings.new')}</Button>} />
      <Card>
        <Table rows={list.data} onRow={(r) => router.push(`/os/meetings/${r.id}`)} columns={[{ key: 'title', header: t('common.title') }, { key: 'starts_at', header: t('common.when'), render: (r) => <DateText value={r.starts_at} withTime /> }, { key: 'room_name', header: t('exams.room') }, { key: 'attendees', header: t('meetings.attendees') }, { key: 'status', header: t('common.status'), render: (r) => <StatusBadge status={r.status} /> }]} />
      </Card>
      <Modal open={open} onClose={() => setOpen(false)} title={t('meetings.new')}>
        <div className="space-y-3">
          <Field label={t('common.title')}><Input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
          <Field label={t('meetings.agenda')}><Textarea value={f.agenda} onChange={(e) => setF({ ...f, agenda: e.target.value })} /></Field>
          <Grid cols={2}>
            <Field label={t('exams.start')}><Input type="datetime-local" value={f.starts_at} onChange={(e) => setF({ ...f, starts_at: e.target.value })} /></Field>
            <Field label={t('exams.end')}><Input type="datetime-local" value={f.ends_at} onChange={(e) => setF({ ...f, ends_at: e.target.value })} /></Field>
            <Field label={t('exams.room')}><Select value={f.room_id} onChange={(e) => setF({ ...f, room_id: e.target.value })} placeholder={t('common.optional')} options={opts(lk?.rooms, (r) => r.name)} /></Field>
            <Field label={t('meetings.repeat')}><Select value={f.repeat} onChange={(e) => setF({ ...f, repeat: e.target.value })} options={[{ value: '', label: t('meetings.once') }, { value: 'weekly', label: t('meetings.weekly') }, { value: 'monthly', label: t('meetings.monthly') }]} /></Field>
          </Grid>
          {f.repeat && <Field label={t('meetings.occurrences')}><Input type="number" min={1} max={52} value={f.count} onChange={(e) => setF({ ...f, count: Number(e.target.value) })} /></Field>}
          <Field label={t('meetings.attendees')}><select multiple aria-label={t('meetings.attendees')} className="h-32 w-full rounded-md border border-slate-300 p-1 text-sm" value={f.attendee_ids} onChange={(e) => setF({ ...f, attendee_ids: [...e.target.selectedOptions].map((o) => o.value) })}>{(lk?.staff ?? []).map((s) => <option key={s.id} value={s.id}>{s.full_name}</option>)}</select></Field>
          <ErrorBox error={a.error} />
          <Button disabled={!f.title || !f.starts_at || !f.ends_at || !f.attendee_ids.length || a.busy} onClick={async () => { const r = await a.run(() => post<{ id: string }>('/meetings', { title: f.title, agenda: f.agenda || undefined, starts_at: new Date(f.starts_at).toISOString(), ends_at: new Date(f.ends_at).toISOString(), room_id: f.room_id || null, attendee_ids: f.attendee_ids, recurrence: f.repeat ? { frequency: f.repeat, count: f.count } : null })); if (r) router.push(`/os/meetings/${r.id}`); }}>{t('common.save')}</Button>
        </div>
      </Modal>
    </div>
  );
}
