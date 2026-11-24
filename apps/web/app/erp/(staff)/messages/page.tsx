import Link from 'next/link';
import { requireCap, STAFF_ROLES, ROLE_LABEL, type Ctx } from '@/lib/erp/ctx';
import { core, erp } from '@/lib/erp/db';
import { sectionsFor } from '@/lib/erp/q';
import { lookup } from '@/lib/erp/lookup';
import { Page, Card, Empty, Badge, Field, Tabs, Meter } from '@/components/erp/ui';
import { ConfirmSubmit } from '@/components/erp/client';
import { ftime } from '@/lib/erp/fmt';
import { compose, reply, emergency, sendApproved } from './actions';

export const metadata = { title: 'Messages' };
type Sp = { tab?: string; open?: string };
/** Communication hub (COM-01..07): one composer, one inbox, one log. */
export default async function Messages({ searchParams }: { searchParams: Promise<Sp> }) {
  const sp = await searchParams;
  const tab = sp.tab ?? 'compose';
  const ctx = await requireCap('messages');
  const can = ctx.can('messages', 'write');
  const tabs = [{ href: '/erp/messages', label: 'Compose and log' }, { href: '/erp/messages?tab=inbox', label: 'Parent inbox' }, { href: '/erp/messages?tab=emergency', label: 'Emergency broadcast' }, { href: '/erp/messages?tab=channels', label: 'Channels and templates' }];
  return (
    <Page title="Messages" sub="Announcements, circulars, alerts and two-way parent messages.">
      <Tabs current={tab === 'compose' ? '/erp/messages' : `/erp/messages?tab=${tab}`} tabs={tabs} />
      {tab === 'compose' && <Compose ctx={ctx} can={can} />}{tab === 'inbox' && <Inbox ctx={ctx} can={can} open={sp.open} />}{tab === 'emergency' && <Emergency ctx={ctx} can={can} />}{tab === 'channels' && <Channels ctx={ctx} />}
    </Page>
  );
}

