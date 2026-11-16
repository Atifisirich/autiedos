'use client';
/** Modules per branch, branding, branch settings, new branch, year rollover, assignment rules, delegations. */
import { useState } from 'react';
import { useApp } from '@/lib/app';
import { post, uploadFile, useApi } from '@/lib/api';
import { useLookups, opts } from '@/lib/lookups';
import { Button, Card, DateText, ErrorBox, Field, Grid, Input, PageHeader, Select, Table, Tabs, useAction } from '@/components/ui';

export default function Modules() {
  const { t, me, reload } = useApp();
  const lk = useLookups();
  const [tab, setTab] = useState('modules');
  const flags = useApi<{ module_key: string; branches: Record<string, boolean> }[]>(tab === 'modules' ? '/modules' : null);
  const rules = useApi<any[]>(tab === 'rules' ? '/assignment-rules' : null);
  const dels = useApi<any[]>(tab === 'delegations' ? '/delegations' : null);
  const a = useAction();
  const [brand, setBrand] = useState({ primary: me?.org.branding.primary ?? '#1d4ed8', accent: me?.org.branding.accent ?? '#f59e0b' });
  const [logo, setLogo] = useState<File | null>(null);
  const [br, setBr] = useState({ name: '', code: '', preset_key: 'cbse' });
  const [roll, setRoll] = useState({ name: '', starts_on: '', ends_on: '' });
  const [rule, setRule] = useState({ from_role_id: '', to_role_id: '', rule: 'assign' });
  const [del, setDel] = useState({ staff_id: '', delegate_id: '', starts_on: '', ends_on: '', reason: '' });
  return (
    <div>
      <PageHeader title={t('setup.modulesBranches')} />
      <Tabs value={tab} onChange={setTab} tabs={['modules', 'branding', 'branches', 'rules', 'delegations'].map((v) => ({ value: v, label: t(`setup.tab.${v}`) }))} />
      {tab === 'modules' && (
        <Card>
          <p className="mb-2 text-xs text-slate-500">{t('setup.modulesNote')}</p>
          <Table rows={flags.data} rowKey={(r) => r.module_key} columns={[{ key: 'module_key', header: t('setup.module'), render: (r) => t(`module.${r.module_key}`) }, ...(me?.branches ?? []).map((b) => ({ key: b.id, header: b.name, render: (r: any) => <input type="checkbox" aria-label={`${t(`module.${r.module_key}`)} ${b.name}`} checked={r.branches[b.id] ?? true} onChange={async (e) => (await a.run(() => post('/modules', { branch_id: b.id, module_key: r.module_key, enabled: e.target.checked }))) && (flags.reload(), reload())} /> }))]} />
          <ErrorBox error={a.error} />
        </Card>
      )}
      {tab === 'branding' && (
        <Card>
          <Grid cols={3}>
            <Field label={t('setup.primaryColour')}><Input type="color" value={brand.primary} onChange={(e) => setBrand({ ...brand, primary: e.target.value })} /></Field>
            <Field label={t('setup.accentColour')}><Input type="color" value={brand.accent} onChange={(e) => setBrand({ ...brand, accent: e.target.value })} /></Field>
            <Field label={t('setup.logo')}><input type="file" accept="image/*" onChange={(e) => setLogo(e.target.files?.[0] ?? null)} /></Field>
          </Grid>
          <p className="mb-2 text-xs text-slate-500">{t('setup.brandingHint')}</p>
          <ErrorBox error={a.error} />
          <Button disabled={a.busy} onClick={async () => (await a.run(async () => post('/branding', { branding: brand, ...(logo ? { logo_url: await uploadFile(logo, 'document') } : {}) }))) && reload()}>{t('common.save')}</Button>
        </Card>
      )}
      {tab === 'branches' && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card title={t('setup.addBranch')}>
            <Grid cols={3}>
              <Field label={t('common.name')}><Input value={br.name} onChange={(e) => setBr({ ...br, name: e.target.value })} /></Field>
              <Field label={t('setup.branchCode')}><Input value={br.code} onChange={(e) => setBr({ ...br, code: e.target.value })} /></Field>
              <Field label={t('setup.preset')}><Select value={br.preset_key} onChange={(e) => setBr({ ...br, preset_key: e.target.value })} options={['cbse', 'cambridge', 'dual'].map((p) => ({ value: p, label: t(`preset.${p}`) }))} /></Field>
            </Grid>
            <Button disabled={br.name.length < 2 || !br.code || a.busy} onClick={async () => (await a.run(() => post('/branches', br))) && (setBr({ name: '', code: '', preset_key: 'cbse' }), reload())}>{t('setup.addBranch')}</Button>
          </Card>
          <Card title={t('setup.yearRollover')}>
            <p className="mb-2 text-xs text-slate-500">{t('setup.rolloverHint')}</p>
            <Grid cols={3}>
              <Field label={t('common.name')}><Input value={roll.name} onChange={(e) => setRoll({ ...roll, name: e.target.value })} /></Field>
              <Field label={t('leave.from')}><Input type="date" value={roll.starts_on} onChange={(e) => setRoll({ ...roll, starts_on: e.target.value })} /></Field>
              <Field label={t('leave.to')}><Input type="date" value={roll.ends_on} onChange={(e) => setRoll({ ...roll, ends_on: e.target.value })} /></Field>
            </Grid>
            <Button disabled={!roll.name || !roll.starts_on || !roll.ends_on || a.busy} onClick={async () => window.confirm(t('setup.rolloverConfirm')) && (await a.run(() => post('/year-rollover', roll))) && reload()}>{t('setup.rollover')}</Button>
          </Card>
          <ErrorBox error={a.error} />
        </div>
      )}
      {tab === 'rules' && (
        <Card>
          <p className="mb-2 text-xs text-slate-500">{t('setup.rulesHint')}</p>
          <div className="mb-3 flex flex-wrap items-end gap-2">
            <Field label={t('setup.fromRole')}><Select value={rule.from_role_id} onChange={(e) => setRule({ ...rule, from_role_id: e.target.value })} placeholder={t('common.choose')} options={opts(lk?.roles, (r) => r.name)} /></Field>
            <Field label={t('setup.toRole')}><Select value={rule.to_role_id} onChange={(e) => setRule({ ...rule, to_role_id: e.target.value })} placeholder={t('common.choose')} options={opts(lk?.roles, (r) => r.name)} /></Field>
            <Field label={t('setup.rule')}><Select value={rule.rule} onChange={(e) => setRule({ ...rule, rule: e.target.value })} options={['assign', 'request', 'none', 'default'].map((x) => ({ value: x, label: t(`assignRule.${x}`) }))} /></Field>
            <Button disabled={!rule.from_role_id || !rule.to_role_id || a.busy} onClick={async () => (await a.run(() => post('/assignment-rules', { ...rule, rule: rule.rule === 'default' ? null : rule.rule }))) && rules.reload()}>{t('common.save')}</Button>
          </div>
          <Table rows={rules.data} columns={[{ key: 'from_name', header: t('setup.fromRole') }, { key: 'to_name', header: t('setup.toRole') }, { key: 'rule', header: t('setup.rule'), render: (r) => t(`assignRule.${r.rule}`) }]} />
          <ErrorBox error={a.error} />
        </Card>
      )}
      {tab === 'delegations' && (
        <Card>
          <p className="mb-2 text-xs text-slate-500">{t('setup.delegationHint')}</p>
          <Grid cols={4}>
            <Field label={t('common.person')}><Select value={del.staff_id} onChange={(e) => setDel({ ...del, staff_id: e.target.value })} placeholder={t('common.choose')} options={opts(lk?.staff, (s) => s.full_name)} /></Field>
            <Field label={t('setup.delegate')}><Select value={del.delegate_id} onChange={(e) => setDel({ ...del, delegate_id: e.target.value })} placeholder={t('common.choose')} options={opts(lk?.staff, (s) => s.full_name)} /></Field>
            <Field label={t('leave.from')}><Input type="date" value={del.starts_on} onChange={(e) => setDel({ ...del, starts_on: e.target.value })} /></Field>
            <Field label={t('leave.to')}><Input type="date" value={del.ends_on} onChange={(e) => setDel({ ...del, ends_on: e.target.value })} /></Field>
          </Grid>
          <Field label={t('tasks.reason')}><Input value={del.reason} onChange={(e) => setDel({ ...del, reason: e.target.value })} /></Field>
          <Button disabled={!del.staff_id || !del.delegate_id || !del.starts_on || !del.ends_on || a.busy} onClick={async () => (await a.run(() => post('/delegations', { ...del, reason: del.reason || undefined }))) && dels.reload()}>{t('common.save')}</Button>
          <Table rows={dels.data} columns={[{ key: 'staff_name', header: t('common.person') }, { key: 'delegate_name', header: t('setup.delegate') }, { key: 'starts_on', header: t('leave.from'), render: (r) => <DateText value={r.starts_on} /> }, { key: 'ends_on', header: t('leave.to'), render: (r) => <DateText value={r.ends_on} /> }]} />
          <ErrorBox error={a.error} />
        </Card>
      )}
    </div>
  );
}
