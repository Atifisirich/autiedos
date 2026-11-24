'use client';
/** Incident log: quick entry with students from a section roster, follow-up tasks, confidential flag, reports. */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useApp } from '@/lib/app';
import { post, useApi } from '@/lib/api';
import { useLookups, opts } from '@/lib/lookups';
import { Badge, Button, Card, Checkbox, DateText, ErrorBox, Field, Grid, Input, Modal, PageHeader, Select, StatusBadge, Table, Tabs, Textarea, useAction } from '@/components/ui';

const TYPES = ['discipline', 'injury', 'parent_complaint', 'safety', 'property', 'ptm_note'] as const;
const SEV = ['low', 'medium', 'high', 'critical'] as const;

export default function Incidents() {
  const { t, can } = useApp();
  const router = useRouter();
  const lk = useLookups();
  const [tab, setTab] = useState('list');
  const list = useApi<any[]>(tab === 'list' ? '/incidents' : null);
  const rep = useApi<any>(tab === 'reports' ? '/incidents/reports' : null);
  const a = useAction();
  const [open, setOpen] = useState(false);
  const now = new Date(Date.now() - new Date().getTimezoneOffset() * 6e4).toISOString().slice(0, 16);
  const blank = { type: 'discipline', section: '', student_ids: [] as string[], room_id: '', location_text: '', occurred_at: now, description: '', action_taken: '', severity: 'low', confidential: false, owner_id: '', follow_ups: [] as { title: string; owner_id: string; due_on: string }[] };
  const [f, setF] = useState(blank);
  const roster = useApi<any>(f.section ? `/student-attendance/roster?section_id=${f.section}&date=${now.slice(0, 10)}&session_key=day` : null);
  return (
    <div>
      <PageHeader title={t('nav.incidents')} actions={can('incidents', 'create') && <Button onClick={() => (setF(blank), setOpen(true))}>{t('incidents.log')}</Button>} />
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'list', label: t('incidents.list') }, ...(can('incidents', 'view', 3) ? [{ value: 'reports', label: t('nav.reports') }] : [])]} />
      {tab === 'list' && (
        <Card>
          <Table rows={list.data} onRow={(r) => router.push(`/os/incidents/${r.id}`)} columns={[{ key: 'occurred_at', header: t('common.when'), render: (r) => <DateText value={r.occurred_at} withTime /> }, { key: 'type', header: t('common.type'), render: (r) => t(`incidentType.${r.type}`) }, { key: 'severity', header: t('incidents.severity'), render: (r) => <Badge tone={r.severity === 'critical' || r.severity === 'high' ? 'red' : r.severity === 'medium' ? 'amber' : 'gray'}>{t(`severity.${r.severity}`)}</Badge> }, { key: 'location', header: t('helpdesk.location'), render: (r) => r.room_name ?? r.location_text ?? '—' }, { key: 'students', header: t('incidents.students') }, { key: 'owner_name', header: t('tasks.owner') }, { key: 'status', header: t('common.status'), render: (r) => <>{r.confidential && <Badge tone="red">{t('incidents.confidential')}</Badge>} <StatusBadge status={r.status} /></> }]} />
        </Card>
      )}
      {tab === 'reports' && rep.data && (
        <div className="grid gap-4 lg:grid-cols-3">
          <Card title={t('incidents.byType')}><Table rows={rep.data.by_type} rowKey={(r) => r.type} columns={[{ key: 'type', header: t('common.type'), render: (r) => t(`incidentType.${r.type}`) }, { key: 'n', header: t('incidents.count') }]} /></Card>
          <Card title={t('incidents.byHour')}><Table rows={rep.data.by_hour} rowKey={(r) => String(r.hour)} columns={[{ key: 'hour', header: t('incidents.hour'), render: (r) => `${String(r.hour).padStart(2, '0')}:00` }, { key: 'n', header: t('incidents.count') }]} /></Card>
          <Card title={t('helpdesk.byLocation')}><Table rows={rep.data.by_location} rowKey={(r) => r.location} columns={[{ key: 'location', header: t('helpdesk.location') }, { key: 'n', header: t('incidents.count') }]} /></Card>
          <Card title={t('incidents.byClass')}><Table rows={rep.data.by_class} rowKey={(r) => r.class} columns={[{ key: 'class', header: t('common.class') }, { key: 'n', header: t('incidents.count') }]} /></Card>
          <Card title={t('incidents.repeat')}><Table rows={rep.data.repeat_students} rowKey={(r) => r.full_name} columns={[{ key: 'full_name', header: t('common.name') }, { key: 'n', header: t('incidents.count') }]} /></Card>
        </div>
      )}
      <Modal open={open} onClose={() => setOpen(false)} title={t('incidents.log')} wide>
        <div className="space-y-3">
          <Grid cols={3}>
            <Field label={t('common.type')}><Select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })} options={TYPES.map((x) => ({ value: x, label: t(`incidentType.${x}`) }))} /></Field>
            <Field label={t('incidents.severity')}><Select value={f.severity} onChange={(e) => setF({ ...f, severity: e.target.value })} options={SEV.map((x) => ({ value: x, label: t(`severity.${x}`) }))} /></Field>
            <Field label={t('common.when')}><Input type="datetime-local" value={f.occurred_at} onChange={(e) => setF({ ...f, occurred_at: e.target.value })} /></Field>
            <Field label={t('common.section')}><Select value={f.section} onChange={(e) => setF({ ...f, section: e.target.value })} placeholder={t('common.optional')} options={opts(lk?.sections, (s) => `${lk!.classes.find((c) => c.id === s.programme_id)?.name} ${s.name}`)} /></Field>
            <Field label={t('exams.room')}><Select value={f.room_id} onChange={(e) => setF({ ...f, room_id: e.target.value })} placeholder={t('common.optional')} options={opts(lk?.rooms, (r) => r.name)} /></Field>
            <Field label={t('helpdesk.location')}><Input value={f.location_text} onChange={(e) => setF({ ...f, location_text: e.target.value })} /></Field>
          </Grid>
          {roster.data && <Field label={t('incidents.students')}><select multiple aria-label={t('incidents.students')} className="h-28 w-full rounded-md border border-slate-300 p-1 text-sm" value={f.student_ids} onChange={(e) => setF({ ...f, student_ids: [...e.target.selectedOptions].map((o) => o.value) })}>{roster.data.students.map((s: any) => <option key={s.id} value={s.id}>{s.roll_no}. {s.full_name}</option>)}</select></Field>}
          <Field label={t('common.description')}><Textarea value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
          <Field label={t('incidents.actionTaken')}><Textarea value={f.action_taken} onChange={(e) => setF({ ...f, action_taken: e.target.value })} /></Field>
          <Grid cols={2}>
            <Field label={t('tasks.owner')}><Select value={f.owner_id} onChange={(e) => setF({ ...f, owner_id: e.target.value })} placeholder={t('incidents.autoOwner')} options={opts(lk?.staff, (s) => s.full_name)} /></Field>
            {can('incidents_confidential', 'view') && <Checkbox label={t('incidents.confidential')} checked={f.confidential} onChange={(e) => setF({ ...f, confidential: e.target.checked })} />}
          </Grid>
          <p className="text-sm font-semibold">{t('incidents.followUps')}</p>
          {f.follow_ups.map((fu, i) => (
            <div key={i} className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <Input aria-label={t('common.title')} placeholder={t('common.title')} value={fu.title} onChange={(e) => setF({ ...f, follow_ups: f.follow_ups.map((y, j) => (j === i ? { ...y, title: e.target.value } : y)) })} />
              <Select aria-label={t('tasks.owner')} value={fu.owner_id} onChange={(e) => setF({ ...f, follow_ups: f.follow_ups.map((y, j) => (j === i ? { ...y, owner_id: e.target.value } : y)) })} placeholder={t('tasks.owner')} options={opts(lk?.staff, (s) => s.full_name)} />
              <Input aria-label={t('tasks.due')} type="date" value={fu.due_on} onChange={(e) => setF({ ...f, follow_ups: f.follow_ups.map((y, j) => (j === i ? { ...y, due_on: e.target.value } : y)) })} />
            </div>
          ))}
          <Button size="sm" variant="secondary" onClick={() => setF({ ...f, follow_ups: [...f.follow_ups, { title: '', owner_id: '', due_on: new Date(Date.now() + 2 * 864e5).toISOString().slice(0, 10) }] })}>{t('common.add')}</Button>
          <ErrorBox error={a.error} />
          <Button disabled={f.description.length < 3 || a.busy} onClick={async () => { const { section: _s, ...rest } = f; const r = await a.run(() => post<{ id: string }>('/incidents', { ...rest, room_id: f.room_id || null, location_text: f.location_text || null, owner_id: f.owner_id || null, action_taken: f.action_taken || null, occurred_at: new Date(f.occurred_at).toISOString(), follow_ups: f.follow_ups.filter((y) => y.title && y.owner_id) })); if (r) router.push(`/os/incidents/${r.id}`); }}>{t('common.save')}</Button>
        </div>
      </Modal>
    </div>
  );
}
