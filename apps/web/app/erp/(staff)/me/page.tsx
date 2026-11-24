import Link from 'next/link';
import { getCtx } from '@/lib/erp/ctx';
import { core, erp } from '@/lib/erp/db';
import { NO_ID } from '@/lib/erp/q';
import { Page, Card, Empty, Badge, Field } from '@/components/erp/ui';
import { fdate, inr, today, ftime } from '@/lib/erp/fmt';
import { leaveBalance } from '@autoed/shared/erp';
import { applyLeave, checkIn, regularise } from '../hr/actions';
import { GeoFields } from './geo';

export const metadata = { title: 'My leave and payslips' };

/** Staff self-service: check-in, leave, payslips (TAP-02). Tasks and duties are in the OS. */
export default async function Me() {
  const ctx = await getCtx();
  const sid = ctx.staff?.id;
  if (!sid) return <Page title="My leave and payslips"><Card><Empty title="Your login is not linked to a staff record yet" hint="Ask your school admin to link your account in Admin console → Users." /></Card></Page>;
  const d = today();
  const [{ data: types }, { data: bal }, { data: lv }, { data: slips }, { data: att }] = await Promise.all([
    core(ctx.sb).from('leave_types').select('id, name, yearly_quota').eq('applies_to', 'staff').eq('active', true).is('deleted_at', null),
    core(ctx.sb).from('leave_balances').select('leave_type_id, opening, carried_forward, adjusted').eq('staff_id', sid).eq('academic_year_id', ctx.year?.id ?? NO_ID).is('deleted_at', null),
    core(ctx.sb).from('leave_requests').select('id, start_date, end_date, days, status, leave_type_id, reason').eq('staff_id', sid).is('deleted_at', null).order('start_date', { ascending: false }).limit(15),
    erp(ctx.sb).from('payslips').select('id, month, net').eq('staff_id', sid).is('deleted_at', null).order('month', { ascending: false }).limit(12),
    core(ctx.sb).from('staff_attendance').select('check_in_at, check_out_at, status').eq('staff_id', sid).eq('date', d).is('deleted_at', null).maybeSingle(),
  ]);
  const L = (lv ?? []) as { id: string; start_date: string; end_date: string; days: number; status: string; leave_type_id: string; reason: string | null }[];
  const used = (t: string) => L.filter((l) => l.leave_type_id === t && l.status === 'approved').reduce((x, l) => x + Number(l.days), 0);
  const a = att as { check_in_at: string | null; check_out_at: string | null; status: string } | null;
  return (
    <Page title="My leave and payslips" sub={fdate(d)}>
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4">
          <Card title="Today"><form action={checkIn} className="space-y-2 p-4 text-sm"><GeoFields />
            <p>{a?.check_in_at ? <>Checked in at {ftime(a.check_in_at)}{a.check_out_at ? `, out at ${ftime(a.check_out_at)}` : ''}</> : a ? <>Marked <Badge>{a.status}</Badge></> : 'Not checked in yet.'}</p>
            <button className="btn w-full">{a?.check_in_at && !a.check_out_at ? 'Check out' : a?.check_in_at ? 'Update check-out' : 'Check in'}</button></form></Card>
          <Card title="Payslips">{((slips ?? []) as unknown[]).length === 0 ? <Empty title="No payslips yet" /> : <ul className="divide-y divide-line text-sm">{(slips as { id: string; month: string; net: number }[]).map((p) => <li key={p.id} className="flex justify-between px-4 py-2"><Link className="link" href={`/erp/payslip/${p.id}`}>{new Date(p.month).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' })}</Link><span>{inr(p.net)}</span></li>)}</ul>}</Card>
        </div>
        <Card title="Apply for leave"><form action={applyLeave} className="space-y-3 p-4">
          <Field label="Leave type"><select name="leave_type_id" className="input" required>{((types ?? []) as { id: string; name: string; yearly_quota: number | null }[]).map((t) => { const b = ((bal ?? []) as { leave_type_id: string; opening: number; carried_forward: number; adjusted: number }[]).find((x) => x.leave_type_id === t.id); return <option key={t.id} value={t.id}>{t.name}{Number(t.yearly_quota) > 0 ? ` (${leaveBalance(Number(b?.opening ?? t.yearly_quota) + Number(b?.adjusted ?? 0), Number(b?.carried_forward ?? 0), used(t.id))} left)` : ''}</option>; })}</select></Field>
          <div className="grid grid-cols-2 gap-2"><Field label="From"><input type="date" name="from_date" className="input" required /></Field><Field label="To"><input type="date" name="to_date" className="input" /></Field></div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="half_day" className="h-4 w-4" /> Half day</label>
          <Field label="Reason"><input name="reason" className="input" required /></Field><button className="btn w-full">Submit</button></form>
          <form action={regularise} className="space-y-2 border-t border-line p-4"><div className="text-xs font-semibold text-muted">Missed a punch? Attendance regularisation</div><div className="grid grid-cols-2 gap-2"><input type="date" name="date" max={d} required className="input" aria-label="Date" /><select name="requested_status" className="input" aria-label="Status"><option value="present">Present</option><option value="half_day">Half day</option></select></div><input name="reason" required placeholder="Reason" className="input" aria-label="Reason" /><button className="btn-ghost w-full">Request</button></form></Card>
        <Card title="My leave requests">{L.length === 0 ? <Empty title="No leave taken" /> : <ul className="divide-y divide-line text-sm">{L.map((l) => <li key={l.id} className="flex justify-between gap-2 px-4 py-2"><span>{fdate(l.start_date)}{l.end_date !== l.start_date ? ` – ${fdate(l.end_date)}` : ''}<span className="block text-xs text-muted">{l.reason}</span></span><Badge>{l.status}</Badge></li>)}</ul>}</Card>
      </div>
    </Page>
  );
}
