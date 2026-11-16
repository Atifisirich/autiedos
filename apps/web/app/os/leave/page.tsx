'use client';
/** Leave: balances, apply with live preview (days, balance, clashes), my requests, calendar. */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useApp } from '@/lib/app';
import { post, uploadFile, useApi } from '@/lib/api';
import { useLookups, opts } from '@/lib/lookups';
import { Badge, Button, Card, DateText, ErrorBox, Field, Grid, Input, PageHeader, Select, StatusBadge, Stat, Table, Tabs, Textarea, useAction } from '@/components/ui';

export default function Leave() {
  const { t, label, can } = useApp();
  const lk = useLookups();
  const [tab, setTab] = useState('apply');
  const bal = useApi<any[]>('/leave/balances');
  const mine = useApi<any[]>(tab === 'mine' ? '/leave/mine' : null);
  const cal = useApi<any[]>(tab === 'calendar' ? '/leave/calendar' : null);
  const [f, setF] = useState({ leave_type_id: '', start_date: '', end_date: '', half_day: 'none', hours: '', reason: '', handover_note: '' });
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<any>(null);
  const a = useAction();
  const [done, setDone] = useState(false);
  const type = lk?.leave_types.find((x) => x.id === f.leave_type_id);
  useEffect(() => {
    if (!f.leave_type_id || !f.start_date || !f.end_date) return setPreview(null);
    const body = { leave_type_id: f.leave_type_id, start_date: f.start_date, end_date: f.end_date, half_day: f.half_day, hours: f.hours ? Number(f.hours) : null, attachment_path: file ? 'pending' : null };
    post('/leave/preview', body).then(setPreview).catch(() => setPreview(null));
  }, [f.leave_type_id, f.start_date, f.end_date, f.half_day, f.hours, file]);
  return (
    <div>
      <PageHeader title={t('nav.leave')} />
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {(bal.data ?? []).filter((b) => b.quota > 0).map((b) => (
          <Stat key={b.leave_type_id} label={label(b.name_i18n, b.name)} value={`${b.requestable}${b.unit === 'hour' ? 'h' : ''}`} />
        ))}
      </div>
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'apply', label: t('leave.apply') }, { value: 'mine', label: t('leave.mine') }, ...(can('leave', 'view', 3) ? [{ value: 'calendar', label: t('leave.calendar') }] : [])]} />
      {tab === 'apply' && (
        <Card>
          {done ? (
            <div className="space-y-2 text-sm">
              <p className="text-green-700">{t('leave.submitted')}</p>
              <Button variant="secondary" onClick={() => setDone(false)}>{t('leave.applyAnother')}</Button>
            </div>
          ) : (
            <div className="space-y-3">
              <Grid cols={3}>
                <Field label={t('leave.type')}><Select value={f.leave_type_id} onChange={(e) => setF({ ...f, leave_type_id: e.target.value })} placeholder={t('common.choose')} options={opts(lk?.leave_types, (x) => label(x.name_i18n, x.name))} /></Field>
                <Field label={t('leave.from')}><Input type="date" value={f.start_date} onChange={(e) => setF({ ...f, start_date: e.target.value, end_date: f.end_date || e.target.value })} /></Field>
                <Field label={t('leave.to')}><Input type="date" value={f.end_date} onChange={(e) => setF({ ...f, end_date: e.target.value })} /></Field>
              </Grid>
              <Grid cols={3}>
                {type?.unit === 'hour' ? (
                  <Field label={t('leave.hours')}><Input type="number" step="0.5" min={0.5} value={f.hours} onChange={(e) => setF({ ...f, hours: e.target.value })} /></Field>
                ) : (
                  type?.half_day_allowed && <Field label={t('leave.halfDay')}><Select value={f.half_day} onChange={(e) => setF({ ...f, half_day: e.target.value })} options={['none', 'first', 'second'].map((x) => ({ value: x, label: t(`halfDay.${x}`) }))} /></Field>
                )}
                <Field label={t('leave.document')}><input type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></Field>
              </Grid>
              <Field label={t('tasks.reason')}><Textarea value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
              <Field label={t('leave.handover')}><Textarea value={f.handover_note} onChange={(e) => setF({ ...f, handover_note: e.target.value })} /></Field>
              {preview && (
                <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm">
                  <p>{t('leave.preview', { days: preview.days, balance: preview.balance.requestable })}</p>
                  {preview.clash_count > 0 && <p className="text-amber-700">{t('leave.clashes', { count: preview.clash_count })}: {preview.clashes.map((c: any) => c.full_name).join(', ')}</p>}
                  {preview.errors.map((e: string) => <p key={e} className="text-red-700">{t(`leaveError.${e}`)}</p>)}
                </div>
              )}
              <ErrorBox error={a.error} />
              <Button disabled={a.busy || !preview || preview.errors.filter((e: string) => e !== 'document_required' || !file).length > 0} onClick={async () => {
                const attachment_path = file ? await uploadFile(file, 'leave_doc') : null;
                const r = await a.run(() => post('/leave', { ...f, hours: f.hours ? Number(f.hours) : null, attachment_path }));
                if (r) (setDone(true), bal.reload(), setF({ leave_type_id: '', start_date: '', end_date: '', half_day: 'none', hours: '', reason: '', handover_note: '' }));
              }}>{t('common.submit')}</Button>
            </div>
          )}
        </Card>
      )}
      {tab === 'mine' && (
        <Card>
          <Table rows={mine.data} columns={[{ key: 'type', header: t('leave.type'), render: (r) => label(r.name_i18n, r.type_name) }, { key: 'start_date', header: t('leave.from'), render: (r) => <DateText value={r.start_date} /> }, { key: 'end_date', header: t('leave.to'), render: (r) => <DateText value={r.end_date} /> }, { key: 'days', header: t('leave.days') }, { key: 'status', header: t('common.status'), render: (r) => <StatusBadge status={r.status} /> }, { key: 'approval', header: '', render: (r) => (r.approval_request_id ? <Link className="text-brand-700" href={`/os/approvals/${r.approval_request_id}`}>{t('common.open')}</Link> : null) }]} />
        </Card>
      )}
      {tab === 'calendar' && (
        <Card>
          <Table rows={cal.data} columns={[{ key: 'full_name', header: t('common.person') }, { key: 'department', header: t('common.department') }, { key: 'type_name', header: t('leave.type') }, { key: 'start_date', header: t('leave.from'), render: (r) => <DateText value={r.start_date} /> }, { key: 'end_date', header: t('leave.to'), render: (r) => <DateText value={r.end_date} /> }, { key: 'status', header: t('common.status'), render: (r) => <StatusBadge status={r.status} /> }, { key: 'half_day', header: '', render: (r) => (r.half_day !== 'none' ? <Badge>{t(`halfDay.${r.half_day}`)}</Badge> : null) }]} />
        </Card>
      )}
    </div>
  );
}
