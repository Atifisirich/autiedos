'use client';
import { useState } from 'react';
import { PRODUCT_KEYS } from '@autoed/shared';
import { apatch, apost, useAdmin, useAdminApi } from '../../../_lib/admin';
import { Button, Card, Field, Input, Notice, Select, SubStatus, Textarea } from '../../../_lib/ui';

/** Which events an operator may try per status. The server runs the shared state machine and refuses the rest. */
const EVENTS: Record<string, string[]> = {
  trial: ['activate', 'suspend', 'cancel'],
  active: ['activate', 'mark_past_due', 'suspend', 'cancel'],
  past_due: ['activate', 'suspend', 'cancel', 'tick'],
  suspended: ['activate', 'cancel'],
  cancelled: [],
};

export function SubscriptionsTab({ orgId, detail, reload }: { orgId: string; detail: any; reload: () => Promise<void> }) {
  const { t, errorText, date } = useAdmin();
  const plans = useAdminApi<any[]>('/plans');
  const billing = useAdminApi<any>(`/clients/${orgId}/billing`);
  const [msg, setMsg] = useState<{ ok?: string; error?: string }>({});
  const subs: any[] = detail.subscriptions;
  const missing = PRODUCT_KEYS.filter((p) => !subs.some((s) => s.product_key === p));
  const [add, setAdd] = useState({ product_key: '', status: 'trial', plan_key: '', seats: '', trial_days: '' });

  async function run(fn: () => Promise<unknown>, ok: string) {
    setMsg({});
    try {
      await fn();
      await Promise.all([reload(), billing.reload()]);
      setMsg({ ok });
    } catch (e) {
      setMsg({ error: errorText(e) });
    }
  }

  return (
    <>
      <Notice ok={msg.ok} error={msg.error} />
      {subs.map((s) => (
        <SubscriptionCard key={s.product_key} orgId={orgId} sub={s} plans={(plans.data ?? []).filter((p) => p.product_key === s.product_key)} access={billing.data?.entitlements?.products?.[s.product_key]} run={run} />
      ))}
      {!subs.length && <p className="text-sm text-slate-700">{t('console.subs.none')}</p>}
      {missing.length > 0 && (
        <Card title={t('console.subs.add')}>
          <form
            className="grid grid-cols-1 gap-3 sm:grid-cols-5"
            onSubmit={(e) => {
              e.preventDefault();
              void run(
                () =>
                  apost(`/clients/${orgId}/subscriptions`, {
                    product_key: add.product_key,
                    status: add.status,
                    plan_key: add.plan_key || null,
                    seats: add.seats ? Number(add.seats) : null,
                    ...(add.status === 'trial' && add.trial_days ? { trial_days: Number(add.trial_days) } : {}),
                  }),
                t('console.saved'),
              );
            }}
          >
            <Field label={t('console.clients.product')}>
              {(id) => <Select id={id} required value={add.product_key} onChange={(e) => setAdd({ ...add, product_key: e.target.value, plan_key: '' })} placeholder={t('common.choose')} options={missing.map((p) => ({ value: p, label: t(`console.product.${p}`) }))} />}
            </Field>
            <Field label={t('console.field.startAs')}>
              {(id) => <Select id={id} value={add.status} onChange={(e) => setAdd({ ...add, status: e.target.value })} options={['trial', 'active'].map((x) => ({ value: x, label: t(`console.sub.status.${x}`) }))} />}
            </Field>
            <Field label={t('console.field.plan')}>
              {(id) => <Select id={id} value={add.plan_key} onChange={(e) => setAdd({ ...add, plan_key: e.target.value })} placeholder={t('console.field.noPlan')} options={(plans.data ?? []).filter((p) => p.product_key === add.product_key && p.active).map((p) => ({ value: p.key, label: p.name }))} />}
            </Field>
            <Field label={t('console.field.seats')}>{(id) => <Input id={id} type="number" min={1} inputMode="numeric" value={add.seats} onChange={(e) => setAdd({ ...add, seats: e.target.value })} />}</Field>
            <Field label={t('console.field.trialDays')} hint={t('console.field.trialDays.hint')}>
              {(id) => <Input id={id} type="number" min={1} max={365} inputMode="numeric" disabled={add.status !== 'trial'} value={add.trial_days} onChange={(e) => setAdd({ ...add, trial_days: e.target.value })} />}
            </Field>
            <div className="sm:col-span-5">
              <Button type="submit" disabled={!add.product_key}>
                {t('console.subs.addButton')}
              </Button>
            </div>
          </form>
        </Card>
      )}
      <p className="text-xs text-slate-600">{t('console.subs.dates', { today: date(new Date()) })}</p>
    </>
  );
}

