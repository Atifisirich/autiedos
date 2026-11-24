'use client';
/** Generic configuration editor: every school-specific list is data, edited here, with history and reset to preset. */
import { use, useState } from 'react';
import { useApp } from '@/lib/app';
import { api, post, useApi } from '@/lib/api';
import { useLookups, type Lookups } from '@/lib/lookups';
import { cell } from '@/components/auto-table';
import { Button, Card, Checkbox, DateText, ErrorBox, Field, Input, Modal, PageHeader, Select, Table, Textarea, useAction } from '@/components/ui';

const REF: Record<string, keyof Lookups> = { role_id: 'roles', default_role_id: 'roles', owner_role_id: 'roles', staff_id: 'staff', head_staff_id: 'staff', owner_staff_id: 'staff', class_teacher_id: 'staff', wing_id: 'wings', programme_id: 'classes', subject_id: 'subjects', department_id: 'departments', room_id: 'rooms', position_id: 'positions' };
const BOOL = /^(is_|default_verification|carry_forward$|half_day_allowed|optional|urgent|enabled|required|notify_|mandatory|cost_approval)/;
const NUM = /(_minutes|_hours|quota|_max|^seq$|rank|capacity|strength|grade_level|periods|staff_needed|overlaps_period_seq|days_before|due_weekday|_days$|radius)/;
const JSONCOL = /^(domains|scale|sections|header|channels|recipients|options|task_pack|committees|checklist|budget_lines|data|profile|review_steps|steps)$/;

function FieldFor({ col, value, onChange, lk }: { col: string; value: unknown; onChange: (v: unknown) => void; lk: Lookups | null }) {
  const { t, me } = useApp();
  const [raw, setRaw] = useState(() => (typeof value === 'object' && value !== null ? JSON.stringify(value, null, 2) : ''));
  if (col.endsWith('_i18n')) {
    const v = (value as Record<string, string>) ?? {};
    return <div className="grid grid-cols-2 gap-2">{(['hi', 'te'] as const).map((l) => <Input key={l} aria-label={t(`lang.${l}`)} placeholder={t(`lang.${l}`)} value={v[l] ?? ''} onChange={(e) => onChange({ ...v, [l]: e.target.value })} />)}</div>;
  }
  if (col === 'branch_id') return <Select value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value || null)} placeholder={t('config.allBranches')} options={(me?.branches ?? []).map((b) => ({ value: b.id, label: b.name }))} />;
  if (REF[col]) {
    const list = (lk?.[REF[col]] ?? []) as { id: string; name?: string; full_name?: string }[];
    return <Select value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value || null)} placeholder={t('common.optional')} options={list.map((x) => ({ value: x.id, label: x.name ?? x.full_name ?? '' }))} />;
  }
  if (typeof value === 'boolean' || (value == null && BOOL.test(col))) return <Checkbox label={t('common.yes')} checked={!!value} onChange={(e) => onChange(e.target.checked)} />;
  if (typeof value === 'number' || (value == null && NUM.test(col))) return <Input type="number" value={(value as number) ?? ''} onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))} />;
  if ((value !== null && typeof value === 'object') || JSONCOL.test(col)) {
    return <><Textarea rows={6} className="font-mono text-xs" value={raw} onChange={(e) => { setRaw(e.target.value); try { onChange(JSON.parse(e.target.value)); } catch { /* keep typing */ } }} /><p className="text-xs text-slate-500">{t('config.jsonHint')}</p></>;
  }
  return <Input value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} />;
}

export default function ConfigEntity({ params }: { params: Promise<{ entity: string }> }) {
  const { entity } = use(params);
  const { t } = useApp();
  const lk = useLookups();
  const meta = useApi<Record<string, { columns: string[]; resettable: boolean }>>('/config-entities');
  const rows = useApi<any[]>(`/config/${entity}`);
  const history = useApi<any[]>(`/config/${entity}/history`);
  const a = useAction();
  const [edit, setEdit] = useState<{ id?: string; data: Record<string, unknown> } | null>(null);
  const cols = meta.data?.[entity]?.columns ?? [];
  const shown = cols.filter((c) => !c.endsWith('_i18n')).slice(0, 6);
  const label = (c: string, v: unknown) => {
    if (REF[c]) { const x = ((lk?.[REF[c]] ?? []) as { id: string; name?: string; full_name?: string }[]).find((y) => y.id === v); return x?.name ?? x?.full_name ?? cell(v); }
    return cell(v);
  };
  return (
    <div>
      <PageHeader title={t(`config.${entity}`)} actions={<>{meta.data?.[entity]?.resettable && <Button variant="secondary" disabled={a.busy} onClick={async () => window.confirm(t('config.resetConfirm')) && (await a.run(() => post(`/config/${entity}/reset`))) && (rows.reload(), history.reload())}>{t('config.reset')}</Button>}<Button onClick={() => setEdit({ data: Object.fromEntries(cols.map((c) => [c, rows.data?.[0] && typeof rows.data[0][c] === 'boolean' ? false : null])) })}>{t('common.add')}</Button></>} />
      <Card>
        <Table rows={rows.data} onRow={(r) => setEdit({ id: r.id, data: Object.fromEntries(cols.map((c) => [c, r[c]])) })} columns={shown.map((c) => ({ key: c, header: t(`col.${c}`), render: (r: any) => label(c, r[c]) }))} />
      </Card>
      <Card className="mt-4" title={t('config.history')}>
        <Table rows={history.data} columns={[{ key: 'created_at', header: t('common.when'), render: (r) => <DateText value={r.created_at} withTime /> }, { key: 'actor_name', header: t('common.person') }, { key: 'op', header: t('config.change'), render: (r) => t(`configOp.${String(r.action).toLowerCase()}`) }]} />
      </Card>
      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? t('common.edit') : t('common.add')} wide>
        {edit && (
          <div className="space-y-3">
            {cols.map((c) => <Field key={c} label={t(`col.${c}`)}><FieldFor col={c} value={edit.data[c]} lk={lk} onChange={(v) => setEdit({ ...edit, data: { ...edit.data, [c]: v } })} /></Field>)}
            <ErrorBox error={a.error} />
            <div className="flex gap-2">
              <Button disabled={a.busy} onClick={async () => (await a.run(() => post(`/config/${entity}`, { id: edit.id, data: Object.fromEntries(Object.entries(edit.data).filter(([, v]) => v !== null && v !== '')) }))) && (setEdit(null), rows.reload(), history.reload())}>{t('common.save')}</Button>
              {edit.id && <Button variant="danger" disabled={a.busy} onClick={async () => window.confirm(t('config.deleteConfirm')) && (await a.run(() => api('DELETE', `/config/${entity}/${edit.id}`))) && (setEdit(null), rows.reload(), history.reload())}>{t('common.delete')}</Button>}
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
