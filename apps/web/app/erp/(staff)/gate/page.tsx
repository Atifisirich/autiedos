import Link from 'next/link';
import { requireCap, type Ctx } from '@/lib/erp/ctx';
import { core, erp } from '@/lib/erp/db';
import { fullNameOf } from '@/lib/erp/q';
import { look } from '@/lib/erp/lookup';
import { Page, Card, Empty, Badge, Field, Tabs } from '@/components/erp/ui';
import { ftime, go, str, today } from '@/lib/erp/fmt';

export const metadata = { title: 'Gate' };
async function checkInVisitor(fd: FormData) {
  'use server';
  const ctx = await requireCap('gate', 'write');
  const badge = `V${Date.now().toString().slice(-6)}`;
  const { error } = await erp(ctx.sb).from('visitors').insert({ name: str(fd, 'name'), phone: str(fd, 'phone'), type: str(fd, 'type') ?? 'visitor', purpose: str(fd, 'purpose'), host_name: str(fd, 'host_name'), id_type: str(fd, 'id_type'), id_number_last4: str(fd, 'id_number_last4'), vehicle_no: str(fd, 'vehicle_no'), material_details: str(fd, 'material_details'), badge_no: badge, branch_id: ctx.branchId ?? ctx.orgUser.home_branch_id });
  go('/erp/gate', error ? error.message : `Checked in. Badge ${badge}.`, error ? 'err' : 'ok');
}
async function checkOut(fd: FormData) { 'use server'; const ctx = await requireCap('gate', 'write'); await erp(ctx.sb).from('visitors').update({ status: 'out', out_at: new Date().toISOString() }).eq('id', str(fd, 'id')!); go('/erp/gate', 'Checked out.'); }
async function verify(fd: FormData) {
  'use server';
  const ctx = await requireCap('gate', 'write');
  const { data, error } = await erp(ctx.sb).rpc('verify_gate_pass', { p_pass: str(fd, 'id'), p_otp: str(fd, 'otp') ?? '' });
  if (error) go('/erp/gate?tab=passes', error.message, 'err');
  go('/erp/gate?tab=passes', data === 'ok' ? 'OTP matched. Student handed over and the parent has been told.' : 'The OTP does not match. Do not hand over the student. The office has been alerted.', data === 'ok' ? 'ok' : 'err');
}
async function staffPass(fd: FormData) {
  'use server';
  const ctx = await requireCap('gate', 'write');
  const sid = str(fd, 'student_id');
  const { data: s } = await core(ctx.sb).from('students').select('first_name, last_name, branch_id').eq('id', sid!).single();
  const { data: g, error } = await erp(ctx.sb).from('gate_passes').insert({ student_id: sid, type: 'early_pickup', reason: str(fd, 'reason'), collector_name: str(fd, 'collector_name'), collector_phone: str(fd, 'collector_phone'), branch_id: (s as { branch_id: string } | null)?.branch_id, requested_by: ctx.user.id, status: 'requested' }).select('id').single();
  if (error) go('/erp/gate?tab=passes', error.message, 'err');
  const x = s as { first_name: string; last_name: string | null } | null;
  const r = await erp(ctx.sb).rpc('submit_approval', { p_type: 'gate_pass', p_object: (g as { id: string }).id, p_title: `Early pickup: ${x?.first_name} ${x?.last_name ?? ''}`, p_summary: `${str(fd, 'reason') ?? ''} · collector ${str(fd, 'collector_name') ?? ''}`, p_student: sid, p_payload: {} });
  go('/erp/gate?tab=passes', r.error ? r.error.message : 'Gate pass requested. It needs the class teacher’s approval.', r.error ? 'err' : 'ok');
}

/** Gate app (SAF-01..04): large buttons for one-hand use on a tablet or phone. */
export default async function Gate({ searchParams }: { searchParams: Promise<{ tab?: string; q?: string }> }) {
  const sp = await searchParams;
  const tab = sp.tab ?? 'visitors';
  const ctx = await requireCap('gate');
  const can = ctx.can('gate', 'write');
  return (
    <Page title="Gate and visitors" sub="Visitor check-in, student gate passes and pickup verification.">
      <Tabs current={tab === 'visitors' ? '/erp/gate' : `/erp/gate?tab=${tab}`} tabs={[{ href: '/erp/gate', label: 'Visitors' }, { href: '/erp/gate?tab=passes', label: 'Student gate passes' }, { href: '/erp/gate?tab=pickup', label: 'Authorised pickup' }, { href: '/erp/x/safeguarding_incidents', label: 'Incident register' }]} />
      {tab === 'visitors' && <Visitors ctx={ctx} can={can} />}{tab === 'passes' && <Passes ctx={ctx} can={can} />}{tab === 'pickup' && <Pickup ctx={ctx} q={sp.q} />}
    </Page>
  );
}

