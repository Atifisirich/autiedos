'use client';
/** School library (RAG sources) and curriculum maps. */
import { useState } from 'react';
import { useApp } from '@/lib/app';
import { get, post, uploadFile, useApi } from '@/lib/api';
import { useLookups, opts } from '@/lib/lookups';
import { Badge, Button, Card, DateText, ErrorBox, Field, Grid, Input, PageHeader, Select, Table, Tabs, useAction } from '@/components/ui';

const KINDS = ['textbook', 'year_plan', 'lesson_plan', 'worksheet', 'sop', 'other'] as const;

export default function Library() {
  const { t, can } = useApp();
  const lk = useLookups();
  const [tab, setTab] = useState('documents');
  const docs = useApi<any[]>(tab === 'documents' ? '/documents' : null);
  const boards = useApi<any[]>(tab === 'curriculum' ? '/curriculum/boards' : null);
  const [board, setBoard] = useState('');
  const subjects = useApi<any[]>(board ? `/curriculum/boards/${board}` : null);
  const [cs, setCs] = useState('');
  const tree = useApi<any[]>(cs ? `/curriculum/subjects/${cs}` : null);
  const [q, setQ] = useState('');
  const [results, setResults] = useState<any[] | null>(null);
  const [f, setF] = useState({ title: '', kind: 'textbook', subject_id: '', class_id: '' });
  const [file, setFile] = useState<File | null>(null);
  const a = useAction();
  return (
    <div>
      <PageHeader title={t('plans.library')} />
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'documents', label: t('library.documents') }, { value: 'curriculum', label: t('library.curriculum') }]} />
      {tab === 'documents' && (
        <div className="space-y-4">
          <Card title={t('library.upload')}>
            <Grid cols={4}>
              <Field label={t('common.title')}><Input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
              <Field label={t('common.type')}><Select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })} options={KINDS.map((k) => ({ value: k, label: t(`docKind.${k}`) }))} /></Field>
              <Field label={t('common.subject')}><Select value={f.subject_id} onChange={(e) => setF({ ...f, subject_id: e.target.value })} placeholder={t('common.optional')} options={opts(lk?.subjects, (s) => s.name)} /></Field>
              <Field label={t('common.class')}><Select value={f.class_id} onChange={(e) => setF({ ...f, class_id: e.target.value })} placeholder={t('common.optional')} options={opts(lk?.classes, (c) => c.name)} /></Field>
            </Grid>
            <input type="file" aria-label={t('library.file')} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            <p className="mt-1 text-xs text-slate-500">{t('library.uploadHint')}</p>
            <ErrorBox error={a.error} />
            <Button className="mt-2" disabled={!file || !f.title || a.busy} onClick={async () => {
              const r = await a.run(async () => {
                const storage_path = await uploadFile(file!, 'document');
                const text = /^text\//.test(file!.type) || /\.(md|txt|csv)$/i.test(file!.name) ? await file!.text() : undefined;
                return post('/documents', { title: f.title, kind: f.kind, storage_path, mime: file!.type || 'application/octet-stream', size_bytes: file!.size, subject_id: f.subject_id || null, class_id: f.class_id || null, text });
              });
              if (r) (setFile(null), setF({ ...f, title: '' }), docs.reload());
            }}>{t('library.upload')}</Button>
          </Card>
          <Card title={t('library.search')} actions={<div className="flex gap-2"><Input aria-label={t('common.search')} value={q} onChange={(e) => setQ(e.target.value)} className="w-64" /><Button size="sm" disabled={!q} onClick={async () => setResults((await a.run(() => get<any[]>(`/documents/search?q=${encodeURIComponent(q)}`))) ?? null)}>{t('common.search')}</Button></div>}>
            {results && <ul className="space-y-2 text-sm">{results.map((r) => <li key={r.id} className="rounded border border-slate-100 p-2"><div className="font-medium">{r.title} <Badge>{Math.round(r.score * 100)}%</Badge></div><p className="line-clamp-3 text-slate-600">{r.content}</p></li>)}</ul>}
            <Table rows={docs.data} columns={[{ key: 'title', header: t('common.title') }, { key: 'kind', header: t('common.type'), render: (r) => t(`docKind.${r.kind}`) }, { key: 'chunks', header: t('library.chunks') }, { key: 'created_at', header: t('common.created'), render: (r) => <DateText value={r.created_at} /> }]} />
          </Card>
        </div>
      )}
      {tab === 'curriculum' && (
        <Card>
          <div className="mb-3 flex flex-wrap gap-2">
            <Select aria-label={t('library.board')} value={board} onChange={(e) => (setBoard(e.target.value), setCs(''))} placeholder={t('library.board')} options={(boards.data ?? []).map((b) => ({ value: b.id, label: `${b.name} ${b.syllabus_year ?? ''}${b.org_id ? ` (${t('library.schoolCopy')})` : ''}` }))} className="w-72" />
            <Select aria-label={t('common.subject')} value={cs} onChange={(e) => setCs(e.target.value)} placeholder={t('common.subject')} options={(subjects.data ?? []).map((s) => ({ value: s.id, label: `${s.stage} · ${s.name}` }))} className="w-72" />
            {board && can('lesson_planner', 'configure') && !boards.data?.find((b) => b.id === board)?.org_id && <Button variant="secondary" onClick={async () => (await a.run(() => post('/curriculum/clone', { board_id: board }))) && boards.reload()}>{t('library.clone')}</Button>}
          </div>
          <p className="mb-2 text-xs text-slate-500">{t('library.cloneHint')}</p>
          {(tree.data ?? []).map((u) => (
            <div key={u.id} className="mb-3">
              <h3 className="text-sm font-semibold">{u.name}</h3>
              {u.chapters.map((ch: any) => (
                <details key={ch.id} className="ml-3 text-sm">
                  <summary>{ch.name} <span className="text-xs text-slate-500">({t('plans.periodsN', { n: ch.est_periods })})</span></summary>
                  <ul className="ml-5 list-disc">{ch.topics.map((tp: any) => <li key={tp.id}>{tp.name}{tp.outcomes.length > 0 && <span className="text-xs text-slate-500"> · {tp.outcomes.map((o: any) => o.code).join(', ')}</span>}</li>)}</ul>
                </details>
              ))}
            </div>
          ))}
          <ErrorBox error={a.error} />
        </Card>
      )}
    </div>
  );
}
