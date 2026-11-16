'use client';
/** Compose a circular: targeting by branch/wing/department/role/person, response mode, schedule, attachments. */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useApp } from '@/lib/app';
import { post, uploadFile } from '@/lib/api';
import { useLookups } from '@/lib/lookups';
import { Button, Card, Checkbox, ErrorBox, Field, Grid, Input, PageHeader, Select, Textarea, useAction } from '@/components/ui';

function Multi({ label, value, onChange, options }: { label: string; value: string[]; onChange: (v: string[]) => void; options: { value: string; label: string }[] }) {
  return (
    <Field label={label}>
      <select multiple aria-label={label} className="h-28 w-full rounded-md border border-slate-300 p-1 text-sm" value={value} onChange={(e) => onChange([...e.target.selectedOptions].map((o) => o.value))}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </Field>
  );
}

export default function NewCircular() {
  const { t, me } = useApp();
  const lk = useLookups();
  const router = useRouter();
  const a = useAction();
  const [f, setF] = useState({ title: '', body: '', response_mode: 'read', question: '', options: 'yes,no', important: false, tags: '', scheduled_at: '', reminder_after_hours: 24 });
  const [target, setTarget] = useState({ branch_ids: [] as string[], wing_ids: [] as string[], department_ids: [] as string[], role_ids: [] as string[], staff_ids: [] as string[] });
  const [files, setFiles] = useState<File[]>([]);
  const o = (xs: { id: string; name?: string; full_name?: string }[] | undefined) => (xs ?? []).map((x) => ({ value: x.id, label: x.name ?? x.full_name ?? '' }));
  return (
    <div>
      <PageHeader title={t('circulars.new')} />
      <Card>
        <div className="space-y-3">
          <Field label={t('common.title')}><Input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
          <Field label={t('circulars.body')}><Textarea rows={8} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} /></Field>
          <p className="text-sm font-semibold">{t('circulars.audience')}</p>
          <p className="text-xs text-slate-500">{t('circulars.audienceHint')}</p>
          <Grid cols={3}>
            <Multi label={t('common.branch')} value={target.branch_ids} onChange={(v) => setTarget({ ...target, branch_ids: v })} options={o(me?.branches)} />
            <Multi label={t('common.wing')} value={target.wing_ids} onChange={(v) => setTarget({ ...target, wing_ids: v })} options={o(lk?.wings)} />
            <Multi label={t('common.department')} value={target.department_ids} onChange={(v) => setTarget({ ...target, department_ids: v })} options={o(lk?.departments)} />
            <Multi label={t('common.role')} value={target.role_ids} onChange={(v) => setTarget({ ...target, role_ids: v })} options={o(lk?.roles)} />
            <Multi label={t('common.person')} value={target.staff_ids} onChange={(v) => setTarget({ ...target, staff_ids: v })} options={o(lk?.staff)} />
          </Grid>
          <Grid cols={3}>
            <Field label={t('circulars.responseMode')}><Select value={f.response_mode} onChange={(e) => setF({ ...f, response_mode: e.target.value })} options={['read', 'acknowledge', 'reply'].map((m) => ({ value: m, label: t(`responseMode.${m}`) }))} /></Field>
            <Field label={t('circulars.schedule')}><Input type="datetime-local" value={f.scheduled_at} onChange={(e) => setF({ ...f, scheduled_at: e.target.value })} /></Field>
            <Field label={t('circulars.reminderHours')}><Input type="number" value={f.reminder_after_hours} onChange={(e) => setF({ ...f, reminder_after_hours: Number(e.target.value) })} /></Field>
          </Grid>
          {f.response_mode === 'reply' && (
            <Grid cols={2}>
              <Field label={t('circulars.question')}><Input value={f.question} onChange={(e) => setF({ ...f, question: e.target.value })} /></Field>
              <Field label={t('circulars.options')} hint={t('circulars.optionsHint')}><Input value={f.options} onChange={(e) => setF({ ...f, options: e.target.value })} /></Field>
            </Grid>
          )}
          <Grid cols={2}>
            <Field label={t('circulars.tags')} hint={t('circulars.optionsHint')}><Input value={f.tags} onChange={(e) => setF({ ...f, tags: e.target.value })} /></Field>
            <Field label={t('circulars.attachments')}><input type="file" multiple onChange={(e) => setFiles([...(e.target.files ?? [])])} /></Field>
          </Grid>
          <Checkbox label={t('circulars.markImportant')} checked={f.important} onChange={(e) => setF({ ...f, important: e.target.checked })} />
          <ErrorBox error={a.error} />
          <Button disabled={a.busy || f.title.length < 2 || !f.body} onClick={async () => {
            const r = await a.run(async () => {
              const attachments = [];
              for (const file of files) attachments.push({ path: await uploadFile(file, 'circular'), name: file.name });
              return post<{ id: string }>('/circulars', { title: f.title, body: f.body, attachments, target, response_mode: f.response_mode, reply_form: f.response_mode === 'reply' ? { question: f.question, options: f.options.split(',').map((x) => x.trim()).filter(Boolean) } : null, important: f.important, tags: f.tags.split(',').map((x) => x.trim()).filter(Boolean), scheduled_at: f.scheduled_at ? new Date(f.scheduled_at).toISOString() : null, reminder_after_hours: f.reminder_after_hours });
            });
            if (r) router.push(`/os/circulars/${r.id}`);
          }}>{f.scheduled_at ? t('circulars.scheduleSend') : t('circulars.send')}</Button>
        </div>
      </Card>
    </div>
  );
}
