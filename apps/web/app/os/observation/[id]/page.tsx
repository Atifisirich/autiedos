'use client';
/** Observation: observer fills the rubric with evidence; teacher sees feedback and acknowledges with reflection. */
import { use, useEffect, useState } from 'react';
import { useApp } from '@/lib/app';
import { post, useApi } from '@/lib/api';
import { Button, Card, Checkbox, DateText, ErrorBox, Field, Input, Loading, PageHeader, StatusBadge, Textarea, useAction } from '@/components/ui';

export default function ObservationDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { t, me } = useApp();
  const o = useApi<any>(`/observations/${id}`);
  const a = useAction();
  const [scores, setScores] = useState<Record<string, number>>({});
  const [evidence, setEvidence] = useState<Record<string, string>>({});
  const [feedback, setFeedback] = useState('');
  const [actions, setActions] = useState<{ description: string; due_on: string }[]>([]);
  const [share, setShare] = useState(true);
  const [reflection, setReflection] = useState('');
  useEffect(() => {
    if (!o.data) return;
    setScores(o.data.scores ?? {});
    setEvidence(o.data.evidence ?? {});
    setFeedback(o.data.feedback ?? '');
    setActions(o.data.agreed_actions ?? []);
  }, [o.data]);
  if (!o.data) return o.error ? <ErrorBox error={o.error} /> : <Loading />;
  const x = o.data;
  const observer = x.observer_id === me?.staff.id && ['scheduled', 'completed'].includes(x.status);
  const teacher = x.teacher_id === me?.staff.id;
  const levels = Array.from({ length: x.scale.max - x.scale.min + 1 }, (_, i) => x.scale.min + i);
  return (
    <div>
      <PageHeader title={`${x.rubric_name} · ${x.teacher_name}`} subtitle={<span className="flex items-center gap-2"><StatusBadge status={x.status} /><DateText value={x.scheduled_at} withTime /> · {x.observer_name}{x.overall != null && ` · ${Math.round(x.overall)}%`}</span>} />
      <div className="space-y-4">
        {x.domains.map((d: any) => (
          <Card key={d.key} title={`${d.name} (${d.weight}%)`}>
            {d.indicators.map((ind: any) => {
              const k = `${d.key}.${ind.key}`;
              return (
                <div key={k} className="mb-3 border-b border-slate-100 pb-2 text-sm">
                  <p>{ind.text}</p>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {levels.map((lv) => (
                      <button key={lv} type="button" disabled={!observer} onClick={() => setScores({ ...scores, [k]: lv })} className={`min-h-[40px] rounded border px-2 text-xs ${scores[k] === lv ? 'border-brand-600 bg-brand-50' : 'border-slate-200'}`}>{lv} · {x.scale.labels?.[lv - x.scale.min] ?? ''}</button>
                    ))}
                  </div>
                  {observer ? <Input className="mt-1" placeholder={t('observation.evidence')} aria-label={t('observation.evidence')} value={evidence[k] ?? ''} onChange={(e) => setEvidence({ ...evidence, [k]: e.target.value })} /> : evidence[k] && <p className="mt-1 text-xs text-slate-600">{evidence[k]}</p>}
                </div>
              );
            })}
          </Card>
        ))}
        <Card title={t('observation.feedback')}>
          {observer ? <Textarea value={feedback} onChange={(e) => setFeedback(e.target.value)} /> : <p className="whitespace-pre-wrap text-sm">{x.feedback ?? '—'}</p>}
          <h3 className="mb-1 mt-3 text-sm font-semibold">{t('observation.actions')}</h3>
          {actions.map((ac, i) => (
            <div key={i} className="mb-1 flex gap-2">
              <Input aria-label={t('common.description')} disabled={!observer} value={ac.description} onChange={(e) => setActions(actions.map((y, j) => (j === i ? { ...y, description: e.target.value } : y)))} />
              <Input aria-label={t('tasks.due')} type="date" disabled={!observer} value={ac.due_on} onChange={(e) => setActions(actions.map((y, j) => (j === i ? { ...y, due_on: e.target.value } : y)))} className="w-44" />
            </div>
          ))}
          {observer && (
            <>
              <Button size="sm" variant="secondary" onClick={() => setActions([...actions, { description: '', due_on: new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10) }])}>{t('common.add')}</Button>
              <div className="mt-3 flex items-center gap-3">
                <Checkbox label={t('observation.shareNow')} checked={share} onChange={(e) => setShare(e.target.checked)} />
                <Button disabled={a.busy} onClick={async () => (await a.run(() => post(`/observations/${id}/fill`, { scores, evidence, feedback: feedback || undefined, agreed_actions: actions.filter((y) => y.description), share }))) && o.reload()}>{t('common.save')}</Button>
              </div>
            </>
          )}
        </Card>
        {teacher && x.status === 'shared' && (
          <Card title={t('observation.acknowledge')}>
            <Field label={t('plans.reflection')}><Textarea value={reflection} onChange={(e) => setReflection(e.target.value)} /></Field>
            <Button disabled={a.busy} onClick={async () => (await a.run(() => post(`/observations/${id}/acknowledge`, { reflection }))) && o.reload()}>{t('observation.acknowledge')}</Button>
          </Card>
        )}
        {x.teacher_reflection && <Card title={t('plans.reflection')}><p className="text-sm">{x.teacher_reflection}</p></Card>}
        <ErrorBox error={a.error} />
      </div>
    </div>
  );
}
