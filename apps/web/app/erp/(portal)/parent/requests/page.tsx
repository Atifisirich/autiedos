'use client';
import { useState } from 'react';
import Link from 'next/link';
import { addDays, childName, daysBetween, fmtDate, friendlyError, istToday, loadRequests, raiseTicket, requestLeave, type Child } from '@autoed/shared/erp-portal';
import { usePortal } from '@/lib/erp-portal/session';
import { useLoad } from '@/lib/erp-portal/use-load';
import { Badge, Btn, Card, Empty, Input, Notice, PageHead, Select, Textarea, type Tone } from '@/components/erp-portal/ui';
import { NeedChild, WithData } from '@/components/erp-portal/screen';

export default function Requests() {
  return <NeedChild>{(c) => <Inner child={c} />}</NeedChild>;
}

const CERTS = ['bonafide', 'fee', 'character', 'transfer', 'other'] as const;
const TONE: Record<string, Tone> = { approved: 'good', rejected: 'bad', pending: 'warn', cancelled: 'none', resolved: 'good', closed: 'none' };

function Inner({ child }: { child: Child }) {
  const { sb, org, member, L, lang } = usePortal();
  const today = istToday();
  const q = useLoad('requests', () => loadRequests(sb!, child.id), [child.id], { childScoped: true });
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [reason, setReason] = useState('');
  const [cert, setCert] = useState<(typeof CERTS)[number]>('bonafide');
  const [note, setNote] = useState('');
  const [concernTitle, setConcernTitle] = useState('');
  const [concern, setConcern] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);

  async function run(kind: string, fn: () => Promise<void>, ok: string, reset: () => void) {
    setBusy(kind); setMsg(null);
    try { await fn(); setMsg({ tone: 'good', text: ok }); reset(); await q.reload(); }
    catch (e) { setMsg({ tone: 'bad', text: friendlyError(e, L('c.error')) }); }
    finally { setBusy(null); }
  }
  const name = member?.display_name ?? '';

  return (
    <>
      <PageHead title={L('requests.title')} sub={childName(child)} />
      <div className="space-y-4">
        {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}

        <Card title={L('requests.leave')}>
          <form className="space-y-3" onSubmit={(e) => {
            e.preventDefault();
            if (to < from) return setMsg({ tone: 'bad', text: L('requests.badDates') });
            void run('leave', () => requestLeave(sb!, org!.id, { studentId: child.id, from, to, reason: reason.trim(), days: daysBetween(from, to) + 1 }), L('requests.leaveSent'), () => setReason(''));
          }}>
            <div className="grid grid-cols-2 gap-3">
              <Input label={L('requests.from')} type="date" value={from} min={addDays(today, -7)} onChange={(e) => { setFrom(e.target.value); if (to < e.target.value) setTo(e.target.value); }} required />
              <Input label={L('requests.to')} type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} required />
            </div>
            <Textarea label={L('requests.reason')} value={reason} onChange={(e) => setReason(e.target.value)} rows={2} required />
            <Btn type="submit" disabled={busy === 'leave' || !org || !reason.trim()}>{busy === 'leave' ? L('c.sending') : L('requests.sendLeave')}</Btn>
          </form>
        </Card>

        <Card title={L('requests.certificate')}>
          <form className="space-y-3" onSubmit={(e) => {
            e.preventDefault();
            void run('cert', () => raiseTicket(sb!, org!.id, { studentId: child.id, branchId: child.branch_id, title: `${L(`requests.cert.${cert}`)}: ${childName(child)}`, description: note.trim(), kind: 'certificate', name, certType: cert }), L('requests.sent'), () => setNote(''));
          }}>
            <Select label={L('requests.certType')} value={cert} onChange={(e) => setCert(e.target.value as (typeof CERTS)[number])}>{CERTS.map((c) => <option key={c} value={c}>{L(`requests.cert.${c}`)}</option>)}</Select>
            <Textarea label={`${L('requests.note')} (${L('c.optional')})`} value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
            <Btn type="submit" disabled={busy === 'cert' || !org}>{busy === 'cert' ? L('c.sending') : L('requests.sendCert')}</Btn>
          </form>
        </Card>

        <Card title={L('requests.concern')}>
          <form className="space-y-3" onSubmit={(e) => {
            e.preventDefault();
            void run('concern', () => raiseTicket(sb!, org!.id, { studentId: child.id, branchId: child.branch_id, title: concernTitle.trim(), description: concern.trim(), kind: 'concern', name }), L('requests.sent'), () => { setConcern(''); setConcernTitle(''); });
          }}>
            <Input label={L('requests.concernTitle')} value={concernTitle} onChange={(e) => setConcernTitle(e.target.value)} required />
            <Textarea label={L('messages.body')} value={concern} onChange={(e) => setConcern(e.target.value)} rows={3} required />
            <Btn type="submit" disabled={busy === 'concern' || !org || !concernTitle.trim() || !concern.trim()}>{busy === 'concern' ? L('c.sending') : L('requests.sendConcern')}</Btn>
          </form>
        </Card>

        <WithData q={q}>
          {(d) => (
            <>
              <Card title={L('requests.history')} flush>
                {d.leaves.length + d.tickets.length === 0 ? <Empty title={L('requests.noHistory')} /> : (
                  <ul className="divide-y divide-slate-100">
                    {d.leaves.map((l) => (
                      <li key={l.id} className="flex items-start justify-between gap-3 px-4 py-3"><div><div className="text-base font-semibold text-slate-900">{L('requests.kind.leave')}: {fmtDate(l.start_date, lang)}{l.end_date !== l.start_date ? ` – ${fmtDate(l.end_date, lang)}` : ''}</div><div className="text-sm text-slate-700">{l.reason}</div></div><Badge tone={TONE[l.status] ?? 'none'}>{L(`requests.status.${l.status}`)}</Badge></li>
                    ))}
                    {d.tickets.map((t) => (
                      <li key={t.id} className="flex items-start justify-between gap-3 px-4 py-3"><div><div className="text-base font-semibold text-slate-900">{t.title}</div><div className="text-sm text-slate-700">{fmtDate(t.created_at, lang)}</div></div><Badge tone={TONE[t.status] ?? 'warn'}>{L(`requests.status.${['open', 'in_progress', 'resolved', 'closed'].includes(t.status) ? t.status : 'in_progress'}`)}</Badge></li>
                    ))}
                  </ul>
                )}
              </Card>
              {d.docs.length > 0 && (
                <Card title={L('requests.documents')} flush>
                  <ul className="divide-y divide-slate-100">
                    {d.docs.map((x) => <li key={x.id} className="flex items-center justify-between gap-3 px-4 py-3 text-base"><span>{x.title ?? x.type} {x.number}</span>{x.verify_code && <Link className="text-[var(--pt-primary)] underline" href={`/erp/verify/${encodeURIComponent(x.verify_code)}`}>{L('requests.verifyDoc')}</Link>}</li>)}
                  </ul>
                </Card>
              )}
            </>
          )}
        </WithData>
      </div>
    </>
  );
}
