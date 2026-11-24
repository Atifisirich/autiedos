import Link from 'next/link';
import { requireCap } from '@/lib/erp/ctx';
import { core, erp } from '@/lib/erp/db';
import { NO_ID, fullNameOf } from '@/lib/erp/q';
import { lookup } from '@/lib/erp/lookup';
import { Page, Card, Empty, Field } from '@/components/erp/ui';
import { ConfirmSubmit } from '@/components/erp/client';
import { inr, fdate } from '@/lib/erp/fmt';
import { savePlan, savePlanItem, deletePlanItem, generateDemands } from '../actions';

export const metadata = { title: 'Fee structure' };
/** Fee structure builder (FEE-01): heads, plans per programme, instalment schedules. Versioned per year. */
export default async function Structure({ searchParams }: { searchParams: Promise<{ plan?: string; assign?: string }> }) {
  const sp = await searchParams;
  const ctx = await requireCap('fees');
  const [{ data: plans }, { data: progs }, { data: heads }, { data: items }, { data: st }] = await Promise.all([
    erp(ctx.sb).from('fee_plans').select('id, name, category, programme_id').eq('academic_year_id', ctx.year?.id ?? NO_ID).is('deleted_at', null).order('name'),
    core(ctx.sb).from('programmes').select('id, name').is('deleted_at', null).order('seq'),
    erp(ctx.sb).from('fee_heads').select('id, name').eq('active', true).is('deleted_at', null).order('name'),
    sp.plan ? erp(ctx.sb).from('fee_plan_items').select('id, instalment, amount, due_date, head:fee_heads(name)').eq('plan_id', sp.plan).is('deleted_at', null).order('due_date') : Promise.resolve({ data: [] }),
    sp.assign ? core(ctx.sb).from('students').select('id, first_name, last_name').eq('id', sp.assign).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  const can = ctx.can('fees', 'write');
  const P = (plans ?? []) as { id: string; name: string; category: string | null; programme_id: string | null }[];
  const prog = await lookup(ctx, 'programmes', P.map((p) => p.programme_id));
  const I = (items ?? []) as unknown as { id: string; instalment: string; amount: number; due_date: string; head: { name: string } | null }[];
  const plan = P.find((p) => p.id === sp.plan);
  const stud = st as { id: string; first_name: string; last_name: string | null } | null;
  return (
    <Page title="Fee structure" sub={`Plans for ${ctx.year?.name ?? 'this year'}. Fee heads, late-fee rule and receipt series are in the Admin console.`} actions={<Link className="btn-ghost" href="/erp/x/fee_heads">Fee heads</Link>}>
      {stud && <div className="mb-3 rounded-lg bg-brand-soft px-4 py-2 text-sm">Assigning a plan to <b>{fullNameOf(stud)}</b>: open a plan and choose &quot;Raise for this student&quot;.</div>}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Plans">{P.length === 0 ? <Empty title="No fee plans yet" hint="A plan is the set of instalments for a class, for example 'Class 5 day scholar'." /> : <ul className="divide-y divide-line text-sm">{P.map((p) => <li key={p.id}><Link href={`/erp/fees/structure?plan=${p.id}${sp.assign ? `&assign=${sp.assign}` : ''}`} className={`block px-4 py-2.5 hover:bg-paper ${p.id === sp.plan ? 'bg-brand-soft font-semibold' : ''}`}>{p.name}<span className="block text-xs font-normal text-muted">{prog.name(p.programme_id) || 'All classes'}{p.category ? ` · ${p.category}` : ''}</span></Link></li>)}</ul>}
          {can && <form action={savePlan} className="space-y-2 border-t border-line p-4"><input name="name" className="input" placeholder="New plan name" required aria-label="Plan name" /><select name="programme_id" className="input" aria-label="Class"><option value="">All classes</option>{((progs ?? []) as { id: string; name: string }[]).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select><input name="category" className="input" placeholder="Category (optional, e.g. day scholar)" aria-label="Category" /><button className="btn-ghost w-full">Create plan</button></form>}
        </Card>
        <Card title={plan ? plan.name : 'Instalments'} className="lg:col-span-2">
          {!plan ? <Empty title="Choose a plan" hint="Its instalments, due dates and the action to raise demands appear here." /> : <>
            {I.length === 0 ? <Empty title="No instalments yet" hint="Add each fee head and due date below." /> : <table className="tbl"><thead><tr><th>Fee head</th><th>Instalment</th><th>Due date</th><th className="text-right">Amount</th><th></th></tr></thead><tbody>
              {I.map((i) => <tr key={i.id}><td>{i.head?.name}</td><td>{i.instalment}</td><td>{fdate(i.due_date)}</td><td className="text-right tabular-nums">{inr(i.amount)}</td><td className="text-right">{can && <form action={deletePlanItem}><input type="hidden" name="id" value={i.id} /><input type="hidden" name="plan_id" value={plan.id} /><button className="text-xs text-red-600 underline">Remove</button></form>}</td></tr>)}
              <tr><td colSpan={3} className="font-semibold">Total for the year</td><td className="text-right font-semibold tabular-nums">{inr(I.reduce((t, i) => t + Number(i.amount), 0))}</td><td /></tr></tbody></table>}
            {can && <form action={savePlanItem} className="grid gap-2 border-t border-line p-4 sm:grid-cols-5"><input type="hidden" name="plan_id" value={plan.id} />
              <Field label="Fee head"><select name="head_id" className="input" required>{((heads ?? []) as { id: string; name: string }[]).map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}</select></Field>
              <Field label="Instalment"><input name="instalment" className="input" placeholder="Term 1" required /></Field>
              <Field label="Amount"><input name="amount" type="number" min={1} className="input" required /></Field>
              <Field label="Due date"><input name="due_date" type="date" className="input" required /></Field>
              <div className="flex items-end"><button className="btn-ghost w-full">Add</button></div></form>}
            {can && I.length > 0 && <div className="flex flex-wrap gap-2 border-t border-line p-4">
              <form action={generateDemands}><input type="hidden" name="plan_id" value={plan.id} /><ConfirmSubmit className="btn" message={`Raise fee demands for every active student in ${prog.name(plan.programme_id) || 'all classes'}? Students who already have these instalments are skipped.`}>Raise demands for all students</ConfirmSubmit></form>
              {stud && <form action={generateDemands}><input type="hidden" name="plan_id" value={plan.id} /><input type="hidden" name="student_id" value={stud.id} /><button className="btn-ghost">Raise for {stud.first_name} only</button></form>}
            </div>}
          </>}
        </Card>
      </div>
    </Page>
  );
}
