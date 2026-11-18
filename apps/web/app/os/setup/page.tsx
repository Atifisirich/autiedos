'use client';
/** Setup wizard (PRD 5.1): profile → year & bells → structure → subjects → staff → org chart → roles → modules. */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useApp } from '@/lib/app';
import { post, useApi } from '@/lib/api';
import { ImportSheet } from '@/components/import-sheet';
import { Badge, Button, Card, ErrorBox, Field, Grid, Input, LinkButton, PageHeader, Select, cx, useAction } from '@/components/ui';

const PRESETS = ['cbse', 'cambridge', 'dual'] as const;

export default function Setup() {
  const { t, reload } = useApp();
  const w = useApi<any>('/setup');
  const a = useAction();
  const [step, setStep] = useState(0);
  useEffect(() => { if (w.data) setStep(Math.min(w.data.org.setup_step ?? 0, 7)); }, [w.data]);
  if (!w.data) return <ErrorBox error={w.error} />;
  const steps: string[] = w.data.steps;
  const go = async (n: number) => { setStep(n); await post('/setup/step', { step: Math.max(n, w.data.org.setup_step ?? 0) }).catch(() => undefined); };
  const c = w.data.counts;
  return (
    <div>
      <PageHeader title={t('nav.setup')} subtitle={w.data.org.setup_completed_at ? t('setup.complete') : t('setup.progress', { n: step + 1, total: steps.length })} actions={<><LinkButton variant="secondary" href="/os/setup/config">{t('setup.configuration')}</LinkButton><LinkButton variant="secondary" href="/os/setup/modules">{t('setup.modulesBranches')}</LinkButton></>} />
      <ol className="mb-4 flex flex-wrap gap-2">
        {steps.map((s, i) => <li key={s}><button type="button" onClick={() => go(i)} className={cx('rounded-full border px-3 py-1 text-xs', i === step ? 'border-brand-600 bg-brand-50 text-brand-700' : 'border-slate-200')}>{i + 1}. {t(`setup.step.${s}`)}</button></li>)}
      </ol>
      <Card title={t(`setup.step.${steps[step]}`)}>
        {steps[step] === 'profile' && <Profile w={w.data} onSaved={() => (w.reload(), reload(), go(1))} />}
        {steps[step] === 'year' && <Year onSaved={() => (w.reload(), go(2))} />}
        {steps[step] === 'structure' && <Structure counts={c} onSaved={() => w.reload()} />}
        {steps[step] === 'subjects' && <><p className="mb-2 text-sm">{t('setup.subjectsCount', { n: c.subjects })}</p><ImportSheet kind="subjects" onDone={w.reload} /><p className="mt-3 text-sm"><Link className="text-brand-700" href="/os/setup/config/subjects">{t('setup.editSubjects')}</Link> · <Link className="text-brand-700" href="/os/setup/config/class_subjects">{t('setup.editClassSubjects')}</Link></p></>}
        {steps[step] === 'staff' && <><p className="mb-2 text-sm">{t('setup.staffCount', { n: c.staff })}</p><ImportSheet kind="staff" onDone={w.reload} /><p className="mt-3 text-sm"><Link className="text-brand-700" href="/os/setup/staff">{t('setup.manageStaff')}</Link></p></>}
        {steps[step] === 'org_chart' && <><p className="mb-2 text-sm">{t('setup.reportingCount', { n: c.reporting, total: c.staff })}</p><ImportSheet kind="org_chart" onDone={w.reload} /><p className="mt-3 text-sm"><Link className="text-brand-700" href="/os/setup/org-chart">{t('setup.openOrgChart')}</Link></p></>}
        {steps[step] === 'roles' && <p className="text-sm">{t('setup.rolesHint')} <Link className="text-brand-700" href="/os/setup/roles">{t('setup.openRoles')}</Link></p>}
        {steps[step] === 'modules' && <p className="text-sm">{t('setup.modulesHint')} <Link className="text-brand-700" href="/os/setup/modules">{t('setup.modulesBranches')}</Link></p>}
        <div className="mt-4 flex gap-2">
          {step > 0 && <Button variant="ghost" onClick={() => go(step - 1)}>{t('common.back')}</Button>}
          {step < steps.length - 1 ? <Button variant="secondary" onClick={() => go(step + 1)}>{t('common.next')}</Button> : <Button disabled={a.busy} onClick={async () => (await a.run(() => post('/setup/step', { step: 8 }))) && (w.reload(), reload())}>{t('setup.finish')}</Button>}
        </div>
        <ErrorBox error={a.error} />
      </Card>
      <div className="mt-4 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">{Object.entries(c).map(([k, v]) => <Badge key={k}>{t(`setup.count.${k}`)}: {String(v)}</Badge>)}</div>
    </div>
  );
}