type V = { id: string; badge_no: string | null; name: string; type: string; phone: string | null; purpose: string | null; host_name: string | null; in_at: string; out_at: string | null; status: string };
async function Visitors({ ctx, can }: { ctx: Ctx; can: boolean }) {
  const { data } = await erp(ctx.sb).from('visitors').select('*').gte('in_at', today() + 'T00:00:00+05:30').is('deleted_at', null).order('in_at', { ascending: false }).limit(200);
  const D = (data ?? []) as V[];
  const inside = D.filter((v) => v.status === 'in');
  return <div className="grid gap-4 lg:grid-cols-3">
    {can && <Card title="Check in"><form action={checkInVisitor} className="space-y-3 p-4">
      <Field label="Name"><input name="name" className="input !py-3 text-base" required /></Field><Field label="Phone"><input name="phone" inputMode="tel" className="input !py-3 text-base" /></Field>
      <div className="grid grid-cols-2 gap-2"><Field label="Type"><select name="type" className="input">{['visitor', 'parent', 'vendor', 'material'].map((t) => <option key={t}>{t}</option>)}</select></Field><Field label="ID shown"><select name="id_type" className="input"><option value="">—</option>{['Aadhaar', 'Driving licence', 'Voter ID', 'Company ID'].map((t) => <option key={t}>{t}</option>)}</select></Field></div>
      <div className="grid grid-cols-2 gap-2"><Field label="ID last 4 digits"><input name="id_number_last4" maxLength={4} className="input" /></Field><Field label="Vehicle no."><input name="vehicle_no" className="input" /></Field></div>
      <Field label="Purpose"><input name="purpose" className="input" required /></Field><Field label="Meeting whom"><input name="host_name" className="input" /></Field><Field label="Material carried (for material passes)"><input name="material_details" className="input" /></Field>
      <button className="btn w-full !py-3 text-base">Check in and print badge</button></form></Card>}
    <Card title={`Inside now (${inside.length}) · ${D.length} today`} className="lg:col-span-2">{D.length === 0 ? <Empty title="No visitors today" /> : <table className="tbl"><thead><tr><th>Badge</th><th>Visitor</th><th>Purpose</th><th>In</th><th>Out</th><th></th></tr></thead><tbody>{D.map((v) => <tr key={v.id}><td>{v.badge_no}</td><td className="font-medium">{v.name}<div className="text-xs font-normal text-muted">{v.type} · {v.phone}</div></td><td>{v.purpose}<div className="text-xs text-muted">{v.host_name}</div></td><td>{ftime(v.in_at)}</td><td>{ftime(v.out_at)}</td><td>{v.status === 'in' && can ? <form action={checkOut}><input type="hidden" name="id" value={v.id} /><button className="btn-ghost btn-sm">Check out</button></form> : <Badge>{v.status}</Badge>}</td></tr>)}</tbody></table>}</Card>
  </div>;
}

