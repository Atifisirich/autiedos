import Link from 'next/link';
import { revalidatePath } from 'next/cache';
import { getCtx } from '@/lib/erp/ctx';
import { core, erp } from '@/lib/erp/db';
import { Page, Card, Empty } from '@/components/erp/ui';
import { ftime, str, go } from '@/lib/erp/fmt';

export const metadata = { title: 'Notifications' };
async function readAll() {
  'use server';
  const ctx = await getCtx();
  await core(ctx.sb).from('notifications').update({ read_at: new Date().toISOString() }).eq('user_id', ctx.user.id).is('read_at', null);
  revalidatePath('/erp', 'layout');
}
async function ack(fd: FormData) {
  'use server';
  const ctx = await getCtx();
  const now = new Date().toISOString();
  await erp(ctx.sb).from('announcement_recipients').update({ ack_at: now, read_at: now }).eq('id', str(fd, 'id')!);
  go('/erp/inbox', 'Acknowledged.');
}

type N = { id: string; title: string; body: string | null; link: string | null; read_at: string | null; created_at: string };
export default async function Inbox() {
  const ctx = await getCtx();
  const [{ data }, { data: circ }] = await Promise.all([
    core(ctx.sb).from('notifications').select('id, title, body, link, read_at, created_at').eq('user_id', ctx.user.id).is('deleted_at', null).order('created_at', { ascending: false }).limit(80),
    erp(ctx.sb).from('announcement_recipients').select('id, title, body, requires_ack, read_at, ack_at, created_at').eq('user_id', ctx.user.id).is('deleted_at', null).order('created_at', { ascending: false }).limit(20),
  ]);
  const notes = (data ?? []) as N[];
  const circs = (circ ?? []) as { id: string; title: string | null; body: string | null; requires_ack: boolean; ack_at: string | null; created_at: string }[];
  return (
    <Page title="Notifications" actions={<form action={readAll}><button className="btn-ghost">Mark all as read</button></form>}>
      {circs.length > 0 && <Card title="Announcements and circulars" className="mb-4"><ul className="divide-y divide-line text-sm">{circs.map((c) => (
        <li key={c.id} className="px-4 py-2.5"><div className="flex items-start justify-between gap-3"><div><div className="font-medium">{c.title}{c.requires_ack && !c.ack_at ? <span className="ml-2 text-xs text-amber-700">needs acknowledgement</span> : null}</div><p className="text-muted">{c.body}</p></div>
          {c.requires_ack && !c.ack_at && <form action={ack}><input type="hidden" name="id" value={c.id} /><button className="btn-ghost btn-sm">Acknowledge</button></form>}</div></li>))}</ul></Card>}
      <Card>{notes.length === 0 ? <Empty title="You are all caught up" hint="Alerts about approvals, attendance, fees, buses and requests appear here." /> : <ul className="divide-y divide-line">{notes.map((n) => (
        <li key={n.id} className={`px-4 py-2.5 text-sm ${n.read_at ? '' : 'bg-brand-soft'}`}><div className="flex justify-between gap-3">{n.link ? <Link className="link font-medium" href={n.link}>{n.title}</Link> : <span className="font-medium">{n.title}</span>}<span className="shrink-0 text-xs text-muted">{ftime(n.created_at)}</span></div>{n.body && <p className="text-muted">{n.body}</p>}</li>))}</ul>}</Card>
    </Page>
  );
}
