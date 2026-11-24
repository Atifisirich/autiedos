'use client';
/** Daily plan generator (PRD 6.1): class, subject, topic, periods, model, resources → AI draft. */
import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useApp } from '@/lib/app';
import { post, useApi } from '@/lib/api';
import { useLookups } from '@/lib/lookups';
import { useCurriculum } from '@/lib/curriculum';
import { Button, Card, Checkbox, ErrorBox, Field, Grid, Input, PageHeader, Select, Textarea, useAction } from '@/components/ui';

const MODELS = ['5E', 'gradual_release', 'experiential', 'inquiry', 'direct', 'flipped', 'school'] as const;
const RESOURCES = ['smart_board', 'lab', 'projector'] as const;

export default function NewPlan() {
  const { t, lang } = useApp();
  const sp = useSearchParams();
  const router = useRouter();
  const lk = useLookups();
  const a = useAction();
  const [f, setF] = useState({ section_ids: sp.get('section') ? [sp.get('section')!] : ([] as string[]), subject_id: sp.get('subject') ?? '', topic_id: '', plan_date: sp.get('date') ?? new Date().toISOString().slice(0, 10), period_count: 1, period_minutes: 40, teaching_model: '5E' as string, resources: [] as string[], ability_mix: 'mixed', notes: '', language: lang });
  const { chapters } = useCurriculum(lk, f.section_ids[0] ?? '', f.subject_id);
  const quote = useApi<{ credits: number; balance: number }>(`/lesson-plans/quote?action=daily_plan&units=${f.period_count}`);
  const secName = (id: string) => { const s = lk?.sections.find((x) => x.id === id); return `${lk?.classes.find((c) => c.id === s?.programme_id)?.name ?? ''} ${s?.name ?? ''}`; };
  const first = lk?.sections.find((s) => s.id === f.section_ids[0]);
  return (
    <div>
      <PageHeader title={t('plans.new')} />
      <Card>
        <div className="space-y-3">
          <Grid cols={3}>
            <Field label={t('common.section')} hint={t('plans.multiSectionHint')}>
              <select multiple className="h-28 w-full rounded-md border border-slate-300 p-1 text-sm" value={f.section_ids} onChange={(e) => setF({ ...f, section_ids: [...e.target.selectedOptions].map((o) => o.value), topic_id: '' })}>
                {(lk?.sections ?? []).filter((s) => !first || s.programme_id === first.programme_id || f.section_ids.length === 0).map((s) => <option key={s.id} value={s.id}>{secName(s.id)}</option>)}
              </select>
            </Field>
            <Field label={t('common.subject')}><Select value={f.subject_id} onChange={(e) => setF({ ...f, subject_id: e.target.value, topic_id: '' })} placeholder={t('common.choose')} options={(lk?.subjects ?? []).map((s) => ({ value: s.id, label: s.name }))} /></Field>
            <Field label={t('common.date')}><Input type="date" value={f.plan_date} onChange={(e) => setF({ ...f, plan_date: e.target.value })} /></Field>
          </Grid>
          <Field label={t('plans.topic')} hint={chapters && chapters.length === 0 ? t('plans.noCurriculum') : undefined}>
            <select className="w-full rounded-md border border-slate-300 p-2 text-sm" value={f.topic_id} onChange={(e) => setF({ ...f, topic_id: e.target.value })}>
              <option value="">{t('common.choose')}</option>
              {(chapters ?? []).map((ch) => (
                <optgroup key={ch.id} label={ch.name}>
                  {ch.topics.map((tp) => <option key={tp.id} value={tp.id}>{tp.name}</option>)}
                </optgroup>
              ))}
            </select>
          </Field>
          <Grid cols={4}>
            <Field label={t('plans.periods')}><Select value={String(f.period_count)} onChange={(e) => setF({ ...f, period_count: Number(e.target.value) })} options={[1, 2, 3].map((n) => ({ value: String(n), label: String(n) }))} /></Field>
            <Field label={t('plans.minutes')}><Input type="number" min={20} max={120} value={f.period_minutes} onChange={(e) => setF({ ...f, period_minutes: Number(e.target.value) })} /></Field>
            <Field label={t('plans.model')}><Select value={f.teaching_model} onChange={(e) => setF({ ...f, teaching_model: e.target.value })} options={MODELS.map((m) => ({ value: m, label: t(`teachingModel.${m}`) }))} /></Field>
            <Field label={t('plans.abilityMix')}><Select value={f.ability_mix} onChange={(e) => setF({ ...f, ability_mix: e.target.value })} options={['mixed', 'mostly_strong', 'mostly_support'].map((m) => ({ value: m, label: t(`abilityMix.${m}`) }))} /></Field>
          </Grid>
          <div className="flex flex-wrap gap-4">
            {RESOURCES.map((r) => <Checkbox key={r} label={t(`resource.${r}`)} checked={f.resources.includes(r)} onChange={(e) => setF({ ...f, resources: e.target.checked ? [...f.resources, r] : f.resources.filter((x) => x !== r) })} />)}
          </div>
          <Grid cols={2}>
            <Field label={t('plans.language')}><Select value={f.language} onChange={(e) => setF({ ...f, language: e.target.value as typeof lang })} options={['en', 'hi', 'te'].map((l) => ({ value: l, label: t(`lang.${l}`) }))} /></Field>
          </Grid>
          <Field label={t('plans.notes')}><Textarea value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} placeholder={t('plans.notesHint')} /></Field>
          {quote.data && <p className="text-sm text-slate-600">{t('ai.quote', { credits: quote.data.credits, balance: quote.data.balance })}</p>}
          <p className="text-xs text-slate-500">{t('ai.privacyNote')}</p>
          <ErrorBox error={a.error} />
          <Button disabled={a.busy || !f.section_ids.length || !f.subject_id || !f.topic_id} onClick={async () => {
            const r = await a.run(() => post<{ id: string }>('/lesson-plans/generate', { section_ids: f.section_ids, subject_id: f.subject_id, topic_id: f.topic_id, plan_date: f.plan_date, period_count: f.period_count, period_minutes: f.period_minutes, teaching_model: f.teaching_model, resources: f.resources.length ? f.resources : ['none'], class_profile: { ability_mix: f.ability_mix }, notes: f.notes || undefined, language: f.language }));
            if (r) router.push(`/os/lesson-plans/${r.id}`);
          }}>{a.busy ? t('plans.generating') : t('plans.generate')}</Button>
        </div>
      </Card>
    </div>
  );
}
