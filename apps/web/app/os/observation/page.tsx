'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useApp } from '@/lib/app';
import { post, useApi } from '@/lib/api';
import { useLookups, opts } from '@/lib/lookups';
import { Button, Card, Checkbox, DateText, ErrorBox, Field, Input, LinkButton, Modal, PageHeader, Select, StatusBadge, Table, useAction } from '@/components/ui';

export default function Observations() {
  const { t, can } = useApp();
  const router = useRouter();
  const lk = useLookups();
  const list = useApi<any[]>('/observations');
  const rubrics = useApi<any[]>('/observation/rubrics');
  const a = useAction();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ rubric_id: '', teacher_id: '', section_id: '', subject_id: '', scheduled_at: '', announced: true });
  return (
    <div>
      <PageHeader title={t('nav.observation')} actions={<>{can('appraisal', 'view', 3) && <LinkButton variant="secondary" href="/os/observation/appraisal">{t('observation.appraisal')}</LinkButton>}{can('observation', 'create') && <Button onClick={() => setOpen(true)}>{t('observation.schedule')}</Button>}</>} />
      <Card>
        <Table rows={list.data} onRow={(r) => router.push(`/os/observation/${r.id}`)} columns={[{ key: 'scheduled_at', header: t('common.date'), render: (r) => <DateText value={r.scheduled_at} withTime /> }, { key: 'teacher_name', header: t('observation.teacher') }, { key: 'observer_name', header: t('observation.observer') }, { key: 'section_name', header: t('common.section') }, { key: 'subject_name', header: t('common.subject') }, { key: 'overall', header: t('observation.overall'), render: (r) => (r.overall != null ? `${Math.round(r.overall)}%` : '—') }, { key: 'status', header: t('common.status'), render: (r) => <StatusBadge status={r.status} /> }]} />
      </Card>
      <Modal open={open} onClose={() => setOpen(false)} title={t('observation.schedule')}>
        <div className="space-y-3">
          <Field label={t('observation.rubric')}><Select value={f.rubric_id} onChange={(e) => setF({ ...f, rubric_id: e.target.value })} placeholder={t('common.choose')} options={(rubrics.data ?? []).map((r) => ({ value: r.id, label: r.name }))} /></Field>
          <Field label={t('observation.teacher')}><Select value={f.teacher_id} onChange={(e) => setF({ ...f, teacher_id: e.target.value })} placeholder={t('common.choose')} options={opts(lk?.staff.filter((s) => s.is_teaching), (s) => s.full_name)} /></Field>
          <Field label={t('common.section')}><Select value={f.section_id} onChange={(e) => setF({ ...f, section_id: e.target.value })} placeholder={t('common.optional')} options={opts(lk?.sections, (s) => `${lk!.classes.find((c) => c.id === s.class_id)?.name} ${s.name}`)} /></Field>
          <Field label={t('common.subject')}><Select value={f.subject_id} onChange={(e) => setF({ ...f, subject_id: e.target.value })} placeholder={t('common.optional')} options={opts(lk?.subjects, (s) => s.name)} /></Field>
          <Field label={t('common.when')}><Input type="datetime-local" value={f.scheduled_at} onChange={(e) => setF({ ...f, scheduled_at: e.target.value })} /></Field>
          <Checkbox label={t('observation.announced')} checked={f.announced} onChange={(e) => setF({ ...f, announced: e.target.checked })} />
          <ErrorBox error={a.error} />
          <Button disabled={!f.rubric_id || !f.teacher_id || !f.scheduled_at || a.busy} onClick={async () => (await a.run(() => post('/observations', { ...f, section_id: f.section_id || null, subject_id: f.subject_id || null, scheduled_at: new Date(f.scheduled_at).toISOString() }))) && (setOpen(false), list.reload())}>{t('common.save')}</Button>
        </div>
      </Modal>
    </div>
  );
}
