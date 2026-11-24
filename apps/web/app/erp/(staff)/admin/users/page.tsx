import { requireCap, STAFF_ROLES, ROLE_LABEL } from '@/lib/erp/ctx';
import { core } from '@/lib/erp/db';
import { Page, Card, Empty, Badge } from '@/components/erp/ui';
import { go, str } from '@/lib/erp/fmt';

export const metadata = { title: 'Users and access' };
/**
 * Role and status changes for people who already have a login. Creating the login itself (the invitation e-mail) belongs to the platform
 * identity service, not to the ERP, so this screen manages access, not sign-up (decision 37: one login, one organisation).
 */
async function update(fd: FormData) {
  'use server';
  const ctx = await requireCap('admin', 'write');
  const uid = str(fd, 'user_id')!, role = str(fd, 'role')!, active = fd.get('active') === 'on';
  if (uid === ctx.user.id && (role !== ctx.role || !active)) go('/erp/admin/users', 'You cannot change your own role or suspend yourself.', 'err');
  const a = await core(ctx.sb).from('user_product_access').update({ role_key: role }).eq('user_id', uid).eq('product_key', 'erp').is('revoked_at', null);
  if (a.error) go('/erp/admin/users', a.error.message, 'err');
  const b = await core(ctx.sb).from('org_users').update({ status: active ? 'active' : 'disabled', home_branch_id: str(fd, 'branch_id') }).eq('user_id', uid);
  go('/erp/admin/users', b.error ? b.error.message : 'User updated.', b.error ? 'err' : 'ok');
}

export default async function Users() {
  const ctx = await requireCap('admin');
  const [{ data: users }, { data: access }, { data: staff }] = await Promise.all([
    core(ctx.sb).from('org_users').select('user_id, kind, display_name, status, home_branch_id').order('display_name').limit(2000),
    core(ctx.sb).from('user_product_access').select('user_id, role_key, product_key').eq('product_key', 'erp').is('revoked_at', null).limit(5000),
    core(ctx.sb).from('staff').select('user_id, employee_code, email').not('user_id', 'is', null).is('deleted_at', null).limit(5000),
  ]);
  const role = new Map(((access ?? []) as { user_id: string; role_key: string }[]).map((a) => [a.user_id, a.role_key]));
  const st = new Map(((staff ?? []) as { user_id: string; employee_code: string | null; email: string | null }[]).map((s) => [s.user_id, s]));
  const U = (users ?? []) as { user_id: string; kind: string; display_name: string; status: string; home_branch_id: string | null }[];
  const can = ctx.can('admin', 'write');
  return (
    <Page title="Users and access" sub="Who can sign in, with which role and for which branch. Parents and students are listed here but are managed from the family record.">
      <Card title={`People with a login (${U.length})`}>{U.length === 0 ? <Empty title="No users" /> : <div className="overflow-x-auto"><table className="tbl"><thead><tr><th>User</th><th>Type</th><th>Role</th><th>Branch</th><th>Active</th><th></th></tr></thead><tbody>{U.map((u) => {
        const r = role.get(u.user_id); const s = st.get(u.user_id); const staffUser = u.kind === 'staff';
        return <tr key={u.user_id}><td>{u.display_name}<div className="text-xs text-muted">{s?.email ?? s?.employee_code ?? ''}</div></td><td>{u.kind}</td>
          {can && staffUser ? <td colSpan={4}><form action={update} className="flex flex-wrap items-center gap-2"><input type="hidden" name="user_id" value={u.user_id} /><select name="role" defaultValue={r ?? ''} className="input !w-auto !py-1 text-xs" aria-label="Role">{!r && <option value="">No role</option>}{STAFF_ROLES.map((x) => <option key={x} value={x}>{ROLE_LABEL[x]}</option>)}</select><select name="branch_id" defaultValue={u.home_branch_id ?? ''} className="input !w-auto !py-1 text-xs" aria-label="Branch"><option value="">All branches</option>{ctx.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select><label className="flex items-center gap-1 text-xs"><input type="checkbox" name="active" defaultChecked={u.status === 'active'} />active</label><button className="btn-ghost btn-sm">Save</button></form></td>
            : <><td>{r ? <Badge tone="teal">{ROLE_LABEL[r] ?? r}</Badge> : '—'}</td><td>{ctx.branches.find((b) => b.id === u.home_branch_id)?.name ?? 'All'}</td><td>{u.status === 'active' ? 'Yes' : 'No'}</td><td /></>}</tr>;
      })}</tbody></table></div>}</Card>
      <p className="mt-3 text-xs text-muted">New logins are created by the platform identity service (invitation by e-mail), after which they appear here for a role to be assigned.</p>
    </Page>
  );
}
