'use client';
import { useState } from 'react';
import { bookPtmSlot, childName, fmtDate, fmtTime, friendlyError, istToday, loadDirectory, loadPtm, requestAppointment, type Child } from '@autoed/shared/erp-portal';
import { usePortal } from '@/lib/erp-portal/session';
import { useLoad } from '@/lib/erp-portal/use-load';
import { Badge, Btn, Card, Empty, Input, Notice, PageHead, Select, Textarea, type Tone } from '@/components/erp-portal/ui';
import { NeedChild, WithData } from '@/components/erp-portal/screen';

export default function Ptm() {
  return <NeedChild>{(c) => <Inner child={c} />}</NeedChild>;
}

const STATUS_TONE: Record<string, Tone> = { requested: 'warn', confirmed: 'good', done: 'none', declined: 'bad' };

function Inner({ child }: { child: Child }) {
  const { sb, org, member, L, lang } = usePortal();
  const today = istToday();
  const q = useLoad('ptm', async () => {
    const [ptm, dir] = await Promise.all([loadPtm(sb!, child.id, today), loadDirectory(sb!, child.id)]);
    return { ptm, names: Object.fromEntries([...(dir.class_teacher ? [dir.class_teacher] : []), ...dir.ptm_staff, ...dir.subject_teachers].map((s) => [s.id, s.name])) as Record<string, string> };
  }, [child.id], { childScoped: true });
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [role, setRole] = useState<'principal' | 'counsellor'>('principal');
  const [reason, setReason] = useState('');
  const [when, setWhen] = useState('');

  async function book(slot: string) {
    setBusy(slot); setMsg(null);
    try { await bookPtmSlot(sb!, slot, child.id); setMsg({ tone: 'good', text: L('ptm.booked') }); }
    catch (e) { setMsg({ tone: 'bad', text: (e as { code?: string }).code === '55000' ? L('ptm.taken') : friendlyError(e, L('c.error')) }); }
    finally { setBusy(null); await q.reload(); }
  }
  async function ask() {
    if (!org) return;
    setBusy('appt'); setMsg(null);
    try { await requestAppointment(sb!, org.id, { studentId: child.id, withRole: role, reason: reason.trim(), preferredAt: when ? new Date(when).toISOString() : null, name: member?.display_name ?? '' }); setMsg({ tone: 'good', text: L('ptm.appointmentSent') }); setReason(''); setWhen(''); await q.reload(); }
    catch (e) { setMsg({ tone: 'bad', text: friendlyError(e, L('c.error')) }); }
    finally { setBusy(null); }
  }

  return (
    <>
      <PageHead title={L('ptm.title')} sub={childName(child)} />
      {msg && <div className="mb-3"><Notice tone={msg.tone}>{msg.text}</Notice></div>}
      <WithData q={q}>
        {({ ptm, names }) => (
          <div className="space-y-4">
            <Card title={L('ptm.mine')} flush>
              {ptm.mine.length === 0 ? <Empty title={L('ptm.noneMine')} /> : (
                <ul className="divide-y divide-slate-100" data-testid="ptm-mine">
                  {ptm.mine.map((s) => (
                    <li key={s.id} className="px-4 py-3 text-base"><span className="font-semibold">{fmtDate(s.date, lang, true)} {fmtTime(s.start_time, lang)}</span> · {L('ptm.with', { name: names[s.staff_id] ?? '' })} · <Badge tone="good">{L(`ptm.mode.${s.mode}`)}</Badge>{s.feedback && <p className="text-sm text-slate-800">{L('ptm.feedback')}: {s.feedback}</p>}</li>
                  ))}
                </ul>
              )}
            </Card>
            <Card title={L('ptm.open')} flush>
              {ptm.open.length === 0 ? <Empty title={L('ptm.none')} /> : (
                <ul className="divide-y divide-slate-100" data-testid="ptm-open">
                  {ptm.open.map((s) => (
                    <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                      <div className="text-base"><span className="font-semibold">{fmtDate(s.date, lang, true)} {fmtTime(s.start_time, lang)}</span><div className="text-sm text-slate-700">{L('ptm.with', { name: names[s.staff_id] ?? '' })} · {L(`ptm.mode.${s.mode}`)}</div></div>
                      <Btn disabled={busy === s.id} onClick={() => void book(s.id)}>{L('ptm.book')}</Btn>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card title={L('ptm.appointment')}>
              <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void ask(); }}>
                <Select label={L('ptm.appointmentWith')} value={role} onChange={(e) => setRole(e.target.value as 'principal')}><option value="principal">{L('ptm.with.principal')}</option><option value="counsellor">{L('ptm.with.counsellor')}</option></Select>
                <Input label={L('ptm.appointmentWhen')} type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
                <Textarea label={L('ptm.appointmentReason')} value={reason} onChange={(e) => setReason(e.target.value)} rows={2} required />
                <Btn type="submit" disabled={busy === 'appt' || !reason.trim() || !org}>{L('c.send')}</Btn>
              </form>
              {ptm.appts.length > 0 && (
                <div className="mt-4"><h3 className="mb-1 text-base font-semibold text-slate-900">{L('ptm.appointments')}</h3>
                  <ul className="divide-y divide-slate-100">{ptm.appts.map((a) => <li key={a.id} className="flex items-center justify-between gap-2 py-2 text-base"><span>{L(`ptm.with.${a.with_role}`)}{a.reason ? ` · ${a.reason}` : ''}</span><Badge tone={STATUS_TONE[a.status] ?? 'none'}>{L(`ptm.status.${a.status}`)}</Badge></li>)}</ul>
                </div>
              )}
            </Card>
          </div>
        )}
      </WithData>
    </>
  );
}
