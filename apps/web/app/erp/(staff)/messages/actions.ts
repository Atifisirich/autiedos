'use server';
import { getCtx, type Ctx } from '@/lib/erp/ctx';
import { core, erp } from '@/lib/erp/db';
import { go, str } from '@/lib/erp/fmt';
import { NO_ID } from '@/lib/erp/q';

/** Expand an audience into app users. Parents come from the guardians of matching active students; staff from core.staff with a login. */
async function audienceUsers(ctx: Ctx, a: { scope: string; section_id?: string | null; route_id?: string | null; role?: string | null }) {
  const users = new Map<string, string | null>();
  if (['all', 'parents', 'section', 'route'].includes(a.scope)) {
    let ids: string[] | null = null;
    if (a.scope === 'route' && a.route_id) { const { data } = await erp(ctx.sb).from('student_transport').select('student_id').eq('route_id', a.route_id).eq('active', true).is('deleted_at', null); ids = ((data ?? []) as { student_id: string }[]).map((d) => d.student_id); }
    let q = core(ctx.sb).from('students').select('id, household_id').eq('status', 'active').is('deleted_at', null).limit(20000);
    if (a.scope === 'section' && a.section_id) q = q.eq('section_id', a.section_id);
    if (ids) q = q.in('id', ids.length ? ids : [NO_ID]);
    if (ctx.branchId) q = q.eq('branch_id', ctx.branchId);
    const { data: studs } = await q;
    const S = (studs ?? []) as { id: string; household_id: string | null }[];
    const hh = [...new Set(S.map((s) => s.household_id).filter((x): x is string => !!x))];
    for (let i = 0; i < hh.length; i += 300) {
      const { data: gs } = await core(ctx.sb).from('guardians').select('user_id, household_id').in('household_id', hh.slice(i, i + 300)).not('user_id', 'is', null).is('deleted_at', null);
      for (const g of (gs ?? []) as { user_id: string; household_id: string }[]) users.set(g.user_id, S.find((s) => s.household_id === g.household_id)?.id ?? null);
    }
  }
  if (['all', 'staff', 'role'].includes(a.scope)) {
    if (a.scope === 'role' && a.role) {
      const { data } = await core(ctx.sb).from('user_product_access').select('user_id').eq('product_key', 'erp').eq('role_key', a.role).is('revoked_at', null);
      for (const p of (data ?? []) as { user_id: string }[]) users.set(p.user_id, null);
    } else {
      const { data } = await core(ctx.sb).from('staff').select('user_id').eq('status', 'active').not('user_id', 'is', null).is('deleted_at', null);
      for (const p of (data ?? []) as { user_id: string }[]) users.set(p.user_id, null);
    }
  }
  return users;
}

async function deliver(ctx: Ctx, id: string) {
  const { data } = await erp(ctx.sb).from('announcements').select('*').eq('id', id).single();
  const m = data as { id: string; kind: string; title: string; body: string; audience: { scope: string }; channels: string; requires_ack: boolean } | null;
  if (!m) return 0;
  const users = await audienceUsers(ctx, m.audience as { scope: string });
  const rows = [...users].map(([user_id, student_id]) => ({ message_id: id, user_id, student_id, title: m.title, body: m.body, requires_ack: m.requires_ack }));
  for (let i = 0; i < rows.length; i += 500) await erp(ctx.sb).from('announcement_recipients').insert(rows.slice(i, i + 500));
  for (let i = 0; i < rows.length; i += 500) await core(ctx.sb).from('notifications').insert(rows.slice(i, i + 500).map((r) => ({ user_id: r.user_id, product_key: 'erp', event_key: `announcement.${m.kind}`, title: m.title, body: String(m.body).slice(0, 160), link: '/erp/inbox', priority: m.kind === 'alert' ? 'high' : 'normal' })));
  // Other channels (WhatsApp, SMS, email, voice) are picked up from the announcement by the delivery job through the connected provider; the app is always used first (COM-05).
  await erp(ctx.sb).from('announcements').update({ status: 'sent', sent_at: new Date().toISOString(), recipient_count: rows.length, sent_by_name: ctx.name, sent_by_user_id: ctx.user.id }).eq('id', id);
  return rows.length;
}

