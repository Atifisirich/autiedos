'use client';
/** Timetable: view by section/teacher/room, generate, edit with drag-and-drop + live clash check, publish. */
import { useEffect, useState } from 'react';
import { useApp } from '@/lib/app';
import { download, post, useApi } from '@/lib/api';
import { useLookups, opts } from '@/lib/lookups';
import { Badge, Button, Card, ErrorBox, Field, Input, Modal, PageHeader, Select, StatusBadge, Table, Tabs, cx, useAction } from '@/components/ui';

const DAYS = [1, 2, 3, 4, 5, 6];

export default function Timetable() {
  const { t, can } = useApp();
  const lk = useLookups();
  const [tab, setTab] = useState('grid');
  const versions = useApi<any[]>('/timetable/versions');
  const [version, setVersion] = useState('');
  const [by, setBy] = useState('section');
  const [id, setId] = useState('');
  useEffect(() => {
    if (!id && lk) setId(by === 'section' ? lk.sections[0]?.id ?? '' : by === 'teacher' ? lk.staff.find((s) => s.is_teaching)?.id ?? '' : lk.rooms[0]?.id ?? '');
  }, [lk, by, id]);
  const grid = useApi<any>(id ? `/timetable/grid?by=${by}&id=${id}${version ? `&version_id=${version}` : ''}` : null);
  const workload = useApi<any[]>(tab === 'workload' ? `/timetable/workload${version ? `?version_id=${version}` : ''}` : null);
  const [freeQ, setFreeQ] = useState({ date: new Date().toISOString().slice(0, 10), period_seq: '1' });
  const free = useApi<any[]>(tab === 'free' ? `/timetable/free-teachers?date=${freeQ.date}&period_seq=${freeQ.period_seq}` : null);
  const a = useAction();
  const [genName, setGenName] = useState('');
  const [publishOpen, setPublishOpen] = useState(false);
  const [effective, setEffective] = useState(new Date().toISOString().slice(0, 10));
  const [drag, setDrag] = useState<string | null>(null);
  const [clashes, setClashes] = useState<any[] | null>(null);
  const v = grid.data?.version;
  const editable = can('timetable', 'edit') && v && v.status === 'draft';
  const cell = (day: number, seq: number) => (grid.data?.entries ?? []).filter((e: any) => e.day === day && e.period_seq === seq);
  const drop = async (day: number, seq: number) => {
    if (!drag || !v) return;
    const check = await a.run(() => post<{ applied: boolean; clashes: any[] }>(`/timetable/versions/${v.id}/edit`, { op: 'move', entry_id: drag, day, period_seq: seq }));
    setDrag(null);
    if (check && !check.applied) setClashes(check.clashes.map((c) => ({ ...c, day, seq, entry: drag })));
    await grid.reload();
  };
  const choices = by === 'section' ? opts(lk?.sections, (s) => lk!.classes.find((c) => c.id === s.class_id)?.name + ' ' + s.name) : by === 'teacher' ? opts(lk?.staff.filter((s) => s.is_teaching), (s) => s.full_name) : opts(lk?.rooms, (r) => r.name);
  return (
    <div>
      <PageHeader title={t('nav.timetable')} actions={v && <Button variant="secondary" onClick={() => download(`/timetable/export?by=${by}&id=${id}&version_id=${v.id}`)}>{t('common.exportExcel')}</Button>} />
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'grid', label: t('timetable.grid') }, { value: 'versions', label: t('timetable.versions') }, { value: 'workload', label: t('timetable.workload') }, { value: 'free', label: t('timetable.freeTeachers') }]} />
      {tab === 'grid' && (
        <Card>
          <div className="mb-3 flex flex-wrap gap-2">
            <Select aria-label={t('timetable.version')} value={version} onChange={(e) => setVersion(e.target.value)} placeholder={t('timetable.current')} options={(versions.data ?? []).map((x) => ({ value: x.id, label: `${x.name} (${t(`status.${x.status}`)})` }))} className="w-60" />
            <Select aria-label={t('timetable.viewBy')} value={by} onChange={(e) => (setBy(e.target.value), setId(''))} options={['section', 'teacher', 'room'].map((x) => ({ value: x, label: t(`timetable.by.${x}`) }))} className="w-40" />
            <Select aria-label={t('common.choose')} value={id} onChange={(e) => setId(e.target.value)} options={choices} className="w-56" />
            {v && <StatusBadge status={v.status} />}
            {v?.unplaced > 0 && <Badge tone="amber">{t('timetable.unplaced', { n: v.unplaced })}</Badge>}
          </div>
          {editable && <p className="mb-2 text-xs text-slate-500">{t('timetable.dragHint')}</p>}
          <div className="overflow-x-auto">
            <table className="min-w-full border-collapse text-xs">
              <thead>
                <tr>
                  <th className="border border-slate-200 p-1">{t('timetable.period')}</th>
                  {DAYS.map((d) => <th key={d} className="border border-slate-200 p-1">{t(`day.${d}`)}</th>)}
                </tr>
              </thead>
              <tbody>
                {(grid.data?.periods ?? []).map((p: any) => (
                  <tr key={p.teaching_index}>
                    <td className="border border-slate-200 p-1 whitespace-nowrap">{p.label}<div className="text-[10px] text-slate-500">{p.starts_at?.slice(0, 5)}–{p.ends_at?.slice(0, 5)}</div></td>
                    {DAYS.map((d) => (
                      <td key={d} onDragOver={(e) => editable && e.preventDefault()} onDrop={() => drop(d, p.teaching_index)} className={cx('min-w-[110px] border border-slate-200 p-1 align-top', drag && 'bg-brand-50')}>
                        {cell(d, p.teaching_index).map((e: any) => (
                          <div key={e.id} draggable={!!editable && !e.locked} onDragStart={() => setDrag(e.id)} className={cx('mb-1 rounded bg-slate-100 p-1', e.locked && 'ring-1 ring-amber-400', editable && !e.locked && 'cursor-move')}>
                            <div className="font-medium">{e.fixed_label ?? e.subject_name}</div>
                            <div className="text-slate-600">{by === 'section' ? e.staff_name : e.section_name}{e.room_name && ` · ${e.room_name}`}</div>
                            {editable && (
                              <button className="text-[10px] text-brand-700" onClick={async () => (await a.run(() => post(`/timetable/versions/${v.id}/edit`, { op: e.locked ? 'unlock' : 'lock', entry_id: e.id }))) && grid.reload()}>
                                {e.locked ? t('timetable.unlock') : t('timetable.lock')}
                              </button>
                            )}
                          </div>
                        ))}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!grid.data?.version && grid.data && <p className="text-sm text-slate-500">{t('timetable.noVersion')}</p>}
          <ErrorBox error={a.error} />
        </Card>
      )}
      {tab === 'versions' && (
        <Card>
          {can('timetable', 'create') && (
            <div className="mb-4 flex flex-wrap items-end gap-2">
              <Field label={t('timetable.newName')}><Input value={genName} onChange={(e) => setGenName(e.target.value)} /></Field>
              <Button disabled={!genName || a.busy} onClick={async () => (await a.run(() => post('/timetable/generate', { name: genName, keep_locked_from_version_id: version || null }))) && (setGenName(''), setTimeout(() => versions.reload(), 1500))}>{t('timetable.generate')}</Button>
              <p className="text-xs text-slate-500">{t('timetable.generateHint')}</p>
            </div>
          )}
          <Table rows={versions.data} columns={[
            { key: 'name', header: t('common.name') },
            { key: 'status', header: t('common.status'), render: (r) => <StatusBadge status={r.status} /> },
            { key: 'unplaced', header: t('timetable.unplacedCol') },
            { key: 'effective_from', header: t('timetable.effectiveFrom') },
            { key: 'actions', header: '', render: (r) => (
              <div className="flex gap-1">
                <Button size="sm" variant="ghost" onClick={() => (setVersion(r.id), setTab('grid'))}>{t('common.open')}</Button>
                {can('timetable', 'edit') && r.status !== 'draft' && <Button size="sm" variant="secondary" onClick={async () => { const x = await a.run(() => post<{ version_id: string }>(`/timetable/versions/${r.id}/revision`, { name: `${r.name} (${t('timetable.revision')})` })); if (x) (versions.reload(), setVersion(x.version_id)); }}>{t('timetable.revise')}</Button>}
                {can('timetable', 'approve') && r.status === 'draft' && <Button size="sm" onClick={() => (setVersion(r.id), setPublishOpen(true))}>{t('timetable.publish')}</Button>}
              </div>
            ) },
          ]} />
          <ErrorBox error={a.error} />
        </Card>
      )}
      {tab === 'workload' && (
        <Card>
          <Table rows={workload.data} columns={[{ key: 'full_name', header: t('common.person') }, { key: 'periods_week', header: t('timetable.periodsWeek'), render: (r) => <span className={r.periods_week > r.max_periods_week ? 'font-semibold text-red-700' : ''}>{r.periods_week} / {r.max_periods_week}</span> }, { key: 'max_day', header: t('timetable.maxDay') }, ...DAYS.map((d) => ({ key: `d${d}`, header: t(`day.${d}`), render: (r: any) => r.by_day?.[d] ?? 0 }))]} />
        </Card>
      )}
      {tab === 'free' && (
        <Card>
          <div className="mb-3 flex gap-2">
            <Input type="date" aria-label={t('common.date')} value={freeQ.date} onChange={(e) => setFreeQ({ ...freeQ, date: e.target.value })} className="w-44" />
            <Select aria-label={t('timetable.period')} value={freeQ.period_seq} onChange={(e) => setFreeQ({ ...freeQ, period_seq: e.target.value })} options={(grid.data?.periods ?? [{ teaching_index: 1, label: '1' }]).map((p: any) => ({ value: String(p.teaching_index), label: p.label }))} className="w-40" />
          </div>
          <Table rows={free.data} columns={[{ key: 'full_name', header: t('common.person') }, { key: 'department', header: t('common.department') }, { key: 'periods_today', header: t('timetable.periodsToday') }]} />
        </Card>
      )}
      <Modal open={publishOpen} onClose={() => setPublishOpen(false)} title={t('timetable.publish')}>
        <Field label={t('timetable.effectiveFrom')}><Input type="date" value={effective} onChange={(e) => setEffective(e.target.value)} /></Field>
        <p className="mb-3 text-xs text-slate-500">{t('timetable.publishHint')}</p>
        <ErrorBox error={a.error} />
        <Button disabled={a.busy} onClick={async () => (await a.run(() => post(`/timetable/versions/${version}/publish`, { effective_from: effective }))) && (setPublishOpen(false), versions.reload(), grid.reload())}>{t('timetable.publish')}</Button>
      </Modal>
      <Modal open={!!clashes} onClose={() => setClashes(null)} title={t('timetable.clashes')}>
        <ul className="mb-3 list-disc pl-5 text-sm">{(clashes ?? []).map((c, i) => <li key={i}>{t(`clash.${c.type}`)}</li>)}</ul>
        <div className="flex gap-2">
          <Button variant="danger" onClick={async () => { const c = clashes![0]; setClashes(null); if (await a.run(() => post(`/timetable/versions/${v.id}/edit`, { op: 'move', entry_id: c.entry, day: c.day, period_seq: c.seq, force: true }))) await grid.reload(); }}>{t('timetable.moveAnyway')}</Button>
          <Button variant="secondary" onClick={() => setClashes(null)}>{t('common.cancel')}</Button>
        </div>
      </Modal>
    </div>
  );
}
