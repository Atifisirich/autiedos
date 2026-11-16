'use client';
import { use, useState } from 'react';
import { useApp } from '@/lib/app';
import { download, post, useApi } from '@/lib/api';
import { useLookups, opts } from '@/lib/lookups';
import { AutoTable } from '@/components/auto-table';
import { Button, Card, ErrorBox, Field, Grid, Input, Modal, PageHeader, Select, useAction } from '@/components/ui';

export default function ReportView({ params }: { params: Promise<{ key: string }> }) {
  const { key } = use(params);
  const { t, me } = useApp();
  const lk = useLookups();
  const [f, setF] = useState({ from: new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10), to: new Date().toISOString().slice(0, 10), wing_id: '', department_id: '', branch_id: '' });
  const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
  const r = useApi<{ columns: { key: string; header: string }[]; rows: any[] }>(`/reports/${key}?${qs}`);
  const a = useAction();
  const [sched, setSched] = useState<{ open: boolean; frequency: string; send_time: string; weekday: number; recipient_ids: string[]; channel: string }>({ open: false, frequency: 'weekly', send_time: '07:30', weekday: 1, recipient_ids: [], channel: 'inapp' });
  return (
    <div>
      <PageHeader title={t(`report.${key}`)} subtitle={t(`report.${key}.desc`)} actions={<><Button variant="secondary" onClick={() => download(`/reports/${key}/xlsx?${qs}`)}>{t('common.exportExcel')}</Button><Button variant="secondary" onClick={() => setSched({ ...sched, open: true, recipient_ids: me ? [me.staff.id] : [] })}>{t('reports.schedule')}</Button></>} />
      <Card>
        <div className="mb-3 flex flex-wrap gap-2">
          <Input type="date" aria-label={t('leave.from')} value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} className="w-40" />
          <Input type="date" aria-label={t('leave.to')} value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} className="w-40" />
          <Select aria-label={t('common.wing')} value={f.wing_id} onChange={(e) => setF({ ...f, wing_id: e.target.value })} placeholder={t('common.allWings')} options={opts(lk?.wings, (w) => w.name)} className="w-40" />
          <Select aria-label={t('common.department')} value={f.department_id} onChange={(e) => setF({ ...f, department_id: e.target.value })} placeholder={t('common.allDepartments')} options={opts(lk?.departments, (d) => d.name)} className="w-44" />
          {(me?.branches.length ?? 0) > 1 && <Select aria-label={t('common.branch')} value={f.branch_id} onChange={(e) => setF({ ...f, branch_id: e.target.value })} placeholder={t('common.thisBranch')} options={(me?.branches ?? []).map((b) => ({ value: b.id, label: b.name }))} className="w-44" />}
        </div>
        <ErrorBox error={r.error} />
        <AutoTable rows={r.data?.rows} columns={r.data?.columns} />
      </Card>
      <Modal open={sched.open} onClose={() => setSched({ ...sched, open: false })} title={t('reports.schedule')}>
        <div className="space-y-3">
          <Grid cols={2}>
            <Field label={t('reports.frequency')}><Select value={sched.frequency} onChange={(e) => setSched({ ...sched, frequency: e.target.value })} options={['daily', 'weekly', 'monthly'].map((x) => ({ value: x, label: t(`frequency.${x}`) }))} /></Field>
            <Field label={t('common.time')}><Input type="time" value={sched.send_time} onChange={(e) => setSched({ ...sched, send_time: e.target.value })} /></Field>
            {sched.frequency === 'weekly' && <Field label={t('reports.weekday')}><Select value={String(sched.weekday)} onChange={(e) => setSched({ ...sched, weekday: Number(e.target.value) })} options={[1, 2, 3, 4, 5, 6, 7].map((d) => ({ value: String(d), label: t(`day.${d}`) }))} /></Field>}
            <Field label={t('reports.channel')}><Select value={sched.channel} onChange={(e) => setSched({ ...sched, channel: e.target.value })} options={['inapp', 'email', 'whatsapp_link'].map((x) => ({ value: x, label: t(`channel.${x}`) }))} /></Field>
          </Grid>
          <Field label={t('reports.recipients')}><select multiple aria-label={t('reports.recipients')} className="h-28 w-full rounded-md border border-slate-300 p-1 text-sm" value={sched.recipient_ids} onChange={(e) => setSched({ ...sched, recipient_ids: [...e.target.selectedOptions].map((o) => o.value) })}>{(lk?.staff ?? []).map((s) => <option key={s.id} value={s.id}>{s.full_name}</option>)}</select></Field>
          <ErrorBox error={a.error} />
          <Button disabled={!sched.recipient_ids.length || a.busy} onClick={async () => (await a.run(() => post('/reports/schedules', { report_key: key, frequency: sched.frequency, send_time: sched.send_time, weekday: sched.frequency === 'weekly' ? sched.weekday : null, recipient_ids: sched.recipient_ids, channel: sched.channel }))) && setSched({ ...sched, open: false })}>{t('common.save')}</Button>
        </div>
      </Modal>
    </div>
  );
}
