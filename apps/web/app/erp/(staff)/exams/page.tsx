import Link from 'next/link';
import { requireCap, type Ctx } from '@/lib/erp/ctx';
import { core, erp } from '@/lib/erp/db';
import { Page, Card, Empty, Badge, Field, Tabs } from '@/components/erp/ui';
import { PrintButton } from '@/components/erp/client';
import { fdate, pct } from '@/lib/erp/fmt';
import { sectionsFor, NO_ID } from '@/lib/erp/q';
import { options, look, lookup } from '@/lib/erp/lookup';
import { aiEnabled } from '@/lib/erp/ai';
import { createTest, closeTest, seat, aiQuestions } from './actions';

export const metadata = { title: 'Exam cell' };
type Sp = { tab?: string; schedule?: string; paper?: string; test?: string; easy?: string; medium?: string; hard?: string; subject?: string };
export default async function Exams({ searchParams }: { searchParams: Promise<Sp> }) {
  const sp = await searchParams;
  const tab = sp.tab ?? 'exams';
  const ctx = await requireCap('exams');
  const can = ctx.can('exams', 'write');
  return (
    <Page title="Exam cell and online tests" sub="Exam calendar, seating and hall tickets, question bank, paper builder, online and diagnostic tests.">
      <Tabs current={tab === 'exams' ? '/erp/exams' : `/erp/exams?tab=${tab}`} tabs={[{ href: '/erp/exams', label: 'Exams and seating' }, { href: '/erp/exams?tab=bank', label: 'Question bank' }, { href: '/erp/exams?tab=papers', label: 'Paper builder' }, { href: '/erp/exams?tab=tests', label: 'Online and diagnostic tests' }]} />
      {tab === 'exams' && <ExamsTab ctx={ctx} sp={sp} can={can} />}{tab === 'bank' && <Bank ctx={ctx} can={can} />}{tab === 'papers' && <Papers ctx={ctx} sp={sp} />}{tab === 'tests' && <TestsTab ctx={ctx} sp={sp} can={can} />}
    </Page>
  );
}

