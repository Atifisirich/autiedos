'use client';
/** Student attendance: all present by default, tap to change. Summary for managers. */
import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { STUDENT_MARKS } from '@autoed/shared';
import { useApp } from '@/lib/app';
import { post, useApi } from '@/lib/api';
import { Badge, Button, Card, ErrorBox, Field, Input, Loading, PageHeader, Select, Table, Tabs, cx, useAction } from '@/components/ui';

const NEXT: Record<string, string> = { present: 'absent', absent: 'late', late: 'half_day', half_day: 'on_duty', on_duty: 'leave', leave: 'present' };
const TONE: Record<string, string> = { present: 'bg-green-50 border-green-200', absent: 'bg-red-50 border-red-300', late: 'bg-amber-50 border-amber-300', half_day: 'bg-amber-50 border-amber-200', on_duty: 'bg-blue-50 border-blue-200', leave: 'bg-slate-100 border-slate-300' };

export default function StudentAttendance() {
  const { t, can } = useApp();
  const sp = useSearchParams();
  const [tab, setTab] = useState('mark');
  const sections = useApi<{ id: string; name: string; mode: string }[]>('/student-attendance/sections');
  const [section, setSection] = useState(sp.get('section') ?? '');
  const today = new Date().toISOString().slice(0, 10);
  const [date, setDate] = useState(today);
  const sec = sections.data?.find((s) => s.id === section);
  const sessionKeys = sec?.mode === 'daily_twice' ? ['am', 'pm'] : sec?.mode === 'period' ? Array.from({ length: 8 }, (_, i) => `p${i + 1}`) : ['day'];
  const [session, setSession] = useState('day');
  useEffect(() => setSession(sessionKeys[0]!), [section]); // eslint-disable-line react-hooks/exhaustive-deps
  const roster = useApi<any>(section ? `/student-attendance/roster?section_id=${section}&date=${date}&session_key=${session}` : null);
  const [marks, setMarks] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');
  const a = useAction();
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => setMarks(Object.fromEntries((roster.data?.students ?? []).map((s: any) => [s.id, s.status]))), [roster.data]);
  const summary = useApi<any>(tab === 'summary' ? `/student-attendance/summary?date=${date}` : null);
  const alerts = useApi<any>(tab === 'alerts' ? '/student-attendance/alerts' : null);
  const counts = Object.values(marks).reduce<Record<string, number>>((c, m) => ((c[m] = (c[m] ?? 0) + 1), c), {});
  const submitted = !!roster.data?.session?.submitted_at;
  return (
    <div>
      <PageHeader title={t('nav.studentAttendance')} />
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'mark', label: t('studentAtt.mark') }, ...(can('student_attendance', 'view', 3) ? [{ value: 'summary', label: t('studentAtt.summary') }, { value: 'alerts', label: t('studentAtt.alerts') }] : [])]} />
      {tab === 'mark' && (
        <>
          <div className="mb-3 flex flex-wrap gap-2">
            <Select aria-label={t('common.section')} value={section} onChange={(e) => setSection(e.target.value)} placeholder={t('studentAtt.chooseSection')} options={(sections.data ?? []).map((s) => ({ value: s.id, label: s.name }))} className="w-56" />
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-44" aria-label={t('common.date')} />
            {sessionKeys.length > 1 && <Select aria-label={t('studentAtt.session')} value={session} onChange={(e) => setSession(e.target.value)} options={sessionKeys.map((k) => ({ value: k, label: t(`session.${k.startsWith('p') ? 'period' : k}`, { n: k.slice(1) }) }))} className="w-40" />}
          </div>
          {section && !roster.data && <Loading />}
          {roster.data && (
            <Card title={`${roster.data.section.class_name} ${roster.data.section.name}`} actions={<div className="flex flex-wrap gap-1">{STUDENT_MARKS.map((m) => <Badge key={m}>{t(`mark.${m}`)}: {counts[m] ?? 0}</Badge>)}</div>}>
              <p className="mb-3 text-xs text-slate-500">{t('studentAtt.tapHint')}</p>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
                {roster.data.students.map((s: any) => (
                  <button key={s.id} type="button" onClick={() => setMarks((m) => ({ ...m, [s.id]: NEXT[m[s.id] ?? 'present']! }))} className={cx('min-h-[56px] rounded-md border p-2 text-left text-sm', TONE[marks[s.id] ?? 'present'])}>
                    <div className="font-medium">{s.roll_no}. {s.full_name}</div>
                    <div className="text-xs">{t(`mark.${marks[s.id] ?? 'present'}`)}</div>
                  </button>
                ))}
              </div>
              {submitted && (
                <Field label={t('studentAtt.editReason')} hint={roster.data.editable === 'approval_required' ? t('studentAtt.needsApproval') : t('studentAtt.withinWindow')}>
                  <Input value={reason} onChange={(e) => setReason(e.target.value)} />
                </Field>
              )}
              <ErrorBox error={a.error} />
              {msg && <p className="mt-2 text-sm text-green-700">{msg}</p>}
              <Button className="mt-3" disabled={a.busy || (submitted && !reason)} onClick={async () => {
                const r = await a.run(() => post<{ status: string }>('/student-attendance', { section_id: section, date, session_key: session, marks: Object.entries(marks).map(([student_id, status]) => ({ student_id, status })), edit_reason: reason || undefined, client_id: crypto.randomUUID() }));
                if (r) {
                  setMsg(t(`studentAtt.result.${r.status}`));
                  await roster.reload();
                }
              }}>{submitted ? t('studentAtt.saveChanges') : t('common.submit')}</Button>
            </Card>
          )}
        </>
      )}
      {tab === 'summary' && (
        <Card title={t('studentAtt.summary')} actions={<Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-44" aria-label={t('common.date')} />}>
          <Table rows={summary.data?.sections} rowKey={(r) => r.section_id} columns={[{ key: 'section', header: t('common.section') }, { key: 'wing', header: t('common.wing') }, { key: 'marked', header: t('studentAtt.marked'), render: (r) => (r.marked ? <Badge tone="green">{t('common.yes')}</Badge> : <Badge tone="red">{t('studentAtt.notMarked')}</Badge>) }, { key: 'absent', header: t('mark.absent'), render: (r) => r.summary?.absent ?? '—' }, { key: 'pct', header: t('studentAtt.pct'), render: (r) => (r.pct != null ? `${r.pct}%` : '—') }]} />
          <h3 className="mb-2 mt-4 text-sm font-semibold">{t('studentAtt.absentees')}</h3>
          <Table rows={summary.data?.absentees} columns={[{ key: 'section', header: t('common.section') }, { key: 'roll_no', header: t('studentAtt.roll') }, { key: 'full_name', header: t('common.name') }, { key: 'status', header: t('common.status'), render: (r) => t(`mark.${r.status}`) }]} />
        </Card>
      )}
      {tab === 'alerts' && alerts.data && (
        <div className="space-y-4">
          <Card title={t('studentAtt.below', { pct: alerts.data.threshold })}>
            <Table rows={alerts.data.below} rowKey={(r) => r.student_id} columns={[{ key: 'full_name', header: t('common.name') }, { key: 'section', header: t('common.section') }, { key: 'pct', header: t('studentAtt.pct'), render: (r) => `${r.pct}%` }]} />
          </Card>
          <Card title={t('studentAtt.consecutive')}>
            <Table rows={alerts.data.consecutive} rowKey={(r) => r.student_id} columns={[{ key: 'full_name', header: t('common.name') }, { key: 'section', header: t('common.section') }, { key: 'consecutive_absences', header: t('studentAtt.days') }]} />
          </Card>
        </div>
      )}
    </div>
  );
}
