'use client';
import { useState } from 'react';
import { PRODUCT_KEYS } from '@autoed/shared';
import { aput, useAdmin, useAdminApi } from '../_lib/admin';
import { Badge, Button, Card, Checkbox, DataTable, Field, Input, Notice, PageTitle, Select } from '../_lib/ui';

const toPaise = (rupees: string) => Math.round(Number(rupees) * 100);

/** The price list (billing.plans). Prices are ex-GST; GST is added on the invoice. */
export default function PlansPage() {
  const { t, errorText, money } = useAdmin();
  const plans = useAdminApi<any[]>('/plans');
  const [f, setF] = useState({ key: '', product_key: 'crm', name: '', billing_interval: 'month', price: '', sac_code: '998314', gst_rate: '18', active: true });
  const [msg, setMsg] = useState<{ ok?: string; error?: string }>({});

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setMsg({});
    try {
      await aput(`/plans/${f.key}`, { product_key: f.product_key, name: f.name.trim(), billing_interval: f.billing_interval, price_paise: toPaise(f.price), sac_code: f.sac_code || null, gst_rate: Number(f.gst_rate), active: f.active });
      await plans.reload();
      setMsg({ ok: t('console.saved') });
    } catch (err) {
      setMsg({ error: errorText(err) });
    }
  }

  return (
    <>
      <PageTitle title={t('console.plans.title')} subtitle={t('console.plans.subtitle')} />
      <Notice ok={msg.ok} error={msg.error ?? (plans.error ? errorText(plans.error) : null)} />
      <div className="space-y-4">
        <Card>
          <DataTable
            caption={t('console.plans.title')}
            rows={plans.data}
            rowKey={(p: any) => p.key}
            empty={t('console.plans.empty')}
            columns={[
              { key: 'k', header: t('console.plans.key'), render: (p: any) => <span className="font-mono text-xs">{p.key}</span> },
              { key: 'n', header: t('console.field.name'), render: (p: any) => p.name },
              { key: 'p', header: t('console.clients.product'), render: (p: any) => t(`console.product.${p.product_key}`) },
              { key: 'i', header: t('console.plans.interval'), render: (p: any) => t(`console.interval.${p.billing_interval}`) },
              { key: 'pr', header: t('console.plans.price'), render: (p: any) => money(p.price_paise) },
              { key: 'g', header: t('console.plans.gst'), render: (p: any) => `${p.gst_rate}%` },
              { key: 'a', header: t('console.branches.active'), render: (p: any) => <Badge tone={p.active ? 'green' : 'gray'}>{p.active ? t('console.yes') : t('console.no')}</Badge> },
              {
                key: 'e',
                header: <span className="sr-only">{t('console.actions')}</span>,
                render: (p: any) => (
                  <Button size="sm" variant="secondary" onClick={() => setF({ key: p.key, product_key: p.product_key, name: p.name, billing_interval: p.billing_interval, price: String(p.price_paise / 100), sac_code: p.sac_code ?? '', gst_rate: String(p.gst_rate), active: p.active })}>
                    {t('console.edit')}
                  </Button>
                ),
              },
            ]}
          />
        </Card>
        <Card title={t('console.plans.edit')}>
          <form onSubmit={save} className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label={t('console.plans.key')} hint={t('console.plans.key.hint')}>{(id) => <Input id={id} required pattern="[a-z][a-z0-9_]*" value={f.key} onChange={(e) => setF({ ...f, key: e.target.value })} />}</Field>
            <Field label={t('console.field.name')}>{(id) => <Input id={id} required minLength={2} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field>
            <Field label={t('console.clients.product')}>{(id) => <Select id={id} value={f.product_key} onChange={(e) => setF({ ...f, product_key: e.target.value })} options={PRODUCT_KEYS.map((p) => ({ value: p, label: t(`console.product.${p}`) }))} />}</Field>
            <Field label={t('console.plans.interval')}>
              {(id) => <Select id={id} value={f.billing_interval} onChange={(e) => setF({ ...f, billing_interval: e.target.value })} options={['month', 'year'].map((x) => ({ value: x, label: t(`console.interval.${x}`) }))} />}
            </Field>
            <Field label={t('console.plans.price')} hint={t('console.billing.exGst')}>{(id) => <Input id={id} type="number" min={0} step="0.01" required inputMode="decimal" value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} />}</Field>
            <Field label={t('console.plans.gst')}>{(id) => <Input id={id} type="number" min={0} max={28} step="0.01" required inputMode="decimal" value={f.gst_rate} onChange={(e) => setF({ ...f, gst_rate: e.target.value })} />}</Field>
            <Field label={t('console.billing.sac')} hint={t('console.plans.sac.hint')}>{(id) => <Input id={id} pattern="[0-9]{4,8}" value={f.sac_code} onChange={(e) => setF({ ...f, sac_code: e.target.value })} />}</Field>
            <div className="flex items-end">
              <Checkbox label={t('console.branches.active')} checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} />
            </div>
            <div className="flex items-end">
              <Button type="submit">{t('console.save')}</Button>
            </div>
          </form>
        </Card>
      </div>
    </>
  );
}
