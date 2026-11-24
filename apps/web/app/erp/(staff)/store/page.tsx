import Link from 'next/link';
import { requireCap, type Ctx } from '@/lib/erp/ctx';
import { core, erp } from '@/lib/erp/db';
import { options, lookup } from '@/lib/erp/lookup';
import { Page, Card, Empty, Badge, Field, Tabs } from '@/components/erp/ui';
import { inr, go, str, ftime, today } from '@/lib/erp/fmt';
import { entitiesOf } from '@/lib/erp/nav';

export const metadata = { title: 'Store and canteen' };
async function sell(fd: FormData) {
  'use server';
  const ctx = await requireCap('inventory', 'write');
  const counter = str(fd, 'counter') ?? 'canteen';
  const lines = [1, 2, 3, 4].map((n) => { const it = str(fd, `item${n}`); if (!it) return null; const [item_id, name, price] = it.split('|'); return { item_id, name, price: Number(price), qty: Number(str(fd, `qty${n}`) ?? 1) }; }).filter(Boolean);
  const { error } = await erp(ctx.sb).rpc('pos_sale', { p: { counter, student_id: str(fd, 'student_id'), payment_mode: str(fd, 'payment_mode'), lines } });
  go(`/erp/store?tab=${counter}`, error ? error.message : 'Sale recorded.', error ? 'err' : 'ok');
}
async function topup(fd: FormData) {
  'use server';
  const ctx = await requireCap('canteen', 'write');
  const sid = str(fd, 'student_id')!, amt = Number(str(fd, 'amount') ?? 0);
  if (amt <= 0) go('/erp/store?tab=wallets', 'Enter an amount.', 'err');
  const { error } = await erp(ctx.sb).rpc('wallet_topup', { p_student: sid, p_amount: amt, p_ref: 'Counter top-up', p_type: 'topup' });
  if (error) go('/erp/store?tab=wallets', error.message, 'err');
  const patch: Record<string, unknown> = {};
  if (str(fd, 'daily_limit')) patch.daily_limit = Number(str(fd, 'daily_limit'));
  if (str(fd, 'blocked_items')) patch.blocked_items = str(fd, 'blocked_items');
  if (Object.keys(patch).length) await erp(ctx.sb).from('student_wallets').update(patch).eq('student_id', sid);
  go('/erp/store?tab=wallets', `Wallet topped up by ${inr(amt)}.`);
}
async function stock(fd: FormData) {
  'use server';
  const ctx = await requireCap('inventory', 'write');
  const type = str(fd, 'type') ?? 'inward';
  const qty = Number(str(fd, 'qty') ?? 0);
  const { error } = await erp(ctx.sb).from('stock_movements').insert({ item_id: str(fd, 'item_id'), qty: ['issue', 'damage', 'transfer_out'].includes(type) ? -Math.abs(qty) : Math.abs(qty), type, issued_to: str(fd, 'issued_to'), note: str(fd, 'note'), branch_id: ctx.branchId ?? ctx.orgUser.home_branch_id });
  go('/erp/store?tab=stock', error ? error.message : 'Stock updated.', error ? 'err' : 'ok');
}
async function orderStatus(fd: FormData) { 'use server'; const ctx = await requireCap('inventory', 'write'); await erp(ctx.sb).from('store_orders').update({ status: str(fd, 'status') }).eq('id', str(fd, 'id')!); go('/erp/store?tab=store', 'Order updated.'); }

