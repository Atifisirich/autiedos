'use client';
import { useState } from 'react';
import Link from 'next/link';
import { GST_STATE_CODES, PRODUCT_KEYS, type ProductKey } from '@autoed/shared';
import { apost, useAdmin, useAdminApi } from '../../_lib/admin';
import { Button, Card, Checkbox, Field, Input, Notice, PageTitle, Select } from '../../_lib/ui';

const KINDS = ['school', 'coaching_centre', 'college', 'other'];
const stateOptions = Object.entries(GST_STATE_CODES).map(([code, name]) => ({ value: code, label: `${code} ${name}` }));
const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

/** Organisation + first branch + products + first admin invite (+ billing profile) in one step. */
export default function NewClientPage() {
  const { t, errorText } = useAdmin();
  const plans = useAdminApi<any[]>('/plans');
  const [f, setF] = useState({ name: '', slug: '', kind: 'school', legal_name: '', branch_name: '', branch_code: 'MAIN', city: '', state_code: '', admin_name: '', admin_email: '', billing: false, gstin: '', billing_email: '' });
  const [slugTouched, setSlugTouched] = useState(false);
  const [subs, setSubs] = useState<Record<string, { on: boolean; status: 'trial' | 'active'; plan_key: string; seats: string }>>(
    Object.fromEntries(PRODUCT_KEYS.map((p) => [p, { on: false, status: 'trial' as const, plan_key: '', seats: '' }])),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f, v: string | boolean) => setF((x) => ({ ...x, [k]: v }));
  const chosen = PRODUCT_KEYS.filter((p) => subs[p]!.on);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = {
        name: f.name.trim(),
        slug: f.slug,
        kind: f.kind,
        legal_name: f.legal_name.trim() || null,
        branch: { name: f.branch_name.trim(), code: f.branch_code.trim(), city: f.city.trim() || null, state_code: f.state_code || null },
        subscriptions: chosen.map((p) => ({ product_key: p, status: subs[p]!.status, plan_key: subs[p]!.plan_key || null, seats: subs[p]!.seats ? Number(subs[p]!.seats) : null })),
        admin: { email: f.admin_email.trim(), display_name: f.admin_name.trim() },
        ...(f.billing && f.state_code ? { billing: { legal_name: (f.legal_name || f.name).trim(), gstin: f.gstin.trim() || null, state_code: f.state_code, billing_email: f.billing_email.trim() || null } } : {}),
      };
      const r = await apost<{ org: { id: string } }>('/clients', body);
      window.location.href = `/admin/clients/${r.org.id}`;
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <PageTitle title={t('console.new.title')} subtitle={t('console.new.subtitle')} actions={<Link href="/admin" className="inline-flex min-h-[44px] items-center text-sm text-brand-700 underline">{t('console.back')}</Link>} />
      <Card title={t('console.new.client')}>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label={t('console.field.name')}>
            {(id) => (
              <Input
                id={id}
                required
                minLength={2}
                value={f.name}
                onChange={(e) => {
                  set('name', e.target.value);
                  if (!slugTouched) set('slug', slugify(e.target.value));
                }}
              />
            )}
          </Field>
          <Field label={t('console.field.slug')} hint={t('console.field.slug.hint')}>
            {(id) => (
              <Input
                id={id}
                required
                pattern="[a-z0-9][a-z0-9\-]{1,40}"
                value={f.slug}
                onChange={(e) => {
                  setSlugTouched(true);
                  set('slug', e.target.value);
                }}
              />
            )}
          </Field>
          <Field label={t('console.field.kind')}>{(id) => <Select id={id} value={f.kind} onChange={(e) => set('kind', e.target.value)} options={KINDS.map((k) => ({ value: k, label: t(`console.kind.${k}`) }))} />}</Field>
          <Field label={t('console.field.legalName')}>{(id) => <Input id={id} value={f.legal_name} onChange={(e) => set('legal_name', e.target.value)} />}</Field>
        </div>
      </Card>

      <Card title={t('console.new.firstBranch')}>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label={t('console.field.branchName')}>{(id) => <Input id={id} required minLength={2} value={f.branch_name} onChange={(e) => set('branch_name', e.target.value)} />}</Field>
          <Field label={t('console.field.branchCode')}>{(id) => <Input id={id} required value={f.branch_code} onChange={(e) => set('branch_code', e.target.value)} />}</Field>
          <Field label={t('console.field.city')}>{(id) => <Input id={id} value={f.city} onChange={(e) => set('city', e.target.value)} />}</Field>
          <Field label={t('console.field.state')} hint={t('console.field.state.hint')}>
            {(id) => <Select id={id} value={f.state_code} onChange={(e) => set('state_code', e.target.value)} placeholder={t('common.choose')} options={stateOptions} />}
          </Field>
        </div>
      </Card>

      <Card title={t('console.new.products')}>
        <p className="mb-3 text-sm text-slate-700">{t('console.new.products.hint')}</p>
        <div className="space-y-3">
          {PRODUCT_KEYS.map((p: ProductKey) => {
            const s = subs[p]!;
            const upd = (patch: Partial<typeof s>) => setSubs((x) => ({ ...x, [p]: { ...x[p]!, ...patch } }));
            return (
              <fieldset key={p} className="rounded-md border border-slate-200 p-3">
                <legend className="px-1 text-sm font-medium">{t(`console.product.${p}`)}</legend>
                <Checkbox label={t('console.new.includeProduct')} checked={s.on} onChange={(e) => upd({ on: e.target.checked })} />
                {s.on && (
                  <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-3">
                    <Field label={t('console.field.startAs')}>
                      {(id) => <Select id={id} value={s.status} onChange={(e) => upd({ status: e.target.value as 'trial' | 'active' })} options={['trial', 'active'].map((x) => ({ value: x, label: t(`console.sub.status.${x}`) }))} />}
                    </Field>
                    <Field label={t('console.field.plan')}>
                      {(id) => (
                        <Select
                          id={id}
                          value={s.plan_key}
                          onChange={(e) => upd({ plan_key: e.target.value })}
                          placeholder={t('console.field.noPlan')}
                          options={(plans.data ?? []).filter((x) => x.product_key === p && x.active).map((x) => ({ value: x.key, label: x.name }))}
                        />
                      )}
                    </Field>
                    <Field label={t('console.field.seats')}>{(id) => <Input id={id} type="number" min={1} inputMode="numeric" value={s.seats} onChange={(e) => upd({ seats: e.target.value })} />}</Field>
                  </div>
                )}
              </fieldset>
            );
          })}
        </div>
      </Card>

      <Card title={t('console.new.firstAdmin')}>
        <p className="mb-3 text-sm text-slate-700">{t('console.new.firstAdmin.hint')}</p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label={t('console.field.adminName')}>{(id) => <Input id={id} required minLength={2} value={f.admin_name} onChange={(e) => set('admin_name', e.target.value)} />}</Field>
          <Field label={t('console.field.adminEmail')}>{(id) => <Input id={id} type="email" required autoComplete="off" value={f.admin_email} onChange={(e) => set('admin_email', e.target.value)} />}</Field>
        </div>
      </Card>

      <Card title={t('console.new.billing')}>
        <Checkbox label={t('console.new.billing.add')} checked={f.billing} onChange={(e) => set('billing', e.target.checked)} />
        {f.billing && (
          <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label={t('console.field.gstin')} hint={t('console.field.gstin.hint')}>{(id) => <Input id={id} value={f.gstin} onChange={(e) => set('gstin', e.target.value.toUpperCase())} pattern="[0-9]{2}[A-Z0-9]{10}[0-9A-Z]Z[0-9A-Z]" />}</Field>
            <Field label={t('console.field.billingEmail')}>{(id) => <Input id={id} type="email" value={f.billing_email} onChange={(e) => set('billing_email', e.target.value)} />}</Field>
            {!f.state_code && <p className="text-sm text-amber-800 sm:col-span-2">{t('console.new.billing.needState')}</p>}
          </div>
        )}
      </Card>

      <Notice error={error} />
      <div className="flex gap-2">
        <Button type="submit" disabled={busy || !chosen.length}>
          {busy ? t('console.saving') : t('console.new.create')}
        </Button>
        {!chosen.length && <p className="self-center text-sm text-slate-700">{t('console.new.pickProduct')}</p>}
      </div>
    </form>
  );
}