type P = { id: string; reason: string | null; collector_name: string | null; collector_phone: string | null; status: string; handed_over_at: string | null; verified_by_name: string | null; student_id: string; person: { name: string; relation: string | null } | null };
async function Passes({ ctx, can }: { ctx: Ctx; can: boolean }) {
  const { data } = await erp(ctx.sb).from('gate_passes').select('id, reason, collector_name, collector_phone, status, handed_over_at, verified_by_name, student_id, person:pickup_persons(name, relation)').gte('created_at', today() + 'T00:00:00+05:30').is('deleted_at', null).order('created_at', { ascending: false });
  const Ps = (data ?? []) as unknown as P[];
  const [lk, { data: studs }] = await Promise.all([look(ctx, { students: Ps.map((p) => p.student_id), sections: [] as unknown[] }), can ? core(ctx.sb).from('students').select('id, first_name, last_name').eq('status', 'active').is('deleted_at', null).order('first_name').limit(2000) : Promise.resolve({ data: [] })]);
  const sec = await look(ctx, { sections: Ps.map((p) => lk.students.get(p.student_id)?.section_id) });
  return <div className="grid gap-4 lg:grid-cols-3">
    <div className="space-y-3 lg:col-span-2">{Ps.length === 0 ? <Card><Empty title="No gate passes today" hint="Parents request early pickup in the app. After approval the collector gives the OTP here." /></Card> : Ps.map((p) => <Card key={p.id}><div className="flex flex-wrap items-center justify-between gap-3 p-4">
      <div><div className="text-base font-semibold">{lk.students.name(p.student_id)} <span className="text-sm font-normal text-muted">· {sec.sections.name(lk.students.get(p.student_id)?.section_id)}</span></div><div className="text-sm">Collector: <b>{p.person?.name ?? p.collector_name ?? 'Not named'}</b>{p.person?.relation ? ` (${p.person.relation})` : ''} {p.collector_phone}</div><div className="text-xs text-muted">{p.reason}</div>{p.person ? <Badge tone="green">registered pickup person</Badge> : <Badge tone="amber">not on the registered list: check ID</Badge>}</div>
      {p.status === 'approved' && can ? <form action={verify} className="flex items-center gap-2"><input type="hidden" name="id" value={p.id} /><input name="otp" inputMode="numeric" maxLength={6} required placeholder="OTP" className="input !w-32 !py-3 text-center text-lg tracking-widest" aria-label="OTP from collector" /><button className="btn !py-3">Verify and hand over</button></form>
        : <div className="text-right"><Badge>{p.status}</Badge>{p.handed_over_at && <div className="text-xs text-muted">{ftime(p.handed_over_at)} · {p.verified_by_name}</div>}</div>}</div></Card>)}</div>
    {can && <Card title="Request for a student"><form action={staffPass} className="space-y-3 p-4"><Field label="Student"><select name="student_id" className="input" required><option value="">Choose</option>{((studs ?? []) as { id: string; first_name: string; last_name: string | null }[]).map((s) => <option key={s.id} value={s.id}>{fullNameOf(s)}</option>)}</select></Field><Field label="Reason"><input name="reason" className="input" required /></Field><Field label="Collector name"><input name="collector_name" className="input" /></Field><Field label="Collector phone"><input name="collector_phone" className="input" /></Field><button className="btn-ghost w-full">Request (class teacher approves)</button></form></Card>}
  </div>;
}

async function Pickup({ ctx, q }: { ctx: Ctx; q?: string }) {
  const term = (q ?? '').replace(/[%,()]/g, ' ').trim();
  const { data } = term ? await core(ctx.sb).from('students').select('id, first_name, last_name, section_id').or(`first_name.ilike.%${term}%,last_name.ilike.%${term}%,admission_no.ilike.%${term}%`).eq('status', 'active').is('deleted_at', null).limit(10) : { data: null };
  const S = (data ?? []) as { id: string; first_name: string; last_name: string | null; section_id: string | null }[];
  const [{ data: pp }, sec] = await Promise.all([S.length ? erp(ctx.sb).from('pickup_persons').select('student_id, name, relation, phone, active').in('student_id', S.map((s) => s.id)).eq('active', true).is('deleted_at', null) : Promise.resolve({ data: [] }), look(ctx, { sections: S.map((s) => s.section_id) })]);
  const P = (pp ?? []) as { student_id: string; name: string; relation: string | null; phone: string | null }[];
  return <><form className="mb-3 flex gap-2"><input type="hidden" name="tab" value="pickup" /><input name="q" defaultValue={q ?? ''} placeholder="Student name or admission number" className="input max-w-md !py-3 text-base" aria-label="Find student" /><button className="btn">Find</button><Link className="btn-ghost" href="/erp/x/pickup_persons">Manage list</Link></form>
    {!data ? <Card><Empty title="Look up who may collect a student" hint="If the person at the gate is not on the list, do not hand over the student; call the office." /></Card> : <div className="space-y-3">{S.map((s) => { const mine = P.filter((p) => p.student_id === s.id); return <Card key={s.id} title={`${fullNameOf(s)} · ${sec.sections.name(s.section_id)}`}>{mine.length === 0 ? <div className="p-4 text-sm text-red-700">No registered pickup persons. Only a parent with an approved gate pass may collect.</div> : <ul className="divide-y divide-line text-sm">{mine.map((p, i) => <li key={i} className="flex justify-between px-4 py-2.5"><span className="font-medium">{p.name}</span><span className="text-muted">{p.relation} · {p.phone}</span></li>)}</ul>}</Card>; })}</div>}</>;
}
