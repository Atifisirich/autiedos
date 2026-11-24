import Link from 'next/link';
import { requireCap } from '@/lib/erp/ctx';
import { core, erp } from '@/lib/erp/db';
import { fullNameOf } from '@/lib/erp/q';
import { look } from '@/lib/erp/lookup';
import { Page, Card, Empty, Badge } from '@/components/erp/ui';
import { fdate, today } from '@/lib/erp/fmt';
import { entitiesOf } from '@/lib/erp/nav';
import { addDays } from '@/lib/erp/calendar';

export const metadata = { title: 'Staff and HR' };
type S = { id: string; employee_code: string | null; first_name: string; last_name: string | null; position_id: string | null; department_id: string | null; staff_type: string; status: string; phone: string | null; user_id: string | null };
export default async function HR({ searchParams }: { searchParams: Promise<{ q?: string; status?: string }> }) {
  const sp = await searchParams;
  const ctx = await requireCap('staff');
  let q = core(ctx.sb).from('staff').select('id, employee_code, first_name, last_name, position_id, department_id, staff_type, status, phone, user_id').is('deleted_at', null).order('first_name').limit(500);
  q = q.eq('status', sp.status ?? 'active');
  if (ctx.branchId) q = q.or(`branch_id.eq.${ctx.branchId},branch_id.is.null`);
  const term = (sp.q ?? '').replace(/[%,()]/g, ' ').trim();
  if (term) q = q.or(`first_name.ilike.%${term}%,last_name.ilike.%${term}%,employee_code.ilike.%${term}%`);
  const [{ data }, { data: prof }] = await Promise.all([q, erp(ctx.sb).from('staff_hr_profiles').select('staff_id, bgv_status, licence_expiry').is('deleted_at', null)]);
  const rows = (data ?? []) as S[];
  const lk = await look(ctx, { positions: rows.map((r) => r.position_id), departments: rows.map((r) => r.department_id) });
  const hp = new Map(((prof ?? []) as { staff_id: string; bgv_status: string; licence_expiry: string | null }[]).map((p) => [p.staff_id, p]));
  const soon = addDays(today(), 30);
  const can = ctx.can('staff', 'write');
  return (
    <Page title="Staff and HR" sub={`${rows.length} ${sp.status ?? 'active'} staff`} actions={<>{ctx.can('leave') && <Link className="btn-ghost" href="/erp/hr/leave">Leave</Link>}{ctx.can('payroll') && <Link className="btn-ghost" href="/erp/hr/payroll">Payroll</Link>}{can && <Link className="btn" href="/erp/x/staff/new?back=/erp/hr">Add staff</Link>}</>}>
      <form className="no-print mb-3 flex gap-2"><input name="q" defaultValue={sp.q ?? ''} placeholder="Name or employee code" className="input !w-60" aria-label="Search staff" /><select name="status" defaultValue={sp.status ?? 'active'} className="input !w-auto" aria-label="Status">{['active', 'invited', 'on_notice', 'left', 'inactive'].map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}</select><button className="btn-ghost">Filter</button></form>
      <Card>{rows.length === 0 ? <Empty title="No staff yet" hint="Add staff one at a time, or import a list from Admin console → Import." action={can ? <Link className="btn" href="/erp/x/staff/new?back=/erp/hr">Add staff</Link> : undefined} /> : <div className="overflow-x-auto"><table className="tbl"><thead><tr><th>Name</th><th>Code</th><th>Position</th><th>Department</th><th>Type</th><th>Phone</th><th>App login</th><th>Checks</th></tr></thead>
        <tbody>{rows.map((s) => { const p = hp.get(s.id); return <tr key={s.id} className="hover:bg-paper"><td><Link className="link font-medium" href={`/erp/hr/staff/${s.id}`}>{fullNameOf(s)}</Link></td><td>{s.employee_code}</td><td>{lk.positions.name(s.position_id)}</td><td>{lk.departments.name(s.department_id)}</td><td>{s.staff_type}</td><td>{s.phone}</td><td>{s.user_id ? <Badge tone="green">linked</Badge> : <Badge tone="grey">not invited</Badge>}</td>
          <td>{p && p.bgv_status !== 'clear' && <Badge tone={p.bgv_status === 'flagged' ? 'red' : 'amber'}>BGV {p.bgv_status}</Badge>} {p?.licence_expiry && p.licence_expiry <= soon && <Badge tone="red">licence {fdate(p.licence_expiry)}</Badge>}</td></tr>; })}</tbody></table></div>}</Card>
      <Card title="HR desk" className="mt-4"><div className="grid gap-px bg-line sm:grid-cols-2 lg:grid-cols-4">{entitiesOf('hr').filter((e) => ctx.can(e.cap)).map((e) => <Link key={e.table} href={`/erp/x/${e.table}`} className="bg-white px-4 py-3 text-sm hover:bg-paper">{e.title}</Link>)}</div></Card>
    </Page>
  );
}
