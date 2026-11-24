'use client';
/** Plan editor: sections in template order, per-section AI actions, companions, workflow, Word export. */
import { use, useEffect, useState } from 'react';
import { useApp } from '@/lib/app';
import { download, post, useApi, api } from '@/lib/api';
import { useLookups } from '@/lib/lookups';
import { ValueEditor, ValueView } from '@/components/value-editor';
import { Badge, Button, Card, DateText, ErrorBox, Field, Input, Loading, Modal, PageHeader, Select, StatusBadge, Textarea, useAction } from '@/components/ui';

const SECTION_ACTIONS = ['regenerate', 'more_hands_on', 'simplify', 'add_unplugged_activity', 'shorten', 'add_questions', 'translate'] as const;
const COMPANIONS = ['worksheet', 'quiz', 'exit_ticket', 'homework', 'slides', 'activities', 'rubric', 'remedial', 'enrichment', 'cover_plan'] as const;

export default function PlanDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { t, lang, me } = useApp();
  const lk = useLookups();
  const plan = useApi<any>(`/lesson-plans/${id}`);
  const a = useAction();
  const [content, setContent] = useState<Record<string, unknown> | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [comment, setComment] = useState('');
  const [secComments, setSecComments] = useState<Record<string, string>>({});
  const [reflection, setReflection] = useState('');
  const [rating, setRating] = useState('5');
  const [companion, setCompanion] = useState<{ kind: string; companion: unknown } | null>(null);
  const [reuse, setReuse] = useState<{ open: boolean; sections: string[]; date: string }>({ open: false, sections: [], date: new Date().toISOString().slice(0, 10) });
  useEffect(() => { setContent(plan.data?.content ?? null); }, [plan.data]);
  if (!plan.data || !content) return plan.error ? <ErrorBox error={plan.error} /> : <Loading />;
  const p = plan.data;
  const sections: { key: string; name: string; mandatory: boolean }[] = p.template?.sections ?? [];
  const owner = me?.staff.id === p.staff_id;
  const wf = async (action: string, extra: Record<string, unknown> = {}) => (await a.run(() => post(`/lesson-plans/${id}/workflow`, { action, ...extra }))) && plan.reload();
  const save = async () => (await a.run(() => api('PATCH', `/lesson-plans/${id}`, { content, note: editing ?? undefined }))) && (setEditing(null), plan.reload());
  const sectionAction = async (section: string, action: string) => {
    const r = await a.run(() => post<{ content: Record<string, unknown> }>(`/lesson-plans/${id}/section`, { section, action, language: action === 'translate' ? (lang === 'en' ? 'hi' : 'en') : undefined }));
    if (r) (setContent(r.content), plan.reload());
  };
  return (
    <div>
      <PageHeader
        title={`${p.subject_name} · ${p.topic_name ?? ''}`}
        subtitle={<span className="flex flex-wrap items-center gap-2"><StatusBadge status={p.status} />{p.section_name} · <DateText value={p.plan_date} /> · {p.period_count} × {p.period_minutes} {t('common.min')} · {p.teacher_name}{p.generation && <Badge>{t('ai.creditsUsed', { n: p.generation.credits })}</Badge>}</span>}
        actions={<Button variant="secondary" onClick={() => download(`/lesson-plans/${id}/docx`)}>{t('common.exportWord')}</Button>}
      />
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-3 lg:col-span-2">
          {sections.map((s) => (
            <Card key={s.key} title={<>{s.name}{s.mandatory && <span className="text-red-600"> *</span>}</>} actions={p.can_edit && (
              <div className="flex flex-wrap gap-1">
                {editing === s.key ? <Button size="sm" onClick={save} disabled={a.busy}>{t('common.save')}</Button> : <Button size="sm" variant="ghost" onClick={() => setEditing(s.key)}>{t('common.edit')}</Button>}
                <select aria-label={t('plans.aiAction')} className="rounded border border-slate-300 text-xs" value="" onChange={(e) => e.target.value && sectionAction(s.key, e.target.value)} disabled={a.busy}>
                  <option value="">{t('plans.aiAction')}</option>
                  {SECTION_ACTIONS.map((x) => <option key={x} value={x}>{t(`sectionAction.${x}`)}</option>)}
                </select>
              </div>
            )}>
              <div className="text-sm">
                {editing === s.key ? <ValueEditor value={content[s.key] ?? ''} onChange={(v) => setContent({ ...content, [s.key]: v })} /> : <ValueView value={content[s.key]} />}
              </div>
              {(p.reviews ?? []).filter((r: any) => r.section_key === s.key).map((r: any) => (
                <p key={r.id} className="mt-2 rounded bg-amber-50 p-2 text-xs">{r.reviewer_name}: {r.comment}</p>
              ))}
              {p.can_review && <Input className="mt-2" placeholder={t('plans.sectionComment')} aria-label={t('plans.sectionComment')} value={secComments[s.key] ?? ''} onChange={(e) => setSecComments({ ...secComments, [s.key]: e.target.value })} />}
            </Card>
          ))}
          {companion && (
            <Card title={t(`companion.${companion.kind}`)} actions={<Button size="sm" variant="ghost" onClick={() => setCompanion(null)}>{t('common.close')}</Button>}>
              <div className="text-sm"><ValueView value={companion.companion} /></div>
            </Card>
          )}
        </div>
        <div className="space-y-4">
          <Card title={t('tasks.actions')}>
            <div className="space-y-2">
              {p.can_edit && !p.confirmed_by_teacher && <Button onClick={() => wf('confirm')}>{t('plans.confirm')}</Button>}
              {p.can_edit && p.confirmed_by_teacher && <Button onClick={() => wf('submit')}>{t('plans.submit')}</Button>}
              {p.can_edit && <p className="text-xs text-slate-500">{t('plans.confirmHint')}</p>}
              {p.can_review && (
                <>
                  <Field label={t('approvals.comment')}><Textarea value={comment} onChange={(e) => setComment(e.target.value)} /></Field>
                  <div className="flex gap-2">
                    <Button onClick={() => wf('approve', { comment: comment || undefined, section_comments: Object.entries(secComments).filter(([, v]) => v).map(([section, c]) => ({ section, comment: c })) })}>{t('approvalAction.approve')}</Button>
                    <Button variant="secondary" onClick={() => wf('return', { comment: comment || undefined, section_comments: Object.entries(secComments).filter(([, v]) => v).map(([section, c]) => ({ section, comment: c })) })}>{t('approvalAction.return')}</Button>
                  </div>
                </>
              )}
              {owner && p.status === 'approved' && <Button onClick={() => wf('deliver')}>{t('plans.deliver')}</Button>}
              {owner && p.status === 'delivered' && (
                <>
                  <Field label={t('plans.reflection')}><Textarea value={reflection} onChange={(e) => setReflection(e.target.value)} /></Field>
                  <Button disabled={!reflection} onClick={() => wf('reflect', { reflection })}>{t('plans.saveReflection')}</Button>
                </>
              )}
              {owner && ['approved', 'delivered', 'reflected'].includes(p.status) && !p.in_bank && <Button variant="secondary" onClick={() => wf('add_to_bank')}>{t('plans.addToBank')}</Button>}
              {p.in_bank && !owner && (
                <div className="flex items-end gap-2">
                  <Field label={t('plans.rating')}><Select value={rating} onChange={(e) => setRating(e.target.value)} options={[5, 4, 3, 2, 1].map((n) => ({ value: String(n), label: '★'.repeat(n) }))} /></Field>
                  <Button variant="secondary" onClick={() => wf('rate', { rating: Number(rating) })}>{t('plans.rate')}</Button>
                </div>
              )}
              {p.in_bank && <Button variant="secondary" onClick={() => setReuse({ ...reuse, open: true })}>{t('plans.reuse')}</Button>}
              <ErrorBox error={a.error} />
            </div>
          </Card>
          <Card title={t('plans.companions')}>
            <div className="flex flex-wrap gap-1">
              {COMPANIONS.map((k) => <Button key={k} size="sm" variant="secondary" disabled={a.busy} onClick={async () => { const r = await a.run(() => post<{ kind: string; companion: unknown }>(`/lesson-plans/${id}/companion`, { kind: k })); if (r) setCompanion(r); }}>{t(`companion.${k}`)}</Button>)}
            </div>
          </Card>
          <Card title={t('plans.reviews')}>
            <ul className="space-y-1 text-sm">{(p.reviews ?? []).filter((r: any) => !r.section_key).map((r: any) => <li key={r.id}>{t(`approvalAction.${r.action}`)} · {r.reviewer_name}: {r.comment ?? ''}</li>)}</ul>
          </Card>
          <Card title={t('plans.versions')}>
            <ul className="space-y-1 text-xs">{(p.versions ?? []).map((v: any) => <li key={v.version}>v{v.version} · <DateText value={v.created_at} withTime /> {v.note && `· ${v.note}`}</li>)}</ul>
          </Card>
        </div>
      </div>
      <Modal open={reuse.open} onClose={() => setReuse({ ...reuse, open: false })} title={t('plans.reuse')}>
        <Field label={t('common.section')}>
          <select multiple className="h-32 w-full rounded-md border border-slate-300 p-1 text-sm" value={reuse.sections} onChange={(e) => setReuse({ ...reuse, sections: [...e.target.selectedOptions].map((o) => o.value) })}>
            {(lk?.sections ?? []).map((s) => <option key={s.id} value={s.id}>{lk?.classes.find((c) => c.id === s.programme_id)?.name} {s.name}</option>)}
          </select>
        </Field>
        <Field label={t('common.date')}><Input type="date" value={reuse.date} onChange={(e) => setReuse({ ...reuse, date: e.target.value })} /></Field>
        <Button disabled={!reuse.sections.length} onClick={async () => { const r = await a.run(() => post<{ id: string }>(`/lesson-plans/${id}/reuse`, { section_ids: reuse.sections, plan_date: reuse.date })); if (r) window.location.assign(`/os/lesson-plans/${r.id}`); }}>{t('plans.reuse')}</Button>
      </Modal>
    </div>
  );
}
