import Link from 'next/link';
import { requireCap, type Ctx } from '@/lib/erp/ctx';
import { core, erp } from '@/lib/erp/db';
import { Page, Card, Empty, Badge, Tabs } from '@/components/erp/ui';
import { fdate, today, pct } from '@/lib/erp/fmt';
import { addDays } from '@/lib/erp/calendar';
import { riskReasons } from '@autoed/shared/erp';
import { entitiesOf } from '@/lib/erp/nav';
import { look, lookup } from '@/lib/erp/lookup';

export const metadata = { title: 'Wellbeing' };
export default async function Wellbeing({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { tab = 'feed' } = await searchParams;
  const ctx = await requireCap('wellbeing');
  const tabs = [{ href: '/erp/wellbeing', label: 'Growth record' }, { href: '/erp/wellbeing?tab=warning', label: 'Early warning' }, ...(ctx.can('health') ? [{ href: '/erp/wellbeing?tab=health', label: 'Health alerts' }] : []), { href: '/erp/wellbeing?tab=more', label: 'Houses, clubs and registers' }];
  return (
    <Page title="Wellbeing, health and conduct" sub="One growth record per student, with visibility levels for teachers, the counsellor and leadership.">
      <Tabs current={tab === 'feed' ? '/erp/wellbeing' : `/erp/wellbeing?tab=${tab}`} tabs={tabs} />
      {tab === 'feed' && <Feed ctx={ctx} />}{tab === 'warning' && <Warning ctx={ctx} />}{tab === 'health' && <Health ctx={ctx} />}{tab === 'more' && <More ctx={ctx} />}
    </Page>
  );
}

async function Feed({ ctx }: { ctx: Ctx }) {
  const { data } = await erp(ctx.sb).from('growth_records').select('id, student_id, type, category, note, date, visibility, follow_up_date, follow_up_done, recorded_by_name').is('deleted_at', null).order('date', { ascending: false }).limit(80);
  const G = (data ?? []) as { id: string; student_id: string; type: string; category: string | null; note: string; date: string; visibility: string; follow_up_date: string | null; follow_up_done: boolean; recorded_by_name: string | null }[];
  const st = await lookup(ctx, 'students', G.map((g) => g.student_id));
  const due = G.filter((g) => g.follow_up_date && !g.follow_up_done && g.follow_up_date <= today());
  return <div className="grid gap-4 lg:grid-cols-3"><Card title="Recent records" className="lg:col-span-2">{G.length === 0 ? <Empty title="Nothing recorded yet" hint="Add anecdotes, achievements, observations and discipline notes from a student's page (Growth record tab)." /> : <ul className="divide-y divide-line text-sm">{G.map((g) => <li key={g.id} className="px-4 py-2.5"><div className="flex flex-wrap items-center gap-2"><Link className="link font-medium" href={`/erp/students/${g.student_id}?tab=growth`}>{st.name(g.student_id)}</Link><Badge tone={g.type === 'discipline' ? 'red' : g.type === 'achievement' ? 'green' : 'blue'}>{g.type}</Badge>{g.visibility !== 'teacher' && <Badge tone="amber">{g.visibility} only</Badge>}<span className="text-xs text-muted">{fdate(g.date)} · {g.recorded_by_name}</span></div><p className="mt-1">{g.note}</p></li>)}</ul>}</Card>
    <Card title={`Follow-ups due (${due.length})`}>{due.length === 0 ? <Empty title="No follow-ups due" /> : <ul className="divide-y divide-line text-sm">{due.map((g) => <li key={g.id} className="px-4 py-2"><Link className="link" href={`/erp/x/growth_records/${g.id}?back=/erp/wellbeing`}>{st.name(g.student_id)}</Link><div className="text-muted">{g.note.slice(0, 80)}</div></li>)}</ul>}</Card></div>;
}

async function Warning({ ctx }: { ctx: Ctx }) {
  const d = today(), two = addDays(d, -14);
  let sq = core(ctx.sb).from('students').select('id, first_name, last_name, section_id').eq('status', 'active').is('deleted_at', null).limit(3000);
  if (ctx.branchId) sq = sq.eq('branch_id', ctx.branchId);
  const [{ data: studs }, { data: att }, { data: res }, { data: hw }, { data: inc }] = await Promise.all([sq,
    core(ctx.sb).from('student_attendance_marks').select('student_id, status, date').eq('session_key', 'day').gte('date', ctx.year?.starts_on ?? '2000-01-01').is('deleted_at', null).limit(200000),
    ctx.can('marks') ? erp(ctx.sb).from('assessment_results').select('student_id, marks, assessment:assessments(max_marks, term)').not('marks', 'is', null).is('deleted_at', null).limit(100000) : Promise.resolve({ data: [] }),
    erp(ctx.sb).from('post_submissions').select('student_id').eq('late', true).is('deleted_at', null).limit(20000),
    erp(ctx.sb).from('growth_records').select('student_id').eq('type', 'discipline').gte('date', addDays(d, -120)).is('deleted_at', null).limit(20000)]);
  const by = <T extends { student_id: string }>(rows: T[] | null) => { const m = new Map<string, T[]>(); for (const r of rows ?? []) m.set(r.student_id, [...(m.get(r.student_id) ?? []), r]); return m; };
  const A = by(att as { student_id: string; status: string; date: string }[]), R = by(res as unknown as { student_id: string; marks: number; assessment: { max_marks: number; term: string } | null }[]), H = by(hw as { student_id: string }[]), I = by(inc as { student_id: string }[]);
  const avg = (rows: { marks: number; assessment: { max_marks: number } | null }[]) => rows.length ? Math.round(rows.reduce((t, r) => t + (Number(r.marks) / Number(r.assessment?.max_marks || 100)) * 100, 0) / rows.length) : null;
  const sec = await lookup(ctx, 'sections', ((studs ?? []) as { section_id: string | null }[]).map((s) => s.section_id));
  const flagged = ((studs ?? []) as { id: string; first_name: string; last_name: string | null; section_id: string | null }[]).map((s) => {
    const a = A.get(s.id) ?? [], r = R.get(s.id) ?? [];
    const terms = [...new Set(r.map((x) => x.assessment?.term))].sort();
    const cur = r.filter((x) => x.assessment?.term === terms[terms.length - 1]), prev = terms.length > 1 ? r.filter((x) => x.assessment?.term === terms[terms.length - 2]) : [];
    const counted = a.filter((x) => x.status !== 'on_leave');
    return { s, reasons: riskReasons({ attendancePct: counted.length ? pct(counted.filter((x) => x.status !== 'absent').length, counted.length) : null, recentAbsences: a.filter((x) => x.status === 'absent' && x.date >= two).length, avgPct: avg(cur), prevAvgPct: avg(prev), homeworkLate: (H.get(s.id) ?? []).length, incidents: (I.get(s.id) ?? []).length }) };
  }).filter((x) => x.reasons.length).sort((a, b) => b.reasons.length - a.reasons.length);
  return <Card title={`${flagged.length} students may need support`}>{flagged.length === 0 ? <Empty title="No students are flagged" hint="The view combines attendance, marks trend, homework and incidents, and always explains why. It is never shown to parents or students." /> : <table className="tbl"><thead><tr><th>Student</th><th>Class</th><th>Why</th></tr></thead><tbody>{flagged.slice(0, 100).map(({ s, reasons }) => <tr key={s.id}><td><Link className="link font-medium" href={`/erp/students/${s.id}`}>{s.first_name} {s.last_name ?? ''}</Link></td><td>{sec.name(s.section_id)}</td><td>{reasons.join(' · ')}</td></tr>)}</tbody></table>}
    <p className="border-t border-line px-4 py-2 text-xs text-muted">For staff only. This is a prompt to look closer, not a judgement about a child.</p></Card>;
}

async function Health({ ctx }: { ctx: Ctx }) {
  const [{ data: sens }, { data: visits }] = await Promise.all([
    ctx.can('sensitive') ? core(ctx.sb).from('student_sensitive').select('student_id, allergies, medical_conditions, medications').or('allergies.not.is.null,medical_conditions.not.is.null').is('deleted_at', null).limit(1000) : Promise.resolve({ data: [] }),
    erp(ctx.sb).from('infirmary_visits').select('id, student_id, at, complaint, action, parent_informed').is('deleted_at', null).order('at', { ascending: false }).limit(30)]);
  const S0 = (sens ?? []) as { student_id: string; allergies: string | null; medical_conditions: string | null; medications: string | null }[];
  const V = (visits ?? []) as { id: string; student_id: string; at: string; complaint: string; action: string; parent_informed: boolean }[];
  const lk = await look(ctx, { students: [...S0.map((s) => s.student_id), ...V.map((v) => v.student_id)], sections: [] as unknown[] });
  const sec = await lookup(ctx, 'sections', S0.map((s) => lk.students.get(s.student_id)?.section_id));
  const S = S0.filter((x) => lk.students.get(x.student_id)?.status === 'active');
  return <div className="grid gap-4 lg:grid-cols-2"><Card title="Allergy and medical alerts (need-to-know)">{S.length === 0 ? <Empty title="No alerts recorded" hint="Shown to class teachers, the canteen counter and trip organisers." /> : <table className="tbl"><thead><tr><th>Student</th><th>Class</th><th>Alert</th></tr></thead><tbody>{S.map((x, i) => <tr key={i}><td><Link className="link" href={`/erp/students/${x.student_id}?tab=health`}>{lk.students.name(x.student_id)}</Link></td><td>{sec.name(lk.students.get(x.student_id)?.section_id)}</td><td>{[x.allergies && `Allergy: ${x.allergies}`, x.medical_conditions, x.medications && `Medication: ${x.medications}`].filter(Boolean).join(' · ')}</td></tr>)}</tbody></table>}</Card>
    <Card title="Infirmary visits" actions={ctx.can('health', 'write') ? <Link className="link text-sm" href="/erp/x/infirmary_visits/new?back=/erp/wellbeing?tab=health">Log a visit</Link> : undefined}>{V.length === 0 ? <Empty title="No visits logged" /> : <ul className="divide-y divide-line text-sm">{V.map((v) => <li key={v.id} className="px-4 py-2">{lk.students.name(v.student_id)} · {v.complaint}<div className="text-xs text-muted">{fdate(v.at)} · {v.action.replace(/_/g, ' ')}{v.parent_informed ? ' · parent informed' : ''}</div></li>)}</ul>}</Card></div>;
}

async function More({ ctx }: { ctx: Ctx }) {
  const { data: hp } = await erp(ctx.sb).from('house_points').select('house, points').is('deleted_at', null);
  const tot = new Map<string, number>(); for (const h of (hp ?? []) as { house: string; points: number }[]) tot.set(h.house, (tot.get(h.house) ?? 0) + h.points);
  const ents = [...entitiesOf('wellbeing'), ...entitiesOf('health'), ...entitiesOf('activities')].filter((e) => ctx.can(e.cap));
  return <div className="grid gap-4 lg:grid-cols-3"><Card title="House leaderboard">{tot.size === 0 ? <Empty title="No house points yet" /> : <ol className="divide-y divide-line text-sm">{[...tot].sort((a, b) => b[1] - a[1]).map(([h, p], i) => <li key={h} className="flex justify-between px-4 py-2.5"><span>{i + 1}. {h}</span><span className="font-semibold">{p}</span></li>)}</ol>}</Card>
    <Card title="Registers" className="lg:col-span-2"><div className="grid gap-px bg-line sm:grid-cols-2">{ents.map((e) => <Link key={e.table} href={`/erp/x/${e.table}`} className="bg-white px-4 py-3 text-sm hover:bg-paper">{e.title}</Link>)}<Link href="/erp/x/student_groups" className="bg-white px-4 py-3 text-sm hover:bg-paper">Clubs, activities and mentor groups</Link></div></Card></div>;
}
