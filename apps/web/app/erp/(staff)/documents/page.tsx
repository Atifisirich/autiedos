import Link from 'next/link';
import { randomBytes } from 'node:crypto';
import { requireCap, type Ctx } from '@/lib/erp/ctx';
import { core, erp } from '@/lib/erp/db';
import { fullNameOf, nextNo } from '@/lib/erp/q';
import { lookup, options } from '@/lib/erp/lookup';
import { Page, Card, Empty, Badge, Field } from '@/components/erp/ui';
import { fdate, go, str, today, inr } from '@/lib/erp/fmt';
import { balance } from '@autoed/shared/erp';

export const metadata = { title: 'Certificates' };

/** Clearance checklist before a TC or no-dues certificate: fees, library, store, transport, hostel (DOC-02). */
async function clearance(ctx: Ctx, id: string) {
  const [f, l, o, t, h] = await Promise.all([
    erp(ctx.sb).from('fee_demands').select('amount, concession, fine, paid').eq('student_id', id).in('status', ['due', 'partial']).lte('due_date', today()).is('deleted_at', null),
    erp(ctx.sb).from('loans').select('id').eq('student_id', id).is('returned_on', null).is('deleted_at', null), erp(ctx.sb).from('store_orders').select('id').eq('student_id', id).in('status', ['ordered', 'ready']).is('deleted_at', null),
    erp(ctx.sb).from('student_transport').select('id').eq('student_id', id).eq('active', true).is('deleted_at', null), erp(ctx.sb).from('hostel_allocations').select('id').eq('student_id', id).eq('active', true).is('deleted_at', null),
  ]);
  const due = ((f.data ?? []) as { amount: number; concession: number; fine: number; paid: number }[]).reduce((x, d) => x + balance({ ...d, id: '', due_date: '' }), 0);
  const n = (r: { data: unknown[] | null }) => (r.data ?? []).length;
  return [{ item: 'Fees', ok: due <= 0, note: due > 0 ? `${inr(due)} overdue` : 'No dues' }, { item: 'Library', ok: !n(l), note: `${n(l)} books out` }, { item: 'Store', ok: !n(o), note: `${n(o)} open orders` },
    { item: 'Transport', ok: true, note: n(t) ? 'Ends when the student leaves' : 'Not on transport' }, { item: 'Hostel', ok: true, note: n(h) ? 'Ends when the student leaves' : 'Not in hostel' }];
}

