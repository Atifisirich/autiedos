'use client';
import { use, useState } from 'react';
import { useApp } from '@/lib/app';
import { post, useApi } from '@/lib/api';
import { useLookups, opts } from '@/lib/lookups';
import { SignedAudio, SignedImage } from '@/components/files';
import { Button, Card, DateText, ErrorBox, Field, Grid, Input, Loading, PageHeader, Select, StatusBadge, Textarea, useAction } from '@/components/ui';

export default function TicketDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { t, can, me } = useApp();
  const lk = useLookups();
  const x = useApi<any>(`/tickets/${id}`);
  const a = useAction();
  const [note, setNote] = useState('');
  const [owner, setOwner] = useState('');
  const [cost, setCost] = useState({ vendor: '', cost: '', parts: '' });
  if (!x.data) return x.error ? <ErrorBox error={x.error} /> : <Loading />;
  const tk = x.data;
  const act = async (action: string, extra: Record<string, unknown> = {}) => (await a.run(() => post(`/tickets/${id}/action`, { action, note: note || undefined, ...extra }))) && (setNote(''), x.reload());
  const isOwner = tk.owner_id === me?.staff.id;
  const manage = can('helpdesk', 'assign');
  return (
    <div>
      <PageHeader title={tk.title} subtitle={<span className="flex items-center gap-2"><StatusBadge status={tk.status} />{tk.category} · {tk.room_name ?? tk.location_text ?? ''} · {t('tasks.due')} <DateText value={tk.due_at} withTime /></span>} />
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card title={t('common.description')}>
            <p className="whitespace-pre-wrap text-sm">{tk.description ?? '—'}</p>
            {tk.photo_path && <SignedImage path={tk.photo_path} alt={t('helpdesk.photo')} />}
            {tk.voice_path && <SignedAudio path={tk.voice_path} />}
          </Card>
          <Card title={t('tasks.history')}>
            <ol className="space-y-1 text-sm">{tk.events.map((e: any) => <li key={e.id}><DateText value={e.created_at} withTime /> · {e.actor_name ?? t('common.system')} · {t(`ticketEvent.${e.event}`)}{e.note && ` — ${e.note}`}</li>)}</ol>
          </Card>
        </div>
        <Card title={t('tasks.actions')}>
          <div className="space-y-2">
            <Field label={t('helpdesk.note')}><Textarea value={note} onChange={(e) => setNote(e.target.value)} /></Field>
            {manage && (
              <div className="flex gap-2"><Select aria-label={t('tasks.owner')} value={owner} onChange={(e) => setOwner(e.target.value)} placeholder={t('tasks.owner')} options={opts(lk?.staff, (s) => s.full_name)} /><Button variant="secondary" disabled={!owner} onClick={() => act('assign', { owner_id: owner })}>{t('helpdesk.assign')}</Button></div>
            )}
            {(isOwner || manage) && (
              <div className="flex flex-wrap gap-2">
                {['assigned', 'open', 'waiting'].includes(tk.status) && <Button onClick={() => act('start')}>{t('helpdesk.start')}</Button>}
                {tk.status === 'in_progress' && <Button variant="secondary" onClick={() => act('wait')}>{t('helpdesk.wait')}</Button>}
                {['in_progress', 'waiting'].includes(tk.status) && <Button onClick={() => act('resolve')}>{t('helpdesk.resolve')}</Button>}
              </div>
            )}
            {tk.raised_by === me?.staff.id && tk.status === 'resolved' && <div className="flex gap-2"><Button onClick={() => act('close')}>{t('helpdesk.close')}</Button><Button variant="secondary" onClick={() => act('reopen')}>{t('helpdesk.reopen')}</Button></div>}
            {(isOwner || manage) && (
              <>
                <Grid cols={2}>
                  <Field label={t('helpdesk.vendor')}><Input value={cost.vendor} onChange={(e) => setCost({ ...cost, vendor: e.target.value })} /></Field>
                  <Field label={t('helpdesk.cost')}><Input type="number" value={cost.cost} onChange={(e) => setCost({ ...cost, cost: e.target.value })} /></Field>
                </Grid>
                <Field label={t('helpdesk.parts')}><Input value={cost.parts} onChange={(e) => setCost({ ...cost, parts: e.target.value })} /></Field>
                <Button size="sm" variant="secondary" onClick={() => act('update_costs', { vendor: cost.vendor || undefined, cost: cost.cost ? Number(cost.cost) : undefined, parts: cost.parts || undefined })}>{t('helpdesk.saveCosts')}</Button>
              </>
            )}
            <ErrorBox error={a.error} />
          </div>
        </Card>
      </div>
    </div>
  );
}
