'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useApp } from '@/lib/app';
import { post } from '@/lib/api';
import { useLookups, opts } from '@/lib/lookups';
import { Button, Card, Checkbox, ErrorBox, Field, Grid, Input, PageHeader, Select, Textarea, useAction } from '@/components/ui';

export default function NewTask() {
  const { t, label } = useApp();
  const lk = useLookups();
  const router = useRouter();
  const a = useAction();
  const [f, setF] = useState({ title: '', description: '', category_id: '', priority: 'normal', target: 'people', assignee_ids: [] as string[], target_role_id: '', target_wing_id: '', target_department_id: '', group_mode: 'each', due_at: '', estimated_minutes: '', proof_required: '', verification_required: false, subtasks: '', recurring: false, frequency: 'weekly', weekdays: [1] as number[], due_time: '16:00' });
  const set = (k: string, v: unknown) => setF((x) => ({ ...x, [k]: v }));
  const cat = lk?.task_categories.find((c) => c.id === f.category_id);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const body: Record<string, unknown> = {
      title: f.title,
      description: f.description || null,
      category_id: f.category_id || null,
      priority: f.priority,
      source: 'assigned',
      assignee_ids: f.target === 'people' ? f.assignee_ids : [],
      target_role_id: f.target === 'role' ? f.target_role_id || null : null,
      target_wing_id: f.target === 'wing' ? f.target_wing_id || null : null,
      target_department_id: f.target === 'department' ? f.target_department_id || null : null,
      group_mode: f.group_mode,
      due_at: f.due_at ? new Date(f.due_at).toISOString() : null,
      estimated_minutes: f.estimated_minutes ? Number(f.estimated_minutes) : null,
      proof_required: f.proof_required || undefined,
      verification_required: f.proof_required || f.verification_required ? f.verification_required : undefined,
      subtasks: f.subtasks.split('\n').map((s) => s.trim()).filter(Boolean),
      recurrence: f.recurring ? { frequency: f.frequency, interval_n: 1, weekdays: f.weekdays, custom_dates: [], due_time: f.due_time, starts_on: new Date().toISOString().slice(0, 10) } : null,
    };
    const r = await a.run(() => post<{ id: string; recurrence_id?: string }>('/tasks', body));
    if (r) router.push(r.recurrence_id ? '/os/tasks' : `/os/tasks/${r.id}`);
  }

  return (
    <form onSubmit={submit}>
      <PageHeader title={t('tasks.new')} />
      <Card>
        <div className="space-y-4">
          <Field label={t('tasks.title')}>
            <Input required value={f.title} onChange={(e) => set('title', e.target.value)} />
          </Field>
          <Field label={t('tasks.description')}>
            <Textarea value={f.description} onChange={(e) => set('description', e.target.value)} />
          </Field>
          <Grid cols={3}>
            <Field label={t('tasks.category')}>
              <Select value={f.category_id} onChange={(e) => set('category_id', e.target.value)} placeholder={t('common.none')} options={opts(lk?.task_categories, (c) => label(c.name_i18n, c.name))} />
            </Field>
            <Field label={t('tasks.priority')}>
              <Select value={f.priority} onChange={(e) => set('priority', e.target.value)} options={['low', 'normal', 'high', 'urgent'].map((p) => ({ value: p, label: t(`priority.${p}`) }))} />
            </Field>
            <Field label={t('tasks.due')}>
              <Input type="datetime-local" value={f.due_at} onChange={(e) => set('due_at', e.target.value)} />
            </Field>
          </Grid>
          <Field label={t('tasks.assignTo')}>
            <Select value={f.target} onChange={(e) => set('target', e.target.value)} options={['people', 'role', 'wing', 'department'].map((k) => ({ value: k, label: t(`tasks.target.${k}`) }))} />
          </Field>
          {f.target === 'people' && (
            <Field label={t('tasks.people')} hint={t('tasks.peopleHint')}>
              <select multiple className="block h-40 w-full rounded-md border border-slate-300 p-2 text-sm" value={f.assignee_ids} onChange={(e) => set('assignee_ids', [...e.target.selectedOptions].map((o) => o.value))}>
                {lk?.staff.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.full_name}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {f.target === 'role' && <Select value={f.target_role_id} onChange={(e) => set('target_role_id', e.target.value)} placeholder={t('common.choose')} options={opts(lk?.roles, (r) => r.name)} />}
          {f.target === 'wing' && <Select value={f.target_wing_id} onChange={(e) => set('target_wing_id', e.target.value)} placeholder={t('common.choose')} options={opts(lk?.wings, (r) => r.name)} />}
          {f.target === 'department' && <Select value={f.target_department_id} onChange={(e) => set('target_department_id', e.target.value)} placeholder={t('common.choose')} options={opts(lk?.departments, (r) => r.name)} />}
          {(f.target !== 'people' || f.assignee_ids.length > 1) && (
            <Field label={t('tasks.groupMode')}>
              <Select value={f.group_mode} onChange={(e) => set('group_mode', e.target.value)} options={[{ value: 'each', label: t('tasks.groupMode.each') }, { value: 'any', label: t('tasks.groupMode.any') }]} />
            </Field>
          )}
          <Grid cols={3}>
            <Field label={t('tasks.proof')} hint={cat ? t('tasks.categoryDefault', { value: t(`proof.${cat.default_proof}`) }) : undefined}>
              <Select value={f.proof_required} onChange={(e) => set('proof_required', e.target.value)} placeholder={t('tasks.useCategoryDefault')} options={['none', 'note', 'photo', 'file'].map((p) => ({ value: p, label: t(`proof.${p}`) }))} />
            </Field>
            <Field label={t('tasks.estimate')}>
              <Input type="number" min={0} value={f.estimated_minutes} onChange={(e) => set('estimated_minutes', e.target.value)} />
            </Field>
            <div className="pt-6">
              <Checkbox label={t('tasks.verificationRequired')} checked={f.verification_required} onChange={(e) => set('verification_required', e.target.checked)} />
            </div>
          </Grid>
          <Field label={t('tasks.subtasks')} hint={t('tasks.subtasksHint')}>
            <Textarea value={f.subtasks} onChange={(e) => set('subtasks', e.target.value)} />
          </Field>
          <Checkbox label={t('tasks.recurring')} checked={f.recurring} onChange={(e) => set('recurring', e.target.checked)} />
          {f.recurring && (
            <Grid cols={3}>
              <Field label={t('tasks.frequency')}>
                <Select value={f.frequency} onChange={(e) => set('frequency', e.target.value)} options={['daily', 'weekly', 'monthly', 'term'].map((x) => ({ value: x, label: t(`frequency.${x}`) }))} />
              </Field>
              {f.frequency === 'weekly' && (
                <Field label={t('tasks.weekdays')}>
                  <div className="flex flex-wrap gap-2">
                    {[1, 2, 3, 4, 5, 6, 7].map((d) => (
                      <Checkbox key={d} label={t(`weekday.${d}`)} checked={f.weekdays.includes(d)} onChange={(e) => set('weekdays', e.target.checked ? [...f.weekdays, d] : f.weekdays.filter((x) => x !== d))} />
                    ))}
                  </div>
                </Field>
              )}
              <Field label={t('tasks.dueTime')}>
                <Input type="time" value={f.due_time} onChange={(e) => set('due_time', e.target.value)} />
              </Field>
            </Grid>
          )}
          <ErrorBox error={a.error} />
          <Button disabled={a.busy}>{t('common.save')}</Button>
        </div>
      </Card>
    </form>
  );
}
