'use client';
import { useState } from 'react';
import { adel, apost, aput, useAdmin, useAdminApi } from '../../../_lib/admin';
import { Badge, Button, Card, Checkbox, Field, Input, Notice, ReasonAction, Select } from '../../../_lib/ui';
import { PreviewPanel } from './preview';

type Run = (fn: () => Promise<unknown>, ok: string) => Promise<void>;

export function UsersTab({ orgId, detail }: { orgId: string; detail: any }) {
  const { t, errorText } = useAdmin();
  const users = useAdminApi<any[]>(`/clients/${orgId}/users`);
  const roles = useAdminApi<any[]>(`/clients/${orgId}/roles`);
  const [msg, setMsg] = useState<{ ok?: string; error?: string }>({});
  const [preview, setPreview] = useState<string | null>(null);
  const subscribed: string[] = detail.subscriptions.map((s: any) => s.product_key);

  const run: Run = async (fn, ok) => {
    setMsg({});
    try {
      await fn();
      await users.reload();
      setMsg({ ok });
    } catch (e) {
      setMsg({ error: errorText(e) });
    }
  };

  return (
    <>
      <Notice ok={msg.ok} error={msg.error ?? (users.error ? errorText(users.error) : null)} />
      <InviteCard orgId={orgId} detail={detail} subscribed={subscribed} roles={roles.data ?? []} run={run} />
      <Card title={t('console.users.title', { count: users.data?.length ?? 0 })}>
        {!users.data && <p className="text-sm text-slate-700">{t('console.loading')}</p>}
        {users.data && !users.data.length && <p className="text-sm text-slate-700">{t('console.users.empty')}</p>}
        <ul className="divide-y divide-slate-100">
          {users.data?.map((u) => (
            <li key={u.user_id} className="py-4 first:pt-0 last:pb-0">
              <UserRow orgId={orgId} u={u} detail={detail} subscribed={subscribed} roles={roles.data ?? []} run={run} onPreview={() => setPreview(preview === u.user_id ? null : u.user_id)} previewing={preview === u.user_id} />
              {preview === u.user_id && <PreviewPanel orgId={orgId} userId={u.user_id} />}
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}

function InviteCard({ orgId, detail, subscribed, roles, run }: { orgId: string; detail: any; subscribed: string[]; roles: any[]; run: Run }) {
  const { t } = useAdmin();
  const [f, setF] = useState({ email: '', display_name: '', kind: 'staff', home_branch_id: '' });
  const [acc, setAcc] = useState<Record<string, { on: boolean; role: string }>>({});
  const roleOptions = (p: string) => roles.filter((r) => r.product_key === p).map((r) => ({ value: r.key, label: r.name }));
  return (
    <Card title={t('console.users.invite')}>
      <form
        className="grid grid-cols-1 gap-3 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          void run(
            async () => {
              await apost(`/clients/${orgId}/users`, {
                email: f.email.trim(),
                display_name: f.display_name.trim(),
                kind: f.kind,
                home_branch_id: f.home_branch_id || null,
                access: subscribed.filter((p) => acc[p]?.on).map((p) => ({ product_key: p, role_key: acc[p]!.role || 'admin' })),
              });
              setF({ email: '', display_name: '', kind: 'staff', home_branch_id: '' });
              setAcc({});
            },
            t('console.users.invited'),
          );
        }}
      >
        <Field label={t('console.field.adminName')}>{(id) => <Input id={id} required minLength={2} value={f.display_name} onChange={(e) => setF({ ...f, display_name: e.target.value })} />}</Field>
        <Field label={t('console.field.adminEmail')}>{(id) => <Input id={id} type="email" required autoComplete="off" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />}</Field>
        <Field label={t('console.users.kind')}>
          {(id) => <Select id={id} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })} options={['staff', 'guardian', 'parent', 'student'].map((k) => ({ value: k, label: t(`console.memberKind.${k}`) }))} />}
        </Field>
        <Field label={t('console.users.homeBranch')} hint={t('console.users.homeBranch.hint')}>
          {(id) => <Select id={id} value={f.home_branch_id} onChange={(e) => setF({ ...f, home_branch_id: e.target.value })} placeholder={t('console.users.allBranches')} options={detail.branches.map((b: any) => ({ value: b.id, label: b.name }))} />}
        </Field>
        <fieldset className="sm:col-span-2">
          <legend className="mb-1 text-sm font-medium text-slate-800">{t('console.users.productAccess')}</legend>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {subscribed.map((p) => (
              <div key={p} className="rounded-md border border-slate-200 p-2">
                <Checkbox label={t(`console.product.${p}`)} checked={!!acc[p]?.on} onChange={(e) => setAcc({ ...acc, [p]: { on: e.target.checked, role: acc[p]?.role ?? 'admin' } })} />
                {acc[p]?.on && (
                  <Field label={t('console.users.role')}>{(id) => <Select id={id} value={acc[p]?.role ?? 'admin'} onChange={(e) => setAcc({ ...acc, [p]: { on: true, role: e.target.value } })} options={roleOptions(p)} />}</Field>
                )}
              </div>
            ))}
          </div>
        </fieldset>
        <div className="sm:col-span-2">
          <Button type="submit">{t('console.users.sendInvite')}</Button>
        </div>
      </form>
    </Card>
  );
}

