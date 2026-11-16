'use client';
/** School calendar with layers (holidays, exams, events, PTMs, meetings, trainings, deadlines). */
import { useState } from 'react';
import { useApp } from '@/lib/app';
import { api, post, useApi } from '@/lib/api';
import { Badge, Button, Card, Checkbox, ErrorBox, Field, Grid, Input, Modal, PageHeader, Select, cx, useAction } from '@/components/ui';

const LAYERS = ['holiday', 'exam', 'event', 'ptm', 'staff_meeting', 'training', 'deadline'] as const;
const COLORS: Record<string, string> = { holiday: 'bg-red-100', exam: 'bg-purple-100', event: 'bg-blue-100', ptm: 'bg-amber-100', staff_meeting: 'bg-slate-200', training: 'bg-green-100', deadline: 'bg-orange-100' };

export default function Calendar() {
  const { t, can } = useApp();
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [layers, setLayers] = useState<string[]>([...LAYERS]);
  const from = `${month}-01`;
  const last = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate();
  const to = `${month}-${String(last).padStart(2, '0')}`;
  const ev = useApi<any[]>(`/calendar?from=${from}&to=${to}&layers=${layers.join(',')}`);
  const a = useAction();
  const blank = { id: '', layer: 'event', title: '', starts_on: from, ends_on: from, starts_at: '', ends_at: '', group_level: false };
  const [edit, setEdit] = useState<typeof blank | null>(null);
  const firstDow = (new Date(from).getDay() + 6) % 7;
  const cells = [...Array(firstDow).fill(null), ...Array.from({ length: last }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`)];
  const shift = (n: number) => { const d = new Date(`${month}-15`); d.setMonth(d.getMonth() + n); setMonth(d.toISOString().slice(0, 7)); };
  return (
    <div>
      <PageHeader title={t('nav.calendar')} actions={can('calendar', 'create') && <Button onClick={() => setEdit(blank)}>{t('calendar.add')}</Button>} />
      <Card actions={<div className="flex items-center gap-2"><Button size="sm" variant="ghost" onClick={() => shift(-1)} aria-label={t('calendar.previous')}>‹</Button><Input type="month" aria-label={t('calendar.month')} value={month} onChange={(e) => setMonth(e.target.value)} className="w-40" /><Button size="sm" variant="ghost" onClick={() => shift(1)} aria-label={t('calendar.next')}>›</Button></div>}>
        <div className="mb-3 flex flex-wrap gap-3">{LAYERS.map((l) => <Checkbox key={l} label={<span className={cx('rounded px-1', COLORS[l])}>{t(`layer.${l}`)}</span>} checked={layers.includes(l)} onChange={(e) => setLayers(e.target.checked ? [...layers, l] : layers.filter((x) => x !== l))} />)}</div>
        <div className="grid grid-cols-7 gap-1 text-xs">
          {[1, 2, 3, 4, 5, 6, 7].map((d) => <div key={d} className="p-1 text-center font-semibold">{t(`day.${d}`)}</div>)}
          {cells.map((d, i) => (
            <div key={i} className="min-h-[80px] rounded border border-slate-100 p-1">
              {d && <div className="text-slate-500">{Number(d.slice(8))}</div>}
              {d && (ev.data ?? []).filter((e) => e.starts_on.slice(0, 10) <= d && e.ends_on.slice(0, 10) >= d).map((e) => (
                <button key={e.id} type="button" onClick={() => can('calendar', 'edit') && setEdit({ id: e.id, layer: e.layer, title: e.title, starts_on: e.starts_on.slice(0, 10), ends_on: e.ends_on.slice(0, 10), starts_at: e.starts_at?.slice(0, 5) ?? '', ends_at: e.ends_at?.slice(0, 5) ?? '', group_level: !e.branch_id })} className={cx('mb-0.5 block w-full truncate rounded px-1 text-left', COLORS[e.layer])}>
                  {e.starts_at && `${e.starts_at.slice(0, 5)} `}{e.title}
                </button>
              ))}
            </div>
          ))}
        </div>
      </Card>
      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? t('common.edit') : t('calendar.add')}>
        {edit && (
          <div className="space-y-3">
            <Field label={t('common.title')}><Input value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} /></Field>
            <Field label={t('calendar.layer')}><Select value={edit.layer} onChange={(e) => setEdit({ ...edit, layer: e.target.value })} options={LAYERS.map((l) => ({ value: l, label: t(`layer.${l}`) }))} /></Field>
            <Grid cols={2}>
              <Field label={t('leave.from')}><Input type="date" value={edit.starts_on} onChange={(e) => setEdit({ ...edit, starts_on: e.target.value })} /></Field>
              <Field label={t('leave.to')}><Input type="date" value={edit.ends_on} onChange={(e) => setEdit({ ...edit, ends_on: e.target.value })} /></Field>
              <Field label={t('exams.start')}><Input type="time" value={edit.starts_at} onChange={(e) => setEdit({ ...edit, starts_at: e.target.value })} /></Field>
              <Field label={t('exams.end')}><Input type="time" value={edit.ends_at} onChange={(e) => setEdit({ ...edit, ends_at: e.target.value })} /></Field>
            </Grid>
            {can('calendar', 'configure', 6) && <Checkbox label={t('calendar.groupLevel')} checked={edit.group_level} onChange={(e) => setEdit({ ...edit, group_level: e.target.checked })} />}
            <ErrorBox error={a.error} />
            <Button disabled={!edit.title || a.busy} onClick={async () => {
              const body = { layer: edit.layer, title: edit.title, starts_on: edit.starts_on, ends_on: edit.ends_on, starts_at: edit.starts_at || null, ends_at: edit.ends_at || null, group_level: edit.group_level };
              if (await a.run(() => (edit.id ? api('PUT', `/calendar/${edit.id}`, body) : post('/calendar', body)))) (setEdit(null), ev.reload());
            }}>{t('common.save')}</Button>
          </div>
        )}
      </Modal>
    </div>
  );
}
