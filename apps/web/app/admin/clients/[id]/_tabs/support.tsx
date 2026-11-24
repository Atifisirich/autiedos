'use client';
import { useState } from 'react';
import { apost, useAdmin, useAdminApi } from '../../../_lib/admin';
import { Badge, Button, Card, Checkbox, DataTable, Field, Notice, Select, Textarea } from '../../../_lib/ui';

/** "View as" (decision 37): the only way into a client's data. Reason required, time limited, read-only unless asked. */
export function SupportTab({ orgId }: { orgId: string }) {
  const { t, errorText, dateTime, me, reloadMe } = useAdmin();
  const sessions = useAdminApi<any[]>(`/clients/${orgId}/support-sessions`);
  const [f, setF] = useState({ reason: '', minutes: '30', read_only: true });
  const [msg, setMsg] = useState<{ ok?: string; error?: string }>({});
  const open = me?.view_as;

  async function start(e: React.FormEvent) {
    e.preventDefault();
    setMsg({});
    try {
      await apost(`/clients/${orgId}/view-as`, { reason: f.reason.trim(), minutes: Number(f.minutes), read_only: f.read_only });
      setF({ ...f, reason: '' });
      await Promise.all([reloadMe(), sessions.reload()]);
      setMsg({ ok: t('console.viewAs.startedOk') });
    } catch (err) {
      setMsg({ error: errorText(err) });
    }
  }

  return (
    <>
      <Notice ok={msg.ok} error={msg.error} />
      <Card title={t('console.viewAs.title')}>
        <p className="mb-3 text-sm text-slate-700">{t('console.viewAs.help')}</p>
        {open && (
          <p className="mb-3 text-sm text-amber-900">
            {t('console.viewAs.alreadyOpen', { org: open.org_name })}
          </p>
        )}
        <form onSubmit={start} className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label={t('console.reason')} hint={t('console.viewAs.reason.hint')} className="sm:col-span-3">
            {(id) => <Textarea id={id} required minLength={10} maxLength={500} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />}
          </Field>
          <Field label={t('console.viewAs.duration')}>
            {(id) => <Select id={id} value={f.minutes} onChange={(e) => setF({ ...f, minutes: e.target.value })} options={['15', '30', '60', '120', '240'].map((m) => ({ value: m, label: t('console.viewAs.minutes', { minutes: m }) }))} />}
          </Field>
          <div className="flex items-end">
            <Checkbox label={t('console.viewAs.readOnlyOption')} checked={f.read_only} onChange={(e) => setF({ ...f, read_only: e.target.checked })} />
          </div>
          <div className="flex items-end">
            <Button type="submit" disabled={f.reason.trim().length < 10}>
              {t('console.viewAs.start')}
            </Button>
          </div>
        </form>
      </Card>
      <Card title={t('console.viewAs.history')}>
        <DataTable
          caption={t('console.viewAs.history')}
          rows={sessions.data}
          rowKey={(s: any) => s.id}
          columns={[
            { key: 'who', header: t('console.viewAs.staff'), render: (s: any) => s.admin_name ?? t('console.none') },
            { key: 'reason', header: t('console.reason'), render: (s: any) => s.reason },
            { key: 'mode', header: t('console.viewAs.mode'), render: (s: any) => (s.read_only ? t('console.viewAs.readOnly') : t('console.viewAs.readWrite')) },
            { key: 'started', header: t('console.viewAs.started'), render: (s: any) => dateTime(s.started_at) },
            { key: 'ended', header: t('console.viewAs.endedAt'), render: (s: any) => dateTime(s.ended_at ?? s.expires_at) },
            { key: 'state', header: t('console.clients.status'), render: (s: any) => <Badge tone={s.state === 'open' ? 'amber' : 'gray'}>{t(`console.sessionState.${s.state}`)}</Badge> },
          ]}
        />
      </Card>
    </>
  );
}
