'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { act, formObj, useCrm } from '@/lib/crm/api';
import { fmtDateTime, rel } from '@/lib/crm/fmt';
import { Badge, Empty, ErrorBox, Loading, PageHeader } from '@/components/crm/ui';
import { useShell } from '@/components/crm/shell';

type Row = Record<string, any>;
type Res = { list: Row[]; current: Row | null; messages: Row[]; enquiries: Row[]; templates: { id: string; name: string; body: string }[]; sla: number; f: string; windowOpen: boolean; can: Record<string, any>; demo: boolean };
const TABS: [string, string][] = [['open', 'Open'], ['waiting', 'Waiting on parent'], ['closed', 'Closed'], ['unread', 'Unread'], ['unanswered', 'Read but not replied'], ['all', 'All']];

export default function InboxPage() {
  return (
    <Suspense fallback={<Loading />}>
      <Inbox />
    </Suspense>
  );
}

/** Shared WhatsApp team inbox (WA-02): owner, status, unread, SLA timer, 24-hour window, notes, quick replies. */
function Inbox() {
  const { shell } = useShell();
  const sp = useSearchParams();
  const f = sp.get('f') ?? 'open';
  const h = sp.get('h') ?? '';
  const { data: r, error, reload } = useCrm<Res>('/inbox', { f, h });
  const [busy, setBusy] = useState(false);
  if (error) return <ErrorBox message={error.message} />;
  if (!r) return <Loading />;
  const cur = r.current;
  const now = Date.now();
  return (
    <>
      <PageHeader title="Team inbox" sub={shell.scope === 'own' ? 'WhatsApp conversations for your families' : 'WhatsApp conversations across the team'} />
      <div className="mb-3 flex gap-1 overflow-x-auto border-b border-slate-200" role="tablist">
        {TABS.map(([k, l]) => (
          <Link key={k} href={`/crm/inbox?f=${k}`} role="tab" aria-selected={f === k} className={`tab ${f === k ? 'tab-on' : ''}`}>
            {l}
          </Link>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[20rem_minmax(0,1fr)_16rem]">
        <section className="card max-h-[72vh] overflow-y-auto" aria-label="Conversations">
          {!r.list.length && <Empty title="No conversations here">New WhatsApp chats on the school number appear here and are matched to a household.</Empty>}
          {r.list.map((c) => {
            const waiting = c.last_dir === 'in' ? Math.round((now - +new Date(c.last_in)) / 60000) : 0;
            return (
              <Link key={c.id} href={`/crm/inbox?f=${f}&h=${c.id}`} aria-current={cur?.id === c.id ? 'true' : undefined} className={`block border-b border-slate-100 px-3 py-2.5 ${cur?.id === c.id ? 'bg-teal-50' : 'hover:bg-slate-50'}`}>
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-semibold text-slate-900">{c.guardian}</span>
                  {c.unread > 0 && <span className="rounded-full bg-teal-700 px-1.5 text-[11px] font-semibold text-white">{c.unread} new</span>}
                </div>
                <div className="muted truncate text-xs">
                  {c.student} · owner {c.owner}
                </div>
                <div className="truncate text-xs text-slate-700">
                  {c.last_dir === 'out' ? 'You: ' : ''}
                  {c.last_body}
                </div>
                <div className="mt-0.5 flex items-center justify-between text-[11px]">
                  <span className="muted">{rel(c.last_at)}</span>
                  {waiting > 0 && <span className={waiting > r.sla ? 'font-semibold text-rose-700' : 'text-amber-800'}>⏱ waiting {waiting < 60 ? `${waiting} min` : rel(c.last_in).replace(' ago', '')}</span>}
                </div>
              </Link>
            );
          })}
        </section>
        <section className="card flex max-h-[72vh] flex-col" aria-label="Thread">
          {!cur ? (
            <Empty title="Pick a conversation" />
          ) : (
            <>
              <div className="card-h">
                <span>
                  {cur.guardian} <span className="muted font-normal">+91 {cur.mobile}</span>
                </span>
                <span className="flex items-center gap-1.5">
                  <Badge tone={r.windowOpen ? 'green' : 'amber'} title="WhatsApp only allows free-text replies within 24 hours of the parent's last message">
                    {r.windowOpen ? '24-hour window open' : 'Window closed: templates only'}
                  </Badge>
                  <button
                    className="btn btn-sm"
                    onClick={async () => {
                      if (await act(`/inbox/${cur.id}/status`, { status: cur.inbox_status !== 'closed' ? 'closed' : 'open' }, { quiet: true })) reload();
                    }}
                  >
                    {cur.inbox_status !== 'closed' ? 'Close' : 'Reopen'}
                  </button>
                </span>
              </div>
              <div className="flex-1 space-y-2 overflow-y-auto bg-slate-50 p-4" role="log" aria-label="Messages">
                {r.messages.map((m) => (
                  <div key={m.id} className={`flex ${m.direction === 'in' ? 'justify-start' : 'justify-end'}`}>
                    <div className={`max-w-[85%] rounded-lg px-3 py-2 sm:max-w-[75%] ${m.is_note ? 'border border-amber-300 bg-amber-50' : m.direction === 'in' ? 'border border-slate-200 bg-white' : m.status === 'failed' ? 'border border-rose-300 bg-rose-50' : 'bg-teal-100'}`}>
                      {m.is_note && <div className="text-[11px] font-semibold text-amber-900">Internal note (not sent to the parent)</div>}
                      <p className="whitespace-pre-wrap text-slate-900">{m.body}</p>
                      {m.status === 'failed' && <p className="mt-1 text-xs font-medium text-rose-700">Not delivered: {m.fail_reason}</p>}
                      <div className="muted mt-0.5 text-[11px]">
                        {m.direction === 'in' ? cur.guardian : (m.sender ?? 'Automatic')} · {fmtDateTime(m.created_at)}
                        {m.direction === 'out' && !m.is_note && m.status !== 'failed' ? ` · ${m.status === 'read' ? '✓✓ read' : m.status === 'delivered' ? '✓✓ delivered' : '✓ sent'}` : ''}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              {r.can.message && r.enquiries[0] && (
                <form
                  className="space-y-2 border-t border-slate-200 p-3"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    const form = e.currentTarget;
                    const v = formObj(form);
                    setBusy(true);
                    const res = await act(`/leads/${r.enquiries[0]!.id}/message`, { channel: 'whatsapp', templateId: v.templateId, body: v.body, note: v.note === 'on' });
                    setBusy(false);
                    if (res) {
                      form.reset();
                      reload();
                    }
                  }}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <select name="templateId" required={!r.windowOpen} className="input w-56" aria-label="Template or quick reply">
                      <option value="">{r.windowOpen ? 'Free text (or pick a quick reply)' : 'Choose a template'}</option>
                      {r.templates.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </select>
                    <label className="flex items-center gap-1 text-xs">
                      <input type="checkbox" name="note" /> Internal note
                    </label>
                  </div>
                  <div className="flex gap-2">
                    <textarea name="body" rows={2} aria-label="Message" className="input" placeholder={r.windowOpen ? 'Type a reply. If a template is chosen above, it is sent instead.' : 'Free text is only possible as an internal note right now.'} />
                    <button className="btn btn-primary self-end" disabled={busy}>
                      Send
                    </button>
                  </div>
                </form>
              )}
            </>
          )}
        </section>
        <aside className="space-y-3">
          {cur && (
            <>
              <section className="card p-3" aria-label="Family">
                <p className="text-xs font-semibold text-slate-700">Family</p>
                {r.enquiries.map((e) => (
                  <Link key={e.id} href={`/crm/households/${cur.id}?e=${e.id}`} className="mt-1.5 block rounded-md border border-slate-200 p-2 hover:border-teal-600">
                    <span className="link">{e.student}</span> <span className="muted text-xs">· {e.grade}</span>
                    <div className="mt-1 flex items-center gap-1.5">
                      <Badge tone={e.color}>{e.stage}</Badge>
                      <span className="muted text-xs">Score {e.score}</span>
                    </div>
                  </Link>
                ))}
                <p className="muted mt-2 text-xs">Owner: {cur.owner}</p>
              </section>
              {r.demo && (
                <form
                  className="card space-y-2 border-dashed p-3"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    const form = e.currentTarget;
                    if (await act(`/inbox/${cur.id}/simulate`, formObj(form))) {
                      form.reset();
                      reload();
                    }
                  }}
                >
                  <p className="text-xs font-semibold text-slate-700">Demo: simulate a parent reply</p>
                  <p className="muted text-xs">No live WhatsApp number is connected, so this stands in for the provider webhook. Try “STOP” to see opt-out handling.</p>
                  <input name="body" className="input" placeholder="Parent's message" aria-label="Parent's message" />
                  <button className="btn btn-sm w-full">Receive reply</button>
                </form>
              )}
            </>
          )}
        </aside>
      </div>
    </>
  );
}
