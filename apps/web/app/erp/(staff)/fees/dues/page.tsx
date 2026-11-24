import Link from 'next/link';
import { requireCap } from '@/lib/erp/ctx';
import { erp } from '@/lib/erp/db';
import { sectionsFor, fullNameOf } from '@/lib/erp/q';
import { look } from '@/lib/erp/lookup';
import { Page, Card, Empty, Badge, Stat } from '@/components/erp/ui';
import { ConfirmSubmit } from '@/components/erp/client';
import { inr, inrShort, today, fdate } from '@/lib/erp/fmt';
import { balance, ageingBucket, type Demand } from '@autoed/shared/erp';
import { logFollowup, applyLateFees } from '../actions';

export const metadata = { title: 'Defaulter worklist' };
type Fu = { student_id: string; type: string; note: string | null; promise_date: string | null; promise_amount: number | null };
/** One defaulter worklist by ageing, amount and class, with call and message actions and promises to pay (FEE-09). */
export default async function Dues({ searchParams }: { searchParams: Promise<{ bucket?: string; section?: string; open?: string }> }) {
  const sp = await searchParams;
  const ctx = await requireCap('fees');
  const d = today();
  let q = erp(ctx.sb).from('fee_demands').select('id, student_id, amount, concession, fine, paid, due_date').in('status', ['due', 'partial']).lt('due_date', d).is('deleted_at', null).limit(20000);
  if (ctx.branchId) q = q.or(`branch_id.eq.${ctx.branchId},branch_id.is.null`);
  const [{ data }, { data: fu }, sections] = await Promise.all([q, erp(ctx.sb).from('fee_followups').select('student_id, type, note, promise_date, promise_amount, created_at').is('deleted_at', null).order('created_at', { ascending: false }).limit(2000), sectionsFor(ctx)]);
  const rowsRaw = (data ?? []) as unknown as (Demand & { student_id: string })[];
  const lk = await look(ctx, { students: rowsRaw.map((r) => r.student_id), households: [] as unknown[] });
  const hh = await look(ctx, { households: rowsRaw.map((r) => lk.students.get(r.student_id)?.household_id), sections: rowsRaw.map((r) => lk.students.get(r.student_id)?.section_id) });
  const by = new Map<string, { total: number; oldest: string; n: number }>();
  for (const r of rowsRaw) { const x = by.get(r.student_id) ?? { total: 0, oldest: r.due_date, n: 0 }; x.total += balance(r); x.n++; if (r.due_date < x.oldest) x.oldest = r.due_date; by.set(r.student_id, x); }
  const last = new Map<string, Fu>(); for (const f of (fu ?? []) as Fu[]) if (!last.has(f.student_id)) last.set(f.student_id, f);
  let rows = [...by].map(([id, x]) => { const s = lk.students.get(id); return { id, ...x, s, bucket: ageingBucket(x.oldest, d), phone: String(hh.households.get(s?.household_id)?.phone ?? ''), section: hh.sections.name(s?.section_id) }; }).filter((r) => r.total > 0);
  const buckets = ['0-30', '31-60', '61-90', '90+'] as const;
  const totals = Object.fromEntries(buckets.map((b) => [b, rows.filter((r) => r.bucket === b).reduce((t, r) => t + r.total, 0)]));
  if (sp.bucket) rows = rows.filter((r) => r.bucket === sp.bucket);
  if (sp.section) rows = rows.filter((r) => r.s?.section_id === sp.section);
  rows.sort((a, b) => b.total - a.total);
  const can = ctx.can('fees', 'write');
  return (
    <Page title="Defaulter worklist" sub="Overdue instalments by family. Reminders never block a child's attendance, classes or exams." actions={<>{can && <form action={applyLateFees}><ConfirmSubmit className="btn-ghost" message="Recalculate late fees on all overdue instalments using the school's late-fee rule?">Apply late fees</ConfirmSubmit></form>}<Link className="btn-ghost" href="/erp/reports/fees?view=dues">Export</Link></>}>
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">{buckets.map((b) => <Stat key={b} label={`${b} days overdue`} value={inrShort(totals[b] ?? 0)} href={`/erp/fees/dues?bucket=${b}`} tone={b === '90+' && (totals[b] ?? 0) > 0 ? 'bad' : undefined} />)}</div>
      <form className="no-print mb-3 flex gap-2"><select name="section" defaultValue={sp.section ?? ''} className="input !w-auto" aria-label="Section"><option value="">All sections</option>{sections.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select><select name="bucket" defaultValue={sp.bucket ?? ''} className="input !w-auto" aria-label="Ageing"><option value="">All ageing</option>{buckets.map((b) => <option key={b}>{b}</option>)}</select><button className="btn-ghost">Filter</button></form>
      <Card>{rows.length === 0 ? <Empty title="No overdue fees" hint="Instalments past their due date appear here automatically. No report building is needed." /> : (
        <div className="overflow-x-auto"><table className="tbl"><thead><tr><th>Student</th><th>Class</th><th>Phone</th><th className="text-right">Overdue</th><th>Oldest due</th><th>Ageing</th><th>Last follow-up</th><th></th></tr></thead>
          <tbody>{rows.slice(0, 300).map((r) => { const f = last.get(r.id); return (
            <tr key={r.id}><td><Link className="link font-medium" href={`/erp/students/${r.id}?tab=fees`}>{fullNameOf(r.s as never)}</Link>{r.s?.status !== 'active' && <> <Badge>{String(r.s?.status ?? '')}</Badge></>}</td><td>{r.section}</td><td>{r.phone ? <a className="link" href={`tel:${r.phone}`}>{r.phone}</a> : ''}</td>
              <td className="text-right font-medium tabular-nums">{inr(r.total)}</td><td>{fdate(r.oldest)}</td><td><Badge tone={r.bucket === '90+' ? 'red' : r.bucket === '0-30' ? 'grey' : 'amber'}>{r.bucket}</Badge></td>
              <td className="text-xs text-muted">{f ? <>{f.type}{f.promise_date ? `: promised ${f.promise_amount ? inr(f.promise_amount) : ''} by ${fdate(f.promise_date)}` : f.note ? `: ${f.note}` : ''}</> : 'None'}</td>
              <td className="whitespace-nowrap text-right">{can && <><form action={logFollowup} className="inline"><input type="hidden" name="student_id" value={r.id} /><input type="hidden" name="type" value="message" /><input type="hidden" name="amount" value={r.total} /><button className="btn-ghost btn-sm">Remind</button></form> <Link className="btn-ghost btn-sm" href={`/erp/fees/dues?open=${r.id}${sp.bucket ? `&bucket=${sp.bucket}` : ''}`}>Log</Link> <Link className="btn btn-sm" href={`/erp/fees/counter?student=${r.id}`}>Collect</Link></>}</td></tr>); })}</tbody></table></div>)}
      </Card>
      {sp.open && can && (
        <Card title={`Log a follow-up · ${fullNameOf(lk.students.get(sp.open) as never)}`} className="mt-4"><form action={logFollowup} className="grid gap-3 p-4 sm:grid-cols-5">
          <input type="hidden" name="student_id" value={sp.open} />
          <select name="type" className="input" aria-label="Type"><option value="call">Call</option><option value="promise">Promise to pay</option><option value="visit">Visit</option><option value="note">Note</option></select>
          <input name="note" className="input sm:col-span-2" placeholder="What was said" aria-label="Note" />
          <input name="promise_date" type="date" className="input" aria-label="Promise date" /><input name="promise_amount" type="number" className="input" placeholder="Promised amount" aria-label="Promised amount" />
          <button className="btn sm:col-span-5 sm:w-40">Save</button></form></Card>)}
    </Page>
  );
}
