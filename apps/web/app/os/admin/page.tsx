'use client';
/** Platform (AutoEd) console: schools, credits, WhatsApp usage, top-ups, support, bot quality, plans, costs, curriculum, view-as. */
import { useState } from 'react';
import { useApp } from '@/lib/app';
import { post, setViewAs, useApi } from '@/lib/api';
import { AutoTable } from '@/components/auto-table';
import { Button, Card, ErrorBox, Field, Grid, Input, Modal, PageHeader, Select, Table, Tabs, useAction } from '@/components/ui';

export default function Admin() {
  const { t, me } = useApp();
  const o = useApi<any>(me?.is_super_admin ? '/admin/overview' : null);
  const a = useAction();
  const [tab, setTab] = useState('schools');
  const [org, setOrg] = useState({ plan_key: '', name: '', slug: '', preset_key: 'cbse', branch_name: '', branch_code: '', admin_name: '', admin_email: '' });
  const [topup, setTopup] = useState({ branch_id: '', credits: '500', note: '' });
  const [view, setView] = useState<{ org_id: string; reason: string; minutes: number } | null>(null);
  if (!me?.is_super_admin) return <ErrorBox error={{ code: 'forbidden' }} />;
  const d = o.data;
  return (
    <div>
      <PageHeader title={t('admin.title')} subtitle={d && t('admin.period', { period: d.period })} />
      <Tabs value={tab} onChange={setTab} tabs={['schools', 'credits', 'support', 'bot', 'pricing', 'content'].map((v) => ({ value: v, label: t(`admin.tab.${v}`) }))} />
      {d && tab === 'schools' && (
        <div className="space-y-4">
          <Card title={t('admin.schools')}>
            <Table rows={d.orgs} columns={[{ key: 'name', header: t('common.name') }, { key: 'slug', header: t('admin.slug') }, { key: 'branches', header: t('admin.branches') }, { key: 'staff', header: t('admin.activeStaff'), render: (r) => r.staff ?? r.active_staff }, { key: 'setup_step', header: t('admin.setupStep') }, { key: 'act', header: '', render: (r) => <Button size="sm" variant="secondary" onClick={() => setView({ org_id: r.id, reason: '', minutes: 30 })}>{t('admin.viewAs')}</Button> }]} />
          </Card>
          <Card title={t('admin.newSchool')}>
            <Grid cols={3}>
              {(['name', 'slug', 'branch_name', 'branch_code', 'admin_name', 'admin_email'] as const).map((k) => <Field key={k} label={t(`admin.field.${k}`)}><Input value={org[k]} onChange={(e) => setOrg({ ...org, [k]: k === 'slug' ? e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-') : e.target.value })} /></Field>)}
              <Field label={t('setup.preset')}><Select value={org.preset_key} onChange={(e) => setOrg({ ...org, preset_key: e.target.value })} options={['cbse', 'cambridge', 'dual'].map((p) => ({ value: p, label: t(`preset.${p}`) }))} /></Field>
              <Field label={t('admin.plan')}><Select value={org.plan_key} onChange={(e) => setOrg({ ...org, plan_key: e.target.value })} placeholder={t('common.choose')} options={d.plans.map((p: any) => ({ value: p.key, label: p.name }))} /></Field>
            </Grid>
            <Button disabled={a.busy || org.name.length < 2 || !org.slug || !org.admin_email || !org.plan_key} onClick={async () => (await a.run(() => post('/admin/orgs', org))) && o.reload()}>{t('admin.create')}</Button>
          </Card>
          <Card title={t('admin.viewAsLog')}><AutoTable rows={d.view_as} /></Card>
        </div>
      )}
      {d && tab === 'credits' && (
        <div className="space-y-4">
          <Card title={t('admin.credits')}><AutoTable rows={d.credits} /></Card>
          <Card title={t('admin.topups')}>
            <Table rows={d.topups} columns={[{ key: 'org', header: t('admin.school') }, { key: 'branch', header: t('common.branch') }, { key: 'credits', header: t('ai.credits') }, { key: 'note', header: t('common.notes') }, { key: 'act', header: '', render: (r) => <Button size="sm" onClick={async () => (await a.run(() => post('/admin/topup', { branch_id: r.branch_id, credits: Number(r.credits), request_id: r.id }))) && o.reload()}>{t('admin.grant')}</Button> }]} />
            <div className="mt-3 flex flex-wrap items-end gap-2">
              <Field label={t('common.branch')}><Select value={topup.branch_id} onChange={(e) => setTopup({ ...topup, branch_id: e.target.value })} placeholder={t('common.choose')} options={d.credits.map((c: any) => ({ value: c.branch_id, label: `${c.org} · ${c.branch}` }))} /></Field>
              <Field label={t('ai.credits')}><Input type="number" value={topup.credits} onChange={(e) => setTopup({ ...topup, credits: e.target.value })} /></Field>
              <Field label={t('common.notes')}><Input value={topup.note} onChange={(e) => setTopup({ ...topup, note: e.target.value })} /></Field>
              <Button disabled={!topup.branch_id || a.busy} onClick={async () => (await a.run(() => post('/admin/topup', { branch_id: topup.branch_id, credits: Number(topup.credits), note: topup.note || undefined }))) && o.reload()}>{t('admin.grant')}</Button>
            </div>
          </Card>
          <Card title={t('admin.whatsapp')}><AutoTable rows={d.whatsapp} /></Card>
        </div>
      )}
      {d && tab === 'support' && (
        <Card title={t('admin.support')}>
          <Table rows={d.support} columns={[{ key: 'org', header: t('admin.school') }, { key: 'full_name', header: t('common.person') }, { key: 'subject', header: t('common.title'), render: (r) => r.subject ?? r.title ?? '' }, { key: 'status', header: t('common.status') }, { key: 'act', header: '', render: (r) => <Button size="sm" variant="secondary" onClick={async () => (await a.run(() => post(`/admin/support/${r.id}/close`))) && o.reload()}>{t('helpdesk.close')}</Button> }]} />
        </Card>
      )}
      {d && tab === 'bot' && (
        <div className="space-y-4">
          <Card title={t('admin.unanswered')}><Table rows={d.unanswered} columns={[{ key: 'org', header: t('admin.school') }, { key: 'language', header: t('settings.language') }, { key: 'question', header: t('admin.question'), render: (r) => r.messages?.find((m: any) => m.role === 'user')?.text ?? '' }, { key: 'status', header: t('common.status') }]} /></Card>
          <Card title={t('admin.poorlyRated')}><AutoTable rows={d.poorly_rated} /></Card>
        </div>
      )}
      {d && tab === 'pricing' && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card title={t('admin.plans')}><AutoTable rows={d.plans} /></Card>
          <Card title={t('admin.costs')}>
            <Table rows={d.costs} rowKey={(r) => r.action} columns={[{ key: 'action', header: t('ai.feature'), render: (r) => t(`aiAction.${r.action}`) }, { key: 'credits', header: t('ai.credits'), render: (r) => <Input type="number" step="0.5" aria-label={t('ai.credits')} defaultValue={r.credits} onBlur={async (e) => Number(e.target.value) !== Number(r.credits) && (await a.run(() => post('/admin/costs', { action: r.action, credits: Number(e.target.value), daily_fair_use: r.daily_fair_use }))) && o.reload()} className="w-24" /> }, { key: 'daily_fair_use', header: t('admin.fairUse') }]} />
          </Card>
        </div>
      )}
      {d && tab === 'content' && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card title={t('admin.curriculum')} actions={<Button size="sm" disabled={a.busy} onClick={async () => (await a.run(() => post('/admin/curriculum'))) && o.reload()}>{t('admin.pushCurriculum')}</Button>}><AutoTable rows={d.curriculum} /></Card>
          <Card title={t('admin.kb')}><AutoTable rows={d.kb} /></Card>
        </div>
      )}
      <ErrorBox error={a.error} />
      <Modal open={!!view} onClose={() => setView(null)} title={t('admin.viewAs')}>
        {view && (
          <div className="space-y-3">
            <p className="text-xs text-slate-500">{t('admin.viewAsHint')}</p>
            <Field label={t('tasks.reason')}><Input value={view.reason} onChange={(e) => setView({ ...view, reason: e.target.value })} /></Field>
            <Field label={t('admin.minutes')}><Input type="number" min={5} max={120} value={view.minutes} onChange={(e) => setView({ ...view, minutes: Number(e.target.value) })} /></Field>
            <Button disabled={view.reason.length < 5 || a.busy} onClick={async () => { const r = await a.run(() => post<{ session_id: string }>('/admin/view-as', view)); if (r) (setViewAs(r.session_id), window.location.assign('/os')); }}>{t('admin.start')}</Button>
          </div>
        )}
      </Modal>
    </div>
  );
}
