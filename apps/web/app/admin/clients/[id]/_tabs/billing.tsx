'use client';
import { useEffect, useState } from 'react';
import { GST_STATE_CODES, PRODUCT_KEYS } from '@autoed/shared';
import { aget, apost, aput, useAdmin, useAdminApi } from '../../../_lib/admin';
import { Badge, Button, Card, DataTable, Field, Input, Notice, ReasonAction, Select, SubStatus } from '../../../_lib/ui';

const stateOptions = Object.entries(GST_STATE_CODES).map(([code, name]) => ({ value: code, label: `${code} ${name}` }));
const toPaise = (rupees: string) => Math.round(Number(rupees) * 100);

interface Line {
  product_key: string;
  description: string;
  quantity: string;
  unit: string;
  discount: string;
}

/** Billing profile, entitlements by the billing rules, usage, payments, and DRAFT GST invoices (no live Razorpay call). */
export function BillingTab({ orgId, detail }: { orgId: string; detail: any }) {
  const { t, errorText, money, date, dateTime } = useAdmin();
  const b = useAdminApi<any>(`/clients/${orgId}/billing`);
  const [msg, setMsg] = useState<{ ok?: string; error?: string }>({});
  const [acct, setAcct] = useState({ legal_name: '', gstin: '', state_code: '', billing_email: '', address: '' });
  const [lines, setLines] = useState<Line[]>([{ product_key: '', description: '', quantity: '1', unit: '', discount: '' }]);
  const [invDate, setInvDate] = useState('');
  const [shown, setShown] = useState<any>(null);
  const a = b.data?.account;

  useEffect(() => {
    if (b.data) {
      const x = b.data.account;
      setAcct({ legal_name: x?.legal_name ?? detail.client.legal_name ?? detail.client.name, gstin: x?.gstin ?? '', state_code: x?.state_code ?? '', billing_email: x?.billing_email ?? '', address: x?.address ?? '' });
    }
    // Only when the loaded account changes, not on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [b.data?.account]);

  async function run(fn: () => Promise<unknown>, ok: string) {
    setMsg({});
    try {
      await fn();
      await b.reload();
      setMsg({ ok });
    } catch (e) {
      setMsg({ error: errorText(e) });
    }
  }

  async function suggest() {
    const s = await aget<any[]>(`/clients/${orgId}/invoice-suggestion`).catch(() => []);
    if (s.length) setLines(s.map((x) => ({ product_key: x.product_key, description: x.description, quantity: String(x.quantity), unit: String(x.unit_price_paise / 100), discount: '' })));
  }

  const upd = (i: number, patch: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const d = b.data;

  return (
    <>
      <Notice ok={msg.ok} error={msg.error ?? (b.error ? errorText(b.error) : null)} />
      {d && (
        <>
          <Card title={t('console.billing.entitlements')}>
            <p className="mb-2 text-xs text-slate-600">{t('console.billing.entitlements.help')}</p>
            <DataTable
              caption={t('console.billing.entitlements')}
              rows={PRODUCT_KEYS.map((p) => ({ p, e: d.entitlements.products[p], s: d.subscriptions.find((x: any) => x.product_key === p) }))}
              rowKey={(r) => r.p}
              columns={[
                { key: 'p', header: t('console.clients.product'), render: (r) => t(`console.product.${r.p}`) },
                { key: 's', header: t('console.clients.status'), render: (r) => (r.s ? <SubStatus status={r.s.status} /> : t('console.none')) },
                { key: 'a', header: t('console.subs.billingAccess'), render: (r) => <Badge tone={r.e.access === 'full' ? 'green' : r.e.access === 'read_only' ? 'amber' : 'gray'}>{t(`console.access.${r.e.access}`)}</Badge> },
                { key: 'u', header: t('console.billing.until'), render: (r) => (r.e.access === 'read_only' ? date(r.e.readOnlyUntil) : r.e.fullAccessEndsAt ? date(r.e.fullAccessEndsAt) : t('console.none')) },
              ]}
            />
            <p className="mt-2 text-xs text-slate-600">
              {t('console.billing.razorpay', { mode: t(`console.razorpayMode.${d.razorpay_mode}`) })} · {t('console.billing.wallets')}
            </p>
          </Card>

          <Card title={t('console.billing.account')}>
            <form
              className="grid grid-cols-1 gap-3 sm:grid-cols-2"
              onSubmit={(e) => {
                e.preventDefault();
                void run(() => aput(`/clients/${orgId}/billing-account`, { legal_name: acct.legal_name.trim(), gstin: acct.gstin.trim() || null, state_code: acct.state_code, billing_email: acct.billing_email.trim() || null, address: acct.address.trim() || null }), t('console.saved'));
              }}
            >
              <Field label={t('console.field.legalName')}>{(id) => <Input id={id} required minLength={2} value={acct.legal_name} onChange={(e) => setAcct({ ...acct, legal_name: e.target.value })} />}</Field>
              <Field label={t('console.field.state')} hint={t('console.field.state.hint')}>
                {(id) => <Select id={id} required value={acct.state_code} onChange={(e) => setAcct({ ...acct, state_code: e.target.value })} placeholder={t('common.choose')} options={stateOptions} />}
              </Field>
              <Field label={t('console.field.gstin')} hint={t('console.field.gstin.hint')}>
                {(id) => <Input id={id} value={acct.gstin} pattern="[0-9]{2}[A-Z0-9]{10}[0-9A-Z]Z[0-9A-Z]" onChange={(e) => setAcct({ ...acct, gstin: e.target.value.toUpperCase() })} />}
              </Field>
              <Field label={t('console.field.billingEmail')}>{(id) => <Input id={id} type="email" value={acct.billing_email} onChange={(e) => setAcct({ ...acct, billing_email: e.target.value })} />}</Field>
              <div className="sm:col-span-2">
                <Button type="submit">{t('console.save')}</Button>
              </div>
            </form>
          </Card>

          <Card title={t('console.billing.usage')}>
            <DataTable
              caption={t('console.billing.usage')}
              rows={d.usage}
              rowKey={(u: any) => `${u.month}${u.product_key}${u.metric}`}
              empty={t('console.billing.usage.none')}
              columns={[
                { key: 'm', header: t('console.billing.month'), render: (u: any) => date(u.month) },
                { key: 'p', header: t('console.clients.product'), render: (u: any) => (u.product_key ? t(`console.product.${u.product_key}`) : t('console.none')) },
                { key: 'k', header: t('console.billing.metric'), render: (u: any) => t(`console.metric.${u.metric}`) },
                { key: 'q', header: t('console.billing.quantity'), render: (u: any) => u.quantity },
              ]}
            />
          </Card>

          <Card title={t('console.billing.invoices')}>
            <DataTable
              caption={t('console.billing.invoices')}
              rows={d.invoices}
              rowKey={(i: any) => i.id}
              empty={t('console.billing.invoices.none')}
              columns={[
                { key: 'n', header: t('console.billing.number'), render: (i: any) => <button type="button" className="min-h-[36px] text-brand-700 underline" onClick={() => void aget(`/invoices/${i.id}`).then(setShown).catch((e) => setMsg({ error: errorText(e) }))}>{i.invoice_number}</button> },
                { key: 'd', header: t('console.billing.date'), render: (i: any) => date(i.invoice_date) },
                { key: 's', header: t('console.clients.status'), render: (i: any) => <Badge tone={i.status === 'draft' ? 'blue' : i.status === 'void' ? 'gray' : 'green'}>{t(`console.invoiceStatus.${i.status}`)}</Badge> },
                { key: 't', header: t('console.billing.taxable'), render: (i: any) => money(i.taxable_paise) },
                { key: 'g', header: t('console.billing.gst'), render: (i: any) => money(i.cgst_paise + i.sgst_paise + i.igst_paise) },
                { key: 'tot', header: t('console.billing.total'), render: (i: any) => money(i.total_paise) },
              ]}
            />
            {shown && (
              <section aria-label={t('console.billing.invoiceDetail')} className="mt-4 rounded-md border border-slate-300 bg-slate-50 p-3 text-sm">
                <h3 className="font-medium">{shown.invoice_number}</h3>
                <p className="text-xs text-slate-700">
                  {t('console.billing.supplyFrom', { supplier: shown.supplier_state_code, place: shown.place_of_supply })} · {shown.customer_legal_name}
                </p>
                <ul className="my-2 space-y-1">
                  {shown.lines.map((l: any) => (
                    <li key={l.id}>
                      {l.description} · {l.quantity} × {money(l.unit_paise)} · {t('console.billing.sac')} {l.sac_code} · {l.gst_rate}%
                    </li>
                  ))}
                </ul>
                <p>
                  {t('console.billing.taxable')}: {money(shown.taxable_paise)} · {t('console.billing.cgst')}: {money(shown.cgst_paise)} · {t('console.billing.sgst')}: {money(shown.sgst_paise)} · {t('console.billing.igst')}: {money(shown.igst_paise)} · <strong>{money(shown.total_paise)}</strong>
                </p>
                {shown.status === 'draft' && (
                  <div className="mt-2">
                    <ReasonAction
                      variant="danger"
                      label={t('console.billing.void')}
                      confirmLabel={t('console.billing.voidConfirm')}
                      onConfirm={(reason) => run(async () => setShown(await apost(`/invoices/${shown.id}/void`, { reason })), t('console.saved'))}
                    />
                  </div>
                )}
              </section>
            )}
          </Card>

          <Card title={t('console.billing.create')}>
            <p className="mb-3 text-sm text-slate-700">{t('console.billing.create.help')}</p>
            {!a && <p className="mb-3 text-sm text-amber-900">{t('console.billing.needAccount')}</p>}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void run(
                  async () => {
                    const inv = await apost(`/clients/${orgId}/invoices`, {
                      ...(invDate ? { invoice_date: invDate } : {}),
                      lines: lines.map((l) => ({ ...(l.product_key ? { product_key: l.product_key } : {}), description: l.description.trim(), quantity: Number(l.quantity), unit_price_paise: toPaise(l.unit), ...(l.discount ? { discount_paise: toPaise(l.discount) } : {}) })),
                    });
                    setShown(inv);
                    setLines([{ product_key: '', description: '', quantity: '1', unit: '', discount: '' }]);
                  },
                  t('console.billing.created'),
                );
              }}
              className="space-y-3"
            >
              <Field label={t('console.billing.date')} hint={t('console.billing.date.hint')} className="max-w-xs">
                {(id) => <Input id={id} type="date" value={invDate} onChange={(e) => setInvDate(e.target.value)} />}
              </Field>
              {lines.map((l, i) => (
                <fieldset key={i} className="grid grid-cols-1 gap-3 rounded-md border border-slate-200 p-3 sm:grid-cols-6">
                  <legend className="px-1 text-xs text-slate-700">{t('console.billing.line', { n: i + 1 })}</legend>
                  <Field label={t('console.clients.product')}>
                    {(id) => <Select id={id} value={l.product_key} onChange={(e) => upd(i, { product_key: e.target.value })} placeholder={t('console.none')} options={PRODUCT_KEYS.map((p) => ({ value: p, label: t(`console.product.${p}`) }))} />}
                  </Field>
                  <Field label={t('console.billing.description')} className="sm:col-span-2">
                    {(id) => <Input id={id} required minLength={2} value={l.description} onChange={(e) => upd(i, { description: e.target.value })} />}
                  </Field>
                  <Field label={t('console.field.quantity')}>{(id) => <Input id={id} type="number" min={1} step={1} required inputMode="numeric" value={l.quantity} onChange={(e) => upd(i, { quantity: e.target.value })} />}</Field>
                  <Field label={t('console.billing.unitPrice')} hint={t('console.billing.exGst')}>
                    {(id) => <Input id={id} type="number" min={0} step="0.01" required inputMode="decimal" value={l.unit} onChange={(e) => upd(i, { unit: e.target.value })} />}
                  </Field>
                  <Field label={t('console.billing.discount')}>{(id) => <Input id={id} type="number" min={0} step="0.01" inputMode="decimal" value={l.discount} onChange={(e) => upd(i, { discount: e.target.value })} />}</Field>
                  {lines.length > 1 && (
                    <div className="sm:col-span-6">
                      <Button size="sm" variant="ghost" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>
                        {t('console.billing.removeLine')}
                      </Button>
                    </div>
                  )}
                </fieldset>
              ))}
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" onClick={() => setLines((ls) => [...ls, { product_key: '', description: '', quantity: '1', unit: '', discount: '' }])}>
                  {t('console.billing.addLine')}
                </Button>
                <Button variant="secondary" onClick={() => void suggest()}>
                  {t('console.billing.fromPlans')}
                </Button>
                <Button type="submit" disabled={!a}>
                  {t('console.billing.createDraft')}
                </Button>
              </div>
            </form>
          </Card>

          <Card title={t('console.billing.payments')}>
            <DataTable
              caption={t('console.billing.payments')}
              rows={d.payments}
              rowKey={(p: any) => p.id}
              empty={t('console.billing.payments.none')}
              columns={[
                { key: 'd', header: t('console.billing.date'), render: (p: any) => dateTime(p.captured_at ?? p.created_at) },
                { key: 'a', header: t('console.billing.total'), render: (p: any) => money(p.amount_paise) },
                { key: 'm', header: t('console.billing.method'), render: (p: any) => p.method ?? t('console.none') },
                { key: 's', header: t('console.clients.status'), render: (p: any) => <Badge tone={p.status === 'captured' ? 'green' : p.status === 'failed' ? 'red' : 'gray'}>{t(`console.paymentStatus.${p.status}`)}</Badge> },
              ]}
            />
          </Card>
        </>
      )}
    </>
  );
}
