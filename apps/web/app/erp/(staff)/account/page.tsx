import { getCtx, ROLE_LABEL } from '@/lib/erp/ctx';
import { erp } from '@/lib/erp/db';
import { Page, Card, Field } from '@/components/erp/ui';
import { go, str } from '@/lib/erp/fmt';
import { PRODUCT } from '@/lib/erp/nav';
import { signOut } from '@/lib/erp/actions';

export const metadata = { title: 'My account' };
async function ack(fd: FormData) {
  'use server';
  const ctx = await getCtx();
  const { error } = await erp(ctx.sb).from('policy_acks').insert({ policy_id: str(fd, 'id') });
  go('/erp/account', error ? error.message : 'Acknowledged.', error ? 'err' : 'ok');
}

export default async function Account() {
  const ctx = await getCtx();
  const [{ data: policies }, { data: acks }] = await Promise.all([
    erp(ctx.sb).from('policies').select('id, title, body, version, audience').eq('published', true).in('audience', ['staff', 'all']).is('deleted_at', null),
    erp(ctx.sb).from('policy_acks').select('policy_id').eq('user_id', ctx.user.id),
  ]);
  const done = new Set(((acks ?? []) as { policy_id: string }[]).map((a) => a.policy_id));
  const pol = (policies ?? []) as { id: string; title: string; body: string | null; version: string }[];
  const branch = ctx.branches.find((b) => b.id === ctx.orgUser.home_branch_id);
  return (
    <Page title="My account" sub={`${ROLE_LABEL[ctx.role] ?? ctx.role} · ${ctx.org.name}`}>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Profile">
          <div className="grid gap-3 p-4 sm:grid-cols-2">
            <Field label="Name"><input className="input" value={ctx.name} disabled readOnly /></Field>
            <Field label="Role"><input className="input" value={ROLE_LABEL[ctx.role] ?? ctx.role} disabled readOnly /></Field>
            <Field label="Branch"><input className="input" value={branch?.name ?? 'All branches'} disabled readOnly /></Field>
            <Field label="Staff code"><input className="input" value={ctx.staff?.employee_code ?? ''} disabled readOnly /></Field>
          </div>
          <p className="border-t border-line px-4 py-2 text-xs text-muted">Name, phone and role are kept by the school administrator (Staff and HR). Password and sign-in methods are managed in your login provider.</p>
        </Card>
        <Card title="Policies and handbook">
          {pol.length === 0 ? <div className="p-4 text-sm text-muted">No policies published.</div> : <ul className="divide-y divide-line text-sm">{pol.map((p) => (
            <li key={p.id} className="flex items-start justify-between gap-4 px-4 py-3"><div><div className="font-medium">{p.title} <span className="font-normal text-muted">v{p.version}</span></div>{p.body && <p className="mt-1 text-muted">{p.body.slice(0, 220)}</p>}</div>
              {done.has(p.id) ? <span className="text-xs text-emerald-700">Acknowledged</span> : <form action={ack}><input type="hidden" name="id" value={p.id} /><button className="btn-ghost btn-sm">I have read this</button></form>}</li>))}</ul>}
        </Card>
      </div>
      <form action={signOut} className="mt-6"><button className="btn-ghost">Sign out</button></form>
      <p className="mt-6 text-xs text-muted">{PRODUCT.name}</p>
    </Page>
  );
}
