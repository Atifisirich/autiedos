'use client';
/** Role permission matrix: module × action → scope. Plus create a role (optionally copying one). */
import { useState } from 'react';
import { ACTIONS, SCOPES } from '@autoed/shared';
import { useApp } from '@/lib/app';
import { post, useApi } from '@/lib/api';
import { Button, Card, ErrorBox, Field, Grid, Input, Modal, PageHeader, Select, useAction } from '@/components/ui';

export default function Roles() {
  const { t } = useApp();
  const m = useApi<{ roles: any[]; permissions: { role_id: string; module: string; action: string; scope: string }[]; modules: string[] }>('/roles');
  const a = useAction();
  const [role, setRole] = useState('');
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ key: '', name: '', description: '', copy_from_role_id: '' });
  const r = role || m.data?.roles[0]?.id || '';
  const scope = (mod: string, act: string) => m.data?.permissions.find((p) => p.role_id === r && p.module === mod && p.action === act)?.scope ?? '';
  return (
    <div>
      <PageHeader title={t('setup.rolesMatrix')} actions={<Button onClick={() => setOpen(true)}>{t('setup.newRole')}</Button>} />
      <Card actions={<Select aria-label={t('common.role')} value={r} onChange={(e) => setRole(e.target.value)} options={(m.data?.roles ?? []).map((x) => ({ value: x.id, label: x.name }))} className="w-64" />}>
        <p className="mb-2 text-xs text-slate-500">{t('setup.matrixHint')}</p>
        <div className="overflow-x-auto">
          <table className="min-w-full text-xs">
            <thead><tr><th className="p-1 text-left">{t('setup.module')}</th>{ACTIONS.map((ac) => <th key={ac} className="p-1">{t(`action.${ac}`)}</th>)}</tr></thead>
            <tbody>
              {(m.data?.modules ?? []).map((mod) => (
                <tr key={mod} className="border-t border-slate-100">
                  <td className="p-1 font-medium">{t(`module.${mod}`)}</td>
                  {ACTIONS.map((ac) => (
                    <td key={ac} className="p-1">
                      <select aria-label={`${t(`module.${mod}`)} ${t(`action.${ac}`)}`} className="w-full rounded border border-slate-200 text-xs" value={scope(mod, ac)} onChange={async (e) => (await a.run(() => post('/roles/permission', { role_id: r, module: mod, action: ac, scope: e.target.value || null }))) && m.reload()}>
                        <option value="">—</option>
                        {SCOPES.map((s) => <option key={s} value={s}>{t(`scope.${s}`)}</option>)}
                      </select>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <ErrorBox error={a.error} />
      </Card>
      <Modal open={open} onClose={() => setOpen(false)} title={t('setup.newRole')}>
        <div className="space-y-3">
          <Grid cols={2}>
            <Field label={t('common.key')}><Input value={f.key} onChange={(e) => setF({ ...f, key: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') })} /></Field>
            <Field label={t('common.name')}><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          </Grid>
          <Field label={t('common.description')}><Input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
          <Field label={t('setup.copyFrom')}><Select value={f.copy_from_role_id} onChange={(e) => setF({ ...f, copy_from_role_id: e.target.value })} placeholder={t('common.optional')} options={(m.data?.roles ?? []).map((x) => ({ value: x.id, label: x.name }))} /></Field>
          <ErrorBox error={a.error} />
          <Button disabled={!f.key || f.name.length < 2 || a.busy} onClick={async () => { const x = await a.run(() => post<{ id: string }>('/roles', { key: f.key, name: f.name, description: f.description || undefined, copy_from_role_id: f.copy_from_role_id || undefined })); if (x) (setOpen(false), setRole(x.id), m.reload()); }}>{t('common.save')}</Button>
        </div>
      </Modal>
    </div>
  );
}
