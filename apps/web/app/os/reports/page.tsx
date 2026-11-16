'use client';
/** Dashboards by role, report catalogue, custom builder, plain-language questions, daily digest, weekly insight. */
import { useState } from 'react';
import Link from 'next/link';
import { useApp } from '@/lib/app';
import { get, post, useApi } from '@/lib/api';
import { AutoTable, cell } from '@/components/auto-table';
import { ValueView } from '@/components/value-editor';
import { Button, Card, ErrorBox, Field, Grid, Input, Modal, PageHeader, Select, Stat, Table, Tabs, useAction } from '@/components/ui';

export default function Reports() {
  const { t } = useApp();
  const [tab, setTab] = useState('dashboard');
  return (
    <div>
      <PageHeader title={t('nav.reports')} />
      <Tabs value={tab} onChange={setTab} tabs={['dashboard', 'catalogue', 'builder', 'ask', 'digest'].map((v) => ({ value: v, label: t(`reports.tab.${v}`) }))} />
      {tab === 'dashboard' && <Dashboard />}
      {tab === 'catalogue' && <Catalogue />}
      {tab === 'builder' && <Builder />}
      {tab === 'ask' && <Ask />}
      {tab === 'digest' && <Digest />}
    </div>
  );
}

function Dashboard() {
  const { t } = useApp();
  const d = useApi<{ sections: { key: string; metrics: { key: string; value: number; branch_id?: string }[]; extra?: any }[] }>('/dashboard');
  const [drill, setDrill] = useState<{ key: string; rows: any[] } | null>(null);
  const a = useAction();
  const open = async (key: string, branch?: string) => { const r = await a.run(() => get<{ key: string; rows: any[] }>(`/dashboard/drill/${key}${branch ? `?branch_id=${branch}` : ''}`)); if (r) setDrill(r); };
  return (
    <div className="space-y-4">
      {(d.data?.sections ?? []).map((s) => (
        <Card key={s.key} title={t(`dashboard.${s.key}`)}>
          {s.metrics.length > 0 && (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
              {s.metrics.map((m) => <button key={m.key} type="button" className="text-left" onClick={() => open(m.key)}><Stat label={t(`metric.${m.key}`)} value={m.value} tone={m.value > 0 && /uncovered|overdue|critical|unmarked|absent|expiring|risk|missing/.test(m.key) ? 'red' : undefined} /></button>)}
            </div>
          )}
          {s.extra?.comparison && (
            <>
              <h3 className="mb-2 mt-2 text-sm font-semibold">{t('dashboard.comparison')}</h3>
              <AutoTable rows={s.extra.comparison} />
              <h3 className="mb-2 mt-4 text-sm font-semibold">{t('dashboard.exceptions')}</h3>
              <Table rows={s.extra.exceptions} rowKey={(r) => `${r.branch_id}:${r.key}`} onRow={(r) => open(r.key, r.branch_id)} columns={[{ key: 'branch', header: t('common.branch'), render: (r) => s.extra.comparison.find((c: any) => c.branch_id === r.branch_id)?.branch }, { key: 'key', header: t('reports.metric'), render: (r) => t(`metric.${r.key}`) }, { key: 'value', header: t('reports.value') }]} />
            </>
          )}
        </Card>
      ))}
      <ErrorBox error={a.error} />
      <Modal open={!!drill} onClose={() => setDrill(null)} title={drill ? t(`metric.${drill.key}`) : ''} wide>
        <AutoTable rows={drill?.rows} />
      </Modal>
    </div>
  );
}

function Catalogue() {
  const { t } = useApp();
  const c = useApi<{ catalogue: string[] }>('/reports');
  return (
    <Card>
      <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {(c.data?.catalogue ?? []).map((k) => (
          <li key={k}><Link href={`/os/reports/${k}`} className="block rounded-md border border-slate-200 p-3 hover:bg-slate-50"><div className="font-medium">{t(`report.${k}`)}</div><div className="text-xs text-slate-500">{t(`report.${k}.desc`)}</div></Link></li>
        ))}
      </ul>
    </Card>
  );
}

