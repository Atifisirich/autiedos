import Link from 'next/link';
import { requireCap } from '@/lib/erp/ctx';
import { core } from '@/lib/erp/db';
import { lookup } from '@/lib/erp/lookup';
import { Page, Card, Empty, Badge, Stat, Field } from '@/components/erp/ui';
import { ftime, pct, go, str } from '@/lib/erp/fmt';

export const metadata = { title: 'Helpdesk' };
async function raise(fd: FormData) {
  'use server';
  const ctx = await requireCap('helpdesk');
  const cat = str(fd, 'category_id');
  let due: string | null = null;
  if (cat) { const { data: c } = await core(ctx.sb).from('ticket_categories').select('sla_hours').eq('id', cat).maybeSingle(); const h = (c as { sla_hours: number | null } | null)?.sla_hours; if (h) due = new Date(Date.now() + h * 3600000).toISOString(); }
  const { error } = await core(ctx.sb).from('tickets').insert({ title: str(fd, 'title'), description: str(fd, 'description'), category_id: cat, priority: str(fd, 'priority') ?? 'normal', product_key: 'erp', raised_by_user_id: ctx.user.id, raised_by_staff_id: ctx.staff?.id ?? null, raised_by_name: ctx.name, branch_id: ctx.branchId ?? ctx.orgUser.home_branch_id, due_at: due, source: 'manual' });
  go('/erp/helpdesk', error ? error.message : 'Request logged and routed to its owner.', error ? 'err' : 'ok');
}

type T = { id: string; title: string; priority: string; status: string; due_at: string | null; owner_role_key: string | null; raised_by_name: string | null; created_at: string; resolved_at: string | null; rating: number | null; student_id: string | null; category_id: string | null };
/** Helpdesk (HD-01..04): parent and staff requests with owners, SLA, escalation and ratings. */
export default async function Helpdesk({ searchParams }: { searchParams: Promise<{ status?: string; mine?: string }> }) {
  const sp = await searchParams;
  const ctx = await requireCap('helpdesk');
  let q = core(ctx.sb).from('tickets').select('id, title, priority, status, due_at, owner_role_key, raised_by_name, created_at, resolved_at, rating, student_id, category_id').is('deleted_at', null).order('created_at', { ascending: false }).limit(300);
  if (sp.status) q = q.eq('status', sp.status); else q = q.in('status', ['open', 'assigned', 'in_progress', 'waiting', 'reopened']);
  if (sp.mine) q = q.eq('owner_role_key', ctx.role);
  const [{ data }, { data: all }, { data: cats }] = await Promise.all([q, core(ctx.sb).from('tickets').select('status, due_at, resolved_at, rating').is('deleted_at', null).limit(5000), core(ctx.sb).from('ticket_categories').select('id, name').eq('active', true).is('deleted_at', null).order('name')]);
  const Ts = (data ?? []) as T[];
  const A = (all ?? []) as { status: string; due_at: string | null; resolved_at: string | null; rating: number | null }[];
  const lk = await lookup(ctx, 'students', Ts.map((t) => t.student_id));
  const cn = new Map(((cats ?? []) as { id: string; name: string }[]).map((c) => [c.id, c.name]));
  const closed = A.filter((t) => t.resolved_at);
  const inSla = closed.filter((t) => !t.due_at || t.resolved_at! <= t.due_at).length;
  const rated = A.filter((t) => t.rating);
  const now = new Date();
  return (
    <Page title="Helpdesk" sub="Requests are routed to an owner by category, with a service-level timer the parent can see.">
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4"><Stat label="Open" value={A.filter((t) => ['open', 'assigned', 'in_progress', 'waiting', 'reopened'].includes(t.status)).length} /><Stat label="Past SLA" value={A.filter((t) => !t.resolved_at && t.due_at && new Date(t.due_at) < now).length} tone="bad" /><Stat label="Resolved within SLA" value={closed.length ? `${pct(inSla, closed.length)}%` : '—'} hint="target above 85%" /><Stat label="Satisfaction" value={rated.length ? (rated.reduce((t, r) => t + (r.rating ?? 0), 0) / rated.length).toFixed(1) + ' / 5' : '—'} hint={`${rated.length} ratings`} /></div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2" title="Requests" actions={<form className="flex gap-1"><select name="status" defaultValue={sp.status ?? ''} className="input !w-auto !py-1 text-xs" aria-label="Status"><option value="">Open</option>{['resolved', 'closed'].map((s) => <option key={s}>{s}</option>)}</select><label className="flex items-center gap-1 text-xs"><input type="checkbox" name="mine" value="1" defaultChecked={!!sp.mine} />my desk</label><button className="btn-ghost btn-sm">Filter</button></form>}>
          {Ts.length === 0 ? <Empty title="No requests here" hint="Concerns, corrections, certificate and TC requests, and staff maintenance or IT requests all land here." /> : <table className="tbl"><thead><tr><th>Request</th><th>From</th><th>Owner</th><th>SLA</th><th>Status</th></tr></thead>
            <tbody>{Ts.map((t) => { const late = t.due_at && new Date(t.due_at) < now && !['resolved', 'closed'].includes(t.status); return <tr key={t.id}><td><Link className="link font-medium" href={`/erp/helpdesk/${t.id}`}>{t.title}</Link><div className="text-xs text-muted">{t.category_id ? cn.get(t.category_id) : ''} · <Badge>{t.priority}</Badge></div></td><td>{t.raised_by_name}<div className="text-xs text-muted">{lk.name(t.student_id)}</div></td><td>{String(t.owner_role_key ?? '').replace('_', ' ')}</td><td className={late ? 'text-red-600' : 'text-muted'}>{ftime(t.due_at)}{late ? ' · late' : ''}</td><td><Badge>{t.status}</Badge></td></tr>; })}</tbody></table>}</Card>
        <Card title="Log a request"><form action={raise} className="space-y-3 p-4">
          <div className="grid grid-cols-2 gap-2"><Field label="Category"><select name="category_id" className="input"><option value="">—</option>{[...cn].map(([id, n]) => <option key={id} value={id}>{n}</option>)}</select></Field><Field label="Priority"><select name="priority" className="input" defaultValue="normal">{['low', 'normal', 'high', 'urgent'].map((p) => <option key={p}>{p}</option>)}</select></Field></div>
          <Field label="Subject"><input name="title" className="input" required /></Field><Field label="Details"><textarea name="description" rows={3} className="input" /></Field><button className="btn w-full">Log request</button></form></Card>
      </div>
    </Page>
  );
}
