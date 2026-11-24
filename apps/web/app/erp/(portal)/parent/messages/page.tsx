'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { childName, fmtDate, fmtTime, friendlyError, loadCirculars, loadConversations, markCircular, startConversation, type Child } from '@autoed/shared/erp-portal';
import { usePortal } from '@/lib/erp-portal/session';
import { useLoad } from '@/lib/erp-portal/use-load';
import { Badge, Btn, Card, Empty, Input, Notice, PageHead, Row, Select, Textarea } from '@/components/erp-portal/ui';
import { NeedChild, WithData } from '@/components/erp-portal/screen';

export default function Messages() {
  return <NeedChild>{(c) => <Inner child={c} />}</NeedChild>;
}

const ROLES = ['class_teacher', 'office', 'accounts', 'transport'] as const;

function Inner({ child }: { child: Child }) {
  const { sb, org, userId, member, L, lang } = usePortal();
  const router = useRouter();
  const q = useLoad('messages', async () => {
    const [circulars, conversations] = await Promise.all([loadCirculars(sb!, userId!), loadConversations(sb!)]);
    return { circulars, conversations };
  }, [], {});
  const [composing, setComposing] = useState(false);
  const [role, setRole] = useState<(typeof ROLES)[number]>('class_teacher');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    if (!org || !subject.trim() || !body.trim()) return;
    setBusy(true); setError(null);
    try {
      const id = await startConversation(sb!, org.id, { subject: subject.trim(), studentId: child.id, withRole: role, name: member?.display_name ?? '', body: body.trim() });
      router.push(`/erp/parent/messages/${id}`);
    } catch (e) { setError(friendlyError(e, L('c.error'))); setBusy(false); }
  }
  async function read(id: string, ack: boolean) {
    try { await markCircular(sb!, id, ack); await q.reload(); } catch { /* the list stays as it was; the next refresh shows the truth */ }
  }

  return (
    <>
      <PageHead title={L('messages.title')} sub={childName(child)} right={!composing ? <Btn onClick={() => setComposing(true)}>{L('messages.new')}</Btn> : undefined} />
      {composing && (
        <Card title={L('messages.new')} className="mb-4">
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void send(); }}>
            <Select label={L('messages.to')} value={role} onChange={(e) => setRole(e.target.value as (typeof ROLES)[number])}>{ROLES.map((r) => <option key={r} value={r}>{L(`messages.with.${r}`)}</option>)}</Select>
            <Input label={L('messages.subject')} value={subject} onChange={(e) => setSubject(e.target.value)} required />
            <Textarea label={L('messages.body')} value={body} onChange={(e) => setBody(e.target.value)} required />
            {error && <Notice tone="bad">{error}</Notice>}
            <div className="flex gap-2"><Btn type="submit" disabled={busy || !subject.trim() || !body.trim()}>{busy ? L('c.sending') : L('messages.send')}</Btn><Btn variant="ghost" onClick={() => setComposing(false)}>{L('c.cancel')}</Btn></div>
          </form>
        </Card>
      )}
      <WithData q={q}>
        {(d) => (
          <div className="space-y-4">
            <Card title={L('messages.conversations')} flush>
              {d.conversations.length === 0 ? <Empty title={L('messages.none')} /> : (
                <ul className="divide-y divide-slate-100">
                  {d.conversations.map((c) => {
                    const last = c.messages[c.messages.length - 1];
                    return (
                      <li key={c.id}>
                        <Row href={`/erp/parent/messages/${c.id}`}>
                          <span className="min-w-0"><span className="block truncate text-base font-semibold text-slate-900">{c.subject}</span><span className="block truncate text-sm text-slate-700">{L(`messages.with.${c.with_role}`)}{last ? ` · ${last.body}` : ''}</span></span>
                          <span className="shrink-0 text-sm text-slate-700">{fmtDate(c.lastAt, lang)}</span>
                        </Row>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>
            <Card title={L('messages.circulars')} flush>
              {d.circulars.length === 0 ? <Empty title={L('messages.none')} /> : (
                <ul className="divide-y divide-slate-100">
                  {d.circulars.map((c) => {
                    const unread = !c.read_at && c.status !== 'read';
                    return (
                      <li key={c.id} className="space-y-2 px-4 py-3">
                        <div className="flex flex-wrap items-center gap-2"><span className="text-base font-semibold text-slate-900">{c.title}</span>{unread && <Badge tone="info">{L('messages.unread')}</Badge>}<span className="text-sm text-slate-700">{fmtDate(c.created_at, lang)} {fmtTime(c.created_at, lang)}</span></div>
                        {c.body && <p className="whitespace-pre-wrap text-base text-slate-900">{c.body}</p>}
                        {c.requires_ack && !c.ack_at ? <Btn variant="secondary" onClick={() => void read(c.id, true)}>{L('messages.acknowledge')}</Btn>
                          : c.requires_ack ? <Badge tone="good">{L('messages.acked')}</Badge>
                          : unread ? <Btn variant="ghost" onClick={() => void read(c.id, false)}>{L('messages.markRead')}</Btn> : null}
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>
          </div>
        )}
      </WithData>
    </>
  );
}
