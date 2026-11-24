'use client';
import { useEffect, useState } from 'react';
import { aget, useAdmin } from './admin';
import { Button, Card, DataTable, Field, Input, Notice, Select } from './ui';

/** Audit log and configuration history with filters. `orgId` pins it to one client (the client page). */
export function AuditViewer({ orgId }: { orgId?: string }) {
  const { t, errorText, dateTime } = useAdmin();
  const [f, setF] = useState({ source: 'log', action: '', table: '', from: '', to: '', q: '' });
  const [rows, setRows] = useState<any[] | null>(null);
  const [next, setNext] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const query = (before?: number) => {
    const p = new URLSearchParams({ source: f.source, limit: '50' });
    if (orgId) p.set('org_id', orgId);
    for (const k of ['action', 'table', 'q'] as const) if (f[k].trim()) p.set(k, f[k].trim());
    if (f.from) p.set('from', new Date(`${f.from}T00:00:00`).toISOString());
    if (f.to) p.set('to', new Date(`${f.to}T23:59:59`).toISOString());
    if (before) p.set('before_id', String(before));
    return `/audit?${p}`;
  };

  async function load(more = false) {
    setBusy(true);
    setError(null);
    try {
      const r = await aget<{ rows: any[]; next_before_id: number | null }>(query(more ? (next ?? undefined) : undefined));
      setRows(more ? [...(rows ?? []), ...r.rows] : r.rows);
      setNext(r.next_before_id);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void load();
    // First load only; later loads are triggered by the Search button.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId]);

  return (
    <Card title={t('console.audit.title')}>
      <form
        role="search"
        aria-label={t('console.filters')}
        className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3 lg:grid-cols-6"
        onSubmit={(e) => {
          e.preventDefault();
          void load();
        }}
      >
        <Field label={t('console.audit.source')}>
          {(id) => <Select id={id} value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })} options={['log', 'config'].map((s) => ({ value: s, label: t(`console.audit.source.${s}`) }))} />}
        </Field>
        <Field label={t('console.audit.action')} hint={t('console.audit.action.hint')}>{(id) => <Input id={id} value={f.action} onChange={(e) => setF({ ...f, action: e.target.value })} />}</Field>
        <Field label={t('console.audit.table')}>{(id) => <Input id={id} value={f.table} onChange={(e) => setF({ ...f, table: e.target.value })} />}</Field>
        <Field label={t('console.audit.from')}>{(id) => <Input id={id} type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />}</Field>
        <Field label={t('console.audit.to')}>{(id) => <Input id={id} type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} />}</Field>
        <Field label={t('console.audit.text')}>{(id) => <Input id={id} type="search" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />}</Field>
        <div className="sm:col-span-3 lg:col-span-6">
          <Button type="submit" disabled={busy}>
            {t('console.audit.search')}
          </Button>
        </div>
      </form>
      <Notice error={error} />
      <DataTable
        caption={t('console.audit.title')}
        rows={rows}
        rowKey={(r: any) => String(r.id)}
        empty={t('console.audit.empty')}
        columns={[
          { key: 'at', header: t('console.audit.when'), render: (r: any) => dateTime(r.created_at) },
          { key: 'who', header: t('console.audit.who'), render: (r: any) => r.actor_name ?? (r.actor_user_id ? t('console.audit.clientUser') : t('console.audit.system')) },
          ...(orgId ? [] : [{ key: 'org', header: t('console.audit.client'), render: (r: any) => r.org_name ?? t('console.none') }]),
          { key: 'what', header: t('console.audit.what'), render: (r: any) => <span className="font-mono text-xs">{r.action}{r.table_name ? ` ${r.schema_name}.${r.table_name}` : ''}</span> },
          {
            key: 'detail',
            header: t('console.audit.detail'),
            render: (r: any) => {
              const key = String(r.id);
              const payload = { detail: r.detail, before: r.before, after: r.after, support_session_id: r.support_session_id };
              return (
                <>
                  {r.detail?.reason && <p className="mb-1 text-xs">{r.detail.reason}</p>}
                  <Button size="sm" variant="ghost" aria-expanded={open === key} onClick={() => setOpen(open === key ? null : key)}>
                    {open === key ? t('console.audit.hide') : t('console.audit.show')}
                  </Button>
                  {open === key && <pre className="mt-1 max-w-xl overflow-x-auto whitespace-pre-wrap break-words rounded bg-slate-50 p-2 text-xs">{JSON.stringify(payload, null, 1)}</pre>}
                </>
              );
            },
          },
        ]}
      />
      {next && (
        <div className="mt-3">
          <Button variant="secondary" disabled={busy} onClick={() => void load(true)}>
            {t('console.audit.more')}
          </Button>
        </div>
      )}
    </Card>
  );
}
