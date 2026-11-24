'use client';
import { useState } from 'react';
import { childName, fmtDate, fmtTime, friendlyError, loadPickup, loadPickupCode, requestGatePass, type Child, type GatePass } from '@autoed/shared/erp-portal';
import { usePortal } from '@/lib/erp-portal/session';
import { useLoad } from '@/lib/erp-portal/use-load';
import { Badge, Btn, Card, Empty, Input, Notice, PageHead, Select, Textarea, type Tone } from '@/components/erp-portal/ui';
import { NeedChild, WithData } from '@/components/erp-portal/screen';

export default function Pickup() {
  return <NeedChild>{(c) => <Inner child={c} />}</NeedChild>;
}

const TONE: Record<string, Tone> = { requested: 'warn', approved: 'good', rejected: 'bad', handed_over: 'info', expired: 'none' };

/** Early pickup: the family asks, the class teacher approves, and the code to give the collector appears here (never in a message). */
function Inner({ child }: { child: Child }) {
  const { sb, L, lang } = usePortal();
  const q = useLoad('pickup', () => loadPickup(sb!, child.id), [child.id], { childScoped: true });
  const [reason, setReason] = useState('');
  const [who, setWho] = useState('');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [time, setTime] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const [code, setCode] = useState<{ pass: string; otp: string | null; collector: string | null } | null>(null);

  async function send(people: { id: string; name: string }[]) {
    setBusy(true); setMsg(null);
    try {
      const person = people.find((p) => p.id === who);
      await requestGatePass(sb!, { studentId: child.id, reason: reason.trim(), collectorName: person ? person.name : name.trim() || null, collectorPhone: person ? null : phone.trim() || null, pickupPerson: person?.id ?? null, pickupTime: time ? new Date(time).toISOString() : null });
      setMsg({ tone: 'good', text: L('pickup.sent') }); setReason(''); setName(''); setPhone(''); setTime(''); setWho('');
      await q.reload();
    } catch (e) { setMsg({ tone: 'bad', text: friendlyError(e, L('c.error')) }); }
    finally { setBusy(false); }
  }
  async function show(p: GatePass) {
    try { setCode({ pass: p.id, otp: await loadPickupCode(sb!, p.id), collector: p.collector_name }); }
    catch (e) { setMsg({ tone: 'bad', text: friendlyError(e, L('c.error')) }); }
  }

  return (
    <>
      <PageHead title={L('pickup.title')} sub={childName(child)} />
      <p className="mb-3 text-base text-slate-800">{L('pickup.hint')}</p>
      {msg && <div className="mb-3"><Notice tone={msg.tone}>{msg.text}</Notice></div>}
      <WithData q={q}>
        {({ passes, people }) => (
          <div className="space-y-4">
            {code && (
              <Card title={L('pickup.codeFor')}>
                <div className="text-center">
                  <p className="text-5xl font-bold tracking-[0.3em] text-slate-900" data-testid="pickup-otp" aria-label={code.otp ? code.otp.split('').join(' ') : undefined}>{code.otp ?? '–'}</p>
                  <p className="mt-2 text-base text-slate-800">{L('pickup.codeHint', { name: code.collector ?? L('pickup.collectorFallback') })}</p>
                  <div className="mt-3"><Btn variant="secondary" onClick={() => setCode(null)}>{L('c.close')}</Btn></div>
                </div>
              </Card>
            )}
            <Card title={L('pickup.title')}>
              <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void send(people); }}>
                <Textarea label={L('pickup.reason')} value={reason} onChange={(e) => setReason(e.target.value)} rows={2} required />
                <Select label={L('pickup.collector')} value={who} onChange={(e) => setWho(e.target.value)}>
                  <option value="">{L('pickup.someoneElse')}</option>
                  {people.map((p) => <option key={p.id} value={p.id}>{p.name}{p.relation ? ` (${p.relation})` : ''}</option>)}
                </Select>
                {!who && <div className="grid gap-3 sm:grid-cols-2"><Input label={L('pickup.collectorName')} value={name} onChange={(e) => setName(e.target.value)} required /><Input label={L('pickup.collectorPhone')} type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} /></div>}
                <Input label={`${L('pickup.time')} (${L('c.optional')})`} type="datetime-local" value={time} onChange={(e) => setTime(e.target.value)} />
                <Btn type="submit" disabled={busy || !reason.trim() || (!who && !name.trim())}>{busy ? L('c.sending') : L('pickup.send')}</Btn>
              </form>
            </Card>
            <Card title={L('pickup.passes')} flush>
              {passes.length === 0 ? <Empty title={L('pickup.none')} /> : (
                <ul className="divide-y divide-slate-100">
                  {passes.map((p) => (
                    <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                      <div className="text-base"><div className="font-semibold text-slate-900">{p.reason}</div><div className="text-sm text-slate-700">{p.collector_name ?? L('pickup.registered')} · {fmtDate(p.pickup_time ?? p.created_at, lang)} {fmtTime(p.pickup_time ?? p.created_at, lang)}</div></div>
                      <div className="flex items-center gap-2"><Badge tone={TONE[p.status] ?? 'none'}>{L(`pickup.status.${p.status}`)}</Badge>{p.status === 'approved' && <Btn onClick={() => void show(p)}>{L('pickup.showCode')}</Btn>}</div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            {people.length > 0 && (
              <Card title={L('pickup.people')} flush><ul className="divide-y divide-slate-100">{people.map((p) => <li key={p.id} className="px-4 py-3 text-base">{p.name}{p.relation ? ` · ${p.relation}` : ''}</li>)}</ul></Card>
            )}
          </div>
        )}
      </WithData>
    </>
  );
}
