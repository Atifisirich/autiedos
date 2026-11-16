'use client';
import { useState } from 'react';
import { useApp } from '@/lib/app';
import { download, fileToBase64, post, useApi } from '@/lib/api';
import { Badge, Button, Card, DateText, ErrorBox, Field, Grid, Input, PageHeader, Select, StatusBadge, Table, Tabs, Textarea, useAction } from '@/components/ui';
import { CheckInCard } from '@/components/check-in';

export default function Attendance() {
  const { t, can } = useApp();
  const manager = can('staff_attendance', 'view', 3);
  const [tab, setTab] = useState('mine');
  const month = new Date().toISOString().slice(0, 7);
  const mine = useApi<any[]>(tab === 'mine' ? `/attendance/mine?month=${month}` : null);
  const today = mine.data?.find((r) => r.date === new Date().toISOString().slice(0, 10)) ?? null;
  const exc = useApi<any>(tab === 'exceptions' ? '/attendance/exceptions' : null);
  const [regMonth, setRegMonth] = useState(month);
  const reg = useApi<any>(tab === 'register' ? `/attendance/register?month=${regMonth}` : null);
  const r = useAction();
  const [rf, setRf] = useState({ date: '', check_in: '', check_out: '', reason: '' });
  return (
    <div>
      <PageHeader title={t('nav.attendance')} />
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'mine', label: t('attendance.mine') }, ...(manager ? [{ value: 'exceptions', label: t('attendance.exceptions') }, { value: 'register', label: t('attendance.register') }] : []), ...(can('staff_attendance', 'configure', 5) ? [{ value: 'import', label: t('attendance.import') }] : [])]} />
      {tab === 'mine' && (
        <Grid cols={2}>
          <div className="space-y-4">
            <CheckInCard attendance={today} onDone={mine.reload} />
            <Card title={t('attendance.requestCorrection')}>
              <div className="space-y-2">
                <Grid cols={3}>
                  <Field label={t('common.date')}><Input type="date" value={rf.date} onChange={(e) => setRf({ ...rf, date: e.target.value })} /></Field>
                  <Field label={t('attendance.in')}><Input type="time" value={rf.check_in} onChange={(e) => setRf({ ...rf, check_in: e.target.value })} /></Field>
                  <Field label={t('attendance.out')}><Input type="time" value={rf.check_out} onChange={(e) => setRf({ ...rf, check_out: e.target.value })} /></Field>
                </Grid>
                <Field label={t('tasks.reason')}><Textarea value={rf.reason} onChange={(e) => setRf({ ...rf, reason: e.target.value })} /></Field>
                <ErrorBox error={r.error} />
                <Button disabled={!rf.date || rf.reason.length < 3 || r.busy} onClick={async () => (await r.run(() => post('/attendance/regularise', { date: rf.date, check_in: rf.check_in || undefined, check_out: rf.check_out || undefined, reason: rf.reason }))) && setRf({ date: '', check_in: '', check_out: '', reason: '' })}>{t('common.submit')}</Button>
              </div>
            </Card>
          </div>
          <Card title={t('attendance.thisMonth')}>
            <Table rows={mine.data} rowKey={(x) => x.date} columns={[{ key: 'date', header: t('common.date'), render: (x) => <DateText value={x.date} /> }, { key: 'in', header: t('attendance.in'), render: (x) => <DateText value={x.check_in_at} withTime /> }, { key: 'out', header: t('attendance.out'), render: (x) => <DateText value={x.check_out_at} withTime /> }, { key: 'status', header: t('common.status'), render: (x) => <div className="flex gap-1"><StatusBadge status={x.status} />{x.conflict && <Badge tone="amber">{t('attendance.conflict')}</Badge>}</div> }]} />
          </Card>
        </Grid>
      )}
      {tab === 'exceptions' && exc.data && (
        <div className="space-y-4">
          <Card title={t('attendance.exceptionsToday')}>
            <Table rows={exc.data.exceptions} rowKey={(x) => x.staff_id} columns={[{ key: 'full_name', header: t('common.person') }, { key: 'status', header: t('common.status'), render: (x) => (x.on_leave ? <StatusBadge status="on_leave" /> : x.status ? <StatusBadge status={x.status} /> : <Badge tone="red">{t('attendance.noCheckIn')}</Badge>) }, { key: 'late_minutes', header: t('attendance.lateBy') }, { key: 'conflict', header: t('attendance.conflict'), render: (x) => (x.conflict ? x.conflict.map((c: any) => `${t(`attendance.${c.field}`)}: ${c.app} / ${c.device}`).join('; ') : '—') }]} />
          </Card>
          <Card title={t('attendance.regularisations')}>
            <Table rows={exc.data.regularisations} columns={[{ key: 'full_name', header: t('common.person') }, { key: 'title', header: t('common.request'), render: (x) => <a className="text-brand-700" href={`/os/approvals/${x.id}`}>{x.title}</a> }]} />
          </Card>
        </div>
      )}
      {tab === 'register' && (
        <Card title={t('attendance.register')} actions={<><Input type="month" value={regMonth} onChange={(e) => setRegMonth(e.target.value)} className="w-40" aria-label={t('common.month')} /><Button variant="secondary" onClick={() => download(`/attendance/register.xlsx?month=${regMonth}`)}>{t('common.exportExcel')}</Button></>}>
          {reg.data && <p className="mb-2 text-sm text-slate-500">{t('attendance.workingDays', { count: reg.data.working_days })}</p>}
          <Table rows={reg.data?.rows} rowKey={(x) => x.staff_id} columns={[{ key: 'employee_code', header: t('staff.code') }, { key: 'name', header: t('common.person') }, { key: 'present', header: t('status.present') }, { key: 'late', header: t('status.late') }, { key: 'half_days', header: t('status.half_day') }, { key: 'absent', header: t('status.absent') }, { key: 'leave', header: t('nav.leave'), render: (x) => Object.entries(x.leave).map(([k, v]) => `${k}: ${v}`).join(', ') || '—' }, { key: 'loss_of_pay_days', header: t('attendance.lop') }]} />
        </Card>
      )}
      {tab === 'import' && <BiometricImport />}
    </div>
  );
}

