'use client';
/** Paper review: questions with marking scheme, blueprint check, review workflow, watermarked export, access log. */
import { use, useState } from 'react';
import { useApp } from '@/lib/app';
import { download, post, useApi } from '@/lib/api';
import { Badge, Button, Card, DateText, ErrorBox, Field, Loading, PageHeader, StatusBadge, Table, Textarea, useAction } from '@/components/ui';

export default function PaperDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { t } = useApp();
  const p = useApi<any>(`/exams/papers/${id}`);
  const a = useAction();
  const [comment, setComment] = useState('');
  if (!p.data) return p.error ? <ErrorBox error={p.error} /> : <Loading />;
  const x = p.data;
  const review = async (action: string, extra: Record<string, unknown> = {}) => (await a.run(() => post(`/exams/papers/${id}/review`, { action, comment: comment || undefined, ...extra }))) && (setComment(''), p.reload());
  const total = (x.questions ?? []).reduce((s: number, q: any) => s + (q.marks ?? 0), 0);
  return (
    <div>
      <PageHeader title={`${x.class_name ?? ''} ${x.subject_name ?? ''} · ${t('exams.set')} ${x.set_no}`} subtitle={<span className="flex items-center gap-2"><StatusBadge status={x.status} />{x.blueprint_name} · {t('exams.marksOf', { n: total, total: x.total_marks })} · {x.duration_minutes} {t('common.min')}</span>} actions={<><Button variant="secondary" onClick={() => download(`/exams/papers/${id}/docx`)}>{t('exams.exportPaper')}</Button><Button variant="secondary" onClick={() => download(`/exams/papers/${id}/docx?scheme=1`)}>{t('exams.exportScheme')}</Button></>} />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2" title={t('exams.questions')}>
          <ol className="space-y-3 text-sm">
            {(x.questions ?? []).map((q: any, i: number) => (
              <li key={i} className="rounded border border-slate-100 p-2">
                <div className="flex justify-between gap-2"><span className="font-medium">{i + 1}. {q.text}</span><span className="whitespace-nowrap text-xs">[{q.marks}]</span></div>
                {q.options && <ol className="ml-5 list-[lower-alpha]">{q.options.map((o: string, j: number) => <li key={j}>{o}</li>)}</ol>}
                <div className="mt-1 flex flex-wrap gap-1 text-xs"><Badge>{q.section}</Badge><Badge>{t(`difficulty.${q.difficulty}`)}</Badge>{q.bloom && <Badge>{q.bloom}</Badge>}<Badge tone={q.source === 'ai' ? 'amber' : 'gray'}>{t(`paperSource.${q.source}`)}</Badge></div>
                <details className="mt-1 text-xs text-slate-600"><summary>{t('exams.markingScheme')}</summary><p>{q.answer}</p><ul className="list-disc pl-4">{(q.marking ?? []).map((m: any, j: number) => <li key={j}>{m.step} — {m.marks}</li>)}</ul></details>
                {x.is_setter && ['draft', 'returned'].includes(x.status) && <Button size="sm" variant="ghost" onClick={() => review('replace_question', { question_no: i + 1 })}>{t('exams.replace')}</Button>}
              </li>
            ))}
          </ol>
        </Card>
        <div className="space-y-4">
          <Card title={t('tasks.actions')}>
            <div className="space-y-2">
              <Field label={t('approvals.comment')}><Textarea value={comment} onChange={(e) => setComment(e.target.value)} /></Field>
              {x.is_setter && ['draft', 'returned'].includes(x.status) && <Button onClick={() => review('submit')}>{t('common.submit')}</Button>}
              {x.is_reviewer && ['hod_review', 'coordinator_review'].includes(x.status) && (
                <div className="flex gap-2"><Button onClick={() => review('approve')}>{t('approvalAction.approve')}</Button><Button variant="secondary" onClick={() => review('return')}>{t('approvalAction.return')}</Button></div>
              )}
              <ErrorBox error={a.error} />
            </div>
          </Card>
          <Card title={t('exams.blueprintCheck')}>
            <Table rows={x.blueprint_table} rowKey={(r) => String(r.no)} columns={[{ key: 'no', header: '#' }, { key: 'section', header: t('exams.section') }, { key: 'chapter', header: t('plans.chapter') }, { key: 'level', header: t('exams.difficulty'), render: (r) => t(`difficulty.${r.level}`) }, { key: 'marks', header: t('exams.marks') }]} />
          </Card>
          <Card title={t('exams.reviewComments')}>
            <ul className="space-y-1 text-xs">{(x.review_comments ?? []).map((c: any, i: number) => <li key={i}><DateText value={c.at} withTime /> · {c.by} · {t(`status.${c.status}`)}: {c.comment}</li>)}</ul>
          </Card>
          <Card title={t('exams.accessLog')}>
            <ul className="space-y-1 text-xs">{(x.access_log ?? []).map((l: any, i: number) => <li key={i}><DateText value={l.created_at} withTime /> · {l.full_name} · {l.action}</li>)}</ul>
          </Card>
        </div>
      </div>
    </div>
  );
}