export async function compose(fd: FormData) {
  const ctx = await getCtx();
  const scope = str(fd, 'scope') ?? 'section';
  const kind = str(fd, 'kind') ?? 'announcement';
  // Global safeguards (WF-05): quiet hours for parent messages, approval for mass messages.
  const hour = Number(new Date().toLocaleString('en-GB', { hour: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' }));
  const quiet = ((ctx.org.settings ?? {}) as { quiet_hours?: { from: number; to: number } }).quiet_hours ?? { from: 21, to: 7 };
  if (kind !== 'alert' && scope !== 'staff' && scope !== 'role' && (hour >= quiet.from || hour < quiet.to)) go('/erp/messages', `Quiet hours are ${quiet.from}:00 to ${quiet.to}:00. Only alerts can go to parents now; save this for the morning.`, 'err');
  const label = scope === 'section' ? 'Section' : scope === 'route' ? 'Bus route' : scope === 'role' ? `Staff role: ${str(fd, 'role')}` : scope === 'all' ? 'Whole school' : scope === 'parents' ? 'All parents' : 'All staff';
  const channels = ['app', ...fd.getAll('channels').map(String)].join(',');
  const mass = ['all', 'parents'].includes(scope) && !['principal', 'group_admin'].includes(ctx.role);
  const { data: m, error } = await erp(ctx.sb).from('announcements').insert({ kind, title: str(fd, 'title'), body: str(fd, 'body'), audience: { scope, section_id: str(fd, 'section_id'), route_id: str(fd, 'route_id'), role: str(fd, 'role') }, audience_label: label, channels, requires_ack: fd.get('requires_ack') === 'on', status: mass ? 'pending' : 'draft', branch_id: ctx.branchId ?? ctx.orgUser.home_branch_id }).select('id').single();
  if (error) go('/erp/messages', error.message, 'err');
  const id = (m as { id: string }).id;
  if (mass) {
    await erp(ctx.sb).rpc('submit_approval', { p_type: 'announcement', p_object: id, p_title: `Circular: ${str(fd, 'title')}`, p_summary: str(fd, 'body'), p_impact: `Goes to ${label.toLowerCase()} by ${channels}.`, p_payload: {} });
    go('/erp/messages', 'School-wide messages need the principal’s approval. Sent for approval.');
  }
  const n = await deliver(ctx, id);
  go('/erp/messages', `Sent to ${n} people in the app${channels !== 'app' ? `; ${channels.replace('app,', '')} queued for the provider` : ''}.`);
}

/** Send messages that were approved in the inbox. */
export async function sendApproved(fd: FormData) {
  const ctx = await getCtx();
  const n = await deliver(ctx, str(fd, 'id')!);
  go('/erp/messages', `Sent to ${n} people.`);
}

export async function reply(fd: FormData) {
  const ctx = await getCtx();
  const id = str(fd, 'conversation')!;
  const { data } = await erp(ctx.sb).from('conversations').select('parent_user, subject').eq('id', id).single();
  const c = data as { parent_user: string | null; subject: string } | null;
  await erp(ctx.sb).from('conversation_messages').insert({ conversation_id: id, sender: ctx.user.id, sender_name: ctx.name, body: str(fd, 'body') });
  await erp(ctx.sb).from('conversations').update({ last_message_at: new Date().toISOString(), status: fd.get('close') === 'on' ? 'closed' : 'open' }).eq('id', id);
  if (c?.parent_user) await core(ctx.sb).from('notifications').insert({ user_id: c.parent_user, product_key: 'erp', event_key: 'message.reply', title: `Reply: ${c.subject}`, body: String(str(fd, 'body')).slice(0, 140), link: '/erp/parent/messages' });
  go(`/erp/messages?tab=inbox&open=${id}`, 'Reply sent.');
}

export async function emergency(fd: FormData) {
  const ctx = await getCtx();
  const { data: b, error } = await erp(ctx.sb).from('emergency_broadcasts').insert({ type: str(fd, 'type'), message: str(fd, 'message'), is_drill: fd.get('is_drill') === 'on', sent_by_name: ctx.name, sent_by_user_id: ctx.user.id }).select('id').single();
  if (error) go('/erp/messages?tab=emergency', error.message, 'err');
  const users = await audienceUsers(ctx, { scope: 'all' });
  const rows = [...users.keys()].map((user_id) => ({ user_id, product_key: 'erp', event_key: 'emergency', priority: 'urgent', title: `${fd.get('is_drill') === 'on' ? 'DRILL: ' : ''}${String(str(fd, 'type')).toUpperCase()}`, body: str(fd, 'message'), link: `/erp/inbox?ack=${(b as { id: string }).id}` }));
  for (let i = 0; i < rows.length; i += 500) await core(ctx.sb).from('notifications').insert(rows.slice(i, i + 500));
  go('/erp/messages?tab=emergency', `Broadcast sent to ${rows.length} staff and parents. Acknowledgements are tracked below.`);
}
