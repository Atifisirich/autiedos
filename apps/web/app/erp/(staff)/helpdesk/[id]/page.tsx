import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getCtx, STAFF_ROLES, ROLE_LABEL } from '@/lib/erp/ctx';
import { core } from '@/lib/erp/db';
import { lookup } from '@/lib/erp/lookup';
import { Page, Card, Badge, Field } from '@/components/erp/ui';
import { ftime, go, str } from '@/lib/erp/fmt';

async function act(fd: FormData) {
  'use server';
  const ctx = await getCtx();
  const id = str(fd, 'id')!;
  const body = str(fd, 'body');
  const { data } = await core(ctx.sb).from('tickets').select('raised_by_user_id, title, status').eq('id', id).single();
  const t = data as { raised_by_user_id: string | null; title: string; status: string } | null;
  const status = str(fd, 'status');
  const patch: Record<string, unknown> = {};
  if (status && status !== t?.status) { patch.status = status; if (status === 'resolved') { patch.resolved_at = new Date().toISOString(); patch.resolution = body ?? 'Resolved'; } if (status === 'closed') patch.closed_at = new Date().toISOString(); }
  if (str(fd, 'owner_role_key')) patch.owner_role_key = str(fd, 'owner_role_key');
  if (Object.keys(patch).length) await core(ctx.sb).from('tickets').update(patch).eq('id', id);
  if (body || patch.status) await core(ctx.sb).from('ticket_events').insert({ ticket_id: id, event: patch.status ? 'status' : 'comment', from_status: patch.status ? t?.status : null, to_status: (patch.status as string | undefined) ?? null, note: body, internal: fd.get('internal') === 'on', actor_user_id: ctx.user.id, actor_staff_id: ctx.staff?.id ?? null, actor_name: ctx.name });
  if (t?.raised_by_user_id && t.raised_by_user_id !== ctx.user.id && fd.get('internal') !== 'on' && (body || patch.status)) await core(ctx.sb).from('notifications').insert({ user_id: t.raised_by_user_id, product_key: 'erp', event_key: 'helpdesk.update', title: `Update on: ${t.title}`, body: body ?? `Status: ${patch.status}`, link: `/erp/helpdesk/${id}` });
  go(`/erp/helpdesk/${id}`, 'Saved.');
}

type E = { id: string; actor_name: string | null; note: string | null; internal: boolean; created_at: string; event: string };
export default async function Ticket({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getCtx();
  const { data: t } = await core(ctx.sb).from('tickets').select('*').eq('id', id).is('deleted_at', null).maybeSingle();
  if (!t) notFound();
  const [{ data: ev }, lk] = await Promise.all([core(ctx.sb).from('ticket_events').select('id, actor_name, note, internal, created_at, event').eq('ticket_id', id).is('deleted_at', null).order('created_at'), lookup(ctx, 'students', [t.student_id])]);
  const late = t.due_at && new Date(t.due_at) < new Date() && !['resolved', 'closed'].includes(t.status);
  const events = ((ev ?? []) as E[]).filter((e) => e.note);
  return (
    <Page title={t.title} sub={<>raised by {t.raised_by_name} on {ftime(t.created_at)} · <Link className="link" href="/erp/helpdesk">Back</Link></>}>
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2" title="Conversation">
          <div className="space-y-3 p-4">{t.description && <p className="rounded-lg bg-paper p-3 text-sm">{t.description}</p>}
            {events.map((c) => <div key={c.id} className={`rounded-lg p-3 text-sm ${c.internal ? 'border border-amber-200 bg-amber-50' : 'bg-paper'}`}><div className="text-xs text-muted">{c.actor_name} · {ftime(c.created_at)}{c.internal ? ' · internal note' : ''}</div>{c.note}</div>)}</div>
          {t.status !== 'closed' && <form action={act} className="space-y-3 border-t border-line p-4"><input type="hidden" name="id" value={id} />
            <textarea name="body" rows={3} className="input" placeholder="Reply to the requester, or add an internal note" aria-label="Message" />
            <div className="flex flex-wrap items-end gap-3"><Field label="Status"><select name="status" defaultValue={t.status} className="input">{['open', 'assigned', 'in_progress', 'waiting', 'resolved', 'closed', 'reopened'].map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}</select></Field><Field label="Reassign to"><select name="owner_role_key" defaultValue={t.owner_role_key ?? ''} className="input"><option value="">—</option>{STAFF_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}</select></Field><label className="flex items-center gap-2 pb-2 text-sm"><input type="checkbox" name="internal" className="h-4 w-4" /> Internal note</label><button className="btn">Save</button></div></form>}
        </Card>
        <Card title="Details"><dl className="space-y-2 p-4 text-sm">{[['Status', <Badge key="s">{t.status}</Badge>], ['Priority', <Badge key="p">{t.priority}</Badge>], ['Owner', String(t.owner_role_key ?? '').replace('_', ' ')], ['Respond by', <span key="d" className={late ? 'text-red-600' : ''}>{ftime(t.due_at)}{late ? ' · past SLA' : ''}</span>], ['Student', t.student_id ? <Link key="st" className="link" href={`/erp/students/${t.student_id}`}>{lk.name(t.student_id)}</Link> : '—'], ['Resolution', t.resolution ?? '—'], ['Rating', t.rating ? `${t.rating} / 5` : '—']].map(([k, v]) => <div key={String(k)} className="flex justify-between gap-3"><dt className="text-muted">{k}</dt><dd className="text-right">{v}</dd></div>)}</dl></Card>
      </div>
    </Page>
  );
}
