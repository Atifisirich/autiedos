import Link from 'next/link';
import { requireCap } from '@/lib/erp/ctx';
import { core, erp } from '@/lib/erp/db';
import { NO_ID } from '@/lib/erp/q';
import { Page, Card, Badge } from '@/components/erp/ui';
import { go, today } from '@/lib/erp/fmt';

export const metadata = { title: 'Data health' };
type Finding = { check: string; count: number; severity: string; fix: string; href: string };
/** Integrity checks (DM-06, ADO-04): counts, balances and impossible values. The result is stored so the last run can be reopened. */
async function run() {
  'use server';
  const ctx = await requireCap('admin');
  const c = core(ctx.sb), e = erp(ctx.sb), d = today();
  const [st, gu, staff, dem, secs, att] = await Promise.all([
    c.from('students').select('id, dob, section_id, household_id, admission_no, status, photo_file_id, apaar_id').is('deleted_at', null).limit(20000), c.from('guardians').select('household_id, phone, email').is('deleted_at', null).limit(40000),
    c.from('staff').select('id, user_id, status').is('deleted_at', null).limit(5000), e.from('fee_demands').select('id, amount, concession, fine, paid, status').is('deleted_at', null).limit(60000),
    c.from('sections').select('id, capacity, class_teacher_id').eq('academic_year_id', ctx.year?.id ?? NO_ID).is('deleted_at', null), c.from('student_attendance_marks').select('id', { count: 'exact', head: true }).gt('date', d),
  ]);
  type S = { id: string; dob: string | null; section_id: string | null; household_id: string | null; admission_no: string | null; status: string; photo_file_id: string | null; apaar_id: string | null };
  const active = ((st.data ?? []) as S[]).filter((s) => s.status === 'active');
  const G = (gu.data ?? []) as { household_id: string; phone: string | null; email: string | null }[];
  const hh = new Set(G.map((g) => g.household_id));
  const badPhone = (p: string | null) => !!p && !/^(\+91)?[6-9]\d{9}$/.test(p.replace(/[\s-]/g, ''));
  const badEmail = (x: string | null) => !!x && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x);
  const dupAdm = active.map((s) => s.admission_no).filter((a, i, arr) => a && arr.indexOf(a) !== i).length;
  const perSec = new Map<string, number>(); for (const s of active) if (s.section_id) perSec.set(s.section_id, (perSec.get(s.section_id) ?? 0) + 1);
  const D = (dem.data ?? []) as { amount: number; concession: number; fine: number; paid: number; status: string }[];
  const SE = (secs.data ?? []) as { id: string; capacity: number | null; class_teacher_id: string | null }[];
  const f = (check: string, count: number, severity: string, fix: string, href: string): Finding => ({ check, count, severity, fix, href });
  const findings = [
    f('Active students without a section', active.filter((s) => !s.section_id).length, 'high', 'Allocate from Students, bulk actions', '/erp/students'),
    f('Active students with no guardian on record', active.filter((s) => !s.household_id || !hh.has(s.household_id)).length, 'high', 'Add a guardian on the Student 360 page', '/erp/students'),
    f('Students without a date of birth', active.filter((s) => !s.dob).length, 'medium', 'Collect with a parent form', '/erp/forms'),
    f('Students with an impossible date of birth', active.filter((s) => s.dob && (s.dob > d || s.dob < '1990-01-01')).length, 'high', 'Correct the date', '/erp/students'),
    f('Duplicate admission numbers', dupAdm, 'high', 'Renumber the duplicates', '/erp/students'),
    f('Students without a photo', active.filter((s) => !s.photo_file_id).length, 'low', 'Upload ID photos', '/erp/students'),
    f('Students without an APAAR ID', active.filter((s) => !s.apaar_id).length, 'low', 'See the APAAR export', '/erp/reports/statutory?group=apaar'),
    f('Guardian phone numbers that look invalid', G.filter((g) => badPhone(g.phone)).length, 'medium', 'Messages to these numbers will fail', '/erp/x/guardians'),
    f('Guardian emails that look invalid', G.filter((g) => badEmail(g.email)).length, 'medium', 'Correct the address', '/erp/x/guardians'),
    f('Sections over capacity', SE.filter((s) => s.capacity && (perSec.get(s.id) ?? 0) > s.capacity).length, 'medium', 'Rebalance or raise the capacity', '/erp/students/bulk'),
    f('Sections without a class teacher', SE.filter((s) => !s.class_teacher_id).length, 'medium', 'Assign one', '/erp/x/sections'),
    f('Fee demands where paid is more than billed', D.filter((x) => Number(x.paid) > Number(x.amount) - Number(x.concession) + Number(x.fine) + 0.5).length, 'high', 'Review and refund', '/erp/fees'),
    f('Fee demands marked paid with a balance left', D.filter((x) => x.status === 'paid' && Number(x.amount) - Number(x.concession) + Number(x.fine) - Number(x.paid) > 0.5).length, 'high', 'Report to support', '/erp/fees'),
    f('Attendance recorded for future dates', att.count ?? 0, 'high', 'Report to support', '/erp/attendance'),
    f('Active staff without an app login', ((staff.data ?? []) as { status: string; user_id: string | null }[]).filter((s) => s.status === 'active' && !s.user_id).length, 'low', 'Give them access', '/erp/admin/users'),
  ];
  await e.from('data_health_reports').insert({ findings });
  go('/erp/admin/health', `Checked ${findings.length} rules. ${findings.filter((x) => x.count > 0).length} need attention.`);
}

export default async function Health() {
  const ctx = await requireCap('admin');
  const { data } = await erp(ctx.sb).from('data_health_reports').select('at, findings').is('deleted_at', null).order('at', { ascending: false }).limit(1).maybeSingle();
  const F = ((data?.findings ?? []) as Finding[]).sort((a, b) => Number(b.count > 0) - Number(a.count > 0));
  return (
    <Page title="Data-health report" sub={data ? `Last checked ${new Date(data.at as string).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}` : 'Validation rules stop bad data before it reaches a dashboard.'} actions={<form action={run}><button className="btn">Run checks now</button></form>}>
      <Card>{F.length === 0 ? <div className="p-6 text-center text-sm text-muted">Run the checks to see missing mandatory fields, invalid contacts and impossible values.</div> : <table className="tbl"><thead><tr><th>Check</th><th className="text-right">Found</th><th>Severity</th><th>What to do</th></tr></thead><tbody>{F.map((x) => <tr key={x.check}><td>{x.check}</td><td className="text-right tabular-nums">{x.count}</td><td>{x.count === 0 ? <Badge tone="green">clean</Badge> : <Badge tone={x.severity === 'high' ? 'red' : x.severity === 'medium' ? 'amber' : 'grey'}>{x.severity}</Badge>}</td><td>{x.count > 0 && <Link className="link" href={x.href}>{x.fix}</Link>}</td></tr>)}</tbody></table>}</Card>
    </Page>
  );
}
