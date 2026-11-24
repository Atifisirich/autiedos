'use client';
import { useState } from 'react';
import Link from 'next/link';
import { PRODUCT_KEYS } from '@autoed/shared';
import { apost, useAdmin, useAdminApi } from './_lib/admin';
import { Badge, Button, Card, DataTable, Field, Health, Input, Notice, PageTitle, Select, SubStatus } from './_lib/ui';

/** Clients with health and status, filters, and the headline numbers. */
export default function ClientsPage() {
  const { t, errorText, dateTime } = useAdmin();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [health, setHealth] = useState('');
  const [product, setProduct] = useState('');
  const qs = new URLSearchParams({ ...(q ? { q } : {}), ...(status ? { status } : {}), ...(health ? { health } : {}), ...(product ? { product } : {}) }).toString();
  const list = useAdminApi<any[]>(`/clients${qs ? `?${qs}` : ''}`);
  const overview = useAdminApi<any>('/overview');
  const o = overview.data;
  const [tick, setTick] = useState<{ ok?: string; error?: string }>({});
  async function runTick() {
    setTick({});
    try {
      const r = await apost<{ changed: unknown[] }>('/billing/tick');
      setTick({ ok: t('console.clients.tickDone', { count: r.changed.length }) });
      await Promise.all([list.reload(), overview.reload()]);
    } catch (e) {
      setTick({ error: errorText(e) });
    }
  }

  return (
    <>
      <PageTitle
        title={t('console.clients.title')}
        subtitle={t('console.clients.subtitle')}
        actions={
          <>
            <Button variant="secondary" onClick={() => void runTick()}>
              {t('console.clients.tick')}
            </Button>
            <Link href="/admin/clients/new" className="inline-flex min-h-[44px] items-center rounded-md bg-brand-700 px-4 text-sm font-medium text-white hover:bg-brand-900">
              {t('console.clients.new')}
            </Link>
          </>
        }
      />
      <Notice ok={tick.ok} error={tick.error} />
      {o && (
        <dl className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
          {[
            ['console.overview.clients', o.clients],
            ['console.overview.suspended', o.suspended],
            ['console.overview.critical', o.by_health.critical],
            ['console.overview.attention', o.by_health.attention],
            ['console.overview.openSessions', o.open_support_sessions],
          ].map(([k, v]) => (
            <div key={k as string} className="rounded-lg border border-slate-200 bg-white p-3">
              <dt className="text-xs text-slate-700">{t(k as string)}</dt>
              <dd className="text-2xl font-semibold text-slate-900">{v as number}</dd>
            </div>
          ))}
        </dl>
      )}
      <Card>
        <form className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-4" role="search" aria-label={t('console.filters')} onSubmit={(e) => e.preventDefault()}>
          <Field label={t('console.clients.search')}>{(id) => <Input id={id} type="search" value={q} onChange={(e) => setQ(e.target.value)} />}</Field>
          <Field label={t('console.clients.status')}>
            {(id) => (
              <Select id={id} value={status} onChange={(e) => setStatus(e.target.value)} placeholder={t('console.all')} options={['active', 'suspended'].map((s) => ({ value: s, label: t(`console.clientStatus.${s}`) }))} />
            )}
          </Field>
          <Field label={t('console.clients.health')}>
            {(id) => <Select id={id} value={health} onChange={(e) => setHealth(e.target.value)} placeholder={t('console.all')} options={['ok', 'attention', 'critical'].map((s) => ({ value: s, label: t(`console.health.${s}`) }))} />}
          </Field>
          <Field label={t('console.clients.product')}>
            {(id) => <Select id={id} value={product} onChange={(e) => setProduct(e.target.value)} placeholder={t('console.all')} options={PRODUCT_KEYS.map((p) => ({ value: p, label: t(`console.product.${p}`) }))} />}
          </Field>
        </form>
        <Notice error={list.error ? errorText(list.error) : null} />
        <DataTable
          caption={t('console.clients.title')}
          rows={list.loading && !list.data ? null : (list.data ?? [])}
          rowKey={(r) => r.id}
          empty={t('console.clients.empty')}
          columns={[
            {
              key: 'name',
              header: t('console.clients.name'),
              render: (r) => (
                <>
                  <Link href={`/admin/clients/${r.id}`} className="font-medium text-brand-700 underline">
                    {r.name}
                  </Link>
                  <div className="text-xs text-slate-600">
                    {t(`console.kind.${r.kind}`)} · {r.slug}
                  </div>
                </>
              ),
            },
            {
              key: 'status',
              header: t('console.clients.status'),
              render: (r) => <Badge tone={r.client_status === 'active' ? 'green' : 'red'}>{t(`console.clientStatus.${r.client_status}`)}</Badge>,
            },
            {
              key: 'products',
              header: t('console.clients.products'),
              render: (r) =>
                r.products.length ? (
                  <ul className="space-y-1">
                    {r.products.map((p: any) => (
                      <li key={p.product_key} className="flex flex-wrap items-center gap-1">
                        <span>{t(`console.product.${p.product_key}`)}</span>
                        <SubStatus status={p.status} />
                      </li>
                    ))}
                  </ul>
                ) : (
                  t('console.none')
                ),
            },
            { key: 'health', header: t('console.clients.health'), render: (r) => <Health level={r.health.level} reasons={r.health.reasons} /> },
            { key: 'users', header: t('console.clients.users'), render: (r) => t('console.clients.usersCount', { active: r.stats.active_user_count, total: r.stats.user_count }) },
            { key: 'login', header: t('console.clients.lastLogin'), render: (r) => dateTime(r.stats.last_login_at) },
          ]}
        />
      </Card>
    </>
  );
}
