'use client';
import { useState } from 'react';
import { fmtDate, fmtTime, friendlyError, loadGatePasses, verifyGatePass } from '@autoed/shared/erp-portal';
import { usePortal } from '@/lib/erp-portal/session';
import { useLoad } from '@/lib/erp-portal/use-load';
import { Btn, Card, Empty, Input, Notice, PageHead } from '@/components/erp-portal/ui';
import { WithData } from '@/components/erp-portal/screen';

/**
 * Collector check at the gate. The gate staff see approved early-pickup passes (table policy: the gate module), ask the collector for
 * the code the parent received and check it with erp.verify_gate_pass, which allows five tries per pass and tells the office on a
 * wrong code. The code itself is never shown on this screen.
 */
export default function Gate() {
  const { sb, L, lang } = usePortal();
  const q = useLoad('gate', () => loadGatePasses(sb!), [], { pollMs: 20000 });
  const [codes, setCodes] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ pass: string; tone: 'good' | 'bad'; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function check(pass: string) {
    setBusy(pass); setMsg(null);
    try {
      const r = await verifyGatePass(sb!, pass, (codes[pass] ?? '').trim());
      setMsg(r === 'ok' ? { pass, tone: 'good', text: L('gate.ok') } : { pass, tone: 'bad', text: L('gate.mismatch') });
      setCodes((c) => ({ ...c, [pass]: '' }));
      await q.reload();
    } catch (e) { setMsg({ pass, tone: 'bad', text: friendlyError(e, L('c.error')) }); }
    finally { setBusy(null); }
  }

  return (
    <>
      <PageHead title={L('gate.title')} />
      <p className="mb-3 text-base text-slate-800">{L('gate.hint')}</p>
      <WithData q={q}>
        {(passes) => passes.length === 0 && !msg ? <Card><Empty title={L('gate.none')} /></Card> : (
          <ul className="space-y-3">
            {msg && !passes.some((p) => p.id === msg.pass) && <li><Notice tone={msg.tone}>{msg.text}</Notice></li>}
            {passes.map((p) => (
              <li key={p.id}>
                <Card title={p.student}>
                  <p className="text-base text-slate-800">{p.reason}{p.pickup_time ? ` · ${fmtDate(p.pickup_time, lang)} ${fmtTime(p.pickup_time, lang)}` : ''}</p>
                  <p className="text-base font-medium text-slate-900">{L('gate.collector', { name: p.collector_name ?? L('pickup.registered') })}</p>
                  <form className="mt-3 flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); void check(p.id); }}>
                    <div className="flex-1"><Input label={L('gate.code')} inputMode="numeric" autoComplete="off" value={codes[p.id] ?? ''} onChange={(e) => setCodes((c) => ({ ...c, [p.id]: e.target.value }))} /></div>
                    <Btn type="submit" disabled={busy === p.id || !(codes[p.id] ?? '').trim()}>{L('gate.verify')}</Btn>
                  </form>
                  {msg?.pass === p.id && <div className="mt-3"><Notice tone={msg.tone}>{msg.text}</Notice></div>}
                </Card>
              </li>
            ))}
          </ul>
        )}
      </WithData>
    </>
  );
}
