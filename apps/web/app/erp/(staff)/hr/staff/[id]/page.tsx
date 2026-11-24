import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireCap } from '@/lib/erp/ctx';
import { core, erp } from '@/lib/erp/db';
import { fullNameOf, NO_ID } from '@/lib/erp/q';
import { look } from '@/lib/erp/lookup';
import { Page, Card, Empty, Badge, Stat } from '@/components/erp/ui';
import { fdate, inr, pct } from '@/lib/erp/fmt';
import { leaveBalance } from '@autoed/shared/erp';
import { toggleChecklist } from '../../actions';

const CHECKS = ['profile', 'documents', 'bank_details', 'payroll', 'subjects_and_sections', 'timetable', 'devices', 'app_login', 'handbook_acknowledged'];
/** Staff 360 (HR-01): profile, assignments, attendance, leave, payroll and feedback on one page. Appraisals and observations live in the OS. */
export default async function Staff360({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireCap('staff');
  const { data: s } = await core(ctx.sb).from('staff').select('*').eq('id', id).is('deleted_at', null).maybeSingle();
  if (!s) notFound();
  const pay = ctx.can('payroll');
  const yr = ctx.year?.id ?? NO_ID;
  const [ta, att, lv, bal, lt, sal, slips, fb, ob, docs, prof] = await Promise.all([
    core(ctx.sb).from('teacher_allocations').select('id, periods_per_week, section_id, subject_id').eq('staff_id', id).is('deleted_at', null),
    core(ctx.sb).from('staff_attendance').select('status').eq('staff_id', id).gte('date', ctx.year?.starts_on ?? '2000-01-01').is('deleted_at', null),
    core(ctx.sb).from('leave_requests').select('id, start_date, end_date, days, status, leave_type_id').eq('staff_id', id).is('deleted_at', null).order('start_date', { ascending: false }).limit(20),
    core(ctx.sb).from('leave_balances').select('leave_type_id, opening, carried_forward, adjusted').eq('staff_id', id).eq('academic_year_id', yr).is('deleted_at', null),
    core(ctx.sb).from('leave_types').select('id, name, yearly_quota').eq('applies_to', 'staff').is('deleted_at', null),
    pay ? erp(ctx.sb).from('salary_structures').select('*').eq('staff_id', id).eq('active', true).is('deleted_at', null).order('effective_from', { ascending: false }).limit(1).maybeSingle() : Promise.resolve({ data: null }),
    pay ? erp(ctx.sb).from('payslips').select('id, month, net').eq('staff_id', id).is('deleted_at', null).order('month', { ascending: false }).limit(6) : Promise.resolve({ data: [] }),
    erp(ctx.sb).from('staff_feedback').select('id, type, note, date').eq('staff_id', id).is('deleted_at', null).order('date', { ascending: false }).limit(6),
    erp(ctx.sb).from('onboarding_checklists').select('items, completed').eq('staff_id', id).is('deleted_at', null).maybeSingle(),
    ctx.can('documents') ? erp(ctx.sb).from('stored_documents').select('id, doc_type, expiry_date, verified').eq('staff_id', id).is('deleted_at', null) : Promise.resolve({ data: [] }),
    erp(ctx.sb).from('staff_hr_profiles').select('qualifications, experience_years, bgv_status, licence_no, licence_expiry').eq('staff_id', id).is('deleted_at', null).maybeSingle(),
  ]);
  const a = (att.data ?? []) as { status: string }[];
  const away = a.filter((x) => ['absent', 'on_leave'].includes(x.status)).length;
  const L = (lv.data ?? []) as { id: string; start_date: string; end_date: string; days: number; status: string; leave_type_id: string }[];
  const used = (t: string) => L.filter((l) => l.leave_type_id === t && l.status === 'approved').reduce((x, l) => x + Number(l.days), 0);
  const items = { ...Object.fromEntries(CHECKS.map((k) => [k, false])), ...(((ob.data as { items?: Record<string, boolean> } | null)?.items) ?? {}) } as Record<string, boolean>;
  const can = ctx.can('staff', 'write');
  const base = `/erp/hr/staff/${id}`;
  const TA = (ta.data ?? []) as { id: string; periods_per_week: number | null; section_id: string; subject_id: string }[];
  const lk = await look(ctx, { sections: TA.map((t) => t.section_id), subjects: TA.map((t) => t.subject_id), positions: [s.position_id], departments: [s.department_id], staff: [s.reports_to] });
  const sd = sal.data as Record<string, number | boolean | string> | null;
  const pr = prof.data as { qualifications: string | null; experience_years: number | null; bgv_status: string; licence_no: string | null; licence_expiry: string | null } | null;
  return (
    <Page title={fullNameOf(s)} sub={<>{lk.positions.name(s.position_id) || 'Staff'} · {lk.departments.name(s.department_id)} · <Badge>{s.status}</Badge>{s.reports_to ? ` · reports to ${lk.staff.name(s.reports_to)}` : ''}</>}
      actions={<>{can && <Link className="btn-ghost" href={`/erp/x/staff/${id}?back=${base}`}>Edit profile</Link>}{can && !s.user_id && ctx.can('admin') && <Link className="btn" href={`/erp/admin/users?invite_staff=${id}&email=${encodeURIComponent(s.email ?? '')}&name=${encodeURIComponent(fullNameOf(s))}`}>Invite to the app</Link>}</>}>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Attendance this year" value={a.length ? `${pct(a.length - away, a.length)}%` : '—'} hint={`${away} days away`} />
        <Stat label="Teaching load" value={`${TA.reduce((t, x) => t + Number(x.periods_per_week ?? 0), 0)} / week`} hint={`${TA.length} class-subject assignments`} />
        <Stat label="Experience" value={pr?.experience_years ? `${pr.experience_years} yrs` : '—'} hint={pr?.qualifications ?? ''} /><Stat label="Joined" value={fdate(s.joined_on)} hint={s.employee_code ?? ''} />
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card title="Onboarding checklist"><ul className="divide-y divide-line text-sm">{Object.entries(items).map(([k, v]) => <li key={k} className="flex items-center justify-between px-4 py-2"><span className={v ? 'text-muted line-through' : ''}>{k.replace(/_/g, ' ')}</span>{can ? <form action={toggleChecklist}><input type="hidden" name="staff" value={id} /><input type="hidden" name="key" value={k} /><button className="btn-ghost btn-sm">{v ? 'Undo' : 'Done'}</button></form> : v ? <Badge tone="green">done</Badge> : null}</li>)}</ul></Card>
        <Card title="Classes and subjects" actions={ctx.can('timetable', 'write') ? <Link className="link text-sm" href={`/erp/x/teacher_allocations/new?staff_id=${id}&back=${base}`}>Add</Link> : undefined}>{TA.length === 0 ? <Empty title="No teaching assignments" /> : <ul className="divide-y divide-line text-sm">{TA.map((t) => <li key={t.id} className="flex justify-between px-4 py-2"><span>{lk.sections.name(t.section_id)} · {lk.subjects.name(t.subject_id)}</span><span className="text-muted">{t.periods_per_week}/wk</span></li>)}</ul>}</Card>
        <Card title="Leave balances" actions={ctx.can('leave', 'write') ? <Link className="link text-sm" href={`/erp/hr/leave?staff=${id}`}>Apply for them</Link> : undefined}><ul className="divide-y divide-line text-sm">{((lt.data ?? []) as { id: string; name: string; yearly_quota: number | null }[]).filter((t) => Number(t.yearly_quota) > 0).map((t) => { const b = ((bal.data ?? []) as { leave_type_id: string; opening: number; carried_forward: number; adjusted: number }[]).find((x) => x.leave_type_id === t.id); const allot = Number(b?.opening ?? t.yearly_quota) + Number(b?.adjusted ?? 0); return <li key={t.id} className="flex justify-between px-4 py-2"><span>{t.name}</span><span>{leaveBalance(allot, Number(b?.carried_forward ?? 0), used(t.id))} left <span className="text-muted">of {allot + Number(b?.carried_forward ?? 0)}</span></span></li>; })}</ul></Card>
        {pay && <Card title="Salary" actions={ctx.can('payroll', 'write') ? <Link className="link text-sm" href={sd ? `/erp/x/salary_structures/${sd.id}?back=${base}` : `/erp/x/salary_structures/new?staff_id=${id}&back=${base}`}>{sd ? 'Edit' : 'Set structure'}</Link> : undefined}>
          {!sd ? <Empty title="No salary structure" hint="Set one so this person is included in the payroll run." /> : <dl className="grid grid-cols-2 gap-2 p-4 text-sm">{[['Basic', sd.basic], ['HRA', sd.hra], ['DA', sd.da], ['Special', sd.special_allowance], ['Other', sd.other_allowance]].map(([k, v]) => <div key={String(k)}><dt className="text-xs text-muted">{k}</dt><dd>{inr(v as number)}</dd></div>)}<div><dt className="text-xs text-muted">Statutory</dt><dd>{[sd.pf_applicable && 'PF', sd.esi_applicable && 'ESI', sd.pt_applicable && 'PT'].filter(Boolean).join(', ')}</dd></div></dl>}
          {((slips.data ?? []) as { id: string; month: string; net: number }[]).length > 0 && <ul className="divide-y divide-line border-t border-line text-sm">{(slips.data as { id: string; month: string; net: number }[]).map((p) => <li key={p.id} className="flex justify-between px-4 py-2"><Link className="link" href={`/erp/payslip/${p.id}`}>{String(p.month).slice(0, 7)}</Link><span>{inr(p.net)}</span></li>)}</ul>}
          {ctx.can('payroll', 'write') && <div className="border-t border-line px-4 py-2 text-xs"><Link className="link" href={`/erp/hr/staff/${id}/bank`}>Bank and statutory IDs</Link> · <Link className="link" href={`/erp/x/payroll_adjustments/new?staff_id=${id}&back=${base}`}>Add bonus / arrears</Link> · <Link className="link" href={`/erp/x/staff_loans/new?staff_id=${id}&back=${base}`}>Loan / advance</Link></div>}</Card>}
        <Card title="HR checks" actions={can ? <Link className="link text-sm" href={`/erp/x/staff_hr_profiles/new?staff_id=${id}&back=${base}`}>{pr ? 'Edit' : 'Add'}</Link> : undefined}><dl className="grid grid-cols-2 gap-2 p-4 text-sm"><div><dt className="text-xs text-muted">Background check</dt><dd>{pr ? <Badge tone={pr.bgv_status === 'clear' ? 'green' : pr.bgv_status === 'flagged' ? 'red' : 'amber'}>{pr.bgv_status}</Badge> : '—'}</dd></div><div><dt className="text-xs text-muted">Licence</dt><dd>{pr?.licence_no ?? '—'}{pr?.licence_expiry ? ` · ${fdate(pr.licence_expiry)}` : ''}</dd></div></dl><p className="border-t border-line px-4 py-2 text-xs text-muted">Appraisals, classroom observations and training records are in the OS (Observation and Appraisals).</p></Card>
        <Card title="Documents and feedback" actions={can ? <Link className="link text-sm" href={`/erp/x/staff_feedback/new?staff_id=${id}&back=${base}`}>Add feedback</Link> : undefined}><ul className="divide-y divide-line text-sm">
          {((docs.data ?? []) as { id: string; doc_type: string; expiry_date: string | null; verified: boolean }[]).map((d) => <li key={d.id} className="flex justify-between px-4 py-2"><span>{d.doc_type}</span><span className="text-muted">{d.expiry_date ? `expires ${fdate(d.expiry_date)}` : d.verified ? 'verified' : 'not verified'}</span></li>)}
          {((fb.data ?? []) as { id: string; type: string; note: string }[]).map((f) => <li key={f.id} className="px-4 py-2"><Badge tone={f.type === 'praise' ? 'green' : f.type === 'complaint' ? 'red' : 'blue'}>{f.type}</Badge> {f.note}</li>)}
          {(docs.data ?? []).length + (fb.data ?? []).length === 0 && <li className="px-4 py-3 text-muted">Nothing recorded.</li>}</ul>
          {can && <div className="border-t border-line px-4 py-2 text-xs"><Link className="link" href={`/erp/x/stored_documents/new?owner_type=staff&staff_id=${id}&back=${base}`}>Add a document</Link> · <Link className="link" href={`/erp/x/staff_exits/new?staff_id=${id}&back=${base}`}>Start exit</Link></div>}</Card>
      </div>
    </Page>
  );
}
