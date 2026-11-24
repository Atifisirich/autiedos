import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireCap } from '@/lib/erp/ctx';
import { core, erp } from '@/lib/erp/db';
import { fullNameOf, NO_ID } from '@/lib/erp/q';
import { lookup } from '@/lib/erp/lookup';
import { Page, Card, Empty, Badge, Tabs, Stat, Field } from '@/components/erp/ui';
import { fdate, ftime, inr, pct, today } from '@/lib/erp/fmt';
import { changeStatus, addGrowth, saveSensitive, requestConcession } from '../actions';
import { balance } from '@autoed/shared/erp';

const NEXT: Record<string, string[]> = { admitted: ['active', 'withdrawn', 'archived'], active: ['suspended', 'withdrawn', 'transferred', 'alumni'], suspended: ['active', 'withdrawn', 'transferred'], withdrawn: ['alumni', 'active'], transferred: ['active', 'archived'], alumni: ['archived', 'active'], archived: [] };
const PRESENT = ['present', 'late', 'half_day', 'on_duty'];
type Dem = { id: string; label: string | null; amount: number; concession: number; fine: number; paid: number; due_date: string; status: string; head: { name: string } | null };
const bal = (d: { amount: number; concession: number; fine: number; paid: number }) => balance({ ...d, id: '', due_date: '' });