function Builder() {
  const { t } = useApp();
  const meta = useApi<{ datasets: Record<string, string[]> }>('/reports');
  const saved = useApi<any[]>('/reports/saved');
  const a = useAction();
  const today = new Date().toISOString().slice(0, 10);
  const [cfg, setCfg] = useState({ dataset: '', columns: [] as string[], filters: [] as { column: string; op: string; value: string }[], group_by: '', chart: 'table' });
  const [range, setRange] = useState({ from: new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10), to: today });
  const [name, setName] = useState('');
  const [result, setResult] = useState<{ columns: { key: string }[]; rows: any[] } | null>(null);
  const cols = meta.data?.datasets[cfg.dataset] ?? [];
  const config = { columns: cfg.columns, filters: cfg.filters.filter((f) => f.column && f.value).map((f) => ({ ...f, value: f.op === 'in' ? f.value.split(',').map((x) => x.trim()) : f.value })), group_by: cfg.group_by || null, chart: cfg.chart };
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card title={t('reports.saved')}>
        <ul className="space-y-1 text-sm">{(saved.data ?? []).map((s) => <li key={s.id}><button type="button" className="text-brand-700 hover:underline" onClick={() => setCfg({ dataset: s.dataset, columns: s.config.columns, filters: (s.config.filters ?? []).map((f: any) => ({ ...f, value: Array.isArray(f.value) ? f.value.join(',') : String(f.value) })), group_by: s.config.group_by ?? '', chart: s.config.chart ?? 'table' })}>{s.name}</button> <span className="text-xs text-slate-500">{s.owner_name}</span></li>)}</ul>
      </Card>
      <Card className="lg:col-span-2" title={t('reports.tab.builder')}>
        <div className="space-y-3">
          <Grid cols={3}>
            <Field label={t('reports.dataset')}><Select value={cfg.dataset} onChange={(e) => setCfg({ ...cfg, dataset: e.target.value, columns: [], filters: [], group_by: '' })} placeholder={t('common.choose')} options={Object.keys(meta.data?.datasets ?? {}).map((k) => ({ value: k, label: t(`dataset.${k}`) }))} /></Field>
            <Field label={t('leave.from')}><Input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /></Field>
            <Field label={t('leave.to')}><Input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></Field>
          </Grid>
          {cfg.dataset && (
            <>
              <Field label={t('reports.columns')}>
                <div className="flex flex-wrap gap-2">{cols.map((c) => <label key={c} className="flex items-center gap-1 text-sm"><input type="checkbox" checked={cfg.columns.includes(c)} onChange={(e) => setCfg({ ...cfg, columns: e.target.checked ? [...cfg.columns, c] : cfg.columns.filter((x) => x !== c) })} />{t(`col.${c}`)}</label>)}</div>
              </Field>
              <Field label={t('reports.groupBy')}><Select value={cfg.group_by} onChange={(e) => setCfg({ ...cfg, group_by: e.target.value })} placeholder={t('reports.noGrouping')} options={cols.map((c) => ({ value: c, label: t(`col.${c}`) }))} /></Field>
              <p className="text-sm font-semibold">{t('reports.filters')}</p>
              {cfg.filters.map((f, i) => (
                <div key={i} className="grid grid-cols-3 gap-2">
                  <Select aria-label={t('reports.column')} value={f.column} onChange={(e) => setCfg({ ...cfg, filters: cfg.filters.map((y, j) => (j === i ? { ...y, column: e.target.value } : y)) })} placeholder={t('reports.column')} options={cols.map((c) => ({ value: c, label: t(`col.${c}`) }))} />
                  <Select aria-label={t('reports.operator')} value={f.op} onChange={(e) => setCfg({ ...cfg, filters: cfg.filters.map((y, j) => (j === i ? { ...y, op: e.target.value } : y)) })} options={['=', '!=', '>', '<', 'in'].map((o) => ({ value: o, label: o }))} />
                  <Input aria-label={t('reports.value')} value={f.value} onChange={(e) => setCfg({ ...cfg, filters: cfg.filters.map((y, j) => (j === i ? { ...y, value: e.target.value } : y)) })} />
                </div>
              ))}
              <Button size="sm" variant="secondary" onClick={() => setCfg({ ...cfg, filters: [...cfg.filters, { column: '', op: '=', value: '' }] })}>{t('reports.addFilter')}</Button>
              <div className="flex flex-wrap items-end gap-2">
                <Button disabled={!cfg.columns.length || a.busy} onClick={async () => setResult((await a.run(() => post('/reports/builder', { config: { dataset: cfg.dataset, ...config }, range }))) ?? null)}>{t('reports.run')}</Button>
                <Field label={t('reports.saveAs')}><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
                <Button variant="secondary" disabled={name.length < 2 || !cfg.columns.length} onClick={async () => (await a.run(() => post('/reports/saved', { name, dataset: cfg.dataset, config }))) && (setName(''), saved.reload())}>{t('common.save')}</Button>
              </div>
            </>
          )}
          <ErrorBox error={a.error} />
          {result && <AutoTable rows={result.rows} columns={result.columns} />}
        </div>
      </Card>
    </div>
  );
}

function Ask() {
  const { t } = useApp();
  const a = useAction();
  const [q, setQ] = useState('');
  const [r, setR] = useState<{ answered: boolean; function: string | null; rows: any[] } | null>(null);
  return (
    <Card>
      <div className="flex gap-2">
        <Input aria-label={t('reports.askPlaceholder')} placeholder={t('reports.askPlaceholder')} value={q} onChange={(e) => setQ(e.target.value)} />
        <Button disabled={q.length < 3 || a.busy} onClick={async () => setR((await a.run(() => post('/reports/ask', { question: q }))) ?? null)}>{t('reports.ask')}</Button>
      </div>
      <p className="mt-1 text-xs text-slate-500">{t('reports.askHint')}</p>
      <ErrorBox error={a.error} />
      {r && (r.answered ? <div className="mt-3"><p className="mb-2 text-sm font-medium">{t(`askFn.${r.function}`)}</p><AutoTable rows={r.rows} /></div> : <p className="mt-3 text-sm text-slate-600">{t('reports.cannotAnswer')}</p>)}
    </Card>
  );
}

function Digest() {
  const { t } = useApp();
  const d = useApi<{ date: string; metrics: Record<string, number> }>('/reports/digest');
  const ins = useApi<{ output: unknown; created_at: string } | null>('/reports/insight');
  return (
    <div className="space-y-4">
      <Card title={t('reports.digestFor', { date: d.data?.date ?? '' })}>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">{Object.entries(d.data?.metrics ?? {}).map(([k, v]) => <Stat key={k} label={t(`metric.${k}`)} value={cell(v)} />)}</div>
      </Card>
      <Card title={t('reports.weeklyInsight')}>{ins.data ? <div className="text-sm"><ValueView value={ins.data.output} /></div> : <p className="text-sm text-slate-500">{t('reports.noInsight')}</p>}</Card>
    </div>
  );
}