type M = { id: string; kind: string; title: string; audience_label: string | null; channels: string; status: string; sent_at: string | null; recipient_count: number; sent_by_name: string | null };
async function Compose({ ctx, can }: { ctx: Ctx; can: boolean }) {
  const [sections, { data: routes }, { data: log }] = await Promise.all([sectionsFor(ctx), erp(ctx.sb).from('routes').select('id, name').eq('active', true).is('deleted_at', null),
    erp(ctx.sb).from('announcements').select('id, kind, title, audience_label, channels, status, sent_at, recipient_count, sent_by_name').is('deleted_at', null).order('created_at', { ascending: false }).limit(40)]);
  const L = (log ?? []) as M[];
  const { data: reads } = L.length ? await erp(ctx.sb).from('announcement_recipients').select('message_id').in('message_id', L.map((l) => l.id)).not('read_at', 'is', null).is('deleted_at', null).limit(20000) : { data: [] };
  const readBy = new Map<string, number>(); for (const r of (reads ?? []) as { message_id: string }[]) readBy.set(r.message_id, (readBy.get(r.message_id) ?? 0) + 1);
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      {can && <Card title="New message"><form action={compose} className="space-y-3 p-4">
        <Field label="Type"><select name="kind" className="input">{['announcement', 'circular', 'alert', 'greeting'].map((k) => <option key={k}>{k}</option>)}</select></Field>
        <Field label="Send to"><select name="scope" className="input"><option value="section">One section (parents)</option><option value="route">One bus route (parents)</option><option value="parents">All parents</option><option value="staff">All staff</option><option value="role">One staff role</option><option value="all">Whole school</option></select></Field>
        <Field label="Section"><select name="section_id" className="input"><option value="">—</option>{sections.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
        <div className="grid grid-cols-2 gap-2"><Field label="Bus route"><select name="route_id" className="input"><option value="">—</option>{((routes ?? []) as { id: string; name: string }[]).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></Field><Field label="Staff role"><select name="role" className="input"><option value="">—</option>{STAFF_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}</select></Field></div>
        <Field label="Title"><input name="title" className="input" required /></Field><Field label="Message"><textarea name="body" className="input" rows={4} required /></Field>
        <fieldset className="text-sm"><legend className="label">Channels (app is always used first)</legend>{['whatsapp', 'sms', 'email', 'voice'].map((c) => <label key={c} className="mr-3 inline-flex items-center gap-1"><input type="checkbox" name="channels" value={c} className="h-4 w-4" />{c}</label>)}</fieldset>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="requires_ack" className="h-4 w-4" /> Ask for acknowledgement</label>
        <button className="btn w-full">Send</button></form></Card>}
      <Card title="Sent and pending" className={can ? 'lg:col-span-2' : 'lg:col-span-3'}>{L.length === 0 ? <Empty title="No messages yet" hint="Everything sent from here is logged with delivery and read tracking." /> : <table className="tbl"><thead><tr><th>Message</th><th>To</th><th>Channels</th><th className="w-40">Read</th><th>Status</th></tr></thead>
        <tbody>{L.map((m) => <tr key={m.id}><td><div className="font-medium">{m.title}</div><div className="text-xs text-muted">{m.kind} · {m.sent_by_name} · {ftime(m.sent_at)}</div></td><td>{m.audience_label}</td><td>{m.channels}</td>
          <td>{m.status === 'sent' ? <><Meter value={readBy.get(m.id) ?? 0} max={m.recipient_count || 1} /><span className="text-xs text-muted">{readBy.get(m.id) ?? 0} of {m.recipient_count} read</span></> : ''}</td>
          <td><Badge>{m.status}</Badge>{m.status === 'scheduled' && can && <form action={sendApproved}><input type="hidden" name="id" value={m.id} /><button className="btn btn-sm mt-1">Send now (approved)</button></form>}</td></tr>)}</tbody></table>}</Card>
    </div>);
}

type C = { id: string; subject: string; parent_name: string | null; with_role: string; status: string; last_message_at: string; student_id: string | null };
async function Inbox({ ctx, can, open }: { ctx: Ctx; can: boolean; open?: string }) {
  const [{ data }, { data: thread }] = await Promise.all([erp(ctx.sb).from('conversations').select('id, subject, parent_name, with_role, status, last_message_at, student_id').is('deleted_at', null).order('last_message_at', { ascending: false }).limit(60),
    open ? erp(ctx.sb).from('conversation_messages').select('id, sender_name, body, at, sender').eq('conversation_id', open).is('deleted_at', null).order('at') : Promise.resolve({ data: [] })]);
  const Cs = (data ?? []) as C[];
  const st = await lookup(ctx, 'students', Cs.map((c) => c.student_id));
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card title="Conversations">{Cs.length === 0 ? <Empty title="No parent messages" hint="Parents can message the class teacher or the office from the app, within the hours the school sets." /> : <ul className="divide-y divide-line text-sm">{Cs.map((c) => <li key={c.id}><Link href={`/erp/messages?tab=inbox&open=${c.id}`} className={`block px-4 py-2.5 hover:bg-paper ${open === c.id ? 'bg-brand-soft' : ''}`}><div className="flex justify-between gap-2"><span className="font-medium">{c.subject}</span><Badge>{c.status}</Badge></div><div className="text-xs text-muted">{c.parent_name} · {st.name(c.student_id)} · {c.with_role.replace('_', ' ')} · {ftime(c.last_message_at)}</div></Link></li>)}</ul>}</Card>
      <Card title="Thread" className="lg:col-span-2">{!open ? <Empty title="Choose a conversation" /> : <><ul className="space-y-2 p-4">{((thread ?? []) as { id: string; sender_name: string | null; body: string; at: string; sender: string | null }[]).map((t) => <li key={t.id} className={`max-w-[85%] rounded-xl px-3 py-2 text-sm ${t.sender === ctx.user.id ? 'ml-auto bg-brand-soft' : 'bg-paper'}`}><div className="text-xs text-muted">{t.sender_name} · {ftime(t.at)}</div>{t.body}</li>)}</ul>
        {can && <form action={reply} className="flex flex-wrap items-center gap-2 border-t border-line p-4"><input type="hidden" name="conversation" value={open} /><input name="body" className="input flex-1" placeholder="Write a reply" required aria-label="Reply" /><label className="flex items-center gap-1 text-xs"><input type="checkbox" name="close" className="h-4 w-4" />close</label><button className="btn">Reply</button></form>}</>}</Card>
    </div>);
}