function Profile({ w, onSaved }: { w: any; onSaved: () => void }) {
  const { t } = useApp();
  const a = useAction();
  const [f, setF] = useState({ name: w.org.name, preset_key: w.org.preset_key ?? 'cbse', bname: w.branch.name, code: w.branch.code, address: w.branch.address ?? '', latitude: w.branch.latitude ?? '', longitude: w.branch.longitude ?? '', radius: w.branch.geofence_radius_m ?? 200 });
  return (
    <div className="space-y-3">
      <Grid cols={2}>
        <Field label={t('setup.schoolName')}><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label={t('setup.preset')}><Select value={f.preset_key} onChange={(e) => setF({ ...f, preset_key: e.target.value })} options={PRESETS.map((p) => ({ value: p, label: t(`preset.${p}`) }))} /></Field>
        <Field label={t('setup.branchName')}><Input value={f.bname} onChange={(e) => setF({ ...f, bname: e.target.value })} /></Field>
        <Field label={t('setup.branchCode')}><Input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} /></Field>
      </Grid>
      <Field label={t('setup.address')}><Input value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} /></Field>
      <Grid cols={3}>
        <Field label={t('setup.latitude')}><Input type="number" step="any" value={f.latitude} onChange={(e) => setF({ ...f, latitude: e.target.value })} /></Field>
        <Field label={t('setup.longitude')}><Input type="number" step="any" value={f.longitude} onChange={(e) => setF({ ...f, longitude: e.target.value })} /></Field>
        <Field label={t('setup.radius')}><Input type="number" value={f.radius} onChange={(e) => setF({ ...f, radius: Number(e.target.value) })} /></Field>
      </Grid>
      <p className="text-xs text-slate-500">{t('setup.presetHint')}</p>
      <ErrorBox error={a.error} />
      <Button disabled={a.busy} onClick={async () => (await a.run(() => post('/setup/profile', { name: f.name, preset_key: f.preset_key, branch: { name: f.bname, code: f.code, address: f.address || undefined, latitude: f.latitude === '' ? null : Number(f.latitude), longitude: f.longitude === '' ? null : Number(f.longitude), geofence_radius_m: f.radius } }))) && onSaved()}>{t('common.saveContinue')}</Button>
    </div>
  );
}