/** Student 360 (SIS-01): one page that pulls every module together. */
export default async function Student360({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string }> }) {
  const [{ id }, { tab = 'overview' }] = await Promise.all([params, searchParams]);
  const ctx = await requireCap('students');
  const sb = ctx.sb;
  const { data: s } = await core(sb).from('students').select('*, section:sections(id, name), household:households(id, family_name, address, city, phone)').eq('id', id).is('deleted_at', null).maybeSingle();
  if (!s) notFound();
  const base = `/erp/students/${id}`;
  const canFees = ctx.can('fees'), canSens = ctx.can('sensitive'), canWell = ctx.can('wellbeing'), canMarks = ctx.can('marks');
  const tabs = [{ href: base, label: 'Overview' }, { href: `${base}?tab=attendance`, label: 'Attendance' }, ...(canMarks ? [{ href: `${base}?tab=academics`, label: 'Academics' }] : []), ...(canFees ? [{ href: `${base}?tab=fees`, label: 'Fees' }] : []),
    ...(canWell ? [{ href: `${base}?tab=growth`, label: 'Growth record' }] : []), ...(canSens ? [{ href: `${base}?tab=health`, label: 'Health' }] : []), { href: `${base}?tab=services`, label: 'Transport and services' }, { href: `${base}?tab=timeline`, label: 'Timeline' }];
  const [{ data: guardians }, { data: att }, { data: dues }, { data: sens }] = await Promise.all([
    core(sb).from('guardians').select('id, name, relation, phone, email, is_primary, authorised_pickup, user_id').eq('household_id', s.household_id ?? NO_ID).is('deleted_at', null),
    core(sb).from('student_attendance_marks').select('status').eq('student_id', id).is('deleted_at', null).limit(5000),
    canFees ? erp(sb).from('fee_demands').select('amount, concession, fine, paid, due_date').eq('student_id', id).in('status', ['due', 'partial']).is('deleted_at', null) : Promise.resolve({ data: [] }),
    canSens ? core(sb).from('student_sensitive').select('allergies, medical_conditions, blood_group').eq('student_id', id).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  const marks = (att ?? []) as { status: string }[];
  const counted = marks.filter((a) => a.status !== 'on_leave'), present = counted.filter((a) => PRESENT.includes(a.status)).length;
  const dd = (dues ?? []) as Dem[];
  const due = dd.reduce((t, d) => t + bal(d), 0);
  const overdue = dd.filter((d) => d.due_date < today()).reduce((t, d) => t + bal(d), 0);
  const canWrite = ctx.can('students', 'write');
  const sx = sens as { allergies: string | null; medical_conditions: string | null } | null;
  return (
    <Page title={fullNameOf(s)} sub={<>{s.section?.name ?? 'No section'} · Adm {s.admission_no ?? '—'} · <Badge>{s.status}</Badge></>}
      actions={<>{ctx.can('documents') && <Link className="btn-ghost" href={`/erp/documents?student=${id}`}>Certificate</Link>}{canFees && ctx.can('fees', 'write') && <Link className="btn" href={`/erp/fees/counter?student=${id}`}>Collect fee</Link>}</>}>
      {(sx?.allergies || sx?.medical_conditions) && <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900">Medical alert: {[sx.allergies && `Allergies: ${sx.allergies}`, sx.medical_conditions].filter(Boolean).join(' · ')}</div>}
      {overdue > 0 && <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-800">Overdue fees: {inr(overdue)}</div>}
      <Tabs tabs={tabs} current={tab === 'overview' ? base : `${base}?tab=${tab}`} />
      {tab === 'overview' && (
        <div className="grid gap-4 lg:grid-cols-3">
          <div className="grid grid-cols-2 gap-3 lg:col-span-3 lg:grid-cols-4">
            <Stat label="Attendance" value={counted.length ? `${pct(present, counted.length)}%` : '—'} hint={`${counted.length - present} days absent`} />
            {canFees && <Stat label="Fees outstanding" value={inr(due)} tone={overdue > 0 ? 'bad' : undefined} />}
            <Stat label="Joined" value={fdate(s.joined_on)} hint={s.is_new ? 'New this year' : ''} />
            <Stat label="House" value={s.house ?? '—'} hint={s.mother_tongue ?? ''} />
          </div>
          <Card title="Profile" className="lg:col-span-2" actions={canWrite ? <Link className="link text-sm" href={`/erp/x/students/${id}?back=${base}`}>Edit</Link> : undefined}>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-2 p-4 text-sm sm:grid-cols-3">{[['Date of birth', fdate(s.dob)], ['Gender', s.gender], ['Roll number', s.roll_no], ['APAAR ID', s.apaar_id], ['PEN', s.pen], ['Nationality', s.nationality], ['Previous school', s.previous_school], ['RTE quota', s.rte_quota ? 'Yes' : 'No']].map(([k, v]) => <div key={String(k)}><dt className="text-xs text-muted">{k}</dt><dd>{v || '—'}</dd></div>)}</dl>
          </Card>
          <Card title={s.household?.family_name ?? 'Family'} actions={canWrite && s.household ? <Link className="link text-sm" href={`/erp/x/guardians/new?household_id=${s.household.id}&back=${base}`}>Add guardian</Link> : undefined}>
            {(guardians ?? []).length === 0 ? <Empty title="No guardians recorded" /> : <ul className="divide-y divide-line text-sm">{(guardians as { id: string; name: string; relation: string; phone: string | null; email: string | null; user_id: string | null }[]).map((g) => (
              <li key={g.id} className="px-4 py-2.5"><div className="font-medium">{g.name} <span className="font-normal text-muted">· {g.relation}</span> {g.user_id ? <Badge tone="green">app active</Badge> : null}</div><div className="text-muted">{g.phone} {g.email}</div>
                {canWrite && !g.user_id && ctx.can('admin') && <Link className="link text-xs" href={`/erp/admin/users?invite_guardian=${g.id}&email=${encodeURIComponent(g.email ?? '')}`}>Invite to the parent app</Link>}</li>
            ))}</ul>}
            {s.household?.address && <p className="border-t border-line px-4 py-2 text-sm text-muted">{s.household.address}, {s.household.city}</p>}
          </Card>
        </div>
      )}
      {tab === 'attendance' && <AttendanceTab ctx={ctx} id={id} />}
      {tab === 'academics' && canMarks && <AcademicsTab ctx={ctx} id={id} />}
      {tab === 'fees' && canFees && <FeesTab ctx={ctx} id={id} />}
      {tab === 'growth' && canWell && <GrowthTab ctx={ctx} id={id} />}
      {tab === 'health' && canSens && <HealthTab ctx={ctx} id={id} />}
      {tab === 'services' && <ServicesTab ctx={ctx} id={id} />}
      {tab === 'timeline' && <TimelineTab ctx={ctx} id={id} status={s.status} canWrite={canWrite} />}
    </Page>
  );
}
type C = Awaited<ReturnType<typeof requireCap>>;

async function AttendanceTab({ ctx, id }: { ctx: C; id: string }) {
  const { data } = await core(ctx.sb).from('student_attendance_marks').select('date, status, note, source').eq('student_id', id).is('deleted_at', null).order('date', { ascending: false }).limit(120);
  const rows = (data ?? []) as { date: string; status: string; note: string | null; source: string }[];
  const months = new Map<string, { p: number; a: number; l: number }>();
  for (const r of rows) { const m = r.date.slice(0, 7); const x = months.get(m) ?? { p: 0, a: 0, l: 0 }; if (r.status === 'absent') x.a++; else if (r.status === 'on_leave') x.l++; else x.p++; months.set(m, x); }
  return rows.length === 0 ? <Card><Empty title="No attendance recorded yet" hint="Attendance appears here as soon as the class teacher submits the roll call." /></Card> : (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="By month"><table className="tbl"><thead><tr><th>Month</th><th>Present</th><th>Absent</th><th>Leave</th><th>%</th></tr></thead><tbody>{[...months].map(([m, x]) => <tr key={m}><td>{m}</td><td>{x.p}</td><td>{x.a}</td><td>{x.l}</td><td>{pct(x.p, x.p + x.a)}%</td></tr>)}</tbody></table></Card>
      <Card title="Absences and late arrivals"><ul className="divide-y divide-line text-sm">{rows.filter((r) => r.status !== 'present').slice(0, 20).map((r) => <li key={r.date} className="flex justify-between px-4 py-2"><span>{fdate(r.date)} <Badge>{r.status}</Badge></span><span className="text-muted">{r.note ?? r.source}</span></li>)}</ul></Card>
    </div>
  );
}

async function AcademicsTab({ ctx, id }: { ctx: C; id: string }) {
  const [{ data: res }, { data: cards }, { data: hw }] = await Promise.all([
    erp(ctx.sb).from('assessment_results').select('marks, code, grade, assessment:assessments(name, term, max_marks, subject_id)').eq('student_id', id).is('deleted_at', null).limit(200),
    erp(ctx.sb).from('report_cards').select('id, term, status, published_at').eq('student_id', id).is('deleted_at', null),
    erp(ctx.sb).from('post_submissions').select('id, late, marks').eq('student_id', id).is('deleted_at', null),
  ]);
  const raw = (res ?? []) as unknown as { marks: number | null; code: string | null; grade: string | null; assessment: { name: string; term: string; max_marks: number; subject_id: string } | null }[];
  const subj = await lookup(ctx, 'subjects', raw.map((r) => r.assessment?.subject_id));
  const rows = raw.map((r) => ({ ...r, assessment: r.assessment ? { ...r.assessment, subject: { name: subj.name(r.assessment.subject_id) } } : null }));
  const cs = (cards ?? []) as { id: string; term: string; status: string }[];
  const hs = (hw ?? []) as { late: boolean }[];
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card title="Assessment results" className="lg:col-span-2">{rows.length === 0 ? <Empty title="No marks entered yet" /> : <table className="tbl"><thead><tr><th>Assessment</th><th>Subject</th><th>Term</th><th>Marks</th><th>%</th></tr></thead><tbody>{rows.map((r, i) => <tr key={i}><td>{r.assessment?.name}</td><td>{r.assessment?.subject?.name}</td><td>{r.assessment?.term}</td><td>{r.code ?? r.marks ?? '—'} / {r.assessment?.max_marks}</td><td>{r.marks !== null && r.assessment ? pct(Number(r.marks), Number(r.assessment.max_marks)) + '%' : ''}</td></tr>)}</tbody></table>}</Card>
      <div className="space-y-4">
        <Card title="Report cards">{cs.length === 0 ? <Empty title="None generated" /> : <ul className="divide-y divide-line text-sm">{cs.map((c) => <li key={c.id} className="flex justify-between px-4 py-2"><Link className="link" href={`/erp/report-cards/${c.id}`}>{c.term}</Link><Badge>{c.status}</Badge></li>)}</ul>}</Card>
        <Card title="Homework"><div className="p-4 text-sm">{hs.length} submissions · {hs.filter((h) => h.late).length} late</div></Card>
      </div>
    </div>
  );
}

async function FeesTab({ ctx, id }: { ctx: C; id: string }) {
  const [{ data: dem }, { data: rec }, { data: con }, { data: types }] = await Promise.all([
    erp(ctx.sb).from('fee_demands').select('id, label, amount, concession, fine, paid, due_date, status, head:fee_heads(name)').eq('student_id', id).is('deleted_at', null).order('due_date'),
    erp(ctx.sb).from('receipts').select('id, receipt_no, date, total, status').eq('student_id', id).is('deleted_at', null).order('date', { ascending: false }),
    erp(ctx.sb).from('concessions').select('id, kind, value, amount, reason, status, type:concession_types(name)').eq('student_id', id).is('deleted_at', null),
    erp(ctx.sb).from('concession_types').select('id, name, kind, value').is('deleted_at', null).order('name'),
  ]);
  const d = (dem ?? []) as unknown as Dem[];
  const receipts = (rec ?? []) as { id: string; receipt_no: string; total: number; status: string }[];
  const cons = (con ?? []) as unknown as { id: string; kind: string; value: number; amount: number; status: string; type: { name: string } | null }[];
  const ts = (types ?? []) as { id: string; name: string; kind: string; value: number }[];
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card title="Fee demands" className="lg:col-span-2" actions={ctx.can('fees', 'write') ? <Link className="link text-sm" href={`/erp/fees/structure?assign=${id}`}>Assign a fee plan</Link> : undefined}>
        {d.length === 0 ? <Empty title="No fee demand raised" hint="Assign a fee plan to generate instalments for this student." /> : <div className="overflow-x-auto"><table className="tbl"><thead><tr><th>Fee</th><th>Due</th><th>Amount</th><th>Concession</th><th>Fine</th><th>Paid</th><th>Balance</th><th>Status</th></tr></thead>
          <tbody>{d.map((x) => <tr key={x.id}><td>{x.head?.name}<div className="text-xs text-muted">{x.label}</div></td><td>{fdate(x.due_date)}</td><td>{inr(x.amount)}</td><td>{Number(x.concession) ? inr(x.concession) : ''}</td><td>{Number(x.fine) ? inr(x.fine) : ''}</td><td>{inr(x.paid)}</td><td className="font-medium">{inr(bal(x))}</td><td><Badge tone={x.status === 'due' && x.due_date < today() ? 'red' : undefined}>{x.status === 'due' && x.due_date < today() ? 'overdue' : x.status}</Badge></td></tr>)}</tbody></table></div>}
      </Card>
      <div className="space-y-4">
        <Card title="Receipts">{receipts.length === 0 ? <Empty title="No payments yet" /> : <ul className="divide-y divide-line text-sm">{receipts.map((r) => <li key={r.id} className="flex justify-between px-4 py-2"><Link className="link" href={`/erp/receipt/${r.id}`}>{r.receipt_no}</Link><span>{inr(r.total)} {r.status === 'reversed' && <Badge>reversed</Badge>}</span></li>)}</ul>}</Card>
        <Card title="Concessions and scholarships">
          {cons.length > 0 && <ul className="divide-y divide-line text-sm">{cons.map((c) => <li key={c.id} className="px-4 py-2">{c.type?.name ?? 'Concession'} · {c.kind === 'percent' ? `${c.value}%` : inr(c.value)} <Badge>{c.status}</Badge>{Number(c.amount) > 0 && <span className="text-muted"> · {inr(c.amount)}</span>}</li>)}</ul>}
          <form action={requestConcession} className="space-y-2 border-t border-line p-4">
            <input type="hidden" name="student_id" value={id} />
            <select name="type_id" className="input" required aria-label="Concession type"><option value="">Choose a concession</option>{ts.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.kind === 'percent' ? `${t.value}%` : inr(t.value)})</option>)}</select>
            <input name="value" type="number" step="any" className="input" placeholder="Override value (optional)" aria-label="Override value" />
            <input name="reason" className="input" placeholder="Reason" required aria-label="Reason" />
            <button className="btn-ghost w-full">Request (goes for approval)</button>
          </form>
        </Card>
      </div>
    </div>
  );
}

