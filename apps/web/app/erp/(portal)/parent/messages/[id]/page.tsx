'use client';
import { use, useState } from 'react';
import Link from 'next/link';
import { fmtDate, fmtTime, friendlyError, loadConversations, replyConversation } from '@autoed/shared/erp-portal';
import { usePortal } from '@/lib/erp-portal/session';
import { useLoad } from '@/lib/erp-portal/use-load';
import { Btn, Card, Empty, Notice, PageHead, Textarea, cx } from '@/components/erp-portal/ui';
import { WithData } from '@/components/erp-portal/screen';

/** One two-way conversation with the school: the family's messages on the right, the school's on the left. */
export default function Thread({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { sb, org, userId, member, L, lang } = usePortal();
  const q = useLoad('messages-all', () => loadConversations(sb!), [], { pollMs: 15000 });
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    if (!org || !text.trim()) return;
    setBusy(true); setError(null);
    try { await replyConversation(sb!, org.id, id, member?.display_name ?? '', text.trim()); setText(''); await q.reload(); }
    catch (e) { setError(friendlyError(e, L('c.error'))); }
    finally { setBusy(false); }
  }

  return (
    <>
      <p className="mb-2"><Link href="/erp/parent/messages" className="text-base text-[var(--pt-primary)] underline">‹ {L('nav.messages')}</Link></p>
      <WithData q={q}>
        {(all) => {
          const c = all.find((x) => x.id === id);
          if (!c) return <Card><Empty title={L('messages.none')} /></Card>;
          return (
            <div className="space-y-4">
              <PageHead title={c.subject} sub={L(`messages.with.${c.with_role}`)} />
              <ul className="space-y-3" aria-label={c.subject}>
                {c.messages.map((m) => {
                  const mine = m.sender === userId;
                  return (
                    <li key={m.id} className={cx('flex', mine ? 'justify-end' : 'justify-start')}>
                      <div className={cx('max-w-[85%] rounded-2xl px-4 py-2 text-base', mine ? 'bg-[var(--pt-primary)] text-[var(--pt-on-primary)]' : 'border border-slate-200 bg-white text-slate-900')}>
                        <div className="text-sm opacity-90">{mine ? L('messages.you') : m.sender_name || L('messages.school')} · {fmtDate(m.at, lang)} {fmtTime(m.at, lang)}</div>
                        <p className="whitespace-pre-wrap">{m.body}</p>
                      </div>
                    </li>
                  );
                })}
              </ul>
              {c.status === 'closed' ? <Notice>{L('messages.closed')}</Notice> : (
                <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); void send(); }}>
                  <Textarea label={L('messages.reply')} value={text} onChange={(e) => setText(e.target.value)} rows={3} />
                  {error && <Notice tone="bad">{error}</Notice>}
                  <Btn type="submit" disabled={busy || !text.trim()}>{busy ? L('c.sending') : L('messages.send')}</Btn>
                </form>
              )}
            </div>
          );
        }}
      </WithData>
    </>
  );
}
