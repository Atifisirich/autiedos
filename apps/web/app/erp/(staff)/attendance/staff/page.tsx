import { requireCap } from '@/lib/erp/ctx';
import { core } from '@/lib/erp/db';
import { fullNameOf } from '@/lib/erp/q';
import { lookup } from '@/lib/erp/lookup';
import { Page, Card, Empty } from '@/components/erp/ui';
import { today, fdate } from '@/lib/erp/fmt';
import { markStaff } from '../actions';

export const metadata = { title: 'Staff attendance' };
export default async function StaffAttendance({ searchParams }: { searchParams: Promise<{ date?: string }> }) {
  const { date = today() } = await searchParams;
  const ctx = await requireCap('attendance');
  let q = core(ctx.sb).from('staff').select('id, first_name, last_name, position_id').eq('status', 'active').is('deleted_at', null).order('first_name');
  if (ctx.branchId) q = q.or(`branch_id.eq.${ctx.branchId},branch_id.is.null`);
  const [{ data: staff }, { data: att }] = await Promise.all([q, core(ctx.sb).from('staff_attendance').select('staff_id, status, source, check_in_at').eq('date', date).is('deleted_at', null)]);
  const list = (staff ?? []) as { id: string; first_name: string; last_name: string | null; position_id: string | null }[];
  const pos = await lookup(ctx, 'positions', list.map((s) => s.position_id));
  const prev = new Map(((att ?? []) as { staff_id: string; status: string; source: string }[]).map((a) => [a.staff_id, a]));
  const can = ctx.can('attendance', 'write');
  return (
    <Page title="Staff attendance" sub={`${fdate(date)} · feeds payroll. Approved leave is filled in automatically.`} actions={<form className="flex gap-2"><input type="date" name="date" defaultValue={date} max={today()} className="input !w-auto" aria-label="Date" /><button className="btn-ghost">Go</button></form>}>
      <form action={markStaff}><input type="hidden" name="date" value={date} />
        <Card>{list.length === 0 ? <Empty title="No staff yet" hint="Add staff in Staff and HR." /> : (
          <table className="tbl"><thead><tr><th>Staff</th><th>Position</th><th>Status</th><th>Source</th></tr></thead>
            <tbody>{list.map((s) => { const a = prev.get(s.id); return (
              <tr key={s.id}><td className="font-medium">{fullNameOf(s)}</td><td>{pos.name(s.position_id)}</td>
                <td><select name={`s_${s.id}`} defaultValue={a?.status ?? 'present'} disabled={!can} className="input !w-auto !py-1" aria-label={`Status for ${fullNameOf(s)}`}><option value="present">Present</option><option value="absent">Absent</option><option value="late">Late</option><option value="half_day">Half day</option><option value="on_leave">On leave</option></select></td>
                <td className="text-muted">{a?.source ?? ''}</td></tr>); })}</tbody></table>)}
        </Card>
        {can && <button className="btn mt-3">Save staff attendance</button>}
      </form>
    </Page>
  );
}
