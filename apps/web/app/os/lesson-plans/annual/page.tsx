'use client';
/** Annual plan: chapters spread over the teaching calendar; edit dates and periods, then publish. */
import { useState } from 'react';
import { useApp } from '@/lib/app';
import { api, post, useApi } from '@/lib/api';
import { useLookups, opts } from '@/lib/lookups';
import { useCurriculum } from '@/lib/curriculum';
import { Button, Card, Checkbox, ErrorBox, Input, PageHeader, Select, StatusBadge, Table, useAction } from '@/components/ui';

export default function AnnualPlan() {
  const { t, can } = useApp();
  const lk = useLookups();
  const [classId, setClassId] = useState('');
  const [subjectId, setSubjectId] = useState('');
  const [useAi, setUseAi] = useState(false);
  const section = lk?.sections.find((s) => s.programme_id === classId)?.id ?? '';
  const { curriculumSubjectId, chapters } = useCurriculum(lk, section, subjectId);
  const plan = useApi<any>(classId && subjectId ? `/annual-plans?programme_id=${classId}&subject_id=${subjectId}` : null);
  const a = useAction();
  const [edits, setEdits] = useState<Record<string, { planned_start: string; planned_end: string; planned_periods: number }>>({});
  const saveItem = async (r: any) => {
    const e = edits[r.id];
    if (e && (await a.run(() => api('PATCH', `/annual-plans/items/${r.id}`, e)))) { setEdits(({ [r.id]: _, ...rest }) => rest); plan.reload(); }
  };
  return (
    <div>
      <PageHeader title={t('plans.annual')} />
      <Card>
        <div className="mb-3 flex flex-wrap gap-2">
          <Select aria-label={t('common.class')} value={classId} onChange={(e) => setClassId(e.target.value)} placeholder={t('common.class')} options={opts(lk?.classes, (c) => c.name)} className="w-44" />
          <Select aria-label={t('common.subject')} value={subjectId} onChange={(e) => setSubjectId(e.target.value)} placeholder={t('common.subject')} options={opts(lk?.subjects, (s) => s.name)} className="w-52" />
          {plan.data && <StatusBadge status={plan.data.status} />}
        </div>
        {classId && subjectId && plan.data === null && (
          <div className="space-y-2 text-sm">
            <p>{t('plans.noAnnual')}</p>
            {chapters?.length === 0 && <p className="text-amber-700">{t('plans.noCurriculum')}</p>}
            <Checkbox label={t('plans.useAi')} checked={useAi} onChange={(e) => setUseAi(e.target.checked)} />
            <Button disabled={!curriculumSubjectId || a.busy} onClick={async () => (await a.run(() => post('/annual-plans', { programme_id: classId, subject_id: subjectId, curriculum_subject_id: curriculumSubjectId, use_ai: useAi }))) && plan.reload()}>{t('plans.generateAnnual')}</Button>
          </div>
        )}
        {plan.data && (
          <>
            <Table rows={plan.data.items} columns={[
              { key: 'seq', header: '#' },
              { key: 'chapter', header: t('plans.chapter') },
              { key: 'planned_start', header: t('plans.start'), render: (r) => <Input type="date" aria-label={t('plans.start')} value={(edits[r.id]?.planned_start ?? r.planned_start).slice(0, 10)} onChange={(e) => setEdits({ ...edits, [r.id]: { planned_start: e.target.value, planned_end: (edits[r.id]?.planned_end ?? r.planned_end).slice(0, 10), planned_periods: edits[r.id]?.planned_periods ?? r.planned_periods } })} /> },
              { key: 'planned_end', header: t('plans.end'), render: (r) => <Input type="date" aria-label={t('plans.end')} value={(edits[r.id]?.planned_end ?? r.planned_end).slice(0, 10)} onChange={(e) => setEdits({ ...edits, [r.id]: { planned_start: (edits[r.id]?.planned_start ?? r.planned_start).slice(0, 10), planned_end: e.target.value, planned_periods: edits[r.id]?.planned_periods ?? r.planned_periods } })} /> },
              { key: 'planned_periods', header: t('plans.periods'), render: (r) => <Input type="number" aria-label={t('plans.periods')} className="w-20" value={edits[r.id]?.planned_periods ?? r.planned_periods} onChange={(e) => setEdits({ ...edits, [r.id]: { planned_start: (edits[r.id]?.planned_start ?? r.planned_start).slice(0, 10), planned_end: (edits[r.id]?.planned_end ?? r.planned_end).slice(0, 10), planned_periods: Number(e.target.value) } })} /> },
              { key: 'save', header: '', render: (r) => edits[r.id] && <Button size="sm" onClick={() => saveItem(r)}>{t('common.save')}</Button> },
            ]} />
            {plan.data.status !== 'published' && can('lesson_planner', 'approve') && <Button className="mt-3" onClick={async () => (await a.run(() => post(`/annual-plans/${plan.data.id}/publish`))) && plan.reload()}>{t('plans.publishAnnual')}</Button>}
          </>
        )}
        <ErrorBox error={a.error} />
      </Card>
    </div>
  );
}