function Year({ onSaved }: { onSaved: () => void }) {
  const { t } = useApp();
  const a = useAction();
  const y = new Date().getFullYear();
  const [f, setF] = useState({ name: `${y}-${String(y + 1).slice(2)}`, starts_on: `${y}-06-01`, ends_on: `${y + 1}-03-31`, working_days: [1, 2, 3, 4, 5, 6], terms: [{ name: 'Term 1', starts_on: `${y}-06-01`, ends_on: `${y}-09-30` }, { name: 'Term 2', starts_on: `${y}-10-01`, ends_on: `${y + 1}-03-31` }] });
  const [periods, setPeriods] = useState(() => {
    const out: { label: string; kind: string; starts_at: string; ends_at: string }[] = [{ label: 'Assembly', kind: 'assembly', starts_at: '08:30', ends_at: '08:50' }];
    let m = 8 * 60 + 50;
    for (let i = 1; i <= 8; i++) {
      const hh = (x: number) => `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`;
      out.push({ label: `P${i}`, kind: 'period', starts_at: hh(m), ends_at: hh(m + 40) });
      m += 40;
      if (i === 4) (out.push({ label: 'Lunch', kind: 'break', starts_at: hh(m), ends_at: hh(m + 30) }), (m += 30));
    }
    return out;
  });
  const setP = (i: number, patch: Partial<(typeof periods)[number]>) => setPeriods(periods.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  return (
    <div className="space-y-3">
      <Grid cols={3}>
        <Field label={t('common.name')}><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label={t('leave.from')}><Input type="date" value={f.starts_on} onChange={(e) => setF({ ...f, starts_on: e.target.value })} /></Field>
        <Field label={t('leave.to')}><Input type="date" value={f.ends_on} onChange={(e) => setF({ ...f, ends_on: e.target.value })} /></Field>
      </Grid>
      <Field label={t('setup.workingDays')}>
        <div className="flex flex-wrap gap-3">{[1, 2, 3, 4, 5, 6, 7].map((d) => <label key={d} className="flex items-center gap-1 text-sm"><input type="checkbox" checked={f.working_days.includes(d)} onChange={(e) => setF({ ...f, working_days: e.target.checked ? [...f.working_days, d].sort() : f.working_days.filter((x) => x !== d) })} />{t(`day.${d}`)}</label>)}</div>
      </Field>
      <p className="text-sm font-semibold">{t('setup.terms')}</p>
      {f.terms.map((tm, i) => (
        <div key={i} className="grid grid-cols-3 gap-2">
          <Input aria-label={t('common.name')} value={tm.name} onChange={(e) => setF({ ...f, terms: f.terms.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} />
          <Input aria-label={t('leave.from')} type="date" value={tm.starts_on} onChange={(e) => setF({ ...f, terms: f.terms.map((x, j) => (j === i ? { ...x, starts_on: e.target.value } : x)) })} />
          <Input aria-label={t('leave.to')} type="date" value={tm.ends_on} onChange={(e) => setF({ ...f, terms: f.terms.map((x, j) => (j === i ? { ...x, ends_on: e.target.value } : x)) })} />
        </div>
      ))}
      <p className="text-sm font-semibold">{t('setup.bellSchedule')}</p>
      {periods.map((p, i) => (
        <div key={i} className="grid grid-cols-5 gap-2">
          <Input aria-label={t('common.name')} value={p.label} onChange={(e) => setP(i, { label: e.target.value })} />
          <Select aria-label={t('common.type')} value={p.kind} onChange={(e) => setP(i, { kind: e.target.value })} options={['period', 'break', 'assembly'].map((k) => ({ value: k, label: t(`periodKind.${k}`) }))} />
          <Input aria-label={t('exams.start')} type="time" value={p.starts_at} onChange={(e) => setP(i, { starts_at: e.target.value })} />
          <Input aria-label={t('exams.end')} type="time" value={p.ends_at} onChange={(e) => setP(i, { ends_at: e.target.value })} />
          <Button size="sm" variant="ghost" onClick={() => setPeriods(periods.filter((_, j) => j !== i))}>{t('common.remove')}</Button>
        </div>
      ))}
      <Button size="sm" variant="secondary" onClick={() => setPeriods([...periods, { label: `P${periods.filter((p) => p.kind === 'period').length + 1}`, kind: 'period', starts_at: periods.at(-1)?.ends_at ?? '09:00', ends_at: periods.at(-1)?.ends_at ?? '09:40' }])}>{t('common.add')}</Button>
      <ErrorBox error={a.error} />
      <Button disabled={a.busy} onClick={async () => (await a.run(() => post('/setup/year', { ...f, bell: [{ wing_id: null, name: t('setup.defaultBell'), periods }] }))) && onSaved()}>{t('common.saveContinue')}</Button>
    </div>
  );
}

function Structure({ counts, onSaved }: { counts: any; onSaved: () => void }) {
  const { t } = useApp();
  const a = useAction();
  const [preset, setPreset] = useState('cbse');
  const [n, setN] = useState(2);
  return (
    <div className="space-y-4 text-sm">
      <p>{t('setup.structureCount', { wings: counts.wings, sections: counts.sections })}</p>
      <div className="flex flex-wrap items-end gap-2">
        <Field label={t('setup.preset')}><Select value={preset} onChange={(e) => setPreset(e.target.value)} options={PRESETS.map((p) => ({ value: p, label: t(`preset.${p}`) }))} /></Field>
        <Field label={t('setup.sectionsPerClass')}><Input type="number" min={1} max={10} value={n} onChange={(e) => setN(Number(e.target.value))} /></Field>
        <Button disabled={a.busy} onClick={async () => (await a.run(() => post('/setup/structure-preset', { preset_key: preset, sections_per_class: n }))) && onSaved()}>{t('setup.applyPreset')}</Button>
      </div>
      <p className="text-slate-500">{t('setup.orImport')}</p>
      <ImportSheet kind="wings_classes_sections" onDone={onSaved} />
      <p><Link className="text-brand-700" href="/os/setup/config/wings">{t('config.wings')}</Link> · <Link className="text-brand-700" href="/os/setup/config/classes">{t('config.classes')}</Link> · <Link className="text-brand-700" href="/os/setup/config/sections">{t('config.sections')}</Link> · <Link className="text-brand-700" href="/os/setup/config/rooms">{t('config.rooms')}</Link></p>
      <p className="font-semibold">{t('setup.students')}</p>
      <ImportSheet kind="students" onDone={onSaved} />
      <p className="font-semibold">{t('setup.allocations')}</p>
      <ImportSheet kind="allocations" onDone={onSaved} />
      <ErrorBox error={a.error} />
    </div>
  );
}
