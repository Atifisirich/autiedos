import Link from 'next/link';
import { requireCap } from '@/lib/erp/ctx';
import { core } from '@/lib/erp/db';
import { fullNameOf } from '@/lib/erp/q';
import { look, options } from '@/lib/erp/lookup';
import { Page, Card, Empty, Badge, Field } from '@/components/erp/ui';
import { fdate, today } from '@/lib/erp/fmt';
import { applyLeave } from '../actions';

export const metadata = { title: 'Leave' };
type R = { id: string; staff_id: string; start_date: string; end_date: string; days: number; half_day: string; reason: string | null; status: string; leave_type_id: string };
export default async function Leave({ searchParams }: { searchParams: Promise<{ staff?: string; status?: string }> }) {
  const sp = await searchParams;
  const ctx = await requireCap('leave');
  let q = core(ctx.sb).from('leave_requests').select('id, staff_id, start_date, end_date, days, half_day, reason, status, leave_type_id').is('deleted_at', null).order('start_date', { ascending: false }).limit(200);
  if (sp.status) q = q.eq('status', sp.status);
  const [{ data }, staff, { data: types }] = await Promise.all([q, options(ctx, 'staff'), core(ctx.sb).from('leave_types').select('id, name').eq('applies_to', 'staff').eq('active', true).is('deleted_at', null)]);
  const rows = (data ?? []) as R[];
  const lk = await look(ctx, { staff: rows.map((r) => r.staff_id) });
  const tn = new Map(((types ?? []) as { id: string; name: string }[]).map((t) => [t.id, t.name]));
  const d = today();
  const away = rows.filter((r) => r.status === 'approved' && r.start_date <= d && r.end_date >= d);
  return (
    <Page title="Leave" sub="Requests go to the approvals inbox. Approved leave fills attendance and opens the substitution planner." actions={<><Link className="btn-ghost" href="/erp/x/leave_types">Leave types and policies</Link><Link className="btn-ghost" href="/erp/approvals">Approvals inbox</Link></>}>
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card title={`Away today (${away.length})`}>{away.length === 0 ? <Empty title="Nobody is on approved leave today" /> : <ul className="divide-y divide-line text-sm">{away.map((r) => <li key={r.id} className="flex justify-between px-4 py-2"><span>{lk.staff.name(r.staff_id)}</span><span className="text-muted">until {fdate(r.end_date)}</span></li>)}</ul>}</Card>
          <Card title="Requests" actions={<form className="flex gap-1"><select name="status" defaultValue={sp.status ?? ''} className="input !w-auto !py-1 text-xs" aria-label="Status"><option value="">All</option>{['pending', 'approved', 'rejected'].map((s) => <option key={s}>{s}</option>)}</select><button className="btn-ghost btn-sm">Filter</button></form>}>
            {rows.length === 0 ? <Empty title="No leave requests" hint="Staff apply from “My leave and payslips”." /> : <table className="tbl"><thead><tr><th>Who</th><th>Type</th><th>Dates</th><th>Days</th><th>Reason</th><th>Status</th></tr></thead>
              <tbody>{rows.map((r) => <tr key={r.id}><td><Link className="link" href={`/erp/hr/staff/${r.staff_id}`}>{lk.staff.name(r.staff_id)}</Link></td><td>{tn.get(r.leave_type_id)}</td><td>{fdate(r.start_date)}{r.end_date !== r.start_date ? ` – ${fdate(r.end_date)}` : ''}</td><td>{r.days}</td><td className="max-w-xs truncate">{r.reason}</td><td><Badge>{r.status}</Badge></td></tr>)}</tbody></table>}</Card>
        </div>
        {ctx.can('leave', 'write') && <Card title="Apply on behalf of staff"><form action={applyLeave} className="space-y-3 p-4"><input type="hidden" name="back" value="/erp/hr/leave" />
          <Field label="Staff member"><select name="staff_id" className="input" defaultValue={sp.staff ?? ''} required><option value="">Choose</option>{staff.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</select></Field>
          <Field label="Leave type"><select name="leave_type_id" className="input" required>{((types ?? []) as { id: string; name: string }[]).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field>
          <div className="grid grid-cols-2 gap-2"><Field label="From"><input type="date" name="from_date" className="input" required /></Field><Field label="To"><input type="date" name="to_date" className="input" /></Field></div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="half_day" className="h-4 w-4" /> Half day</label>
          <Field label="Reason"><input name="reason" className="input" required /></Field><button className="btn w-full">Submit for approval</button></form></Card>}
      </div>
    </Page>
  );
}
void fullNameOf;
