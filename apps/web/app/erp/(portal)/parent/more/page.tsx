'use client';
import { useEffect, useState } from 'react';
import { PORTAL_LANGS, childName, fmtDate, friendlyError, loadConsents, loadNotifications, setConsent, NEEDS_NATIVE_REVIEW } from '@autoed/shared/erp-portal';
import { usePortal } from '@/lib/erp-portal/session';
import { useLoad } from '@/lib/erp-portal/use-load';
import { Btn, Card, Checkbox, Empty, Notice, PageHead, Row } from '@/components/erp-portal/ui';
import { InstallCard } from '@/components/erp-portal/pwa';
import { WithData } from '@/components/erp-portal/screen';

const NAMES: Record<string, string> = { en: 'English', hi: 'हिन्दी (Hindi)', te: 'తెలుగు (Telugu)' };
const CHANNELS = ['whatsapp', 'sms', 'email'] as const;
const MORE_LINKS = [['calendar', 'nav.calendar'], ['forms', 'nav.forms'], ['ptm', 'nav.ptm'], ['pickup', 'nav.pickup'], ['requests', 'nav.requests'], ['homework', 'nav.homework'], ['bus', 'nav.bus'], ['attendance', 'nav.attendance']] as const;

export default function More() {
  const { sb, userId, org, member, children, lang, setLang, signOut, L, brand } = usePortal();
  const notes = useLoad('notifications', () => loadNotifications(sb!, userId!), []);
  const consents = useLoad('consents', () => loadConsents(sb!), []);
  const [large, setLarge] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  useEffect(() => { try { setLarge(localStorage.getItem('portal_large') === '1'); } catch { /* storage blocked */ } }, []);
  const toggleLarge = (v: boolean) => { setLarge(v); document.documentElement.classList.toggle('large-text', v); try { localStorage.setItem('portal_large', v ? '1' : '0'); } catch { /* storage blocked */ } };

  async function choose(channel: string, on: boolean) {
    setMsg(null);
    try { await setConsent(sb!, channel, 'promotional', on ? 'opted_in' : 'opted_out'); setMsg({ tone: 'good', text: L('more.consentSaved') }); await consents.reload(); }
    catch (e) { setMsg({ tone: 'bad', text: friendlyError(e, L('c.error')) }); }
  }

  return (
    <>
      <PageHead title={L('more.title')} />
      <div className="space-y-4">
        <Card flush>
          <ul className="divide-y divide-slate-100">
            {MORE_LINKS.map(([k, label]) => <li key={k}><Row href={`/erp/parent/${k}`}><span className="text-base font-medium">{L(label)}</span><span aria-hidden className="text-[var(--pt-primary)]">›</span></Row></li>)}
          </ul>
        </Card>

        <Card title={L('more.profile')}>
          <p className="text-lg font-semibold text-slate-900">{member?.display_name}</p>
          <p className="text-base text-slate-700">{L('more.school')}: {org?.name ?? brand.name}</p>
          <h3 className="mt-3 text-base font-semibold text-slate-900">{L('more.children')}</h3>
          <ul className="list-inside list-disc text-base text-slate-800">{children.map((c) => <li key={c.id}>{childName(c)}</li>)}</ul>
        </Card>

        <Card title={L('more.language')}>
          <div role="radiogroup" aria-label={L('more.language')} className="space-y-1">
            {PORTAL_LANGS.map((l) => (
              <label key={l} className="flex min-h-12 cursor-pointer items-center gap-3 text-base text-slate-900">
                <input type="radio" name="lang" checked={lang === l} onChange={() => setLang(l)} className="h-6 w-6 accent-[var(--pt-primary)]" />{NAMES[l]}
              </label>
            ))}
          </div>
          <p className="mt-1 text-sm text-slate-700">{L('more.languageHint')}</p>
          {NEEDS_NATIVE_REVIEW.includes(lang) && <p className="mt-1 text-sm text-slate-700">{L('more.languageReview')}</p>}
          <Checkbox label={L('more.largeText')} checked={large} onChange={toggleLarge} />
        </Card>

        <Card title={L('more.consents')}>
          <p className="mb-2 text-base text-slate-800">{L('more.consent.hint')}</p>
          {msg && <div className="mb-2"><Notice tone={msg.tone}>{msg.text}</Notice></div>}
          <WithData q={consents}>
            {(c) => Object.keys(c).length === 0 ? <p className="text-base text-slate-700">{L('more.consent.noContact')}</p> : (
              <div>{CHANNELS.filter((ch) => c[ch]).map((ch) => <Checkbox key={ch} label={L(`more.consent.${ch}`)} checked={c[ch]?.promotional === 'opted_in'} onChange={(on) => void choose(ch, on)} />)}</div>
            )}
          </WithData>
        </Card>

        <Card title={L('more.notifications')}>
          <p className="text-base text-slate-800">{L('more.notificationsStub')}</p>
          <WithData q={notes}>
            {(n) => n.length === 0 ? <Empty title={L('c.empty')} /> : (
              <ul className="mt-2 divide-y divide-slate-100">
                {n.map((x) => <li key={x.id} className="py-2 text-base"><span className="font-medium text-slate-900">{x.title}</span><span className="block text-sm text-slate-700">{fmtDate(x.created_at, lang)}{x.body ? ` · ${x.body}` : ''}</span></li>)}
              </ul>
            )}
          </WithData>
        </Card>

        <InstallCard />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Btn variant="secondary" onClick={() => void signOut()}>{L('c.signOut')}</Btn>
        </div>
      </div>
    </>
  );
}
