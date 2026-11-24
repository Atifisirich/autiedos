import Link from 'next/link';
import { requireCap } from '@/lib/erp/ctx';
import { core, erp } from '@/lib/erp/db';
import { Page, Card, Empty, Badge, Stat } from '@/components/erp/ui';
import { fdate, go, str, today, pct } from '@/lib/erp/fmt';
import { lookup } from '@/lib/erp/lookup';
import { addDays } from '@/lib/erp/calendar';

export const metadata = { title: 'Admissions' };
async function toggle(fd: FormData) {
  'use server';
  const ctx = await requireCap('admissions', 'write');
  const { error } = await erp(ctx.sb).from('post_admission_tasks').update({ done: fd.get('done') === '1' }).eq('id', str(fd, 'id')!);
  go('/erp/admissions', error ? error.message : 'Updated.', error ? 'err' : 'ok');
}

/**
 * Admissions in the ERP: the enquiry-to-admission pipeline belongs to the CRM (decision 50). The ERP keeps the walk-in admission form
 * (Students -> Admit student) and the post-admission checklist (uniform, transport, medical form, ID photo, app onboarding).
 */
export default async function Admissions() {
  const ctx = await requireCap('admissions');
  const since = addDays(today(), -90);
  let sq = core(ctx.sb).from('students').select('id, first_name, last_name, admission_no, joined_on, section_id, status, branch_id').gte('joined_on', since).in('status', ['active', 'admitted']).is('deleted_at', null).order('joined_on', { ascending: false }).limit(200);
  if (ctx.branchId) sq = sq.eq('branch_id', ctx.branchId);
  const { data: studs } = await sq;
  const students = (studs ?? []) as { id: string; first_name: string; last_name: string | null; admission_no: string | null; joined_on: string | null; section_id: string | null }[];
  const ids = students.map((s) => s.id);
  const [{ data: tasks }, sec] = await Promise.all([
    ids.length ? erp(ctx.sb).from('post_admission_tasks').select('id, student_id, task, done, due_date').in('student_id', ids).is('deleted_at', null).order('created_at') : Promise.resolve({ data: [] }),
    lookup(ctx, 'sections', students.map((s) => s.section_id)),
  ]);
  const T = (tasks ?? []) as { id: string; student_id: string; task: string; done: boolean; due_date: string | null }[];
  const open = T.filter((t) => !t.done).length;
  const can = ctx.can('admissions', 'write');
  const pending = students.filter((s) => T.some((t) => t.student_id === s.id && !t.done));
  return (
    <Page title="Admissions" sub="Enquiries and applications are managed in the CRM. The ERP admits the student and tracks the joining checklist." actions={<>{ctx.can('students', 'write') && <Link className="btn" href="/erp/students/new">Admit a student</Link>}<Link className="btn-ghost" href="/crm">Open CRM pipeline</Link></>}>
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Joined in 90 days" value={students.length} href="/erp/students" />
        <Stat label="Checklist items open" value={open} tone={open ? 'warn' : 'good'} />
        <Stat label="Students with open items" value={pending.length} />
        <Stat label="Checklist complete" value={T.length ? `${pct(T.length - open, T.length)}%` : '—'} />
      </div>
      <Card title="Joining checklist">
        {students.length === 0 ? <Empty title="No recent admissions" hint="Admit a student from the CRM (confirmed admissions arrive here) or use Students → Admit a student." action={ctx.can('students', 'write') ? <Link className="btn" href="/erp/students/new">Admit a student</Link> : undefined} /> : (
          <div className="overflow-x-auto"><table className="tbl"><thead><tr><th>Student</th><th>Section</th><th>Joined</th><th>Checklist</th></tr></thead>
            <tbody>{students.map((s) => { const mine = T.filter((t) => t.student_id === s.id); return (
              <tr key={s.id}><td><Link className="link font-medium" href={`/erp/students/${s.id}`}>{s.first_name} {s.last_name ?? ''}</Link><div className="text-xs text-muted">{s.admission_no}</div></td><td>{sec.name(s.section_id)}</td><td>{fdate(s.joined_on)}</td>
                <td><div className="flex flex-wrap gap-2">{mine.length === 0 ? <Badge tone="grey">no checklist</Badge> : mine.map((t) => (
                  <form key={t.id} action={toggle}><input type="hidden" name="id" value={t.id} /><input type="hidden" name="done" value={t.done ? '0' : '1'} />
                    <button disabled={!can} className={`badge ${t.done ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-800'} cursor-pointer`} title={t.done ? 'Done. Click to reopen' : 'Click to mark done'}>{t.done ? '✓ ' : ''}{t.task}</button></form>))}</div></td></tr>); })}</tbody></table></div>)}
      </Card>
    </Page>
  );
}