async function Emergency({ ctx, can }: { ctx: Ctx; can: boolean }) {
  const { data } = await erp(ctx.sb).from('emergency_broadcasts').select('id, type, message, is_drill, sent_at, sent_by_name, acks:broadcast_acks(count)').is('deleted_at', null).order('sent_at', { ascending: false }).limit(20);
  const D = (data ?? []) as unknown as { id: string; type: string; message: string; is_drill: boolean; sent_at: string; sent_by_name: string | null; acks: { count: number }[] }[];
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      {can && <Card title="Send an emergency broadcast"><form action={emergency} className="space-y-3 p-4"><Field label="Type"><select name="type" className="input">{['lockdown', 'evacuation', 'weather', 'drill', 'other'].map((t) => <option key={t}>{t}</option>)}</select></Field><Field label="Message"><textarea name="message" rows={3} className="input" required /></Field><label className="flex items-center gap-2 text-sm"><input type="checkbox" name="is_drill" className="h-4 w-4" /> This is a drill</label>
        <ConfirmSubmit message="Send this to every staff member and parent now? Emergency broadcasts ignore quiet hours." className="btn-danger">Send to everyone now</ConfirmSubmit></form></Card>}
      <Card title="Broadcasts and drill records" className="lg:col-span-2">{D.length === 0 ? <Empty title="No broadcasts sent" hint="Lockdown, evacuation and weather-closure alerts reach staff and parents at once, with acknowledgement tracking." /> : <ul className="divide-y divide-line text-sm">{D.map((b) => <li key={b.id} className="px-4 py-2.5"><div className="flex justify-between"><span><Badge tone="red">{b.type}</Badge> {b.is_drill && <Badge tone="grey">drill</Badge>} {b.message}</span><span className="text-xs text-muted">{ftime(b.sent_at)}</span></div><div className="text-xs text-muted">{b.acks?.[0]?.count ?? 0} acknowledged · sent by {b.sent_by_name}</div></li>)}</ul>}</Card>
    </div>);
}

async function Channels({ ctx }: { ctx: Ctx }) {
  const [{ data: ints }, { data: out }, { data: tpl }] = await Promise.all([core(ctx.sb).from('integrations').select('id, type, name, enabled, status').in('type', ['whatsapp', 'sms', 'email', 'voice']).is('deleted_at', null), core(ctx.sb).from('outbox').select('channel, status').is('deleted_at', null).limit(5000), core(ctx.sb).from('message_templates').select('id, event_key, channel, body, enabled').eq('product_key', 'erp').is('deleted_at', null)]);
  const by = new Map<string, number>(); for (const o of (out ?? []) as { channel: string; status: string }[]) by.set(`${o.channel}:${o.status}`, (by.get(`${o.channel}:${o.status}`) ?? 0) + 1);
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Channels" actions={<Link className="link text-sm" href="/erp/x/message_templates">Templates</Link>}><table className="tbl"><thead><tr><th>Channel</th><th>Provider status</th><th>Queued</th><th>Sent</th></tr></thead><tbody>
        <tr><td>App notification</td><td><Badge tone="green">working</Badge></td><td>—</td><td>—</td></tr>
        {((ints ?? []) as { id: string; type: string; name: string; enabled: boolean }[]).map((i) => <tr key={i.id}><td>{i.name}</td><td>{i.enabled ? <Badge tone="green">connected</Badge> : <Badge tone="amber">not connected</Badge>}</td><td>{by.get(`${i.type}:queued`) ?? 0}</td><td>{by.get(`${i.type}:sent`) ?? 0}</td></tr>)}</tbody></table>
        <p className="border-t border-line px-4 py-3 text-xs text-muted">WhatsApp, SMS, email and voice messages are queued until a provider is connected in Admin console → Integrations. The school can bring its own provider or use the one run by AutoEd.</p></Card>
      <Card title="Event templates" actions={<Link className="link text-sm" href="/erp/x/message_templates">Edit</Link>}><ul className="divide-y divide-line text-sm">{((tpl ?? []) as { id: string; event_key: string | null; channel: string; body: string; enabled: boolean }[]).map((t) => <li key={t.id} className="px-4 py-2"><div className="flex justify-between"><span className="font-medium">{(t.event_key ?? '').replace(/_/g, ' ')} · {t.channel}</span><Badge>{t.enabled ? 'active' : 'draft'}</Badge></div><p className="text-muted">{t.body}</p></li>)}</ul></Card>
    </div>);
}
