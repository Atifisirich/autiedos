'use client';
/** Personal settings: language, large text, notifications, signed-in devices, calendar feed, support access log. */
import { useState } from 'react';
import { LANGUAGES, LANGUAGE_NAMES } from '@autoed/shared';
import { useApp } from '@/lib/app';
import { api, get, post, useApi } from '@/lib/api';
import { Badge, Button, Card, Checkbox, DateText, ErrorBox, Field, Input, PageHeader, Select, Table, useAction } from '@/components/ui';

export default function Settings() {
  const { t, lang, setLang, me, reload } = useApp();
  const prefs = useApi<any[]>('/notification-prefs');
  const devices = useApi<any[]>('/devices');
  const support = useApi<any[]>('/support-access');
  const a = useAction();
  const [link, setLink] = useState<string | null>(null);
  const ui = (me?.staff.ui_prefs ?? {}) as { large_text?: boolean; simplified_home?: boolean };
  const setUi = async (patch: Record<string, boolean>) => (await a.run(() => api('PATCH', '/me', { ui_prefs: { ...ui, ...patch } }))) && reload();
  return (
    <div>
      <PageHeader title={t('nav.settings')} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={t('settings.display')}>
          <div className="space-y-3">
            <Field label={t('settings.language')}><Select value={lang} onChange={(e) => setLang(e.target.value as typeof lang)} options={LANGUAGES.map((l) => ({ value: l, label: LANGUAGE_NAMES[l] }))} /></Field>
            <Checkbox label={t('settings.largeText')} checked={!!ui.large_text} onChange={(e) => setUi({ large_text: e.target.checked })} />
            <Checkbox label={t('settings.simplifiedHome')} checked={!!ui.simplified_home} onChange={(e) => setUi({ simplified_home: e.target.checked })} />
          </div>
        </Card>
        <Card title={t('settings.calendarFeed')}>
          <p className="mb-2 text-sm text-slate-600">{t('settings.calendarFeedHint')}</p>
          {link ? <Input readOnly value={link} onFocus={(e) => e.target.select()} aria-label={t('settings.calendarFeed')} /> : <Button variant="secondary" onClick={async () => { const r = await a.run(() => get<{ token: string }>('/calendar-link')); if (r) setLink(`${window.location.origin}/api/os/calendar/${r.token}.ics`); }}>{t('settings.showLink')}</Button>}
        </Card>
        <Card title={t('settings.notifications')}>
          <p className="mb-2 text-xs text-slate-500">{t('settings.notificationsHint')}</p>
          <Table rows={prefs.data} rowKey={(r) => r.event_key} columns={[{ key: 'event_key', header: t('settings.event'), render: (r) => t(`event.${r.event_key}`) }, { key: 'channels', header: t('settings.channels'), render: (r) => (r.channels ?? []).map((c: string) => <Badge key={c}>{t(`channel.${c}`)}</Badge>) }, { key: 'muted', header: t('settings.receive'), render: (r) => (r.optional ? <Checkbox label="" aria-label={t(`event.${r.event_key}`)} checked={!r.muted} onChange={async (e) => (await a.run(() => post('/notification-prefs', { event_key: r.event_key, muted: !e.target.checked }))) && prefs.reload()} /> : <span className="text-xs text-slate-500">{t('settings.required')}</span>) }]} />
        </Card>
        <Card title={t('settings.devices')}>
          <Table rows={devices.data} columns={[{ key: 'device_name', header: t('settings.device'), render: (r) => r.device_name ?? (r.is_session ? t('settings.browserSession') : r.platform) }, { key: 'platform', header: t('settings.platform') }, { key: 'last_seen_at', header: t('settings.lastSeen'), render: (r) => <DateText value={r.last_seen_at} withTime /> }, { key: 'act', header: '', render: (r) => (r.revoked_at ? <Badge>{t('settings.signedOut')}</Badge> : <Button size="sm" variant="ghost" onClick={async () => (await a.run(() => post(`/devices/${r.id}/revoke`))) && devices.reload()}>{t('settings.signOutDevice')}</Button>) }]} />
        </Card>
        {(support.data?.length ?? 0) > 0 && (
          <Card title={t('settings.supportAccess')}>
            <Table rows={support.data} columns={[{ key: 'starts_at', header: t('common.when'), render: (r) => <DateText value={r.starts_at} withTime /> }, { key: 'admin', header: t('settings.supportPerson') }, { key: 'reason', header: t('tasks.reason') }, { key: 'expires_at', header: t('settings.until'), render: (r) => <DateText value={r.expires_at} withTime /> }]} />
          </Card>
        )}
      </div>
      <ErrorBox error={a.error} />
    </div>
  );
}