async function GrowthTab({ ctx, id }: { ctx: C; id: string }) {
  const { data } = await erp(ctx.sb).from('growth_records').select('*').eq('student_id', id).is('deleted_at', null).order('date', { ascending: false }).limit(60);
  const rows = (data ?? []) as { id: string; type: string; category: string | null; note: string; visibility: string; date: string; recorded_by_name: string | null; share_with_parent: boolean }[];
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card title="Growth record" className="lg:col-span-2">{rows.length === 0 ? <Empty title="Nothing recorded yet" hint="Anecdotes, achievements, observations, discipline and counselling notes build one growth record, each with its own visibility level." /> : <ul className="divide-y divide-line text-sm">{rows.map((g) => (
        <li key={g.id} className="px-4 py-2.5"><div className="flex flex-wrap items-center gap-2"><Badge tone={g.type === 'discipline' ? 'red' : g.type === 'achievement' ? 'green' : 'blue'}>{g.type}</Badge>{g.category && <span className="text-muted">{g.category}</span>}<span className="text-xs text-muted">{fdate(g.date)} · {g.recorded_by_name}</span>{g.visibility !== 'teacher' && <Badge tone="amber">{g.visibility} only</Badge>}{g.share_with_parent && <Badge tone="teal">shared with parent</Badge>}</div><p className="mt-1">{g.note}</p></li>
      ))}</ul>}</Card>
      {ctx.can('wellbeing', 'write') && <Card title="Add a record"><form action={addGrowth} className="space-y-3 p-4">
        <input type="hidden" name="student_id" value={id} />
        <Field label="Type"><select name="type" className="input">{['anecdote', 'observation', 'achievement', 'discipline', 'counselling', 'mentor', 'warden'].map((t) => <option key={t}>{t}</option>)}</select></Field>
        <Field label="Category"><input name="category" className="input" /></Field>
        <Field label="Note"><textarea name="note" className="input" rows={3} required /></Field>
        <Field label="Who can see it"><select name="visibility" className="input"><option value="teacher">Teachers</option><option value="counsellor">Counsellor and leadership only</option><option value="leadership">Leadership only</option></select></Field>
        <Field label="Follow up on"><input type="date" name="follow_up_date" className="input" /></Field>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="share_with_parent" className="h-4 w-4" /> Share with parent in the app</label>
        <button className="btn w-full">Save</button>
      </form></Card>}
    </div>
  );
}

