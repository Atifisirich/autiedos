'use client';
/** Substitution board: uncovered periods first, ranked suggestions, one-tap assign. */
import { useState } from 'react';
import { useApp } from '@/lib/app';
import { post, useApi } from '@/lib/api';
import { useLookups, opts } from '@/lib/lookups';
import { Badge, Button, Card, DateText, ErrorBox, Field, Input, PageHeader, Select, StatusBadge, Table, Tabs, useAction } from '@/components/ui';

export default function Substitution() {
  const { t, can } = useApp();
  const lk = useLookups();
  const [tab, setTab] = useState(can('substitution', 'view', 3) ? 'board' : 'mine');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const board = useApi<any[]>(tab === 'board' ? `/substitution?date=${date}` : null);
  const mine = useApi<any[]>(tab === 'mine' ? '/substitution/mine' : null);
  const reports = useApi<any>(tab === 'reports' ? '/substitution/reports' : null);
  const a = useAction();
  const [absent, setAbsent] = useState('');
  const [pick, setPick] = useState<Record<string, string>>({});
  const assign = async (id: string, resolution: string, staff?: string) => (await a.run(() => post('/substitution/assign', { substitution_id: id, resolution, substitute_staff_id: staff ?? null }))) && board.reload();
  const rows = [...(board.data ?? [])].sort((x, y) => Number(x.status === 'assigned') - Number(y.status === 'assigned'));
  return (
    <div>
      <PageHeader title={t('nav.substitution')} />
      <Tabs value={tab} onChange={setTab} tabs={[...(can('substitution', 'view', 3) ? [{ value: 'board', label: t('substitution.board') }] : []), { value: 'mine', label: t('substitution.mine') }, ...(can('substitution', 'view', 3) ? [{ value: 'reports', label: t('substitution.reports') }] : [])]} />
      {tab === 'board' && (
        <>
          <Card className="mb-4">
            <div className="flex flex-wrap items-end gap-2">
              <Field label={t('common.date')}><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
              {can('substitution', 'create') && (
                <>
                  <Field label={t('substitution.markAbsent')}><Select value={absent} onChange={(e) => setAbsent(e.target.value)} placeholder={t('common.choose')} options={opts(lk?.staff.filter((s) => s.is_teaching), (s) => s.full_name)} /></Field>
                  <Button disabled={!absent || a.busy} onClick={async () => (await a.run(() => post('/substitution/mark-absent', { staff_id: absent, date }))) && (setAbsent(''), board.reload())}>{t('substitution.createSlots')}</Button>
                </>
              )}
            </div>
          </Card>
          <Card>
            <Table rows={rows} columns={[
              { key: 'period_seq', header: t('timetable.period') },
              { key: 'section_name', header: t('common.section') },
              { key: 'subject_name', header: t('common.subject') },
              { key: 'absent_name', header: t('substitution.absent') },
              { key: 'status', header: t('common.status'), render: (r) => <StatusBadge status={r.status} /> },
              { key: 'sub', header: t('substitution.substitute'), render: (r) => r.substitute_name ?? (r.resolution && r.resolution !== 'substitute' ? t(`resolution.${r.resolution}`) : '—') },
              { key: 'act', header: '', render: (r) => r.status === 'assigned' || r.status === 'resolved_other' || !can('substitution', 'edit') ? null : (
                <div className="flex flex-wrap items-center gap-1">
                  <Select aria-label={t('substitution.substitute')} value={pick[r.id] ?? r.ranked?.[0]?.staffId ?? ''} onChange={(e) => setPick({ ...pick, [r.id]: e.target.value })} options={(r.ranked ?? []).map((c: any) => ({ value: c.staffId, label: `${c.rank}. ${c.name}${c.sameSubjectAndWing ? ' ★' : ''} (${t('substitution.load', { today: c.periodsToday, week: c.subsThisWeek })})` }))} className="w-64" />
                  <Button size="sm" disabled={a.busy || !(pick[r.id] ?? r.ranked?.[0]?.staffId)} onClick={() => assign(r.id, 'substitute', pick[r.id] ?? r.ranked[0].staffId)}>{t('substitution.assign')}</Button>
                  {['combine', 'library', 'games', 'supervision'].map((x) => <Button key={x} size="sm" variant="ghost" onClick={() => assign(r.id, x)}>{t(`resolution.${x}`)}</Button>)}
                </div>
              ) },
            ]} />
            <ErrorBox error={a.error} />
          </Card>
        </>
      )}
      {tab === 'mine' && (
        <Card>
          <Table rows={mine.data} columns={[{ key: 'date', header: t('common.date'), render: (r) => <DateText value={r.date} /> }, { key: 'period_seq', header: t('timetable.period') }, { key: 'section_name', header: t('common.section') }, { key: 'subject_name', header: t('common.subject') }, { key: 'cover', header: t('substitution.cover'), render: (r) => (r.cover_plan_id ? <Badge tone="green">{t('substitution.coverReady')}</Badge> : r.cover_note ?? '—') }]} />
        </Card>
      )}
      {tab === 'reports' && reports.data && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card title={t('substitution.fairness')}><Table rows={reports.data.fairness} rowKey={(r) => r.id} columns={[{ key: 'full_name', header: t('common.person') }, { key: 'substitutions', header: t('substitution.count') }]} /></Card>
          <Card title={t('substitution.register')}><Table rows={reports.data.register} columns={[{ key: 'date', header: t('common.date') }, { key: 'period_seq', header: t('timetable.period') }, { key: 'section', header: t('common.section') }, { key: 'absent', header: t('substitution.absent') }, { key: 'substitute', header: t('substitution.substitute') }, { key: 'status', header: t('common.status'), render: (r) => <StatusBadge status={r.status} /> }]} /></Card>
        </div>
      )}
    </div>
  );
}