async function issue(fd: FormData) {
  'use server';
  const ctx = await requireCap('documents', 'write');
  const studentId = str(fd, 'student_id'), tplId = str(fd, 'template_id');
  if (!studentId || !tplId) go('/erp/documents', 'Choose a student and a template.', 'err');
  const [{ data: tplRow }, { data: sRow }] = await Promise.all([erp(ctx.sb).from('doc_templates').select('*').eq('id', tplId!).single(), core(ctx.sb).from('students').select('*').eq('id', studentId!).single()]);
  const tpl = tplRow as { type: string; name: string; body: string | null } | null;
  const s = sRow as { first_name: string; last_name: string | null; admission_no: string | null; dob: string | null; joined_on: string | null; left_on: string | null; apaar_id: string | null; branch_id: string; household_id: string | null; section_id: string | null; status: string } | null;
  if (!tpl || !s) go('/erp/documents', 'Not found.', 'err');
  if (['tc', 'no_dues'].includes(tpl!.type)) { const c = await clearance(ctx, studentId!); const block = c.filter((x) => !x.ok); if (block.length) go(`/erp/documents?student=${studentId}`, `Clearance pending: ${block.map((b) => `${b.item} (${b.note})`).join(', ')}.`, 'err'); }
  const [{ data: g }, { data: sens }, { data: paid }, { data: sec }] = await Promise.all([core(ctx.sb).from('guardians').select('name').eq('household_id', s!.household_id ?? '00000000-0000-0000-0000-000000000000').is('deleted_at', null).order('is_primary', { ascending: false }).limit(1),
    ctx.can('sensitive') ? core(ctx.sb).from('student_sensitive').select('blood_group').eq('student_id', studentId!).maybeSingle() : Promise.resolve({ data: null }),
    erp(ctx.sb).from('receipt_allocations').select('amount, demand:fee_demands(academic_year_id, head:fee_heads(tax_certificate)), receipt:receipts(status)').eq('student_id', studentId!).is('deleted_at', null),
    s!.section_id ? core(ctx.sb).from('sections').select('name').eq('id', s!.section_id).maybeSingle() : Promise.resolve({ data: null })]);
  const tuition = ((paid ?? []) as unknown as { amount: number; demand: { academic_year_id: string; head: { tax_certificate: boolean } | null } | null; receipt: { status: string } | null }[]).filter((p) => p.receipt?.status === 'valid' && p.demand?.head?.tax_certificate && p.demand.academic_year_id === ctx.year?.id).reduce((t, p) => t + Number(p.amount), 0);
  const fields: Record<string, string> = { student_name: fullNameOf(s), admission_no: s!.admission_no ?? '', class: (sec as { name: string } | null)?.name ?? '', dob: fdate(s!.dob), joined_on: fdate(s!.joined_on), left_on: fdate(s!.left_on ?? today()), parent_name: (g as { name: string }[] | null)?.[0]?.name ?? '', year: ctx.year?.name ?? '', date: fdate(today()), school: ctx.org.name, apaar_id: s!.apaar_id ?? '', blood_group: (sens as { blood_group?: string } | null)?.blood_group ?? '', reason: str(fd, 'reason') ?? '', tuition_paid: inr(tuition) };
  const body = String(tpl!.body ?? '').replace(/\{\{(\w+)\}\}/g, (_, k: string) => fields[k] ?? '');
  const number = await nextNo(ctx, `doc_${tpl!.type}`, `${tpl!.type.toUpperCase().slice(0, 3)}/${ctx.year?.name ?? ''}/`);
  const { data: doc, error } = await erp(ctx.sb).from('issued_documents').insert({ type: tpl!.type, number, title: tpl!.name, student_id: studentId, branch_id: s!.branch_id, data: fields, body, verify_code: randomBytes(9).toString('hex'), issued_by_name: ctx.name, issued_by_user_id: ctx.user.id }).select('id').single();
  if (error) go('/erp/documents', error.message, 'err');
  if (tpl!.type === 'tc' && s!.status === 'withdrawn') await core(ctx.sb).rpc('change_student_status', { p_student: studentId, p_to: 'alumni', p_reason: `TC ${number} issued` });
  go(`/erp/documents/${(doc as { id: string }).id}`, `${tpl!.name} ${number} issued.`);
}

async function requestTc(fd: FormData) {
  'use server';
  const ctx = await requireCap('documents', 'write');
  const id = str(fd, 'student_id')!;
  const { data: s } = await core(ctx.sb).from('students').select('first_name, last_name').eq('id', id).single();
  const c = await clearance(ctx, id);
  const x = s as { first_name: string; last_name: string | null } | null;
  const { error } = await erp(ctx.sb).rpc('submit_approval', { p_type: 'tc', p_object: id, p_title: `Transfer certificate: ${x?.first_name} ${x?.last_name ?? ''}`, p_summary: str(fd, 'reason'), p_student: id, p_impact: `Student moves to withdrawn. Clearance: ${c.map((y) => `${y.item} ${y.ok ? 'clear' : 'PENDING (' + y.note + ')'}`).join(', ')}.`, p_payload: {} });
  go(`/erp/documents?student=${id}`, error ? error.message : 'TC sent to the principal for approval. Once approved and dues are clear, issue the TC here.', error ? 'err' : 'ok');
}

