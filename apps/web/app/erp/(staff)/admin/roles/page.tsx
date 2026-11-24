import { requireCap, STAFF_ROLES, ROLE_LABEL } from '@/lib/erp/ctx';
import { core } from '@/lib/erp/db';
import { CAP_MODULES, LEVELS, LEVEL_LABEL, levelOf, levelRows, type Level } from '@/lib/erp/caps';
import { Page, Card } from '@/components/erp/ui';
import { go } from '@/lib/erp/fmt';

export const metadata = { title: 'Roles and permissions' };
const CAPS = Object.keys(CAP_MODULES);
type P = { role_id: string; module_key: string; action: string; scope: string };

/** Save the matrix: only cells that changed are rewritten, as the platform's (module, action, scope) rows. The group admin is fixed so nobody can be locked out. */
async function save(fd: FormData) {
  'use server';
  const ctx = await requireCap('admin', 'write');
  const c = core(ctx.sb);
  const { data: roles } = await c.from('roles').select('id, key').eq('product_key', 'erp');
  const { data: perms } = await c.from('role_permissions').select('role_id, module_key, action, scope');
  const R = (roles ?? []) as { id: string; key: string }[], P = (perms ?? []) as P[];
  let changed = 0;
  for (const role of R) {
    if (role.key === 'group_admin' || !(STAFF_ROLES as readonly string[]).includes(role.key)) continue;
    const mine = P.filter((p) => p.role_id === role.id);
    for (const cap of CAPS) {
      const want = String(fd.get(`${role.key}:${cap}`) ?? '-') as Level;
      if (!LEVELS.includes(want) || want === levelOf(cap, mine)) continue;
      const mods = CAP_MODULES[cap]!;
      const del = await c.from('role_permissions').delete().eq('role_id', role.id).in('module_key', mods);
      if (del.error) go('/erp/admin/roles', del.error.message, 'err');
      const rows = mods.flatMap((m) => levelRows(want).map((r) => ({ org_id: ctx.orgId, role_id: role.id, module_key: m, action: r.action, scope: r.scope })));
      if (rows.length) { const ins = await c.from('role_permissions').insert(rows); if (ins.error) go('/erp/admin/roles', ins.error.message, 'err'); }
      changed++;
    }
  }
  go('/erp/admin/roles', changed ? `${changed} permission cells saved. They apply from the next page each person opens.` : 'Nothing changed.');
}

export default async function Roles() {
  const ctx = await requireCap('admin');
  const [{ data: roles }, { data: perms }] = await Promise.all([core(ctx.sb).from('roles').select('id, key').eq('product_key', 'erp'), core(ctx.sb).from('role_permissions').select('role_id, module_key, action, scope')]);
  const id = new Map(((roles ?? []) as { id: string; key: string }[]).map((r) => [r.key, r.id]));
  const P = (perms ?? []) as P[];
  const can = ctx.can('admin', 'write');
  return (
    <Page title="Roles and permissions" sub={`${LEVELS.map((l) => `${l} = ${LEVEL_LABEL[l].toLowerCase()}`).join(', ')}. The database enforces these on every query.`}>
      <form action={save}><Card><div className="overflow-x-auto"><table className="tbl"><thead><tr><th className="sticky left-0 bg-paper">Capability</th>{STAFF_ROLES.map((r) => <th key={r} className="text-center">{ROLE_LABEL[r]}</th>)}</tr></thead>
        <tbody>{CAPS.map((c) => <tr key={c}><td className="sticky left-0 bg-white font-medium capitalize">{c}</td>{STAFF_ROLES.map((r) => <td key={r} className="text-center"><select name={`${r}:${c}`} defaultValue={levelOf(c, P.filter((p) => p.role_id === id.get(r)))} disabled={!can || r === 'group_admin'} aria-label={`${ROLE_LABEL[r]} · ${c}`} className="rounded border border-line bg-white px-1 py-0.5 text-xs">{LEVELS.map((l) => <option key={l}>{l}</option>)}</select></td>)}</tr>)}</tbody></table></div></Card>
        {can && <button className="btn mt-3">Save permissions</button>}</form>
      <p className="mt-3 text-xs text-muted">Parents and students do not appear here: they only ever see their own family&apos;s records. The group admin always keeps full access, so nobody can be locked out.</p>
    </Page>
  );
}
