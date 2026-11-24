import { getCtx } from '@/lib/erp/ctx';
import { core, erp } from '@/lib/erp/db';
import { Page, Card, Empty, Badge, Tabs } from '@/components/erp/ui';
import { ftime, inr, go, str } from '@/lib/erp/fmt';

export const metadata = { title: 'Approvals' };
async function decide(fd: FormData) {
  'use server';
  const ctx = await getCtx();
  const ids = fd.getAll('id').map(String);
  const decision = str(fd, 'decision') ?? 'approve';
  let done = 0; let last = '';
  for (const id of ids) {
    const { error } = await erp(ctx.sb).rpc('decide_approval', { p_request: id, p_ok: decision === 'approve', p_comment: str(fd, 'comment') });
    if (error) last = error.message; else done++;
  }
  go('/erp/approvals', last || `${done} ${decision === 'approve' ? 'approved' : 'rejected'}.`, last ? 'err' : 'ok');
}
async function cancel(fd: FormData) {
  'use server';
  const ctx = await getCtx();
  const { error } = await erp(ctx.sb).rpc('cancel_approval', { p_request: str(fd, 'id') });
  go('/erp/approvals?tab=mine', error ? error.message : 'Request withdrawn.', error ? 'err' : 'ok');
}

type A = { id: string; linked_type: string | null; title: string; summary: string | null; impact: string | null; amount: number | null; data: { steps?: string[] }; current_seq: number; status: string; requested_by_name: string | null; created_at: string; step_due_at: string | null; applicant_user_id: string | null };
const SAFE = ['gate_pass', 'gallery', 'announcement'];

/** One approvals inbox (WF-02): context, impact, approve / reject, and bulk approve for safe types. */
export default async function Approvals({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { tab = 'inbox' } = await searchParams;
  const ctx = await getCtx();
  const { data: inbox } = await erp(ctx.sb).rpc('my_approvals');
  const base = core(ctx.sb).from('approval_requests').select('*').eq('product_key', 'erp').is('deleted_at', null);
  const { data: other } = tab === 'mine' ? await base.eq('applicant_user_id', ctx.user.id).order('created_at', { ascending: false }).limit(60)
    : tab === 'history' ? await base.neq('status', 'pending').order('decided_at', { ascending: false }).limit(80) : { data: [] };
  const list = (tab === 'inbox' ? inbox ?? [] : other ?? []) as A[];
  const safe = list.filter((a) => a.linked_type && SAFE.includes(a.linked_type));
  return (
    <Page title="Approvals" sub="Every request that needs a decision, in one place.">
      <Tabs current={tab === 'inbox' ? '/erp/approvals' : `/erp/approvals?tab=${tab}`} tabs={[{ href: '/erp/approvals', label: 'Waiting for me', count: ((inbox ?? []) as unknown[]).length }, { href: '/erp/approvals?tab=mine', label: 'My requests' }, { href: '/erp/approvals?tab=history', label: 'History' }]} />
      {tab === 'inbox' && safe.length > 1 && <form action={decide} className="mb-3">{safe.map((a) => <input key={a.id} type="hidden" name="id" value={a.id} />)}<input type="hidden" name="decision" value="approve" /><button className="btn-ghost">Approve all {safe.length} routine requests (gate passes, gallery, announcements)</button></form>}
      {list.length === 0 ? <Card><Empty title={tab === 'inbox' ? 'Nothing is waiting for you' : 'Nothing here yet'} hint="Concessions, refunds, reversals, gate passes, circulars, purchase requests and mark unlocks all arrive here." /></Card> : (
        <div className="space-y-3">{list.map((a) => {
          const steps = a.data?.steps ?? ['principal'];
          return (
            <Card key={a.id}><div className="p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div><div className="font-medium">{a.title}</div><div className="text-xs text-muted">{(a.linked_type ?? 'request').replace(/_/g, ' ')} · requested by {a.requested_by_name ?? 'staff'} · {ftime(a.created_at)}{a.amount ? ` · ${inr(a.amount)}` : ''}</div></div>
                <div className="flex items-center gap-2"><Badge>{a.status}</Badge>{a.status === 'pending' && <span className="text-xs text-muted">Step {a.current_seq} of {steps.length}: {String(steps[a.current_seq - 1]).replace(/_/g, ' ')}</span>}{a.status === 'pending' && a.step_due_at && new Date(a.step_due_at) < new Date() && <Badge tone="red">overdue</Badge>}</div>
              </div>
              {a.summary && <p className="mt-2 text-sm">{a.summary}</p>}
              {a.impact && <p className="mt-1 rounded-lg bg-paper px-3 py-2 text-sm"><span className="font-medium">Impact: </span>{a.impact}</p>}
              {tab === 'inbox' && <form action={decide} className="mt-3 flex flex-wrap gap-2"><input type="hidden" name="id" value={a.id} /><input name="comment" className="input max-w-sm" placeholder="Comment (optional)" aria-label="Comment" />
                <button name="decision" value="approve" className="btn">Approve</button><button name="decision" value="reject" className="btn-danger">Reject</button></form>}
              {tab === 'mine' && a.status === 'pending' && <form action={cancel} className="mt-3"><input type="hidden" name="id" value={a.id} /><button className="btn-ghost btn-sm">Withdraw request</button></form>}
            </div></Card>
          );
        })}</div>)}
    </Page>
  );
}
