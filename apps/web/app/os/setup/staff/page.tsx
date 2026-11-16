'use client';
/** Staff directory: invite, edit, roles, deactivate (open work is handed to the manager). */
import { useState } from 'react';
import { useApp } from '@/lib/app';
import { api, post, useApi } from '@/lib/api';
import { useLookups, opts } from '@/lib/lookups';
import { ImportSheet } from '@/components/import-sheet';
import { Badge, Button, Card, Checkbox, ErrorBox, Field, Grid, Input, Modal, PageHeader, Select, StatusBadge, Table, useAction } from '@/components/ui';

export default function Staff() {
  const { t } = useApp();
  const lk = useLookups();
  const [q, setQ] = useState('');
  const [all, setAll] = useState(false);
  const list = useApi<any[]>(`/staff?${new URLSearchParams({ ...(q ? { q } : {}), ...(all ? { all: '1' } : {}) })}`);
  const a = useAction();
  const blank = { full_name: '', email: '', phone: '', employee_code: '', position_id: '', department_id: '', wing_id: '', reports_to: '' };
  const [invite, setInvite] = useState<typeof blank | null>(null);
  const [edit, setEdit] = useState<any>(null);
  const [roles, setRoles] = useState<string[]>([]);
  const [importOpen, setImportOpen] = useState(false);
  const openEdit = (r: any) => (setEdit({ ...r }), setRoles((lk?.roles ?? []).filter((x) => r.role_keys.includes(x.key)).map((x) => x.id)));
  return (
    <div>
      <PageHeader title={t('setup.staff')} actions={<><Button variant="secondary" onClick={() => setImportOpen(true)}>{t('setup.import')}</Button><Button onClick={() => setInvite(blank)}>{t('setup.invite')}</Button></>} />
      <Card actions={<div className="flex items-center gap-3"><Checkbox label={t('setup.allBranches')} checked={all} onChange={(e) => setAll(e.target.checked)} /><Input aria-label={t('common.search')} placeholder={t('common.search')} value={q} onChange={(e) => setQ(e.target.value)} className="w-56" /></div>}>
        <Table rows={list.data} onRow={openEdit} columns={[{ key: 'employee_code', header: t('setup.code') }, { key: 'full_name', header: t('common.name') }, { key: 'email', header: t('setup.email') }, { key: 'role_keys', header: t('common.role'), render: (r) => r.role_keys.map((k: string) => <Badge key={k}>{lk?.roles.find((x) => x.key === k)?.name ?? k}</Badge>) }, { key: 'reports_to', header: t('setup.reportsTo'), render: (r) => lk?.staff.find((s) => s.id === r.reports_to)?.full_name ?? '—' }, { key: 'status', header: t('common.status'), render: (r) => <StatusBadge status={r.status} /> }]} />
      </Card>
      <Modal open={importOpen} onClose={() => setImportOpen(false)} title={t('setup.import')}><ImportSheet kind="staff" onDone={list.reload} /></Modal>
      <Modal open={!!invite} onClose={() => setInvite(null)} title={t('setup.invite')}>
        {invite && (
          <div className="space-y-3">
            <Grid cols={2}>
              <Field label={t('common.name')}><Input value={invite.full_name} onChange={(e) => setInvite({ ...invite, full_name: e.target.value })} /></Field>
              <Field label={t('setup.code')}><Input value={invite.employee_code} onChange={(e) => setInvite({ ...invite, employee_code: e.target.value })} /></Field>
              <Field label={t('setup.email')}><Input type="email" value={invite.email} onChange={(e) => setInvite({ ...invite, email: e.target.value })} /></Field>
              <Field label={t('setup.phone')}><Input value={invite.phone} onChange={(e) => setInvite({ ...invite, phone: e.target.value })} /></Field>
              <Field label={t('setup.position')}><Select value={invite.position_id} onChange={(e) => setInvite({ ...invite, position_id: e.target.value })} placeholder={t('common.choose')} options={opts(lk?.positions, (p) => p.name)} /></Field>
              <Field label={t('common.department')}><Select value={invite.department_id} onChange={(e) => setInvite({ ...invite, department_id: e.target.value })} placeholder={t('common.optional')} options={opts(lk?.departments, (d) => d.name)} /></Field>
              <Field label={t('common.wing')}><Select value={invite.wing_id} onChange={(e) => setInvite({ ...invite, wing_id: e.target.value })} placeholder={t('common.optional')} options={opts(lk?.wings, (w) => w.name)} /></Field>
              <Field label={t('setup.reportsTo')}><Select value={invite.reports_to} onChange={(e) => setInvite({ ...invite, reports_to: e.target.value })} placeholder={t('common.optional')} options={opts(lk?.staff, (s) => s.full_name)} /></Field>
            </Grid>
            <ErrorBox error={a.error} />
            <Button disabled={a.busy || invite.full_name.length < 2 || !invite.employee_code || !invite.position_id} onClick={async () => (await a.run(() => post('/staff', { ...invite, email: invite.email || undefined, phone: invite.phone || undefined, department_id: invite.department_id || null, wing_id: invite.wing_id || null, reports_to: invite.reports_to || null }))) && (setInvite(null), list.reload())}>{t('setup.sendInvite')}</Button>
          </div>
        )}
      </Modal>
      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit?.full_name ?? ''}>
        {edit && (
          <div className="space-y-3">
            <Grid cols={2}>
              <Field label={t('common.name')}><Input value={edit.full_name} onChange={(e) => setEdit({ ...edit, full_name: e.target.value })} /></Field>
              <Field label={t('setup.phone')}><Input value={edit.phone ?? ''} onChange={(e) => setEdit({ ...edit, phone: e.target.value })} /></Field>
              <Field label={t('common.department')}><Select value={edit.department_id ?? ''} onChange={(e) => setEdit({ ...edit, department_id: e.target.value || null })} placeholder={t('common.optional')} options={opts(lk?.departments, (d) => d.name)} /></Field>
              <Field label={t('common.wing')}><Select value={edit.wing_id ?? ''} onChange={(e) => setEdit({ ...edit, wing_id: e.target.value || null })} placeholder={t('common.optional')} options={opts(lk?.wings, (w) => w.name)} /></Field>
              <Field label={t('setup.maxDay')}><Input type="number" value={edit.max_periods_day} onChange={(e) => setEdit({ ...edit, max_periods_day: Number(e.target.value) })} /></Field>
              <Field label={t('setup.maxWeek')}><Input type="number" value={edit.max_periods_week} onChange={(e) => setEdit({ ...edit, max_periods_week: Number(e.target.value) })} /></Field>
            </Grid>
            <Checkbox label={t('setup.isTeaching')} checked={edit.is_teaching} onChange={(e) => setEdit({ ...edit, is_teaching: e.target.checked })} />
            <Button disabled={a.busy} onClick={async () => (await a.run(() => api('PATCH', `/staff/${edit.id}`, { full_name: edit.full_name, phone: edit.phone || null, department_id: edit.department_id, wing_id: edit.wing_id, max_periods_day: edit.max_periods_day, max_periods_week: edit.max_periods_week, is_teaching: edit.is_teaching }))) && list.reload()}>{t('common.save')}</Button>
            <Field label={t('setup.roles')}><select multiple aria-label={t('setup.roles')} className="h-32 w-full rounded-md border border-slate-300 p-1 text-sm" value={roles} onChange={(e) => setRoles([...e.target.selectedOptions].map((o) => o.value))}>{(lk?.roles ?? []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></Field>
            <Button variant="secondary" disabled={a.busy} onClick={async () => (await a.run(() => post(`/staff/${edit.id}/roles`, { role_ids: roles }))) && list.reload()}>{t('setup.saveRoles')}</Button>
            {edit.status !== 'inactive' && (
              <div className="border-t border-slate-100 pt-3">
                <p className="mb-2 text-xs text-slate-500">{t('setup.deactivateHint')}</p>
                <Button variant="danger" disabled={a.busy} onClick={async () => window.confirm(t('setup.deactivateConfirm', { name: edit.full_name })) && (await a.run(() => post(`/staff/${edit.id}/deactivate`))) && (setEdit(null), list.reload())}>{t('setup.deactivate')}</Button>
              </div>
            )}
            <ErrorBox error={a.error} />
          </div>
        )}
      </Modal>
    </div>
  );
}
