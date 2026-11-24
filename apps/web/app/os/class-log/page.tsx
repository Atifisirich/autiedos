'use client';
/** Class log: what was taught each period, homework with daily load limit, notebook checks. */
import { useState } from 'react';
import { useApp } from '@/lib/app';
import { post, useApi } from '@/lib/api';
import { useLookups, opts } from '@/lib/lookups';
import { useCurriculum } from '@/lib/curriculum';
import { Badge, Button, Card, Checkbox, DateText, ErrorBox, Field, Grid, Input, PageHeader, Select, Table, Tabs, Textarea, useAction } from '@/components/ui';

export default function ClassLog() {
  const { t, can, me } = useApp();
  const lk = useLookups();
  const [tab, setTab] = useState('log');
  const today = new Date().toISOString().slice(0, 10);
  const [f, setF] = useState({ section_id: '', subject_id: '', date: today, period_seq: 1, topic_id: '', taught_as_planned: true, topic_text: '', classwork: '', remarks: '', hw: false, hw_desc: '', hw_due: today, hw_min: 20 });
  const { chapters } = useCurriculum(lk, f.section_id, f.subject_id);
  const log = useApi<any>(f.section_id && tab === 'log' ? `/class-log?section_id=${f.section_id}` : null);
  const load = useApi<any[]>(tab === 'homework' ? '/class-log/homework-load' : null);
  const nb = useApi<any[]>(tab === 'notebooks' ? '/class-log/notebooks' : null);
  const [n, setN] = useState({ section_id: '', subject_id: '', staff_id: '', kind: 'cycle', checked_on: today, neatness: 3, completion: 3, correction: 3, remarks: '' });
  const a = useAction();
  const [saved, setSaved] = useState<string | null>(null);
  const secOpts = opts(lk?.sections, (s) => `${lk!.classes.find((c) => c.id === s.programme_id)?.name} ${s.name}`);
  return (
    <div>
      <PageHeader title={t('nav.classLog')} />
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'log', label: t('classLog.log') }, { value: 'homework', label: t('classLog.homeworkLoad') }, { value: 'notebooks', label: t('classLog.notebooks') }]} />
      {tab === 'log' && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card title={t('classLog.add')}>
            <div className="space-y-3">
              <Grid cols={2}>
                <Field label={t('common.section')}><Select value={f.section_id} onChange={(e) => setF({ ...f, section_id: e.target.value, topic_id: '' })} placeholder={t('common.choose')} options={secOpts} /></Field>
                <Field label={t('common.subject')}><Select value={f.subject_id} onChange={(e) => setF({ ...f, subject_id: e.target.value, topic_id: '' })} placeholder={t('common.choose')} options={opts(lk?.subjects, (s) => s.name)} /></Field>
                <Field label={t('common.date')}><Input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
                <Field label={t('timetable.period')}><Input type="number" min={1} max={12} value={f.period_seq} onChange={(e) => setF({ ...f, period_seq: Number(e.target.value) })} /></Field>
              </Grid>
              <Field label={t('plans.topic')}>
                <select className="w-full rounded-md border border-slate-300 p-2 text-sm" value={f.topic_id} onChange={(e) => setF({ ...f, topic_id: e.target.value })}>
                  <option value="">{t('common.optional')}</option>
                  {(chapters ?? []).map((ch) => <optgroup key={ch.id} label={ch.name}>{ch.topics.map((tp) => <option key={tp.id} value={tp.id}>{tp.name}</option>)}</optgroup>)}
                </select>
              </Field>
              <Checkbox label={t('classLog.asPlanned')} checked={f.taught_as_planned} onChange={(e) => setF({ ...f, taught_as_planned: e.target.checked })} />
              <Field label={t('classLog.topicText')}><Input value={f.topic_text} onChange={(e) => setF({ ...f, topic_text: e.target.value })} /></Field>
              <Field label={t('classLog.classwork')}><Textarea value={f.classwork} onChange={(e) => setF({ ...f, classwork: e.target.value })} /></Field>
              <Field label={t('classLog.remarks')}><Input value={f.remarks} onChange={(e) => setF({ ...f, remarks: e.target.value })} /></Field>
              <Checkbox label={t('classLog.giveHomework')} checked={f.hw} onChange={(e) => setF({ ...f, hw: e.target.checked })} />
              {f.hw && (
                <Grid cols={3}>
                  <Field label={t('common.description')}><Input value={f.hw_desc} onChange={(e) => setF({ ...f, hw_desc: e.target.value })} /></Field>
                  <Field label={t('tasks.due')}><Input type="date" value={f.hw_due} onChange={(e) => setF({ ...f, hw_due: e.target.value })} /></Field>
                  <Field label={t('classLog.minutes')}><Input type="number" value={f.hw_min} onChange={(e) => setF({ ...f, hw_min: Number(e.target.value) })} /></Field>
                </Grid>
              )}
              <ErrorBox error={a.error} />
              {saved && <p className="text-sm text-green-700">{saved}</p>}
              <Button disabled={!f.section_id || !f.subject_id || a.busy} onClick={async () => {
                const r = await a.run(() => post('/class-log', { section_id: f.section_id, subject_id: f.subject_id, date: f.date, period_seq: f.period_seq, topic_id: f.topic_id || null, taught_as_planned: f.taught_as_planned, topic_text: f.topic_text || null, classwork: f.classwork || null, remarks: f.remarks || null, homework: f.hw ? { description: f.hw_desc, due_on: f.hw_due, est_minutes: f.hw_min } : null, client_id: crypto.randomUUID() }));
                if (r) (setSaved(t('classLog.saved')), log.reload());
              }}>{t('common.save')}</Button>
            </div>
          </Card>
          <Card title={t('classLog.recent')}>
            {!f.section_id && <p className="text-sm text-slate-500">{t('classLog.pickSection')}</p>}
            <Table rows={log.data?.logs} columns={[{ key: 'date', header: t('common.date'), render: (r) => <DateText value={r.date} /> }, { key: 'period_seq', header: t('timetable.period') }, { key: 'subject', header: t('common.subject') }, { key: 'topic_text', header: t('plans.topic') }, { key: 'teacher', header: t('common.person') }]} />
            <h3 className="mb-1 mt-4 text-sm font-semibold">{t('classLog.homework')}</h3>
            <Table rows={log.data?.homework} columns={[{ key: 'due_on', header: t('tasks.due'), render: (r) => <DateText value={r.due_on} /> }, { key: 'subject', header: t('common.subject') }, { key: 'description', header: t('common.description') }, { key: 'est_minutes', header: t('classLog.minutes') }]} />
          </Card>
        </div>
      )}
      {tab === 'homework' && (
        <Card>
          <Table rows={load.data} rowKey={(r) => `${r.sectionId}:${r.date}`} columns={[{ key: 'section', header: t('common.section') }, { key: 'date', header: t('tasks.due'), render: (r) => <DateText value={r.date} /> }, { key: 'minutes', header: t('classLog.minutes'), render: (r) => <span className={r.over ? 'font-semibold text-red-700' : ''}>{r.minutes} / {r.limit}</span> }, { key: 'over', header: '', render: (r) => r.over && <Badge tone="red">{t('classLog.over')}</Badge> }]} />
        </Card>
      )}
      {tab === 'notebooks' && (
        <div className="space-y-4">
          {can('class_log', 'verify') && (
            <Card title={t('classLog.addCheck')}>
              <Grid cols={4}>
                <Field label={t('common.section')}><Select value={n.section_id} onChange={(e) => setN({ ...n, section_id: e.target.value })} placeholder={t('common.choose')} options={secOpts} /></Field>
                <Field label={t('common.subject')}><Select value={n.subject_id} onChange={(e) => setN({ ...n, subject_id: e.target.value })} placeholder={t('common.choose')} options={opts(lk?.subjects, (s) => s.name)} /></Field>
                <Field label={t('observation.teacher')}><Select value={n.staff_id} onChange={(e) => setN({ ...n, staff_id: e.target.value })} placeholder={t('common.choose')} options={opts(lk?.staff.filter((s) => s.is_teaching), (s) => s.full_name)} /></Field>
                <Field label={t('common.type')}><Select value={n.kind} onChange={(e) => setN({ ...n, kind: e.target.value })} options={['cycle', 'spot_check'].map((k) => ({ value: k, label: t(`notebookKind.${k}`) }))} /></Field>
                {(['neatness', 'completion', 'correction'] as const).map((k) => <Field key={k} label={t(`notebook.${k}`)}><Select value={String(n[k])} onChange={(e) => setN({ ...n, [k]: Number(e.target.value) })} options={[1, 2, 3, 4, 5].map((v) => ({ value: String(v), label: String(v) }))} /></Field>)}
                <Field label={t('common.date')}><Input type="date" value={n.checked_on} onChange={(e) => setN({ ...n, checked_on: e.target.value })} /></Field>
              </Grid>
              <Field label={t('classLog.remarks')}><Input value={n.remarks} onChange={(e) => setN({ ...n, remarks: e.target.value })} /></Field>
              <Button disabled={!n.section_id || !n.subject_id || !n.staff_id || a.busy} onClick={async () => (await a.run(() => post('/class-log/notebooks', { section_id: n.section_id, subject_id: n.subject_id, staff_id: n.staff_id, kind: n.kind, checked_on: n.checked_on, rubric: { neatness: n.neatness, completion: n.completion, correction: n.correction }, notes: n.remarks || undefined }))) && nb.reload()}>{t('common.save')}</Button>
              <ErrorBox error={a.error} />
            </Card>
          )}
          <Card><Table rows={nb.data} columns={[{ key: 'checked_on', header: t('common.date'), render: (r) => <DateText value={r.checked_on} /> }, { key: 'section', header: t('common.section') }, { key: 'subject', header: t('common.subject') }, { key: 'teacher', header: t('observation.teacher') }, { key: 'checked_by_name', header: t('classLog.checkedBy') }, { key: 'rubric', header: t('classLog.scores'), render: (r) => Object.entries(r.rubric ?? {}).map(([k, v]) => `${t(`notebook.${k}`)} ${v}`).join(' · ') }]} /></Card>
        </div>
      )}
    </div>
  );
}
