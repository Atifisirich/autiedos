import Link from 'next/link';
import { requireCap } from '@/lib/erp/ctx';
import { core, erp } from '@/lib/erp/db';
import { sectionsFor, NO_ID } from '@/lib/erp/q';
import { options, look } from '@/lib/erp/lookup';
import { Page, Card, Empty, Badge, Field, Tabs, Meter } from '@/components/erp/ui';
import { fdate, today } from '@/lib/erp/fmt';
import { createAssessment } from './actions';

export const metadata = { title: 'Assessment' };
type A = { id: string; name: string; term: string; component: string | null; status: string; entry_deadline: string | null; max_marks: number; section_id: string; subject_id: string; staff_id: string | null; results: { count: number }[] };
export default async function Assessments({ searchParams }: { searchParams: Promise<{ tab?: string; term?: string }> }) {
  const sp = await searchParams;
  const tab = sp.tab ?? 'list';
  const ctx = await requireCap('marks');
  const mine = ['class_teacher', 'subject_teacher'].includes(ctx.role) ? ctx.staff?.id : null;
  let q = erp(ctx.sb).from('assessments').select('id, name, term, component, status, entry_deadline, max_marks, section_id, subject_id, staff_id, results:assessment_results(count)').eq('academic_year_id', ctx.year?.id ?? NO_ID).is('deleted_at', null).order('created_at', { ascending: false }).limit(400);
  if (mine && tab === 'list') q = q.eq('staff_id', mine);
  if (ctx.branchId) q = q.or(`branch_id.eq.${ctx.branchId},branch_id.is.null`);
  if (sp.term) q = q.eq('term', sp.term);
  const [{ data }, sections, subjects, { data: scheme }, { data: strength }] = await Promise.all([q, sectionsFor(ctx), options(ctx, 'subjects'),
    erp(ctx.sb).from('assessment_schemes').select('config').eq('active', true).is('deleted_at', null).limit(1).maybeSingle(), core(ctx.sb).from('students').select('section_id').eq('status', 'active').is('deleted_at', null).limit(20000)]);
  const rows = (data ?? []) as unknown as A[];
  const lk = await look(ctx, { sections: rows.map((r) => r.section_id), subjects: rows.map((r) => r.subject_id), staff: rows.map((r) => r.staff_id) });
  const cfg = ((scheme as { config?: unknown } | null)?.config ?? {}) as { terms?: string[]; components?: { name: string; weightage: number }[] };
  const size = new Map<string, number>(); for (const s of (strength ?? []) as { section_id: string | null }[]) if (s.section_id) size.set(s.section_id, (size.get(s.section_id) ?? 0) + 1);
  const d = today();
  const can = ctx.can('marks', 'write');
  // Status board: pending entry by teacher (GB-04)
  const byTeacher = new Map<string, { name: string; total: number; done: number; late: number }>();
  for (const a of rows) { const k = a.staff_id ?? 'none'; const x = byTeacher.get(k) ?? { name: a.staff_id ? lk.staff.name(a.staff_id) : 'Not assigned', total: 0, done: 0, late: 0 }; x.total++; if (a.status !== 'open') x.done++; else if (a.entry_deadline && a.entry_deadline < d) x.late++; byTeacher.set(k, x); }
  return (
    <Page title="Assessment" sub="One assessment engine for every board. Create tests, enter marks in a grid, and track what is pending." actions={<><Link className="btn-ghost" href="/erp/x/assessment_schemes">Schemes</Link><Link className="btn-ghost" href="/erp/x/rubric_results">Skills and rubrics</Link><Link className="btn" href="/erp/report-cards">Report cards</Link></>}>
      <Tabs current={tab === 'list' ? '/erp/assessments' : `/erp/assessments?tab=${tab}`} tabs={[{ href: '/erp/assessments', label: mine ? 'My assessments' : 'Assessments' }, { href: '/erp/assessments?tab=board', label: 'Marks-entry status board' }]} />
      {tab === 'board' ? (
        <Card>{byTeacher.size === 0 ? <Empty title="No assessments yet" /> : <table className="tbl"><thead><tr><th>Teacher</th><th>Assessments</th><th className="w-1/3">Entry complete</th><th>Past deadline</th></tr></thead><tbody>
          {[...byTeacher.values()].sort((a, b) => b.late - a.late).map((t) => <tr key={t.name}><td className="font-medium">{t.name}</td><td>{t.done} / {t.total}</td><td><Meter value={t.done} max={t.total} /></td><td>{t.late ? <Badge tone="red">{t.late} late</Badge> : ''}</td></tr>)}</tbody></table>}</Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-3">
          <Card className="lg:col-span-2">{rows.length === 0 ? <Empty title="No assessments yet" hint="Create a test for one or more sections. The teacher assigned to that subject sees it under “Marks due”." /> : <table className="tbl"><thead><tr><th>Assessment</th><th>Section</th><th>Subject</th><th>Entered</th><th>Deadline</th><th>Status</th></tr></thead>
            <tbody>{rows.map((a) => { const n = a.results?.[0]?.count ?? 0, of = size.get(a.section_id) ?? 0; return <tr key={a.id}><td><Link className="link font-medium" href={`/erp/assessments/${a.id}`}>{a.name}</Link><div className="text-xs text-muted">{a.term}{a.component ? ` · ${a.component}` : ''}</div></td><td>{lk.sections.name(a.section_id)}</td><td>{lk.subjects.name(a.subject_id)}</td><td>{n} / {of}</td><td className={a.status === 'open' && a.entry_deadline && a.entry_deadline < d ? 'text-red-600' : ''}>{fdate(a.entry_deadline)}</td><td><Badge>{a.status}</Badge></td></tr>; })}</tbody></table>}</Card>
          {can && <Card title="New assessment"><form action={createAssessment} className="space-y-3 p-4">
            <Field label="Name"><input name="name" className="input" required placeholder="Periodic Test 1" /></Field>
            <div className="grid grid-cols-2 gap-2"><Field label="Term"><select name="term" className="input">{(cfg.terms ?? ['Term 1', 'Term 2']).map((t) => <option key={t}>{t}</option>)}</select></Field>
              <Field label="Component"><select name="component" className="input"><option value="">—</option>{(cfg.components ?? []).map((c) => <option key={c.name} value={c.name}>{c.name} ({c.weightage}%)</option>)}</select></Field></div>
            <Field label="Subject"><select name="subject_id" className="input" required>{subjects.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</select></Field>
            <Field label="Sections" help="Hold Ctrl to choose several."><select name="section_id" multiple required size={5} className="input">{sections.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
            <div className="grid grid-cols-2 gap-2"><Field label="Max marks"><input name="max_marks" type="number" defaultValue={100} className="input" /></Field><Field label="Test date"><input name="date" type="date" className="input" /></Field></div>
            <Field label="Marks-entry deadline"><input name="entry_deadline" type="date" className="input" /></Field>
            <button className="btn w-full">Create</button></form></Card>}
        </div>)}
    </Page>
  );
}