export default async function Documents({ searchParams }: { searchParams: Promise<{ student?: string }> }) {
  const sp = await searchParams;
  const ctx = await requireCap('documents');
  const [{ data: tpls }, studs, { data: issued }, { data: apaar }] = await Promise.all([
    erp(ctx.sb).from('doc_templates').select('id, name, type').eq('active', true).is('deleted_at', null).order('name'), options(ctx, 'students'),
    erp(ctx.sb).from('issued_documents').select('id, type, number, title, status, issued_on, student_id').is('deleted_at', null).order('created_at', { ascending: false }).limit(50),
    core(ctx.sb).from('students').select('apaar_id').eq('status', 'active').is('deleted_at', null).limit(20000),
  ]);
  const I = (issued ?? []) as { id: string; number: string | null; title: string | null; status: string; issued_on: string; student_id: string | null }[];
  const st = await lookup(ctx, 'students', I.map((d) => d.student_id));
  const check = sp.student ? await clearance(ctx, sp.student) : null;
  const can = ctx.can('documents', 'write');
  const withId = ((apaar ?? []) as { apaar_id: string | null }[]).filter((a) => a.apaar_id).length;
  return (
    <Page title="Certificates and ID cards" sub="Every document carries a QR code that anyone can scan to verify it." actions={<><Link className="btn-ghost" href="/erp/x/doc_templates">Templates</Link><Link className="btn-ghost" href="/erp/x/stored_documents">Document library</Link></>}>
      <div className="grid gap-4 lg:grid-cols-3">
        {can && <div className="space-y-4"><Card title="Issue a document"><form action={issue} className="space-y-3 p-4">
          <Field label="Student"><select name="student_id" className="input" defaultValue={sp.student ?? ''} required><option value="">Choose</option>{studs.map((s) => <option key={s.value} value={s.value}>{s.label} · {String(s.row.admission_no ?? '')}</option>)}</select></Field>
          <Field label="Template"><select name="template_id" className="input" required>{((tpls ?? []) as { id: string; name: string }[]).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field>
          <Field label="Reason or details (if the template uses it)"><input name="reason" className="input" /></Field><button className="btn w-full">Generate</button></form></Card>
          {sp.student && check && <Card title="Clearance for TC / no dues"><ul className="divide-y divide-line text-sm">{check.map((c) => <li key={c.item} className="flex justify-between px-4 py-2"><span>{c.item}</span><span>{c.ok ? <Badge tone="green">clear</Badge> : <Badge tone="red">pending</Badge>} <span className="text-xs text-muted">{c.note}</span></span></li>)}</ul>
            <form action={requestTc} className="space-y-2 border-t border-line p-4"><input type="hidden" name="student_id" value={sp.student} /><input name="reason" className="input" placeholder="Reason for leaving" required aria-label="Reason" /><button className="btn-ghost w-full">Request TC approval from principal</button></form></Card>}
          <Card title="APAAR ID collection"><div className="p-4 text-sm">{withId} of {(apaar ?? []).length} active students have an APAAR ID. <Link className="link" href="/erp/reports/statutory">Export the missing list</Link></div></Card></div>}
        <Card title="Recently issued" className={can ? 'lg:col-span-2' : 'lg:col-span-3'}>{I.length === 0 ? <Empty title="Nothing issued yet" hint="Bonafide, study, conduct, no-dues, fee and transfer certificates, achievement certificates and ID cards. Install the starter pack in Admin console to get the templates." /> : <table className="tbl"><thead><tr><th>Number</th><th>Document</th><th>Student</th><th>Issued</th><th>Status</th></tr></thead>
          <tbody>{I.map((d) => <tr key={d.id}><td><Link className="link font-medium" href={`/erp/documents/${d.id}`}>{d.number}</Link></td><td>{d.title}</td><td>{st.name(d.student_id)}</td><td>{fdate(d.issued_on)}</td><td><Badge>{d.status}</Badge></td></tr>)}</tbody></table>}</Card>
      </div>
    </Page>
  );
}
