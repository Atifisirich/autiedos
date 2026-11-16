'use client';
/** Appraisal scorecards (auto-computed from system data) and training records. */
import { useState } from 'react';
import { APPRAISAL_COMPONENTS } from '@autoed/shared';
import { useApp } from '@/lib/app';
import { post, uploadFile, useApi } from '@/lib/api';
import { useLookups, opts } from '@/lib/lookups';
import { Button, Card, DateText, ErrorBox, Field, Grid, Input, PageHeader, Select, Table, Tabs, useAction } from '@/components/ui';

export default function Appraisal() {
  const { t, can } = useApp();
  const lk = useLookups();
  const [tab, setTab] = useState('scorecards');
  const [cycle, setCycle] = useState('');
  const cards = useApi<any[]>(cycle ? `/appraisal/cycles/${cycle}/scorecards` : null);
  const trainings = useApi<any[]>(tab === 'trainings' ? '/trainings' : null);
  const a = useAction();
  const [rating, setRating] = useState<Record<string, string>>({});
  const [tr, setTr] = useState({ staff_id: '', title: '', provider: '', attended_on: '', hours: '2' });
  const [cert, setCert] = useState<File | null>(null);
  return (
    <div>
      <PageHeader title={t('observation.appraisal')} />
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'scorecards', label: t('appraisal.scorecards') }, { value: 'trainings', label: t('appraisal.trainings') }]} />
      {tab === 'scorecards' && (
        <Card actions={<div className="flex gap-2"><Select aria-label={t('appraisal.cycle')} value={cycle} onChange={(e) => setCycle(e.target.value)} placeholder={t('appraisal.cycle')} options={opts(lk?.appraisal_cycles, (c) => c.name)} className="w-56" />{cycle && can('appraisal', 'edit') && <Button size="sm" disabled={a.busy} onClick={async () => (await a.run(() => post(`/appraisal/cycles/${cycle}/compute`))) && cards.reload()}>{t('appraisal.compute')}</Button>}</div>}>
          <Table rows={cards.data} columns={[
            { key: 'full_name', header: t('common.person') },
            ...APPRAISAL_COMPONENTS.filter((k) => k !== 'manager_rating').map((k) => ({ key: k, header: t(`appraisal.component.${k}`), render: (r: any) => (r.components?.[k] != null ? Math.round(r.components[k]) : '—') })),
            { key: 'total', header: t('appraisal.total'), render: (r) => (r.total != null ? Math.round(r.total) : '—') },
            { key: 'manager_rating', header: t('appraisal.managerRating'), render: (r) => can('appraisal', 'edit') ? (
              <div className="flex gap-1"><Select aria-label={t('appraisal.managerRating')} value={rating[r.staff_id] ?? String(r.manager_rating ?? '')} onChange={(e) => setRating({ ...rating, [r.staff_id]: e.target.value })} placeholder="—" options={[1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: String(n) }))} className="w-20" />{rating[r.staff_id] && <Button size="sm" onClick={async () => (await a.run(() => post(`/appraisal/cycles/${cycle}/rating`, { staff_id: r.staff_id, manager_rating: Number(rating[r.staff_id]) }))) && cards.reload()}>{t('common.save')}</Button>}</div>
            ) : r.manager_rating ?? '—' },
          ]} />
          <p className="mt-2 text-xs text-slate-500">{t('appraisal.hint')}</p>
          <ErrorBox error={a.error} />
        </Card>
      )}
      {tab === 'trainings' && (
        <div className="space-y-4">
          <Card title={t('appraisal.addTraining')}>
            <Grid cols={4}>
              {can('appraisal', 'edit') && <Field label={t('common.person')}><Select value={tr.staff_id} onChange={(e) => setTr({ ...tr, staff_id: e.target.value })} placeholder={t('appraisal.myself')} options={opts(lk?.staff, (s) => s.full_name)} /></Field>}
              <Field label={t('common.title')}><Input value={tr.title} onChange={(e) => setTr({ ...tr, title: e.target.value })} /></Field>
              <Field label={t('appraisal.provider')}><Input value={tr.provider} onChange={(e) => setTr({ ...tr, provider: e.target.value })} /></Field>
              <Field label={t('common.date')}><Input type="date" value={tr.attended_on} onChange={(e) => setTr({ ...tr, attended_on: e.target.value })} /></Field>
              <Field label={t('appraisal.hours')}><Input type="number" step="0.5" value={tr.hours} onChange={(e) => setTr({ ...tr, hours: e.target.value })} /></Field>
              <Field label={t('appraisal.certificate')}><input type="file" onChange={(e) => setCert(e.target.files?.[0] ?? null)} /></Field>
            </Grid>
            <Button disabled={!tr.title || !tr.attended_on || a.busy} onClick={async () => {
              const r = await a.run(async () => post('/trainings', { staff_id: tr.staff_id || undefined, title: tr.title, provider: tr.provider || undefined, attended_on: tr.attended_on, hours: Number(tr.hours), certificate_path: cert ? await uploadFile(cert, 'certificate') : null }));
              if (r) (setTr({ ...tr, title: '', provider: '' }), trainings.reload());
            }}>{t('common.save')}</Button>
            <ErrorBox error={a.error} />
          </Card>
          <Card><Table rows={trainings.data} columns={[{ key: 'full_name', header: t('common.person') }, { key: 'title', header: t('common.title') }, { key: 'provider', header: t('appraisal.provider') }, { key: 'attended_on', header: t('common.date'), render: (r) => <DateText value={r.attended_on} /> }, { key: 'hours', header: t('appraisal.hours') }]} /></Card>
        </div>
      )}
    </div>
  );
}
