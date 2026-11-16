'use client';
/** Question papers: generate from a blueprint (bank, AI or mixed), list, open for review. */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useApp } from '@/lib/app';
import { post, useApi } from '@/lib/api';
import { useLookups, opts } from '@/lib/lookups';
import { Button, Card, DateText, ErrorBox, Field, Grid, Input, Modal, PageHeader, Select, StatusBadge, Table, useAction } from '@/components/ui';

export default function Papers() {
  const { t, can } = useApp();
  const router = useRouter();
  const lk = useLookups();
  const list = useApi<any[]>('/exams/papers');
  const bps = useApi<any[]>('/exams/blueprints');
  const exams = useApi<any[]>('/exams');
  const quote = useApi<{ credits: number; balance: number }>('/lesson-plans/quote?action=question_paper&units=1');
  const a = useAction();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ blueprint_id: '', exam_id: '', exam_date: '', sets: 1, source: 'mixed', reviewer_ids: [] as string[] });
  return (
    <div>
      <PageHeader title={t('exams.papers')} actions={can('question_papers', 'create') && <Button onClick={() => setOpen(true)}>{t('exams.generatePaper')}</Button>} />
      <Card>
        <p className="mb-2 text-xs text-slate-500">{t('exams.paperSecurity')}</p>
        <Table rows={list.data} onRow={(r) => router.push(`/os/exams/papers/${r.id}`)} columns={[{ key: 'class_name', header: t('common.class') }, { key: 'subject_name', header: t('common.subject') }, { key: 'set_no', header: t('exams.set') }, { key: 'exam_date', header: t('common.date'), render: (r) => <DateText value={r.exam_date} /> }, { key: 'setter_name', header: t('exams.setter') }, { key: 'status', header: t('common.status'), render: (r) => <StatusBadge status={r.status} /> }]} />
      </Card>
      <Modal open={open} onClose={() => setOpen(false)} title={t('exams.generatePaper')}>
        <div className="space-y-3">
          <Field label={t('exams.blueprint')}><Select value={f.blueprint_id} onChange={(e) => setF({ ...f, blueprint_id: e.target.value })} placeholder={t('common.choose')} options={(bps.data ?? []).map((b) => ({ value: b.id, label: `${b.name} · ${b.class_name ?? ''} ${b.subject_name ?? ''}` }))} /></Field>
          <Field label={t('nav.exams')}><Select value={f.exam_id} onChange={(e) => setF({ ...f, exam_id: e.target.value })} placeholder={t('common.optional')} options={(exams.data ?? []).map((x) => ({ value: x.id, label: x.name }))} /></Field>
          <Grid cols={3}>
            <Field label={t('common.date')}><Input type="date" value={f.exam_date} onChange={(e) => setF({ ...f, exam_date: e.target.value })} /></Field>
            <Field label={t('exams.sets')}><Select value={String(f.sets)} onChange={(e) => setF({ ...f, sets: Number(e.target.value) })} options={[1, 2, 3].map((n) => ({ value: String(n), label: String(n) }))} /></Field>
            <Field label={t('exams.source')}><Select value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })} options={['mixed', 'bank', 'ai'].map((x) => ({ value: x, label: t(`paperSource.${x}`) }))} /></Field>
          </Grid>
          <Field label={t('exams.reviewers')}><select multiple aria-label={t('exams.reviewers')} className="h-24 w-full rounded-md border border-slate-300 p-1 text-sm" value={f.reviewer_ids} onChange={(e) => setF({ ...f, reviewer_ids: [...e.target.selectedOptions].map((o) => o.value) })}>{opts(lk?.staff, (s) => s.full_name).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></Field>
          {quote.data && f.source !== 'bank' && <p className="text-sm text-slate-600">{t('ai.quote', { credits: quote.data.credits * f.sets, balance: quote.data.balance })}</p>}
          <ErrorBox error={a.error} />
          <Button disabled={!f.blueprint_id || !f.exam_date || a.busy} onClick={async () => { const r = await a.run(() => post<{ paper_ids: string[] }>('/exams/papers/generate', { ...f, exam_id: f.exam_id || null })); if (r) router.push(`/os/exams/papers/${r.paper_ids[0]}`); }}>{a.busy ? t('plans.generating') : t('exams.generatePaper')}</Button>
        </div>
      </Modal>
    </div>
  );
}
