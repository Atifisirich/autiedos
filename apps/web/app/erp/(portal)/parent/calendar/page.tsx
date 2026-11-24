'use client';
import { useState } from 'react';
import { childName, fmtDate, friendlyError, inr, istToday, loadCalendar, registerEvent, type Child } from '@autoed/shared/erp-portal';
import { usePortal } from '@/lib/erp-portal/session';
import { useLoad } from '@/lib/erp-portal/use-load';
import { Badge, Btn, Card, Checkbox, Empty, Notice, PageHead } from '@/components/erp-portal/ui';
import { NeedChild, WithData } from '@/components/erp-portal/screen';

export default function Calendar() {
  return <NeedChild>{(c) => <Inner child={c} />}</NeedChild>;
}

function Inner({ child }: { child: Child }) {
  const { sb, org, L, lang } = usePortal();
  const today = istToday();
  const q = useLoad('calendar', () => loadCalendar(sb!, child.id, today), [child.id], { childScoped: true });
  const [consent, setConsent] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function register(id: string, needsConsent: boolean) {
    if (!org) return;
    if (needsConsent && !consent[id]) return setError(L('calendar.consent'));
    setBusy(id); setError(null);
    try { await registerEvent(sb!, org.id, id, child.id, Boolean(consent[id])); await q.reload(); }
    catch (e) { setError(friendlyError(e, L('c.error'))); }
    finally { setBusy(null); }
  }

  return (
    <>
      <PageHead title={L('calendar.title')} sub={childName(child)} />
      <WithData q={q}>
        {(d) => (
          <div className="space-y-4">
            {error && <Notice tone="bad">{error}</Notice>}
            <Card title={L('calendar.events')} flush>
              {d.events.length === 0 ? <Empty title={L('calendar.none')} /> : (
                <ul className="divide-y divide-slate-100">
                  {d.events.map((e) => {
                    const done = d.registered.has(e.id);
                    return (
                      <li key={e.id} className="space-y-2 px-4 py-3">
                        <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-base font-semibold text-slate-900">{e.name}</span><span className="text-sm text-slate-700">{fmtDate(e.event_date, lang, true)}{e.venue ? ` · ${e.venue}` : ''}</span></div>
                        {e.fee ? <p className="text-sm text-slate-700">{L('calendar.fee', { amount: inr(e.fee) })}</p> : null}
                        {done ? <Badge tone="good">{L('calendar.registered')}</Badge> : e.registration_open && (
                          <div className="space-y-1">
                            {e.consent_required && <Checkbox label={L('calendar.consent')} checked={Boolean(consent[e.id])} onChange={(v) => setConsent((s) => ({ ...s, [e.id]: v }))} />}
                            <Btn variant="secondary" disabled={busy === e.id} onClick={() => void register(e.id, e.consent_required)}>{L('calendar.register', { name: childName(child) })}</Btn>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>
            <Card title={L('calendar.upcoming')} flush>
              {d.cal.length === 0 ? <Empty title={L('calendar.none')} /> : (
                <ul className="divide-y divide-slate-100">
                  {d.cal.map((c) => (
                    <li key={c.id} className="flex items-start justify-between gap-3 px-4 py-3">
                      <div><div className="text-base font-medium text-slate-900">{c.title}</div>{c.description && <p className="text-sm text-slate-700">{c.description}</p>}</div>
                      <div className="shrink-0 text-right"><div className="text-base tabular-nums">{fmtDate(c.starts_on, lang)}{c.ends_on && c.ends_on !== c.starts_on ? ` – ${fmtDate(c.ends_on, lang)}` : ''}</div><Badge tone={c.layer === 'holiday' ? 'warn' : c.layer === 'exam' ? 'bad' : 'info'}>{L(`calendar.layer.${c.layer}`)}</Badge></div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        )}
      </WithData>
    </>
  );
}