function SubscriptionCard({ orgId, sub, plans, access, run }: { orgId: string; sub: any; plans: any[]; access: any; run: (fn: () => Promise<unknown>, ok: string) => Promise<void> }) {
  const { t, date } = useAdmin();
  const [edit, setEdit] = useState({ plan_key: (sub.plan_key ?? '') as string, seats: sub.seats ? String(sub.seats) : '', ends_on: (sub.ends_on ?? '') as string });
  const [ev, setEv] = useState({ event: '', reason: '', period_end: '' });
  const [restart, setRestart] = useState({ reason: '', status: 'trial' });
  const base = `/clients/${orgId}/subscriptions/${sub.product_key}`;
  const events = EVENTS[sub.status] ?? [];

  return (
    <Card
      title={
        <span className="flex flex-wrap items-center gap-2">
          {t(`console.product.${sub.product_key}`)} <SubStatus status={sub.status} />
        </span>
      }
    >
      <dl className="mb-4 grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-xs text-slate-600">{t('console.field.plan')}</dt>
          <dd>{sub.plan_key ?? t('console.none')}</dd>
        </div>
        <div>
          <dt className="text-xs text-slate-600">{t('console.field.seats')}</dt>
          <dd>{sub.seats ?? t('console.none')}</dd>
        </div>
        <div>
          <dt className="text-xs text-slate-600">{t('console.subs.period')}</dt>
          <dd>
            {date(sub.starts_on)} – {sub.ends_on ? date(sub.ends_on) : t('console.subs.openEnded')}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-slate-600">{t('console.subs.billingAccess')}</dt>
          <dd>{access ? t(`console.access.${access.access}`) : t('console.loading')}</dd>
          {access?.readOnlyUntil && access.access === 'read_only' && <dd className="text-xs text-slate-600">{t('console.subs.readOnlyUntil', { date: date(access.readOnlyUntil) })}</dd>}
        </div>
      </dl>

      <form
        className="grid grid-cols-1 gap-3 sm:grid-cols-4"
        onSubmit={(e) => {
          e.preventDefault();
          void run(() => apatch(base, { plan_key: edit.plan_key || null, seats: edit.seats ? Number(edit.seats) : null, ends_on: edit.ends_on || null }), t('console.saved'));
        }}
      >
        <Field label={t('console.field.plan')}>
          {(id) => <Select id={id} value={edit.plan_key} onChange={(e) => setEdit({ ...edit, plan_key: e.target.value })} placeholder={t('console.field.noPlan')} options={plans.filter((p) => p.active || p.key === sub.plan_key).map((p) => ({ value: p.key, label: p.name }))} />}
        </Field>
        <Field label={t('console.field.seats')}>{(id) => <Input id={id} type="number" min={1} inputMode="numeric" value={edit.seats} onChange={(e) => setEdit({ ...edit, seats: e.target.value })} />}</Field>
        <Field label={t('console.field.endsOn')}>{(id) => <Input id={id} type="date" value={edit.ends_on} onChange={(e) => setEdit({ ...edit, ends_on: e.target.value })} />}</Field>
        <div className="flex items-end">
          <Button type="submit" variant="secondary">
            {t('console.subs.saveChanges')}
          </Button>
        </div>
      </form>

      {events.length > 0 && (
        <form
          className="mt-4 grid grid-cols-1 gap-3 border-t border-slate-100 pt-4 sm:grid-cols-4"
          onSubmit={(e) => {
            e.preventDefault();
            void run(
              async () => {
                await apost(`${base}/transition`, { event: ev.event, reason: ev.reason.trim(), ...(ev.event === 'activate' && ev.period_end ? { period_end: ev.period_end } : {}) });
                setEv({ event: '', reason: '', period_end: '' });
              },
              t('console.subs.transitioned'),
            );
          }}
        >
          <Field label={t('console.subs.event')}>
            {(id) => <Select id={id} required value={ev.event} onChange={(e) => setEv({ ...ev, event: e.target.value })} placeholder={t('common.choose')} options={events.map((x) => ({ value: x, label: t(`console.transition.${x}`) }))} />}
          </Field>
          {ev.event === 'activate' && (
            <Field label={t('console.subs.paidUntil')} hint={t('console.subs.paidUntil.hint')}>
              {(id) => <Input id={id} type="date" value={ev.period_end} onChange={(e) => setEv({ ...ev, period_end: e.target.value })} />}
            </Field>
          )}
          <Field label={t('console.reason')} className="sm:col-span-2">
            {(id) => <Textarea id={id} rows={2} required minLength={5} value={ev.reason} onChange={(e) => setEv({ ...ev, reason: e.target.value })} />}
          </Field>
          <div className="sm:col-span-4">
            <Button type="submit" disabled={!ev.event || ev.reason.trim().length < 5} variant={ev.event === 'cancel' || ev.event === 'suspend' ? 'danger' : 'primary'}>
              {t('console.subs.apply')}
            </Button>
          </div>
        </form>
      )}

      {sub.status === 'cancelled' && (
        <form
          className="mt-4 grid grid-cols-1 gap-3 border-t border-slate-100 pt-4 sm:grid-cols-4"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => apost(`${base}/restart`, { reason: restart.reason.trim(), status: restart.status }), t('console.subs.restarted'));
          }}
        >
          <p className="text-sm text-slate-700 sm:col-span-4">{t('console.subs.restartHelp')}</p>
          <Field label={t('console.field.startAs')}>
            {(id) => <Select id={id} value={restart.status} onChange={(e) => setRestart({ ...restart, status: e.target.value })} options={['trial', 'active'].map((x) => ({ value: x, label: t(`console.sub.status.${x}`) }))} />}
          </Field>
          <Field label={t('console.reason')} className="sm:col-span-2">
            {(id) => <Textarea id={id} rows={2} required minLength={5} value={restart.reason} onChange={(e) => setRestart({ ...restart, reason: e.target.value })} />}
          </Field>
          <div className="flex items-end">
            <Button type="submit" disabled={restart.reason.trim().length < 5}>
              {t('console.subs.restart')}
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}
