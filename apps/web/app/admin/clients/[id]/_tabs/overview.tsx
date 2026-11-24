'use client';
import { useState } from 'react';
import { GST_STATE_CODES, PRODUCT_KEYS } from '@autoed/shared';
import { apatch, apost, aput, useAdmin } from '../../../_lib/admin';
import { Badge, Button, Card, Checkbox, DataTable, Field, Input, Notice, ReasonAction, Select } from '../../../_lib/ui';

const KINDS = ['school', 'coaching_centre', 'college', 'other'];
const stateOptions = Object.entries(GST_STATE_CODES).map(([code, name]) => ({ value: code, label: `${code} ${name}` }));

export function OverviewTab({ detail, reload }: { detail: any; reload: () => Promise<void> }) {
  const { t, errorText, dateTime, date } = useAdmin();
  const c = detail.client;
  const orgId = c.id as string;
  const [f, setF] = useState({ name: c.name as string, legal_name: (c.legal_name ?? '') as string, kind: c.kind as string, default_locale: c.default_locale as string });
  const [msg, setMsg] = useState<{ ok?: string; error?: string }>({});
  const [branch, setBranch] = useState({ name: '', code: '', city: '', state_code: '' });

  async function run(fn: () => Promise<unknown>, ok: string) {
    setMsg({});
    try {
      await fn();
      await reload();
      setMsg({ ok });
    } catch (e) {
      setMsg({ error: errorText(e) });
    }
  }

  const subscribed: string[] = detail.subscriptions.map((s: any) => s.product_key);
  const switchOn = (branchId: string, product: string) => detail.branch_products.find((b: any) => b.branch_id === branchId && b.product_key === product)?.enabled !== false;

  return (
    <>
      <Notice ok={msg.ok} error={msg.error} />
      <Card title={t('console.overview.details')}>
        <form
          className="grid grid-cols-1 gap-3 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => apatch(`/clients/${orgId}`, { name: f.name.trim(), legal_name: f.legal_name.trim() || null, kind: f.kind, default_locale: f.default_locale }), t('console.saved'));
          }}
        >
          <Field label={t('console.field.name')}>{(id) => <Input id={id} required minLength={2} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field>
          <Field label={t('console.field.legalName')}>{(id) => <Input id={id} value={f.legal_name} onChange={(e) => setF({ ...f, legal_name: e.target.value })} />}</Field>
          <Field label={t('console.field.kind')}>{(id) => <Select id={id} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })} options={KINDS.map((k) => ({ value: k, label: t(`console.kind.${k}`) }))} />}</Field>
          <Field label={t('console.field.locale')}>
            {(id) => <Select id={id} value={f.default_locale} onChange={(e) => setF({ ...f, default_locale: e.target.value })} options={['en', 'hi', 'te'].map((l) => ({ value: l, label: t(`console.locale.${l}`) }))} />}
          </Field>
          <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
            <Button type="submit">{t('console.save')}</Button>
            <span className="text-xs text-slate-600">
              {t('console.createdOn', { date: date(c.created_at) })} · {t('console.lastLogin', { date: dateTime(c.stats.last_login_at) })}
            </span>
          </div>
        </form>
      </Card>

      <Card title={t('console.overview.suspendTitle')}>
        <p className="mb-3 text-sm text-slate-700">{c.client_status === 'active' ? t('console.overview.suspendHelp') : t('console.overview.reactivateHelp')}</p>
        {c.client_status === 'active' ? (
          <ReasonAction variant="danger" label={t('console.overview.suspend')} confirmLabel={t('console.overview.suspendConfirm')} onConfirm={(reason) => run(() => apost(`/clients/${orgId}/suspend`, { reason }), t('console.overview.suspendedOk'))} />
        ) : (
          <ReasonAction variant="primary" label={t('console.overview.reactivate')} confirmLabel={t('console.overview.reactivateConfirm')} onConfirm={(reason) => run(() => apost(`/clients/${orgId}/reactivate`, { reason }), t('console.overview.reactivatedOk'))} />
        )}
      </Card>

      <Card title={t('console.branches.title')}>
        <DataTable
          caption={t('console.branches.title')}
          rows={detail.branches}
          rowKey={(b: any) => b.id}
          columns={[
            { key: 'name', header: t('console.field.branchName'), render: (b: any) => <span>{b.name}</span> },
            { key: 'code', header: t('console.field.branchCode'), render: (b: any) => b.code },
            { key: 'state', header: t('console.field.state'), render: (b: any) => (b.state_code ? `${b.state_code} ${(GST_STATE_CODES as Record<string, string>)[b.state_code] ?? ''}` : t('console.none')) },
            { key: 'active', header: t('console.branches.active'), render: (b: any) => <Badge tone={b.active ? 'green' : 'gray'}>{b.active ? t('console.yes') : t('console.no')}</Badge> },
            ...(subscribed.length
              ? [
                  {
                    key: 'products',
                    header: t('console.branches.productsOn'),
                    render: (b: any) => (
                      <div className="flex flex-wrap gap-x-3">
                        {PRODUCT_KEYS.filter((p) => subscribed.includes(p)).map((p) => (
                          <Checkbox
                            key={p}
                            label={t(`console.product.${p}`)}
                            checked={switchOn(b.id, p)}
                            onChange={(e) => void run(() => aput(`/clients/${orgId}/branch-products`, { branch_id: b.id, product_key: p, enabled: e.target.checked }), t('console.saved'))}
                          />
                        ))}
                      </div>
                    ),
                  },
                ]
              : []),
            {
              key: 'toggle',
              header: <span className="sr-only">{t('console.actions')}</span>,
              render: (b: any) => (
                <Button size="sm" variant="secondary" onClick={() => void run(() => apatch(`/clients/${orgId}/branches/${b.id}`, { name: b.name, code: b.code, city: b.city, state_code: b.state_code, time_zone: b.time_zone, active: !b.active }), t('console.saved'))}>
                  {b.active ? t('console.branches.deactivate') : t('console.branches.activate')}
                </Button>
              ),
            },
          ]}
        />
        <p className="mt-2 text-xs text-slate-600">{t('console.branches.switchHelp')}</p>
        <form
          className="mt-4 grid grid-cols-1 gap-3 border-t border-slate-100 pt-4 sm:grid-cols-4"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await apost(`/clients/${orgId}/branches`, { name: branch.name.trim(), code: branch.code.trim(), city: branch.city.trim() || null, state_code: branch.state_code || null, active: true });
              setBranch({ name: '', code: '', city: '', state_code: '' });
            }, t('console.saved'));
          }}
        >
          <Field label={t('console.field.branchName')}>{(id) => <Input id={id} required minLength={2} value={branch.name} onChange={(e) => setBranch({ ...branch, name: e.target.value })} />}</Field>
          <Field label={t('console.field.branchCode')}>{(id) => <Input id={id} required value={branch.code} onChange={(e) => setBranch({ ...branch, code: e.target.value })} />}</Field>
          <Field label={t('console.field.city')}>{(id) => <Input id={id} value={branch.city} onChange={(e) => setBranch({ ...branch, city: e.target.value })} />}</Field>
          <Field label={t('console.field.state')}>
            {(id) => <Select id={id} value={branch.state_code} onChange={(e) => setBranch({ ...branch, state_code: e.target.value })} placeholder={t('common.choose')} options={stateOptions} />}
          </Field>
          <div className="sm:col-span-4">
            <Button type="submit">{t('console.branches.add')}</Button>
          </div>
        </form>
      </Card>
    </>
  );
}
