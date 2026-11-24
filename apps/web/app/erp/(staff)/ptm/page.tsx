import { requireCap } from '@/lib/erp/ctx';
import { erp } from '@/lib/erp/db';
import { look, options } from '@/lib/erp/lookup';
import { Page, Card, Empty, Badge, Field } from '@/components/erp/ui';
import { fdate, go, str } from '@/lib/erp/fmt';

export const metadata = { title: 'PTM slots' };
async function makeSlots(fd: FormData) {
  'use server';
  const ctx = await requireCap('events', 'write');
  const staff = fd.getAll('staff_id').map(String);
  const date = str(fd, 'date')!, len = Number(str(fd, 'minutes') ?? 10);
  const [sh, sm] = (str(fd, 'from') ?? '09:00').split(':').map(Number) as [number, number], [eh, em] = (str(fd, 'to') ?? '12:00').split(':').map(Number) as [number, number];
  const f = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const rows = [];
  for (const s of staff) for (let m = sh * 60 + sm; m + len <= eh * 60 + em; m += len) rows.push({ staff_id: s, date, start_time: f(m), end_time: f(m + len), mode: str(fd, 'mode') ?? 'in_person', branch_id: ctx.branchId ?? ctx.orgUser.home_branch_id });
  if (!rows.length) go('/erp/ptm', 'Choose teachers and a time range.', 'err');
  const { error } = await erp(ctx.sb).from('ptm_slots').insert(rows);
  go('/erp/ptm', error ? error.message : `${rows.length} slots opened for booking.`, error ? 'err' : 'ok');
}
async function note(fd: FormData) { 'use server'; const ctx = await requireCap('events', 'write'); await erp(ctx.sb).from('ptm_slots').update({ notes: str(fd, 'notes'), status: 'done' }).eq('id', str(fd, 'id')!); go('/erp/ptm', 'Notes saved.'); }

type S = { id: string; date: string; start_time: string; mode: string; status: string; notes: string | null; staff_id: string; student_id: string | null };
export default async function Ptm() {
  const ctx = await requireCap('events');
  const [{ data: slots }, staff] = await Promise.all([erp(ctx.sb).from('ptm_slots').select('id, date, start_time, mode, status, notes, staff_id, student_id').is('deleted_at', null).order('date', { ascending: false }).order('start_time').limit(300), options(ctx, 'staff')]);
  const Ss = (slots ?? []) as S[];
  const lk = await look(ctx, { staff: Ss.map((s) => s.staff_id), students: Ss.map((s) => s.student_id) });
  const can = ctx.can('events', 'write');
  return (
    <Page title="Parent-teacher meetings" sub="Open slots per teacher. Parents book in the app; notes are kept with the meeting.">
      <div className="grid gap-4 lg:grid-cols-3">
        {can && <Card title="Open slots"><form action={makeSlots} className="space-y-3 p-4"><Field label="Teachers" help="Hold Ctrl to choose several."><select name="staff_id" multiple required size={6} className="input">{staff.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</select></Field><Field label="Date"><input type="date" name="date" required className="input" /></Field><div className="grid grid-cols-3 gap-2"><Field label="From"><input type="time" name="from" defaultValue="09:00" className="input" /></Field><Field label="To"><input type="time" name="to" defaultValue="12:00" className="input" /></Field><Field label="Minutes"><input type="number" name="minutes" defaultValue={10} className="input" /></Field></div><Field label="Mode"><select name="mode" className="input"><option value="in_person">In person</option><option value="video">Video</option></select></Field><button className="btn w-full">Open slots</button></form></Card>}
        <Card title={`Slots · ${Ss.filter((s) => s.status === 'booked').length} booked, ${Ss.filter((s) => s.status === 'open').length} open`} className={can ? 'lg:col-span-2' : 'lg:col-span-3'}>{Ss.length === 0 ? <Empty title="No PTM slots yet" /> : <table className="tbl"><thead><tr><th>When</th><th>Teacher</th><th>Family</th><th>Status</th><th>Notes</th></tr></thead><tbody>{Ss.map((s) => <tr key={s.id}><td>{fdate(s.date)} {String(s.start_time).slice(0, 5)}</td><td>{lk.staff.name(s.staff_id)}</td><td>{lk.students.name(s.student_id)}</td><td><Badge>{s.status}</Badge></td><td>{s.status === 'booked' && can ? <form action={note} className="flex gap-1"><input type="hidden" name="id" value={s.id} /><input name="notes" className="input !py-1 text-xs" placeholder="Meeting notes" aria-label="Notes" /><button className="btn-ghost btn-sm">Save</button></form> : s.notes}</td></tr>)}</tbody></table>}</Card>
      </div>
    </Page>
  );
}
