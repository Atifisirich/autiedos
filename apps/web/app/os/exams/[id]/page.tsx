'use client';
/** Exam detail: date sheet, invigilation allocation (fair, no teacher in own subject), seating plans. */
import { use, useState } from 'react';
import { useApp } from '@/lib/app';
import { post, useApi } from '@/lib/api';
import { useLookups, opts } from '@/lib/lookups';
import { Button, Card, DateText, ErrorBox, Field, Grid, Input, Loading, PageHeader, Select, StatusBadge, Table, useAction } from '@/components/ui';

export default function ExamDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { t, can, me } = useApp();
  const lk = useLookups();
  const x = useApi<any>(`/exams/${id}`);
  const a = useAction();
  const [s, setS] = useState({ class_id: '', subject_id: '', date: '', starts_at: '09:00', ends_at: '12:00', room_ids: [] as string[] });
  const [seat, setSeat] = useState({ date: '', room_ids: [] as string[] });
  const [swapWith, setSwapWith] = useState<Record<string, string>>({});
  if (!x.data) return x.error ? <ErrorBox error={x.error} /> : <Loading />;
  const rooms = (lk?.rooms ?? []).map((r) => <option key={r.id} value={r.id}>{r.name} ({r.capacity})</option>);
  return (
    <div>
      <PageHeader title={x.data.exam.name} subtitle={<><DateText value={x.data.exam.starts_on} /> – <DateText value={x.data.exam.ends_on} /></>} />
      <div className="space-y-4">
        <Card title={t('exams.dateSheet')}>
          <Table rows={x.data.schedules} columns={[{ key: 'date', header: t('common.date'), render: (r) => <DateText value={r.date} /> }, { key: 'time', header: t('common.time'), render: (r) => `${r.starts_at.slice(0, 5)}–${r.ends_at.slice(0, 5)}` }, { key: 'class_name', header: t('common.class') }, { key: 'subject_name', header: t('common.subject') }]} />
          {can('exams', 'edit') && (
            <div className="mt-3 space-y-2">
              <Grid cols={4}>
                <Field label={t('common.class')}><Select value={s.class_id} onChange={(e) => setS({ ...s, class_id: e.target.value })} placeholder={t('common.choose')} options={opts(lk?.classes.filter((c) => x.data.exam.class_ids?.includes(c.id) ?? true), (c) => c.name)} /></Field>
                <Field label={t('common.subject')}><Select value={s.subject_id} onChange={(e) => setS({ ...s, subject_id: e.target.value })} placeholder={t('common.choose')} options={opts(lk?.subjects, (c) => c.name)} /></Field>
                <Field label={t('common.date')}><Input type="date" value={s.date} onChange={(e) => setS({ ...s, date: e.target.value })} /></Field>
                <Field label={t('common.time')}><div className="flex gap-1"><Input type="time" aria-label={t('exams.start')} value={s.starts_at} onChange={(e) => setS({ ...s, starts_at: e.target.value })} /><Input type="time" aria-label={t('exams.end')} value={s.ends_at} onChange={(e) => setS({ ...s, ends_at: e.target.value })} /></div></Field>
              </Grid>
              <Field label={t('exams.rooms')}><select multiple aria-label={t('exams.rooms')} className="h-24 w-full rounded-md border border-slate-300 p-1 text-sm" value={s.room_ids} onChange={(e) => setS({ ...s, room_ids: [...e.target.selectedOptions].map((o) => o.value) })}>{rooms}</select></Field>
              <Button disabled={!s.class_id || !s.subject_id || !s.date || a.busy} onClick={async () => (await a.run(() => post('/exams/schedules', { exam_id: id, ...s }))) && x.reload()}>{t('exams.addPaper')}</Button>
            </div>
          )}
        </Card>
        <Card title={t('exams.invigilation')} actions={can('exams', 'assign') && <Button size="sm" disabled={a.busy} onClick={async () => (await a.run(() => post(`/exams/${id}/invigilation`))) && x.reload()}>{t('exams.allocate')}</Button>}>
          <Table rows={x.data.duties} columns={[{ key: 'date', header: t('common.date'), render: (r) => <DateText value={r.date} /> }, { key: 'time', header: t('common.time'), render: (r) => `${r.starts_at.slice(0, 5)}–${r.ends_at.slice(0, 5)}` }, { key: 'room_name', header: t('exams.room') }, { key: 'full_name', header: t('common.person') }, { key: 'status', header: t('common.status'), render: (r) => <StatusBadge status={r.status} /> }, { key: 'swap', header: '', render: (r) => r.staff_id === me?.staff.id && r.status === 'assigned' && (
            <div className="flex gap-1"><Select aria-label={t('duty.swapWith')} value={swapWith[r.id] ?? ''} onChange={(e) => setSwapWith({ ...swapWith, [r.id]: e.target.value })} placeholder={t('duty.swapWith')} options={opts(lk?.staff, (s) => s.full_name)} className="w-44" /><Button size="sm" variant="secondary" disabled={!swapWith[r.id]} onClick={async () => (await a.run(() => post(`/exams/invigilation/${r.id}/swap`, { swap_with_id: swapWith[r.id] }))) && x.reload()}>{t('duty.requestSwap')}</Button></div>
          ) }]} />
        </Card>
        <Card title={t('exams.seating')}>
          {can('exams', 'edit') && (
            <div className="mb-3 flex flex-wrap items-end gap-2">
              <Field label={t('common.date')}><Input type="date" value={seat.date} onChange={(e) => setSeat({ ...seat, date: e.target.value })} /></Field>
              <Field label={t('exams.rooms')}><select multiple aria-label={t('exams.rooms')} className="h-20 w-56 rounded-md border border-slate-300 p-1 text-sm" value={seat.room_ids} onChange={(e) => setSeat({ ...seat, room_ids: [...e.target.selectedOptions].map((o) => o.value) })}>{rooms}</select></Field>
              <Button disabled={!seat.date || !seat.room_ids.length || a.busy} onClick={async () => (await a.run(() => post(`/exams/${id}/seating`, seat))) && x.reload()}>{t('exams.generateSeating')}</Button>
            </div>
          )}
          {x.data.seating.map((sp: any) => (
            <details key={sp.id} className="mb-2 text-sm">
              <summary><DateText value={sp.date} /> · {sp.room_name}</summary>
              <div className="mt-1 grid grid-cols-4 gap-1 sm:grid-cols-8">{(sp.layout ?? []).map((seatRow: any, i: number) => <div key={i} className="rounded border border-slate-200 p-1 text-[10px]">{seatRow.seat} · {lk?.classes.find((c) => c.id === seatRow.class_id)?.name ?? ''}</div>)}</div>
            </details>
          ))}
        </Card>
        <ErrorBox error={a.error} />
      </div>
    </div>
  );
}