async function HealthTab({ ctx, id }: { ctx: C; id: string }) {
  // every view of the restricted fields is logged (DM-05): the ERP-only fields come through the logging function
  const [cs, es, { data: visits }, { data: checks }] = await Promise.all([
    core(ctx.sb).from('student_sensitive').select('*').eq('student_id', id).maybeSingle(),
    erp(ctx.sb).rpc('read_student_sensitive', { p_student: id }),
    ctx.can('health') ? erp(ctx.sb).from('infirmary_visits').select('*').eq('student_id', id).is('deleted_at', null).order('at', { ascending: false }).limit(20) : Promise.resolve({ data: [] }),
    ctx.can('health') ? erp(ctx.sb).from('health_checks').select('*').eq('student_id', id).is('deleted_at', null).order('date', { ascending: false }).limit(10) : Promise.resolve({ data: [] }),
  ]);
  const s = { ...((cs.data ?? {}) as Record<string, string | null>), ...((es.data ?? {}) as Record<string, string | null>) };
  const can = ctx.can('sensitive', 'write');
  const vs = (visits ?? []) as { id: string; at: string; complaint: string; action: string }[];
  const hc = (checks ?? []) as { id: string; date: string; height_cm: number | null; weight_kg: number | null }[];
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card title="Health profile (restricted, views are logged)" className="lg:col-span-2"><form action={saveSensitive} className="p-4"><input type="hidden" name="student_id" value={id} />
        <fieldset disabled={!can} className="grid gap-4 sm:grid-cols-3">{[['blood_group', 'Blood group'], ['allergies', 'Allergies'], ['medical_conditions', 'Chronic conditions'], ['medications', 'Medications'], ['vaccination', 'Vaccination'], ['emergency_contact', 'Emergency contact'], ['doctor_name', 'Doctor'], ['doctor_phone', 'Doctor phone'], ['social_category', 'Category'], ['religion', 'Religion (optional)'], ['aadhaar_last4', 'Aadhaar (last 4)'], ['medical_notes', 'Medical notes']].map(([k, l]) => <Field key={k!} label={l!}><input name={k} className="input" defaultValue={s[k!] ?? ''} /></Field>)}</fieldset>
        {can && <button className="btn mt-4">Save</button>}</form></Card>
      <div className="space-y-4">
        <Card title="Infirmary visits" actions={ctx.can('health', 'write') ? <Link className="link text-sm" href={`/erp/x/infirmary_visits/new?student_id=${id}&back=/erp/students/${id}?tab=health`}>Log visit</Link> : undefined}>{vs.length === 0 ? <Empty title="No visits" /> : <ul className="divide-y divide-line text-sm">{vs.map((v) => <li key={v.id} className="px-4 py-2">{ftime(v.at)} · {v.complaint}<div className="text-muted">{v.action}</div></li>)}</ul>}</Card>
        <Card title="Health checks" actions={ctx.can('health', 'write') ? <Link className="link text-sm" href={`/erp/x/health_checks/new?student_id=${id}&back=/erp/students/${id}?tab=health`}>Add</Link> : undefined}>{hc.length === 0 ? <Empty title="None recorded" /> : <ul className="divide-y divide-line text-sm">{hc.map((c) => <li key={c.id} className="px-4 py-2">{fdate(c.date)} · {c.height_cm} cm · {c.weight_kg} kg{c.height_cm && c.weight_kg ? ` · BMI ${(Number(c.weight_kg) / (Number(c.height_cm) / 100) ** 2).toFixed(1)}` : ''}</li>)}</ul>}</Card>
      </div>
    </div>
  );
}