/** Upload the device's CSV/Excel, map columns once per device type, merge with app records. */
function BiometricImport() {
  const { t } = useApp();
  const [rows, setRows] = useState<Record<string, string>[]>([]);
  const [fileName, setFileName] = useState('');
  const [map, setMap] = useState({ device_type: 'eSSL', employeeCode: '', date: '', checkIn: '', checkOut: '', dateFormat: 'DD/MM/YYYY' });
  const a = useAction();
  const [res, setRes] = useState<any>(null);
  const cols = rows[0] ? Object.keys(rows[0]).map((c) => ({ value: c, label: c })) : [];
  return (
    <Card title={t('attendance.import')}>
      <div className="space-y-3">
        <input type="file" accept=".csv,.xlsx" aria-label={t('common.file')} onChange={async (e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          setFileName(f.name);
          const parsed = await a.run(async () => post<{ rows: Record<string, string>[] }>('/setup/parse', { base64: await fileToBase64(f), file_name: f.name }));
          if (parsed) setRows(parsed.rows);
        }} />
        {rows.length > 0 && (
          <>
            <p className="text-sm text-slate-600">{t('attendance.rowsRead', { count: rows.length })}</p>
            <Grid cols={3}>
              <Field label={t('attendance.deviceType')}><Input value={map.device_type} onChange={(e) => setMap({ ...map, device_type: e.target.value })} /></Field>
              {(['employeeCode', 'date', 'checkIn', 'checkOut'] as const).map((k) => (
                <Field key={k} label={t(`attendance.map.${k}`)}><Select value={map[k]} onChange={(e) => setMap({ ...map, [k]: e.target.value })} placeholder={t('common.choose')} options={cols} /></Field>
              ))}
              <Field label={t('attendance.dateFormat')}><Select value={map.dateFormat} onChange={(e) => setMap({ ...map, dateFormat: e.target.value })} options={['DD/MM/YYYY', 'DD-MM-YYYY', 'YYYY-MM-DD', 'MM/DD/YYYY'].map((x) => ({ value: x, label: x }))} /></Field>
            </Grid>
            <Button disabled={!map.employeeCode || !map.date || !map.checkIn || a.busy} onClick={async () => setRes(await a.run(() => post('/attendance/import', { device_type: map.device_type, mapping: { employeeCode: map.employeeCode, date: map.date, checkIn: map.checkIn, checkOut: map.checkOut || undefined, dateFormat: map.dateFormat }, rows, file_name: fileName, save_mapping: true })))}>{t('attendance.merge')}</Button>
          </>
        )}
        <ErrorBox error={a.error} />
        {res && (
          <div className="space-y-2 text-sm">
            <p>{t('attendance.mergedSummary', { merged: res.merged, conflicts: res.conflicts.length, errors: res.errors.length })}</p>
            {res.errors.length > 0 && <ul className="list-disc pl-5 text-red-700">{res.errors.slice(0, 50).map((e: any, i: number) => <li key={i}>{t('import.rowError', { row: e.row, error: t(`importError.${e.error}`) })}</li>)}</ul>}
          </div>
        )}
      </div>
    </Card>
  );
}