type Item = { id: string; name: string; category: string; price: number; reorder_level: number; allergens: string | null; unit: string };
export default async function Store({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const sp = await searchParams;
  const tab = sp.tab ?? 'canteen';
  const ctx = await requireCap('inventory');
  const can = ctx.can('inventory', 'write');
  const [{ data: items }, { data: moves }, studs] = await Promise.all([erp(ctx.sb).from('items').select('id, name, category, price, reorder_level, allergens, unit').eq('active', true).is('deleted_at', null).order('name'), erp(ctx.sb).from('stock_movements').select('item_id, qty').is('deleted_at', null).limit(50000), options(ctx, 'students')]);
  const I = (items ?? []) as Item[];
  const onHand = new Map<string, number>(); for (const m of (moves ?? []) as { item_id: string; qty: number }[]) onHand.set(m.item_id, (onHand.get(m.item_id) ?? 0) + Number(m.qty));
  const cats = tab === 'canteen' ? ['canteen'] : ['store', 'uniform', 'book', 'stationery'];
  const sellable = I.filter((i) => cats.includes(i.category));
  const low = I.filter((i) => Number(i.reorder_level) > 0 && (onHand.get(i.id) ?? 0) <= Number(i.reorder_level));
  return (
    <Page title="Store, canteen and inventory" sub="One item master for the school store, canteen and general inventory." actions={<><Link className="btn-ghost" href="/erp/x/items">Item master</Link><Link className="btn-ghost" href="/erp/x/purchase_requests">Purchase requests</Link><Link className="btn-ghost" href="/erp/x/purchase_orders">Purchase orders</Link></>}>
      <Tabs current={tab === 'canteen' ? '/erp/store' : `/erp/store?tab=${tab}`} tabs={[{ href: '/erp/store', label: 'Canteen counter' }, { href: '/erp/store?tab=store', label: 'School store' }, { href: '/erp/store?tab=wallets', label: 'Wallets' }, { href: '/erp/store?tab=stock', label: 'Stock', count: low.length }, { href: '/erp/store?tab=more', label: 'Assets and procurement' }]} />
      {(tab === 'canteen' || tab === 'store') && <Counter ctx={ctx} tab={tab} can={can} sellable={sellable} studs={studs} />}{tab === 'wallets' && <Wallets ctx={ctx} studs={studs} />}{tab === 'stock' && <Stock items={I} onHand={onHand} can={can} />}
      {tab === 'more' && <Card><div className="grid gap-px bg-line sm:grid-cols-2 lg:grid-cols-4">{[...entitiesOf('inventory'), ...entitiesOf('canteen')].map((e) => <Link key={e.table} href={`/erp/x/${e.table}`} className="bg-white px-4 py-3 text-sm hover:bg-paper">{e.title}</Link>)}</div></Card>}
    </Page>
  );
}

type Studs = Awaited<ReturnType<typeof options>>;
async function Counter({ ctx, tab, can, sellable, studs }: { ctx: Ctx; tab: string; can: boolean; sellable: Item[]; studs: Studs }) {
  const [{ data: sales }, { data: orders }, { data: sens }] = await Promise.all([erp(ctx.sb).from('sales').select('id, total, payment_mode, at, lines, student_id').eq('counter', tab).gte('at', today() + 'T00:00:00+05:30').is('deleted_at', null).order('at', { ascending: false }).limit(30),
    tab === 'store' ? erp(ctx.sb).from('store_orders').select('id, lines, total, status, sizes_note, student_id').in('status', ['ordered', 'paid', 'ready']).is('deleted_at', null).order('created_at') : Promise.resolve({ data: [] }),
    tab === 'canteen' && ctx.can('sensitive') ? core(ctx.sb).from('student_sensitive').select('student_id, allergies').not('allergies', 'is', null).is('deleted_at', null) : Promise.resolve({ data: [] })]);
  const S = (sales ?? []) as unknown as { id: string; total: number; payment_mode: string; at: string; lines: { name: string; qty: number }[]; student_id: string | null }[];
  const O = (orders ?? []) as unknown as { id: string; lines: { name: string; qty: number; size?: string }[]; total: number; status: string; student_id: string }[];
  const st = await lookup(ctx, 'students', [...S.map((s) => s.student_id), ...O.map((o) => o.student_id)]);
  const al = new Map(((sens ?? []) as { student_id: string; allergies: string }[]).map((s) => [s.student_id, s.allergies]));
  return <div className="grid gap-4 lg:grid-cols-3">
    {can && <Card title={tab === 'canteen' ? 'Canteen sale' : 'Store sale'}><form action={sell} className="space-y-3 p-4"><input type="hidden" name="counter" value={tab} />
      <Field label="Student (scan ID card or choose)"><select name="student_id" className="input"><option value="">Walk-in / staff (cash)</option>{studs.map((s) => <option key={s.value} value={s.value}>{s.label} · {String(s.row.admission_no ?? '')}{al.get(s.value) ? ` · ALLERGY: ${al.get(s.value)}` : ''}</option>)}</select></Field>
      {[1, 2, 3, 4].map((n) => <div key={n} className="grid grid-cols-[1fr_70px] gap-2"><select name={`item${n}`} className="input" aria-label={`Item ${n}`} required={n === 1}><option value="">{n === 1 ? 'Choose item' : '+ item'}</option>{sellable.map((i) => <option key={i.id} value={`${i.id}|${i.name}|${i.price}`}>{i.name} · {inr(i.price)}{i.allergens ? ` · contains ${i.allergens}` : ''}</option>)}</select><input name={`qty${n}`} type="number" min={1} defaultValue={1} className="input" aria-label={`Quantity ${n}`} /></div>)}
      <Field label="Payment"><select name="payment_mode" className="input">{(tab === 'canteen' ? ['wallet', 'cash', 'upi'] : ['cash', 'upi', 'card', 'wallet']).map((m) => <option key={m}>{m}</option>)}</select></Field><button className="btn w-full">Complete sale</button>
      <p className="text-xs text-muted">Wallet sales respect the daily limit and blocked items set by the parent.</p></form></Card>}
    <div className={`space-y-4 ${can ? 'lg:col-span-2' : 'lg:col-span-3'}`}>
      {tab === 'store' && <Card title="Parent orders">{O.length === 0 ? <Empty title="No open orders" hint="Parents order uniforms and kits in the app for pick-up." /> : <ul className="divide-y divide-line text-sm">{O.map((o) => <li key={o.id} className="flex items-center justify-between gap-2 px-4 py-2.5"><span>{st.name(o.student_id)} · {o.lines.map((l) => `${l.qty} × ${l.name}${l.size ? ` (${l.size})` : ''}`).join(', ')} · {inr(o.total)}</span>{can && <form action={orderStatus} className="flex gap-1"><input type="hidden" name="id" value={o.id} />{['paid', 'ready', 'delivered'].map((s) => <button key={s} name="status" value={s} className={o.status === s ? 'btn btn-sm' : 'btn-ghost btn-sm'}>{s}</button>)}</form>}</li>)}</ul>}</Card>}
      <Card title="Today's sales">{S.length === 0 ? <Empty title="No sales yet today" /> : <ul className="divide-y divide-line text-sm">{S.map((s) => <li key={s.id} className="flex justify-between gap-2 px-4 py-2"><span>{s.lines.map((l) => `${l.qty} × ${l.name}`).join(', ')}<span className="block text-xs text-muted">{st.name(s.student_id) || 'Walk-in'} · {ftime(s.at)}</span></span><span>{inr(s.total)} <Badge tone="grey">{s.payment_mode}</Badge></span></li>)}</ul>}</Card></div></div>;
}
async function Wallets({ ctx, studs }: { ctx: Ctx; studs: Studs }) {
  const { data: w } = await erp(ctx.sb).from('student_wallets').select('id, student_id, balance, daily_limit, blocked_items').is('deleted_at', null).order('balance', { ascending: false }).limit(300);
  const W = (w ?? []) as { id: string; student_id: string | null; balance: number; daily_limit: number | null; blocked_items: string | null }[];
  const st = await lookup(ctx, 'students', W.map((x) => x.student_id));
  return <div className="grid gap-4 lg:grid-cols-3">{ctx.can('canteen', 'write') && <Card title="Top up or set limits"><form action={topup} className="space-y-3 p-4"><Field label="Student"><select name="student_id" className="input" required><option value="">Choose</option>{studs.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</select></Field><Field label="Amount received"><input name="amount" type="number" min={1} required className="input" /></Field><Field label="Daily spend limit (parent's choice)"><input name="daily_limit" type="number" className="input" /></Field><Field label="Blocked items (comma separated)"><input name="blocked_items" className="input" /></Field><button className="btn w-full">Top up</button></form></Card>}
    <Card title={`Wallet balances · liability ${inr(W.reduce((t, x) => t + Number(x.balance), 0))}`} className="lg:col-span-2">{W.length === 0 ? <Empty title="No wallets yet" /> : <table className="tbl"><thead><tr><th>Student</th><th className="text-right">Balance</th><th>Daily limit</th><th>Blocked</th></tr></thead><tbody>{W.map((x) => <tr key={x.id}><td>{st.name(x.student_id)}</td><td className="text-right tabular-nums">{inr(x.balance)}</td><td>{x.daily_limit ? inr(x.daily_limit) : '—'}</td><td>{x.blocked_items}</td></tr>)}</tbody></table>}</Card></div>;
}
function Stock({ items, onHand, can }: { items: Item[]; onHand: Map<string, number>; can: boolean }) {
  return <div className="grid gap-4 lg:grid-cols-3">{can && <Card title="Stock movement"><form action={stock} className="space-y-3 p-4"><Field label="Item"><select name="item_id" className="input" required>{items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</select></Field><div className="grid grid-cols-2 gap-2"><Field label="Type"><select name="type" className="input">{['inward', 'issue', 'damage', 'transfer_in', 'transfer_out', 'adjust'].map((t) => <option key={t} value={t}>{t.replace('_', ' ')}</option>)}</select></Field><Field label="Quantity"><input name="qty" type="number" required className="input" /></Field></div><Field label="Issued to / from"><input name="issued_to" className="input" /></Field><Field label="Note"><input name="note" className="input" /></Field><button className="btn w-full">Record</button></form></Card>}
    <Card title="Stock on hand" className="lg:col-span-2">{items.length === 0 ? <Empty title="No items yet" hint="Add items to the item master first." /> : <table className="tbl"><thead><tr><th>Item</th><th>Category</th><th className="text-right">On hand</th><th className="text-right">Reorder at</th><th></th></tr></thead><tbody>{items.map((i) => { const q = onHand.get(i.id) ?? 0; return <tr key={i.id}><td>{i.name}</td><td>{i.category}</td><td className="text-right tabular-nums">{q} {i.unit}</td><td className="text-right tabular-nums">{Number(i.reorder_level) || ''}</td><td>{Number(i.reorder_level) > 0 && q <= Number(i.reorder_level) && <Badge tone="red">reorder</Badge>}</td></tr>; })}</tbody></table>}</Card></div>;
}
