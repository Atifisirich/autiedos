'use client';
import { use, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useApp } from '@/lib/app';
import { post, uploadFile, useApi } from '@/lib/api';
import { Badge, Button, Card, ErrorBox, Input, Loading, PageHeader, StatusBadge, Textarea, useAction } from '@/components/ui';

export default function RunChecklist({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { t, label } = useApp();
  const run = useApi<any>(`/checklists/runs/${id}`);
  const [ans, setAns] = useState<Record<string, { value: any; photo_path?: string; note?: string }>>({});
  const a = useAction();
  const router = useRouter();
  const [created, setCreated] = useState<{ type: string; id: string | null }[] | null>(null);
  if (!run.data) return run.error ? <ErrorBox error={run.error} /> : <Loading />;
  const r = run.data;
  const done = r.status === 'completed';
  const val = (itemId: string) => ans[itemId]?.value ?? r.responses.find((x: any) => x.item_id === itemId)?.value ?? null;
  const set = (itemId: string, patch: Partial<{ value: any; photo_path: string; note: string }>) => setAns((s) => ({ ...s, [itemId]: { value: s[itemId]?.value ?? null, ...s[itemId], ...patch } }));
  return (
    <div>
      <PageHeader title={label(r.name_i18n, r.name)} subtitle={<StatusBadge status={r.status} />} />
      <Card>
        <ol className="space-y-4">
          {r.items.map((i: any, k: number) => (
            <li key={i.id} className="border-b border-slate-100 pb-3">
              <div className="mb-2 text-sm font-medium">
                {k + 1}. {label(i.label_i18n, i.label)} {i.required && <span className="text-red-600">*</span>}
                {(i.min_value != null || i.max_value != null) && <span className="ml-2 text-xs text-slate-500">{t('checklists.range', { min: i.min_value ?? '—', max: i.max_value ?? '—' })}</span>}
              </div>
              {(i.item_type === 'yesno' || i.item_type === 'tick') && (
                <div className="flex gap-2">
                  {(i.item_type === 'yesno' ? ['yes', 'no'] : ['yes']).map((v) => (
                    <Button key={v} type="button" disabled={done} variant={val(i.id) === v || (v === 'yes' && val(i.id) === true) ? 'primary' : 'secondary'} onClick={() => set(i.id, { value: v })}>
                      {i.item_type === 'tick' ? t('checklists.done') : t(`common.${v}`)}
                    </Button>
                  ))}
                </div>
              )}
              {i.item_type === 'number' && <Input type="number" disabled={done} value={val(i.id) ?? ''} onChange={(e) => set(i.id, { value: e.target.value === '' ? null : Number(e.target.value) })} className="w-40" aria-label={label(i.label_i18n, i.label)} />}
              {i.item_type === 'text' && <Textarea disabled={done} value={val(i.id) ?? ''} onChange={(e) => set(i.id, { value: e.target.value })} aria-label={label(i.label_i18n, i.label)} />}
              {i.item_type === 'photo' && (
                <div className="flex items-center gap-2">
                  <input type="file" accept="image/*" capture="environment" disabled={done} onChange={async (e) => {
                    const f = e.target.files?.[0];
                    if (f) set(i.id, { photo_path: await uploadFile(f, 'checklist_photo'), value: '' });
                  }} />
                  {ans[i.id]?.photo_path && <Badge tone="green">{t('checklists.photoAdded')}</Badge>}
                </div>
              )}
            </li>
          ))}
        </ol>
        <ErrorBox error={a.error} />
        {created && created.length > 0 && <p className="mt-2 text-sm text-amber-700">{t('checklists.followUpsCreated', { count: created.length })}</p>}
        {!done && (
          <div className="mt-4 flex gap-2">
            <Button disabled={a.busy} onClick={async () => {
              const answers = Object.entries(ans).map(([item_id, v]) => ({ item_id, ...v }));
              const res = await a.run(() => post<{ follow_ups: { type: string; id: string | null }[] }>(`/checklists/runs/${id}`, { answers, complete: true, client_id: crypto.randomUUID() }));
              if (res) {
                setCreated(res.follow_ups);
                if (!res.follow_ups.length) router.push('/os/checklists');
                else await run.reload();
              }
            }}>{t('checklists.complete')}</Button>
            <Button variant="secondary" disabled={a.busy} onClick={() => a.run(() => post(`/checklists/runs/${id}`, { answers: Object.entries(ans).map(([item_id, v]) => ({ item_id, ...v })), complete: false }))}>{t('common.saveDraft')}</Button>
          </div>
        )}
      </Card>
    </div>
  );
}