async function ExamsTab({ ctx, sp, can }: { ctx: Ctx; sp: Sp; can: boolean }) {
  const [{ data: exams }, { data: sch }, { data: seats }, rooms] = await Promise.all([
    core(ctx.sb).from('exams').select('id, name, starts_on, ends_on, status').eq('academic_year_id', ctx.year?.id ?? NO_ID).is('deleted_at', null).order('starts_on'),
    core(ctx.sb).from('exam_schedules').select('id, exam_id, programme_id, section_id, subject_id, exam_date, starts_at').is('deleted_at', null).order('exam_date').limit(200),
    sp.schedule ? core(ctx.sb).from('exam_seating').select('student_id, room_id, seat_no, hall_ticket_no').eq('exam_schedule_id', sp.schedule).is('deleted_at', null).order('hall_ticket_no') : Promise.resolve({ data: [] }),
    options(ctx, 'rooms', { branch: true }),
  ]);
  const E = (exams ?? []) as { id: string; name: string; starts_on: string | null; ends_on: string | null; status: string }[];
  const S = (sch ?? []) as { id: string; exam_id: string; programme_id: string | null; section_id: string | null; subject_id: string; exam_date: string | null; starts_at: string | null }[];
  const SE = (seats ?? []) as { student_id: string; room_id: string | null; seat_no: string; hall_ticket_no: string }[];
  const lk = await look(ctx, { programmes: S.map((s) => s.programme_id), subjects: S.map((s) => s.subject_id), students: SE.map((x) => x.student_id), rooms: SE.map((x) => x.room_id) });
  const exName = new Map(E.map((e) => [e.id, e.name]));
  const cur = S.find((s) => s.id === sp.schedule);
  return <div className="grid gap-4 lg:grid-cols-3">
    <Card title="Exams" actions={can ? <Link className="link text-sm" href="/erp/x/exams/new?back=/erp/exams">New exam</Link> : undefined}>{E.length === 0 ? <Empty title="No exams planned" hint="Create an exam, then add its date sheet." /> : <ul className="divide-y divide-line text-sm">{E.map((e) => <li key={e.id} className="flex justify-between px-4 py-2.5"><span>{e.name}<span className="block text-xs text-muted">{fdate(e.starts_on)} – {fdate(e.ends_on)}</span></span><Badge>{e.status}</Badge></li>)}</ul>}</Card>
    <Card title="Date sheet" className="lg:col-span-2" actions={can ? <Link className="link text-sm" href="/erp/x/exam_schedules/new?back=/erp/exams">Add paper</Link> : undefined}>{S.length === 0 ? <Empty title="No papers scheduled" /> : <table className="tbl"><thead><tr><th>Date</th><th>Exam</th><th>Class</th><th>Subject</th><th></th></tr></thead><tbody>{S.map((s) => <tr key={s.id} className={s.id === sp.schedule ? 'bg-brand-soft' : ''}><td>{fdate(s.exam_date)} {String(s.starts_at ?? '').slice(0, 5)}</td><td>{exName.get(s.exam_id)}</td><td>{lk.programmes.name(s.programme_id)}</td><td>{lk.subjects.name(s.subject_id)}</td><td><Link className="link" href={`/erp/exams?schedule=${s.id}`}>Seating</Link></td></tr>)}</tbody></table>}</Card>
    {cur && <Card title={`Seating and hall tickets · ${lk.programmes.name(cur.programme_id)} · ${lk.subjects.name(cur.subject_id)} · ${fdate(cur.exam_date)}`} className="lg:col-span-3" actions={<PrintButton label="Print hall tickets" />}>
      {can && <form action={seat} className="no-print flex flex-wrap items-end gap-2 border-b border-line p-4"><input type="hidden" name="schedule" value={cur.id} /><Field label="Rooms (hold Ctrl for several)"><select name="room_id" multiple size={4} className="input" required>{rooms.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}</select></Field><Field label="Seats per room"><input name="per_room" type="number" defaultValue={30} className="input !w-24" /></Field><button className="btn">Generate seating</button></form>}
      {SE.length === 0 ? <Empty title="No seating yet" hint="Generate to mix sections fairly across rooms and number the hall tickets." /> : <table className="tbl"><thead><tr><th>Hall ticket</th><th>Student</th><th>Room</th><th>Seat</th></tr></thead><tbody>{SE.map((x) => <tr key={x.hall_ticket_no}><td>{x.hall_ticket_no}</td><td>{lk.students.name(x.student_id)} <span className="text-muted">{String(lk.students.get(x.student_id)?.admission_no ?? '')}</span></td><td>{lk.rooms.name(x.room_id)}</td><td>{x.seat_no}</td></tr>)}</tbody></table>}</Card>}
  </div>;
}

