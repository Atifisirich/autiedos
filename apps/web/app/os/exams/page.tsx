'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useApp } from '@/lib/app';
import { post, useApi } from '@/lib/api';
import { useLookups, opts } from '@/lib/lookups';
import { Button, Card, DateText, ErrorBox, Field, Grid, Input, LinkButton, Modal, PageHeader, Select, Table, useAction } from '@/components/ui';

export default function Exams() {
  const { t, label, can } = useApp();
  const router = useRouter();
  const lk = useLookups();
  const list = useApi<any[]>('/exams');
  const a = useAction();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ name: '', exam_type_id: '', starts_on: '', ends_on: '', programme_ids: [] as string[] });
  return (
    <div>
      <PageHeader title={t('nav.exams')} actions={<><LinkButton variant="secondary" href="/os/exams/papers">{t('exams.papers')}</LinkButton><LinkButton variant="secondary" href="/os/exams/blueprints">{t('exams.blueprints')}</LinkButton>{can('exams', 'create') && <Button onClick={() => setOpen(true)}>{t('exams.new')}</Button>}</>} />
      <Card>
        <Table rows={list.data} onRow={(r) => router.push(`/os/exams/${r.id}`)} columns={[{ key: 'name', header: t('common.name') }, { key: 'type_name', header: t('common.type') }, { key: 'starts_on', header: t('leave.from'), render: (r) => <DateText value={r.starts_on} /> }, { key: 'ends_on', header: t('leave.to'), render: (r) => <DateText value={r.ends_on} /> }, { key: 'papers', header: t('exams.scheduled') }]} />
      </Card>
      <Modal open={open} onClose={() => setOpen(false)} title={t('exams.new')}>
        <div className="space-y-3">
          <Field label={t('common.name')}><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label={t('common.type')}><Select value={f.exam_type_id} onChange={(e) => setF({ ...f, exam_type_id: e.target.value })} placeholder={t('common.optional')} options={opts(lk?.exam_types, (x) => label(x.name_i18n, x.name))} /></Field>
          <Grid cols={2}>
            <Field label={t('leave.from')}><Input type="date" value={f.starts_on} onChange={(e) => setF({ ...f, starts_on: e.target.value })} /></Field>
            <Field label={t('leave.to')}><Input type="date" value={f.ends_on} onChange={(e) => setF({ ...f, ends_on: e.target.value })} /></Field>
          </Grid>
          <Field label={t('common.class')}>
            <select multiple className="h-32 w-full rounded-md border border-slate-300 p-1 text-sm" value={f.programme_ids} onChange={(e) => setF({ ...f, programme_ids: [...e.target.selectedOptions].map((o) => o.value) })}>
              {(lk?.classes ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
          <ErrorBox error={a.error} />
          <Button disabled={a.busy || !f.name || !f.starts_on || !f.ends_on || !f.programme_ids.length} onClick={async () => { const r = await a.run(() => post<{ id: string }>('/exams', { ...f, exam_type_id: f.exam_type_id || null })); if (r) router.push(`/os/exams/${r.id}`); }}>{t('common.save')}</Button>
        </div>
      </Modal>
    </div>
  );
}
