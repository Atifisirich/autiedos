'use client';
/** Form builder for request types and their approval chains (PRD 5.6). */
import { useState } from 'react';
import { useApp } from '@/lib/app';
import { post, useApi } from '@/lib/api';
import { useLookups, opts } from '@/lib/lookups';
import { Button, Card, Checkbox, ErrorBox, Field, Grid, Input, PageHeader, Select, useAction } from '@/components/ui';

interface FieldDef { key: string; label: string; type: string; required: boolean; options: string[] }
interface StepDef { seq: number; approver_kind: string; approver_role_id: string | null; approver_staff_id: string | null; condition: { field: string; op: string; value: number } | null; time_limit_hours: number }

export default function ApprovalTypes() {
  const { t, label } = useApp();
  const types = useApi<any[]>('/approvals/types');
  const lk = useLookups();
  const a = useAction();
  const [edit, setEdit] = useState<{ key: string; name: string; form_schema: FieldDef[]; steps: StepDef[] } | null>(null);
  const load = (x: any) => setEdit({ key: x.key, name: x.name, form_schema: x.form_schema ?? [], steps: x.steps.map((s: any) => ({ seq: s.seq, approver_kind: s.approver_kind, approver_role_id: s.approver_role_id, approver_staff_id: s.approver_staff_id, condition: s.condition, time_limit_hours: s.time_limit_hours })) });
  return (
    <div>
      <PageHeader title={t('approvals.types')} actions={<Button onClick={() => setEdit({ key: '', name: '', form_schema: [], steps: [{ seq: 1, approver_kind: 'manager_of_applicant', approver_role_id: null, approver_staff_id: null, condition: null, time_limit_hours: 48 }] })}>{t('approvals.newType')}</Button>} />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title={t('approvals.types')}>
          <ul className="space-y-1 text-sm">
            {(types.data ?? []).map((x) => (
              <li key={x.id}>
                <button className="text-left text-brand-700 hover:underline" onClick={() => load(x)}>{label(x.name_i18n, x.name)}</button>
                {x.is_system && <span className="ml-2 text-xs text-slate-500">{t('approvals.system')}</span>}
              </li>
            ))}
          </ul>
        </Card>
        {edit && (
          <Card className="lg:col-span-2" title={edit.name || t('approvals.newType')}>
            <div className="space-y-4">
              <Grid cols={2}>
                <Field label={t('common.key')}><Input value={edit.key} onChange={(e) => setEdit({ ...edit, key: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') })} /></Field>
                <Field label={t('common.name')}><Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
              </Grid>
              <div>
                <h3 className="mb-2 text-sm font-semibold">{t('approvals.formFields')}</h3>
                {edit.form_schema.map((f, i) => (
                  <div key={i} className="mb-2 grid grid-cols-2 gap-2 sm:grid-cols-5">
                    <Input aria-label={t('common.key')} value={f.key} onChange={(e) => setEdit({ ...edit, form_schema: edit.form_schema.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)) })} />
                    <Input aria-label={t('common.label')} value={f.label} onChange={(e) => setEdit({ ...edit, form_schema: edit.form_schema.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} />
                    <Select aria-label={t('common.type')} value={f.type} onChange={(e) => setEdit({ ...edit, form_schema: edit.form_schema.map((x, j) => (j === i ? { ...x, type: e.target.value } : x)) })} options={['text', 'number', 'date', 'dropdown', 'yesno', 'file'].map((x) => ({ value: x, label: t(`fieldType.${x}`) }))} />
                    <Checkbox label={t('common.required')} checked={f.required} onChange={(e) => setEdit({ ...edit, form_schema: edit.form_schema.map((x, j) => (j === i ? { ...x, required: e.target.checked } : x)) })} />
                    <Button size="sm" variant="ghost" onClick={() => setEdit({ ...edit, form_schema: edit.form_schema.filter((_, j) => j !== i) })}>{t('common.remove')}</Button>
                  </div>
                ))}
                <Button size="sm" variant="secondary" onClick={() => setEdit({ ...edit, form_schema: [...edit.form_schema, { key: `field_${edit.form_schema.length + 1}`, label: '', type: 'text', required: false, options: [] }] })}>{t('approvals.addField')}</Button>
              </div>
              <div>
                <h3 className="mb-2 text-sm font-semibold">{t('approvals.chain')}</h3>
                {edit.steps.map((s, i) => (
                  <div key={i} className="mb-2 grid grid-cols-2 gap-2 sm:grid-cols-6">
                    <Input aria-label={t('approvals.step')} type="number" min={1} value={s.seq} onChange={(e) => setEdit({ ...edit, steps: edit.steps.map((x, j) => (j === i ? { ...x, seq: Number(e.target.value) } : x)) })} />
                    <Select aria-label={t('approvals.approver')} value={s.approver_kind} onChange={(e) => setEdit({ ...edit, steps: edit.steps.map((x, j) => (j === i ? { ...x, approver_kind: e.target.value } : x)) })} options={['manager_of_applicant', 'role', 'staff'].map((x) => ({ value: x, label: t(`approverKind.${x}`) }))} />
                    {s.approver_kind === 'role' && <Select aria-label={t('common.role')} value={s.approver_role_id ?? ''} onChange={(e) => setEdit({ ...edit, steps: edit.steps.map((x, j) => (j === i ? { ...x, approver_role_id: e.target.value } : x)) })} placeholder={t('common.choose')} options={opts(lk?.roles, (r) => r.name)} />}
                    {s.approver_kind === 'staff' && <Select aria-label={t('common.person')} value={s.approver_staff_id ?? ''} onChange={(e) => setEdit({ ...edit, steps: edit.steps.map((x, j) => (j === i ? { ...x, approver_staff_id: e.target.value } : x)) })} placeholder={t('common.choose')} options={opts(lk?.staff, (r) => r.full_name)} />}
                    <Input aria-label={t('approvals.conditionField')} placeholder={t('approvals.conditionField')} value={s.condition?.field ?? ''} onChange={(e) => setEdit({ ...edit, steps: edit.steps.map((x, j) => (j === i ? { ...x, condition: e.target.value ? { field: e.target.value, op: '>', value: x.condition?.value ?? 0 } : null } : x)) })} />
                    <Input aria-label={t('approvals.conditionValue')} type="number" placeholder={t('approvals.conditionValue')} value={s.condition?.value ?? ''} onChange={(e) => setEdit({ ...edit, steps: edit.steps.map((x, j) => (j === i && x.condition ? { ...x, condition: { ...x.condition, value: Number(e.target.value) } } : x)) })} />
                    <Input aria-label={t('approvals.timeLimit')} type="number" value={s.time_limit_hours} onChange={(e) => setEdit({ ...edit, steps: edit.steps.map((x, j) => (j === i ? { ...x, time_limit_hours: Number(e.target.value) } : x)) })} />
                  </div>
                ))}
                <p className="mb-2 text-xs text-slate-500">{t('approvals.chainHint')}</p>
                <Button size="sm" variant="secondary" onClick={() => setEdit({ ...edit, steps: [...edit.steps, { seq: edit.steps.length + 1, approver_kind: 'role', approver_role_id: null, approver_staff_id: null, condition: null, time_limit_hours: 48 }] })}>{t('approvals.addStep')}</Button>
              </div>
              <ErrorBox error={a.error} />
              <Button disabled={a.busy || !edit.key || !edit.name} onClick={async () => (await a.run(() => post('/approvals/types', edit))) && types.reload()}>{t('common.save')}</Button>
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