async function Bank({ ctx, can }: { ctx: Ctx; can: boolean }) {
  const [{ data: qs }, subjects] = await Promise.all([core(ctx.sb).from('question_bank').select('difficulty, bloom, source, status').is('deleted_at', null).limit(10000), options(ctx, 'subjects')]);
  const Q = (qs ?? []) as { difficulty: string | null; bloom: string | null; source: string; status: string }[];
  const count = (k: 'difficulty' | 'bloom' | 'status') => { const m = new Map<string, number>(); for (const q of Q) m.set(q[k] ?? 'unset', (m.get(q[k] ?? 'unset') ?? 0) + 1); return [...m]; };
  return <div className="grid gap-4 lg:grid-cols-3"><Card title={`${Q.length} questions`} className="lg:col-span-2" actions={<><Link className="link text-sm" href="/erp/x/question_bank">Open bank</Link>{can && <Link className="link text-sm" href="/erp/x/question_bank/new">Add question</Link>}</>}><div className="grid gap-4 p-4 text-sm sm:grid-cols-3">{(['difficulty', 'bloom', 'status'] as const).map((k) => <div key={k}><div className="mb-1 text-xs font-semibold uppercase text-muted">{k === 'bloom' ? "Bloom's level" : k}</div>{count(k).map(([v, n]) => <div key={v} className="flex justify-between"><span>{v.replace('_', ' ')}</span><span className="text-muted">{n}</span></div>)}</div>)}</div><p className="border-t border-line px-4 py-2 text-xs text-muted">{Q.filter((q) => q.status === 'draft').length} drafts wait for a teacher to approve them. Only approved questions are used in tests and papers.</p></Card>
    {can && <Card title="Draft questions with AI"><form action={aiQuestions} className="space-y-3 p-4"><Field label="Subject"><select name="subject_id" className="input"><option value="">—</option>{subjects.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</select></Field><Field label="Topic and learning outcomes" help="Questions are written from this text. Do not type student names."><textarea name="topic" className="input" rows={3} required /></Field><button className="btn-ghost w-full">Draft 5 questions</button><p className="text-xs text-muted">{aiEnabled() ? 'Drafts are saved as "draft".' : 'The AI helper is not switched on for this school. Without it, add questions by hand.'}</p></form></Card>}</div>;
}

type QB = { id: string; marks: number | null; content: { text?: string; options?: string[] } };
async function Papers({ ctx, sp }: { ctx: Ctx; sp: Sp }) {
  const subjects = await options(ctx, 'subjects');
  const bp = { easy: Number(sp.easy ?? 0), medium: Number(sp.medium ?? 0), hard: Number(sp.hard ?? 0) };
  const built = bp.easy + bp.medium + bp.hard > 0;
  const picked: QB[] = [];
  if (built) for (const [d, n] of Object.entries(bp)) {
    if (!n) continue;
    let q = core(ctx.sb).from('question_bank').select('id, marks, content').eq('difficulty', d).eq('status', 'approved').is('deleted_at', null).limit(n);
    if (sp.subject) q = q.eq('subject_id', sp.subject);
    const { data } = await q;
    picked.push(...((data ?? []) as QB[]));
  }
  const total = picked.reduce((t, q) => t + Number(q.marks ?? 1), 0);
  return <div className="grid gap-4 lg:grid-cols-3">
    <div className="no-print space-y-4"><Card title="Build from a blueprint"><form className="space-y-3 p-4"><input type="hidden" name="tab" value="papers" /><Field label="Title"><input name="title" className="input" defaultValue={sp.paper ?? ''} /></Field><Field label="Subject"><select name="subject" className="input" defaultValue={sp.subject ?? ''}><option value="">Any</option>{subjects.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</select></Field>
      <div className="grid grid-cols-3 gap-2">{(['easy', 'medium', 'hard'] as const).map((d) => <Field key={d} label={d}><input name={d} type="number" min={0} defaultValue={sp[d] ?? (d === 'medium' ? 5 : 3)} className="input" /></Field>)}</div><button className="btn w-full">Build paper</button></form>
      <p className="border-t border-line px-4 py-2 text-xs text-muted">The paper is assembled from approved questions each time and printed from this page. Saved papers and the setter-and-reviewer workflow are in the OS.</p></Card></div>
    <Card className="lg:col-span-2" title={sp.paper || 'Print-ready paper'} actions={built ? <PrintButton /> : undefined}>{!built ? <Empty title="Choose a blueprint" hint="Pick how many easy, medium and hard questions, then build." /> : picked.length === 0 ? <Empty title="No approved questions match the blueprint" /> : <div className="space-y-3 p-6"><div className="text-center"><div className="font-semibold">{ctx.org.name}</div><div className="text-sm">{sp.paper || 'Question paper'} · Maximum marks: {total}</div></div><ol className="list-decimal space-y-3 pl-5 text-sm">{picked.map((q) => <li key={q.id}>{q.content?.text} <span className="text-muted">[{q.marks ?? 1}]</span>{Array.isArray(q.content?.options) && <ol className="mt-1 list-[lower-alpha] pl-5">{q.content.options!.map((o) => <li key={o}>{o}</li>)}</ol>}</li>)}</ol>
      <details className="no-print border-t border-line pt-2 text-xs text-muted"><summary>OMR answer sheet</summary><div className="mt-2 grid grid-cols-2 gap-1">{picked.map((q, i) => <div key={q.id}>{i + 1}. Ⓐ Ⓑ Ⓒ Ⓓ</div>)}</div></details></div>}</Card></div>;
}

async function TestsTab({ ctx, sp, can }: { ctx: Ctx; sp: Sp; can: boolean }) {
  const [{ data: tests }, { data: att }, sections, subjects] = await Promise.all([
    erp(ctx.sb).from('online_tests').select('id, title, status, duration_min, is_diagnostic, question_ids, section_id, attempts:test_attempts(count)').is('deleted_at', null).order('created_at', { ascending: false }).limit(40),
    sp.test ? erp(ctx.sb).from('test_attempts').select('student_id, score, max_score, tab_switches, analysis').eq('test_id', sp.test).is('deleted_at', null) : Promise.resolve({ data: [] }),
    sectionsFor(ctx), options(ctx, 'subjects'),
  ]);
  const T = (tests ?? []) as unknown as { id: string; title: string; status: string; is_diagnostic: boolean; question_ids: string[]; section_id: string | null; attempts: { count: number }[] }[];
  const A = (att ?? []) as { student_id: string; score: number; max_score: number; tab_switches: number; analysis: Record<string, { score: number; max: number }> | null }[];
  const st = await lookup(ctx, 'students', A.map((a) => a.student_id));
  const sec = new Map(sections.map((s) => [s.id, s.name]));
  const bloom = new Map<string, { s: number; m: number }>(); for (const a of A) for (const [k, v] of Object.entries(a.analysis ?? {})) { const x = bloom.get(k) ?? { s: 0, m: 0 }; x.s += v.score; x.m += v.max; bloom.set(k, x); }
  return <div className="grid gap-4 lg:grid-cols-3">
    {can && <Card title="New online test"><form action={createTest} className="space-y-3 p-4"><Field label="Title"><input name="title" required className="input" /></Field><Field label="Section"><select name="section_id" className="input" required>{sections.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field><Field label="Subject"><select name="subject_id" className="input"><option value="">Any</option>{subjects.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</select></Field>
      <div className="grid grid-cols-3 gap-2"><Field label="Questions"><input name="count" type="number" defaultValue={10} className="input" /></Field><Field label="Minutes"><input name="duration" type="number" defaultValue={30} className="input" /></Field><Field label="Bloom's level"><select name="bloom" className="input"><option value="">All</option>{['remember', 'understand', 'apply', 'analyse', 'evaluate', 'create'].map((b) => <option key={b}>{b}</option>)}</select></Field></div>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="diagnostic" className="h-4 w-4" /> Diagnostic (feeds remediation groups)</label><button className="btn w-full">Publish test</button></form></Card>}
    <Card title="Tests" className={can ? 'lg:col-span-2' : 'lg:col-span-3'}>{T.length === 0 ? <Empty title="No online tests" hint="Tests pick approved objective questions from the bank, randomise the order and mark themselves." /> : <table className="tbl"><thead><tr><th>Test</th><th>Section</th><th>Questions</th><th>Attempts</th><th>Status</th><th></th></tr></thead><tbody>{T.map((t) => <tr key={t.id}><td><Link className="link font-medium" href={`/erp/exams?tab=tests&test=${t.id}`}>{t.title}</Link>{t.is_diagnostic && <> <Badge tone="teal">diagnostic</Badge></>}</td><td>{t.section_id ? sec.get(t.section_id) : ''}</td><td>{(t.question_ids ?? []).length}</td><td>{t.attempts?.[0]?.count ?? 0}</td><td><Badge>{t.status}</Badge></td>
      <td>{can && <form action={closeTest}><input type="hidden" name="id" value={t.id} /><button name="status" value={t.status === 'live' ? 'closed' : 'live'} className="btn-ghost btn-sm">{t.status === 'live' ? 'Close' : 'Reopen'}</button></form>}</td></tr>)}</tbody></table>}</Card>
    {sp.test && <Card title="Results and item analysis" className="lg:col-span-3">{A.length === 0 ? <Empty title="No attempts yet" /> : <div className="grid gap-4 p-4 lg:grid-cols-2"><table className="tbl"><thead><tr><th>Student</th><th>Score</th><th>Tab switches</th></tr></thead><tbody>{[...A].sort((a, b) => b.score - a.score).map((a, i) => <tr key={i}><td>{st.name(a.student_id)}</td><td>{a.score} / {a.max_score}</td><td>{a.tab_switches > 2 ? <Badge tone="amber">{String(a.tab_switches)}</Badge> : a.tab_switches}</td></tr>)}</tbody></table>
      <div className="text-sm"><div className="mb-2 font-semibold">By Bloom&apos;s level (class)</div>{[...bloom].map(([k, v]) => <div key={k} className="flex justify-between border-b border-line py-1"><span>{k}</span><span className={pct(v.s, v.m) < 50 ? 'text-red-600' : ''}>{pct(v.s, v.m)}%</span></div>)}<p className="mt-2 text-xs text-muted">Students below 40% are candidates for a remedial group (Students → Groups).</p></div></div>}</Card>}
  </div>;
}
