'use client';
/** Raise a ticket: category, location (pre-filled from a room QR code), photo, voice note. */
import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useApp } from '@/lib/app';
import { get, post, uploadFile } from '@/lib/api';
import { useLookups, opts } from '@/lib/lookups';
import { Button, Card, ErrorBox, Field, Grid, Input, PageHeader, Select, Textarea, useAction } from '@/components/ui';

export default function NewTicket() {
  const { t, label } = useApp();
  const lk = useLookups();
  const sp = useSearchParams();
  const router = useRouter();
  const a = useAction();
  const [f, setF] = useState({ category_id: '', room_id: '', location_text: '', title: '', description: '', priority: 'normal' });
  const [photo, setPhoto] = useState<File | null>(null);
  const [voice, setVoice] = useState<File | null>(null);
  const token = sp.get('room');
  useEffect(() => {
    if (token) get<{ id: string }>(`/tickets/room/${token}`).then((r) => setF((x) => ({ ...x, room_id: r.id }))).catch(() => undefined);
  }, [token]);
  return (
    <div>
      <PageHeader title={t('helpdesk.raise')} />
      <Card>
        <div className="space-y-3">
          <Grid cols={3}>
            <Field label={t('common.category')}><Select value={f.category_id} onChange={(e) => setF({ ...f, category_id: e.target.value })} placeholder={t('common.choose')} options={opts(lk?.ticket_categories, (c) => label(c.name_i18n, c.name))} /></Field>
            <Field label={t('helpdesk.room')}><Select value={f.room_id} onChange={(e) => setF({ ...f, room_id: e.target.value })} placeholder={t('common.optional')} options={opts(lk?.rooms, (r) => r.name)} /></Field>
            <Field label={t('tasks.priority')}><Select value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })} options={['low', 'normal', 'high', 'urgent'].map((p) => ({ value: p, label: t(`priority.${p}`) }))} /></Field>
          </Grid>
          {!f.room_id && <Field label={t('helpdesk.location')}><Input value={f.location_text} onChange={(e) => setF({ ...f, location_text: e.target.value })} /></Field>}
          <Field label={t('common.title')}><Input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
          <Field label={t('common.description')}><Textarea value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
          <Grid cols={2}>
            <Field label={t('helpdesk.photo')}><input type="file" accept="image/*" capture="environment" onChange={(e) => setPhoto(e.target.files?.[0] ?? null)} /></Field>
            <Field label={t('helpdesk.voice')}><input type="file" accept="audio/*" onChange={(e) => setVoice(e.target.files?.[0] ?? null)} /></Field>
          </Grid>
          <ErrorBox error={a.error} />
          <Button disabled={!f.category_id || a.busy} onClick={async () => {
            const r = await a.run(async () => post<{ id: string }>('/tickets', { category_id: f.category_id, room_id: f.room_id || null, location_text: f.location_text || null, title: f.title || undefined, description: f.description || undefined, priority: f.priority, photo_path: photo ? await uploadFile(photo, 'ticket_photo') : null, voice_path: voice ? await uploadFile(voice, 'voice') : null, source: token ? 'qr' : 'manual' }));
            if (r) router.push(`/os/helpdesk/${r.id}`);
          }}>{t('common.submit')}</Button>
        </div>
      </Card>
    </div>
  );
}
