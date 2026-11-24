'use client';
/** Compliance tracker: licences and certificates with expiry reminders and an inspection-readiness score. */
import { useState } from 'react';
import { useApp } from '@/lib/app';
import { api, post, uploadFile, useApi } from '@/lib/api';
import { useLookups, opts } from '@/lib/lookups';
import { FileLink } from '@/components/files';
import { Badge, Button, Card, DateText, ErrorBox, Field, Grid, Input, Modal, PageHeader, Select, Stat, Table, Textarea, useAction } from '@/components/ui';

const TONE = { valid: 'green', expiring: 'amber', overdue: 'red', missing: 'gray' } as const;

export default function Compliance() {
  const { t, can, me } = useApp();
  const lk = useLookups();
  const [branch, setBranch] = useState('');
  const list = useApi<any>(`/compliance${branch ? `?branch_id=${branch}` : ''}`);
  const a = useAction();
  const blank = { id: '', name: '', category: '', owner_id: '', issued_on: '', expires_on: '', notes: '', documents: [] as { path: string; name: string }[] };
  const [edit, setEdit] = useState<typeof blank | null>(null);
  const [file, setFile] = useState<File | null>(null);
  return (
    <div>
      <PageHeader title={t('nav.compliance')} actions={can('compliance', 'create') && <Button onClick={() => setEdit(blank)}>{t('compliance.add')}</Button>} />
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label={t('compliance.readiness')} value={list.data ? `${list.data.readiness}%` : '—'} tone={list.data?.readiness >= 90 ? 'green' : list.data?.readiness >= 70 ? 'amber' : 'red'} />
        {(['expiring', 'overdue', 'missing'] as const).map((s) => <Stat key={s} label={t(`compliance.status.${s}`)} value={(list.data?.items ?? []).filter((i: any) => i.status === s).length} />)}
      </div>
      <Card actions={(me?.branches.length ?? 0) > 1 && <Select aria-label={t('common.branch')} value={branch} onChange={(e) => setBranch(e.target.value)} placeholder={t('common.thisBranch')} options={(me?.branches ?? []).map((b) => ({ value: b.id, label: b.name }))} className="w-48" />}>
        <Table rows={list.data?.items} onRow={(r) => can('compliance', 'edit') && setEdit({ id: r.id, name: r.name, category: r.category, owner_id: r.owner_id ?? '', issued_on: r.issued_on?.slice(0, 10) ?? '', expires_on: r.expires_on?.slice(0, 10) ?? '', notes: r.notes ?? '', documents: r.documents ?? [] })} columns={[
          { key: 'name', header: t('common.name') },
          { key: 'category', header: t('common.category') },
          { key: 'owner_name', header: t('tasks.owner') },
          { key: 'expires_on', header: t('compliance.expires'), render: (r) => <DateText value={r.expires_on} /> },
          { key: 'status', header: t('common.status'), render: (r) => <Badge tone={TONE[r.status as keyof typeof TONE]}>{t(`compliance.status.${r.status}`)}{r.daysLeft != null && r.status !== 'valid' && ` (${t('compliance.days', { n: r.daysLeft })})`}</Badge> },
          { key: 'documents', header: t('compliance.documents'), render: (r) => (r.documents ?? []).length },
        ]} />
      </Card>
      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? t('common.edit') : t('compliance.add')}>
        {edit && (
          <div className="space-y-3">
            <Grid cols={2}>
              <Field label={t('common.name')}><Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
              <Field label={t('common.category')}><Input value={edit.category} onChange={(e) => setEdit({ ...edit, category: e.target.value })} /></Field>
              <Field label={t('compliance.issued')}><Input type="date" value={edit.issued_on} onChange={(e) => setEdit({ ...edit, issued_on: e.target.value })} /></Field>
              <Field label={t('compliance.expires')}><Input type="date" value={edit.expires_on} onChange={(e) => setEdit({ ...edit, expires_on: e.target.value })} /></Field>
            </Grid>
            <Field label={t('tasks.owner')}><Select value={edit.owner_id} onChange={(e) => setEdit({ ...edit, owner_id: e.target.value })} placeholder={t('common.optional')} options={opts(lk?.staff, (s) => s.full_name)} /></Field>
            <Field label={t('common.notes')}><Textarea value={edit.notes} onChange={(e) => setEdit({ ...edit, notes: e.target.value })} /></Field>
            <ul className="list-disc pl-5 text-sm">{edit.documents.map((d) => <li key={d.path}><FileLink path={d.path} name={d.name} /></li>)}</ul>
            <Field label={t('compliance.addDocument')}><input type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></Field>
            <ErrorBox error={a.error} />
            <Button disabled={edit.name.length < 2 || edit.category.length < 2 || a.busy} onClick={async () => {
              const ok = await a.run(async () => {
                const documents = file ? [...edit.documents, { path: await uploadFile(file, 'compliance'), name: file.name }] : edit.documents;
                const body = { name: edit.name, category: edit.category, owner_id: edit.owner_id || null, issued_on: edit.issued_on || null, expires_on: edit.expires_on || null, notes: edit.notes || undefined, documents };
                return edit.id ? api('PUT', `/compliance/${edit.id}`, body) : post('/compliance', body);
              });
              if (ok) { setEdit(null); setFile(null); list.reload(); }
            }}>{t('common.save')}</Button>
          </div>
        )}
      </Modal>
    </div>
  );
}
