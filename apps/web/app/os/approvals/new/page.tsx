'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useApp } from '@/lib/app';
import { post, uploadFile } from '@/lib/api';
import { useLookups } from '@/lib/lookups';
import { Button, Card, Checkbox, ErrorBox, Field, Input, PageHeader, Select, useAction } from '@/components/ui';

export default function NewRequest() {
  const { t, label } = useApp();
  const lk = useLookups();
  const router = useRouter();
  const a = useAction();
  const [key, setKey] = useState('');
  const [title, setTitle] = useState('');
  const [data, setData] = useState<Record<string, unknown>>({});
  const type = lk?.approval_types.find((x) => x.key === key);
  return (
    <div>
      <PageHeader title={t('approvals.new')} />
      <Card>
        <div className="space-y-3">
          <Field label={t('common.type')}><Select value={key} onChange={(e) => (setKey(e.target.value), setData({}))} placeholder={t('common.choose')} options={(lk?.approval_types ?? []).filter((x) => !x.is_system).map((x) => ({ value: x.key, label: label(x.name_i18n, x.name) }))} /></Field>
          <Field label={t('common.title')}><Input value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
          {type?.form_schema.map((f) => (
            <Field key={f.key} label={`${f.label}${f.required ? ' *' : ''}`}>
              {f.type === 'yesno' ? (
                <Checkbox label={f.label} checked={!!data[f.key]} onChange={(e) => setData({ ...data, [f.key]: e.target.checked })} />
              ) : f.type === 'dropdown' ? (
                <Select value={String(data[f.key] ?? '')} onChange={(e) => setData({ ...data, [f.key]: e.target.value })} placeholder={t('common.choose')} options={(f.options ?? []).map((o) => ({ value: o, label: o }))} />
              ) : f.type === 'file' ? (
                <input type="file" onChange={async (e) => { const file = e.target.files?.[0]; if (file) setData({ ...data, [f.key]: await uploadFile(file, 'document') }); }} />
              ) : (
                <Input type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'} value={String(data[f.key] ?? '')} onChange={(e) => setData({ ...data, [f.key]: f.type === 'number' ? Number(e.target.value) : e.target.value })} />
              )}
            </Field>
          ))}
          <ErrorBox error={a.error} />
          <Button disabled={!key || title.length < 2 || a.busy} onClick={async () => {
            const r = await a.run(() => post<{ id: string }>('/approvals', { approval_type_key: key, title, data }));
            if (r) router.push(`/os/approvals/${r.id}`);
          }}>{t('common.submit')}</Button>
        </div>
      </Card>
    </div>
  );
}