async function ServicesTab({ ctx, id }: { ctx: C; id: string }) {
  const [tr, ho, lo, wa, docs] = await Promise.all([
    ctx.can('transport') ? erp(ctx.sb).from('student_transport').select('id, active, route:routes(name), stop:stops(name, pickup_time)').eq('student_id', id).is('deleted_at', null) : Promise.resolve({ data: null }),
    ctx.can('hostel') ? erp(ctx.sb).from('hostel_allocations').select('id, bed, active, room:hostel_rooms(name)').eq('student_id', id).is('deleted_at', null) : Promise.resolve({ data: null }),
    ctx.can('library') ? erp(ctx.sb).from('loans').select('id, due_on, returned_on, book:books(title)').eq('student_id', id).is('returned_on', null).is('deleted_at', null) : Promise.resolve({ data: null }),
    ctx.can('canteen') ? erp(ctx.sb).from('student_wallets').select('balance, daily_limit').eq('student_id', id).is('deleted_at', null).maybeSingle() : Promise.resolve({ data: null }),
    ctx.can('documents') ? erp(ctx.sb).from('issued_documents').select('id, type, number, issued_on').eq('student_id', id).is('deleted_at', null) : Promise.resolve({ data: null }),
  ]);
  const item = (title: string, body: React.ReactNode, add?: string) => <Card title={title} actions={add ? <Link className="link text-sm" href={add}>Add</Link> : undefined}><div className="p-4 text-sm">{body}</div></Card>;
  const w = wa.data as { balance: number; daily_limit: number | null } | null;
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {tr.data && item('Transport', (tr.data as unknown as { id: string; active: boolean; route: { name: string } | null; stop: { name: string; pickup_time: string | null } | null }[]).filter((t) => t.active).map((t) => <div key={t.id}>{t.route?.name} · {t.stop?.name} {t.stop?.pickup_time ? `at ${String(t.stop.pickup_time).slice(0, 5)}` : ''}</div>), ctx.can('transport', 'write') ? `/erp/x/student_transport/new?student_id=${id}&back=/erp/students/${id}?tab=services` : undefined)}
      {ho.data && item('Hostel', (ho.data as unknown as { id: string; bed: string | null; active: boolean; room: { name: string } | null }[]).filter((h) => h.active).map((h) => <div key={h.id}>Room {h.room?.name} · Bed {h.bed}</div>), ctx.can('hostel', 'write') ? `/erp/x/hostel_allocations/new?student_id=${id}&back=/erp/students/${id}?tab=services` : undefined)}
      {lo.data && item('Library books out', (lo.data as unknown as { id: string; due_on: string; book: { title: string } | null }[]).map((l) => <div key={l.id}>{l.book?.title} · due {fdate(l.due_on)}</div>))}
      {ctx.can('canteen') && item('Canteen wallet', w ? <>Balance {inr(w.balance)}{w.daily_limit ? ` · daily limit ${inr(w.daily_limit)}` : ''}</> : 'No wallet yet')}
      {docs.data && item('Certificates issued', (docs.data as { id: string; type: string; number: string | null; issued_on: string }[]).map((d) => <div key={d.id}><Link className="link" href={`/erp/documents/${d.id}`}>{d.type.replace(/_/g, ' ')} {d.number}</Link> · {fdate(d.issued_on)}</div>))}
    </div>
  );
}

