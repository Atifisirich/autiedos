'use client';
/** Blueprint builder: sections, chapter weightage, difficulty mix. Totals are validated on save. */
import { useState } from 'react';
import { useApp } from '@/lib/app';
import { post, useApi } from '@/lib/api';
import { useLookups, opts } from '@/lib/lookups';
import { useCurriculum } from '@/lib/curriculum';
import { Button, Card, Checkbox, ErrorBox, Field, Grid, Input, PageHeader, Select, Table, Textarea, useAction } from '@/components/ui';

interface Sec { name: string; question_type: string; count: number; marks_each: number }
const TYPES = ['mcq', 'very_short', 'short', 'long', 'case_based', 'assertion_reason'];
const empty = () => ({ id: undefined as string | undefined, name: '', board: 'CBSE', programme_id: '', subject_id: '', total_marks: 80, duration_minutes: 180, sections: [{ name: 'A', question_type: 'mcq', count: 20, marks_each: 1 }] as Sec[], chapter_weightage: {} as Record<string, number>, difficulty: { easy: 30, medium: 50, hard: 20 }, competency_pct: 50, instructions: '', is_template: false });

export default function Blueprints() {
  const { t } = useApp();
  const lk = useLookups();
  const list = useApi<any[]>('/exams/blueprints');
  const a = useAction();
  const [f, setF] = useState(empty());
  const section = lk?.sections.find((s) => s.programme_id === f.programme_id)?.id ?? '';
  const { chapters } = useCurriculum(lk, section, f.subject_id);
  const secTotal = f.sections.reduce((s, x) => s + x.count * x.marks_each, 0);
  const wTotal = Object.values(f.chapter_weightage).reduce((s, v) => s + v, 0);
  const setSec = (i: number, patch: Partial<Sec>) => setF({ ...f, sections: f.sections.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  return (
    <div>
      <PageHeader title={t('exams.blueprints')} actions={<Button variant="secondary" onClick={() => setF(empty())}>{t('exams.newBlueprint')}</Button>} />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title={t('exams.blueprints')}>
          <Table rows={list.data} onRow={(r) => setF({ ...empty(), ...r, programme_id: r.programme_id ?? '', subject_id: r.subject_id ?? '', instructions: r.instructions ?? '' })} columns={[{ key: 'name', header: t('common.name') }, { key: 'class_name', header: t('common.class') }, { key: 'subject_name', header: t('common.subject') }, { key: 'total_marks', header: t('exams.marks') }]} />
        </Card>
        <Card className="lg:col-span-2" title={f.name || t('exams.newBlueprint')}>
          <div className="space-y-3">
            <Grid cols={3}>
              <Field label={t('common.name')}><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
              <Field label={t('library.board')}><Select value={f.board} onChange={(e) => setF({ ...f, board: e.target.value })} options={['CBSE', 'CAMBRIDGE'].map((b) => ({ value: b, label: b }))} /></Field>
              <Field label={t('common.class')}><Select value={f.programme_id} onChange={(e) => setF({ ...f, programme_id: e.target.value, chapter_weightage: {} })} placeholder={t('common.choose')} options={opts(lk?.classes, (c) => c.name)} /></Field>
              <Field label={t('common.subject')}><Select value={f.subject_id} onChange={(e) => setF({ ...f, subject_id: e.target.value, chapter_weightage: {} })} placeholder={t('common.choose')} options={opts(lk?.subjects, (c) => c.name)} /></Field>
              <Field label={t('exams.totalMarks')}><Input type="number" value={f.total_marks} onChange={(e) => setF({ ...f, total_marks: Number(e.target.value) })} /></Field>
              <Field label={t('exams.duration')}><Input type="number" value={f.duration_minutes} onChange={(e) => setF({ ...f, duration_minutes: Number(e.target.value) })} /></Field>
            </Grid>
            <h3 className="text-sm font-semibold">{t('exams.sections')} <span className={secTotal === f.total_marks ? 'text-green-700' : 'text-red-700'}>({secTotal} / {f.total_marks})</span></h3>
            {f.sections.map((s, i) => (
              <div key={i} className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                <Input aria-label={t('exams.section')} value={s.name} onChange={(e) => setSec(i, { name: e.target.value })} />
                <Select aria-label={t('common.type')} value={s.question_type} onChange={(e) => setSec(i, { question_type: e.target.value })} options={TYPES.map((x) => ({ value: x, label: t(`questionType.${x}`) }))} />
                <Input aria-label={t('exams.count')} type="number" value={s.count} onChange={(e) => setSec(i, { count: Number(e.target.value) })} />
                <Input aria-label={t('exams.marksEach')} type="number" value={s.marks_each} onChange={(e) => setSec(i, { marks_each: Number(e.target.value) })} />
                <Button size="sm" variant="ghost" onClick={() => setF({ ...f, sections: f.sections.filter((_, j) => j !== i) })}>{t('common.remove')}</Button>
              </div>
            ))}
            <Button size="sm" variant="secondary" onClick={() => setF({ ...f, sections: [...f.sections, { name: String.fromCharCode(65 + f.sections.length), question_type: 'short', count: 5, marks_each: 2 }] })}>{t('common.add')}</Button>
            <h3 className="text-sm font-semibold">{t('exams.weightage')} <span className={wTotal === f.total_marks ? 'text-green-700' : 'text-red-700'}>({wTotal} / {f.total_marks})</span></h3>
            {chapters?.length === 0 && <p className="text-xs text-amber-700">{t('plans.noCurriculum')}</p>}
            <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
              {(chapters ?? []).map((ch) => (
                <label key={ch.id} className="flex items-center justify-between gap-2 text-sm">
                  <span>{ch.name}</span>
                  <Input type="number" className="w-20" aria-label={ch.name} value={f.chapter_weightage[ch.id] ?? 0} onChange={(e) => setF({ ...f, chapter_weightage: { ...f.chapter_weightage, [ch.id]: Number(e.target.value) } })} />
                </label>
              ))}
            </div>
            <h3 className="text-sm font-semibold">{t('exams.difficulty')} ({f.difficulty.easy + f.difficulty.medium + f.difficulty.hard}%)</h3>
            <Grid cols={4}>
              {(['easy', 'medium', 'hard'] as const).map((k) => <Field key={k} label={t(`difficulty.${k}`)}><Input type="number" value={f.difficulty[k]} onChange={(e) => setF({ ...f, difficulty: { ...f.difficulty, [k]: Number(e.target.value) } })} /></Field>)}
              <Field label={t('exams.competencyPct')}><Input type="number" value={f.competency_pct} onChange={(e) => setF({ ...f, competency_pct: Number(e.target.value) })} /></Field>
            </Grid>
            <Field label={t('exams.instructions')}><Textarea value={f.instructions} onChange={(e) => setF({ ...f, instructions: e.target.value })} /></Field>
            <Checkbox label={t('exams.isTemplate')} checked={f.is_template} onChange={(e) => setF({ ...f, is_template: e.target.checked })} />
            <ErrorBox error={a.error} />
            <Button disabled={a.busy || !f.name} onClick={async () => {
              const { id, ...rest } = f;
              const weights = Object.fromEntries(Object.entries(f.chapter_weightage).filter(([, v]) => v > 0));
              const r = await a.run(() => post<{ id: string }>('/exams/blueprints', { ...rest, ...(id ? { id } : {}), programme_id: f.programme_id || null, subject_id: f.subject_id || null, chapter_weightage: weights, instructions: f.instructions || undefined }));
              if (r) (setF({ ...f, id: r.id }), list.reload());
            }}>{t('common.save')}</Button>
          </div>
        </Card>
      </div>
    </div>
  );
}