function ConfirmButton({ label, confirmLabel, onConfirm }: { label: string; confirmLabel: string; onConfirm: () => Promise<void> }) {
  const { t } = useAdmin();
  const [ask, setAsk] = useState(false);
  if (!ask)
    return (
      <Button size="sm" variant="ghost" onClick={() => setAsk(true)}>
        {label}
      </Button>
    );
  return (
    <span className="inline-flex gap-1">
      <Button size="sm" variant="danger" onClick={() => void onConfirm().finally(() => setAsk(false))}>
        {confirmLabel}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setAsk(false)}>
        {t('console.cancel')}
      </Button>
    </span>
  );
}

function UserRow({ orgId, u, detail, subscribed, roles, run, onPreview, previewing }: { orgId: string; u: any; detail: any; subscribed: string[]; roles: any[]; run: Run; onPreview: () => void; previewing: boolean }) {
  const { t, dateTime } = useAdmin();
  const [grant, setGrant] = useState({ product_key: '', role_key: '' });
  const base = `/clients/${orgId}/users/${u.user_id}`;
  const branch = detail.branches.find((b: any) => b.id === u.home_branch_id);
  const next = u.status === 'active' ? 'disabled' : 'active';
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="font-medium text-slate-900">{u.display_name}</h3>
          <p className="text-sm text-slate-700">
            {u.email ?? u.phone ?? t('console.none')} · {t(`console.memberKind.${u.kind}`)} · {branch ? branch.name : t('console.users.allBranches')}
          </p>
          <p className="text-xs text-slate-600">{t('console.lastLogin', { date: dateTime(u.last_login_at) })}</p>
        </div>
        <div className="flex flex-wrap gap-1">
          <Badge tone={u.status === 'active' ? 'green' : u.status === 'invited' ? 'blue' : 'gray'}>{t(`console.userStatus.${u.status}`)}</Badge>
          {u.locked && <Badge tone="red">{t('console.users.locked')}</Badge>}
          {u.must_change_password && <Badge tone="amber">{t('console.users.mustChange')}</Badge>}
        </div>
      </div>

      <div>
        <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-700">{t('console.users.productAccess')}</p>
        {u.access.length === 0 && <p className="text-sm text-slate-600">{t('console.users.noAccess')}</p>}
        <ul className="flex flex-wrap gap-2">
          {u.access.map((a: any) => (
            <li key={a.product_key} className="flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-sm">
              <span>
                {t(`console.product.${a.product_key}`)} · {a.role_key}
              </span>
              <ConfirmButton label={t('console.users.revoke')} confirmLabel={t('console.users.revokeConfirm')} onConfirm={() => run(() => adel(`${base}/access/${a.product_key}`), t('console.saved'))} />
            </li>
          ))}
        </ul>
        <form
          className="mt-2 flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await aput(`${base}/access`, grant);
              setGrant({ product_key: '', role_key: '' });
            }, t('console.saved'));
          }}
        >
          <Field label={t('console.clients.product')}>
            {(id) => <Select id={id} required value={grant.product_key} onChange={(e) => setGrant({ product_key: e.target.value, role_key: '' })} placeholder={t('common.choose')} options={subscribed.map((p) => ({ value: p, label: t(`console.product.${p}`) }))} />}
          </Field>
          <Field label={t('console.users.role')}>
            {(id) => <Select id={id} required value={grant.role_key} onChange={(e) => setGrant({ ...grant, role_key: e.target.value })} placeholder={t('common.choose')} options={roles.filter((r) => r.product_key === grant.product_key).map((r) => ({ value: r.key, label: r.name }))} />}
          </Field>
          <Button type="submit" size="sm" variant="secondary" disabled={!grant.product_key || !grant.role_key}>
            {t('console.users.grant')}
          </Button>
        </form>
      </div>

      <div className="flex flex-wrap items-start gap-2">
        <ReasonAction
          label={u.locked ? t('console.users.unlock') : t('console.users.lock')}
          confirmLabel={u.locked ? t('console.users.unlockConfirm') : t('console.users.lockConfirm')}
          variant={u.locked ? 'secondary' : 'danger'}
          onConfirm={(reason) => run(() => apost(`${base}/lock`, { locked: !u.locked, reason }), t('console.saved'))}
        />
        <ReasonAction
          label={u.must_change_password ? t('console.users.clearForceReset') : t('console.users.forceReset')}
          confirmLabel={t('console.users.forceResetConfirm')}
          onConfirm={(reason) => run(() => apost(`${base}/force-password-reset`, { required: !u.must_change_password, reason }), t('console.saved'))}
        />
        <ReasonAction
          label={t(`console.users.set.${next}`)}
          confirmLabel={t(`console.users.set.${next}`)}
          variant={next === 'disabled' ? 'danger' : 'secondary'}
          onConfirm={(reason) => run(() => apost(`${base}/status`, { status: next, reason }), t('console.saved'))}
        />
        <Button size="sm" variant="secondary" aria-expanded={previewing} onClick={onPreview}>
          {t('console.users.preview')}
        </Button>
      </div>
    </div>
  );
}