async function TimelineTab({ ctx, id, status, canWrite }: { ctx: C; id: string; status: string; canWrite: boolean }) {
  const [{ data: ev }, { data: enr }] = await Promise.all([
    core(ctx.sb).from('student_status_events').select('*').eq('student_id', id).is('deleted_at', null).order('created_at', { ascending: false }),
    core(ctx.sb).from('enrolments').select('id, status, start_date, end_date, section:sections(name), year:academic_years(name)').eq('student_id', id).is('deleted_at', null).order('start_date', { ascending: false }),
  ]);
  const events = (ev ?? []) as { id: string; from_status: string | null; to_status: string; effective_date: string; actor_name: string | null; reason: string | null }[];
  const next = NEXT[status] ?? [];
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card title="Status history" className="lg:col-span-2">{events.length === 0 ? <Empty title="No changes recorded" /> : <ul className="divide-y divide-line text-sm">{events.map((e) => <li key={e.id} className="px-4 py-2.5">{e.from_status ? <><Badge>{e.from_status}</Badge> → </> : null}<Badge>{e.to_status}</Badge> <span className="text-muted">on {fdate(e.effective_date)} by {e.actor_name}</span>{e.reason && <div className="text-muted">{e.reason}</div>}</li>)}</ul>}
        <div className="border-t border-line px-4 py-2 text-xs font-semibold text-muted">Enrolment history</div>
        <ul className="divide-y divide-line text-sm">{((enr ?? []) as unknown as { id: string; status: string; start_date: string | null; end_date: string | null; section: { name: string } | null; year: { name: string } | null }[]).map((e) => <li key={e.id} className="flex justify-between px-4 py-2"><span>{e.year?.name} · {e.section?.name ?? 'No section'}</span><span className="text-muted">{fdate(e.start_date)}{e.end_date ? ` to ${fdate(e.end_date)}` : ''} <Badge>{e.status}</Badge></span></li>)}</ul>
      </Card>
      {canWrite && next.length > 0 && <Card title="Change status"><form action={changeStatus} className="space-y-3 p-4">
        <input type="hidden" name="id" value={id} />
        <Field label="Move to"><select name="to" className="input">{next.map((n) => <option key={n}>{n}</option>)}</select></Field>
        <Field label="Effective date"><input type="date" name="date" className="input" defaultValue={today()} /></Field>
        <Field label="Reason" help="Withdrawing cancels future unpaid fee demands and ends transport and hostel allocations."><input name="reason" className="input" required /></Field>
        <button className="btn w-full">Record change</button>
      </form></Card>}
    </div>
  );
}
