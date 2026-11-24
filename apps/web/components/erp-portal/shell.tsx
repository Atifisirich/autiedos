'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { childName, initials, PORTAL_LANGS, fmtDate, fmtTime, type PortalRole, type StringKey } from '@autoed/shared/erp-portal';
import { usePortal } from '@/lib/erp-portal/session';
import { Btn, Card, Notice, Spinner, cx } from './ui';

const ICONS: Record<string, string> = {
  home: 'M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  fees: 'M3 6h18v12H3zM3 10h18M7 15h3',
  academics: 'M12 3l10 5-10 5L2 8zM6 11v5c0 1.5 3 3 6 3s6-1.5 6-3v-5',
  messages: 'M4 5h16v11H9l-5 4z',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  bus: 'M5 4h14v13H5zM5 11h14M8 20v-3M16 20v-3M8 14h.01M16 14h.01',
  tests: 'M6 3h12v18H6zM9 8h6M9 12h6M9 16h3',
  homework: 'M5 4h11l3 3v13H5zM8 11h8M8 15h8',
  results: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  trips: 'M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11zM12 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
  gate: 'M4 21V6l8-3 8 3v15M9 21v-6h6v6',
};
function Icon({ name }: { name: string }) {
  return <svg aria-hidden viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={ICONS[name] ?? ICONS.more} /></svg>;
}

export interface NavItem { href: string; label: StringKey; icon: string; exact?: boolean }

const HOME: Record<PortalRole, string> = { parent: '/erp/parent', student: '/erp/student', staff: '/erp/driver', unknown: '/erp/signin' };

/** Redirects the signed-out to sign-in and the wrong kind of person to their own portal; shows nothing private meanwhile. */
export function Guard({ allow, children }: { allow: PortalRole[]; children: ReactNode }) {
  const { status, role, L, signOut } = usePortal();
  const router = useRouter();
  const path = usePathname();
  useEffect(() => {
    if (status === 'signedout') router.replace(`/erp/signin?next=${encodeURIComponent(path)}`);
    else if (status === 'ready' && !allow.includes(role)) router.replace(HOME[role]);
  }, [status, role, allow, router, path]);
  if (status === 'nomember') {
    return (
      <div className="mx-auto max-w-md p-4">
        <Card><Notice tone="bad">{L('signin.notLinked')}</Notice><div className="mt-3"><Btn variant="secondary" onClick={() => void signOut()}>{L('c.signOut')}</Btn></div></Card>
      </div>
    );
  }
  if (status !== 'ready' || !allow.includes(role)) return <Spinner label={L('c.loading')} />;
  return <>{children}</>;
}

export function Logo({ size = 40 }: { size?: number }) {
  const { brand } = usePortal();
  return (
    <span aria-hidden style={{ width: size, height: size }} className="grid shrink-0 place-items-center rounded-xl bg-[var(--pt-on-primary)] text-lg font-bold text-[var(--pt-primary)]">
      {initials(brand.name).slice(0, 2)}
    </span>
  );
}

export function ChildSwitcher() {
  const { children, child, setChildId, L } = usePortal();
  if (children.length < 2 || !child) return null;
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="sr-only">{L('c.child')}</span>
      <select value={child.id} onChange={(e) => setChildId(e.target.value)} aria-label={L('c.child')} className="min-h-12 rounded-xl border-2 border-white/60 bg-white px-3 text-base font-medium text-slate-900">
        {children.map((c) => <option key={c.id} value={c.id}>{childName(c)}</option>)}
      </select>
    </label>
  );
}

export function LanguageSelect() {
  const { lang, setLang, L } = usePortal();
  const names: Record<string, string> = { en: 'English', hi: 'हिन्दी', te: 'తెలుగు' };
  return (
    <label className="text-sm">
      <span className="sr-only">{L('c.language')}</span>
      <select value={lang} onChange={(e) => setLang(e.target.value as 'en')} aria-label={L('c.language')} className="min-h-12 rounded-xl border-2 border-white/60 bg-white px-2 text-base text-slate-900">
        {PORTAL_LANGS.map((l) => <option key={l} value={l}>{names[l]}</option>)}
      </select>
    </label>
  );
}

function OfflineBar() {
  const { online, offlineSince, L, lang } = usePortal();
  if (online && !offlineSince) return null;
  const when = offlineSince ? `${fmtDate(new Date(offlineSince).toISOString(), lang)} ${fmtTime(new Date(offlineSince).toISOString(), lang)}` : '';
  return <div role="status" className="bg-amber-100 px-4 py-2 text-center text-sm font-medium text-amber-950">{L('c.offline', { when })}</div>;
}

export function PortalShell({ nav, children, showChild = true, title }: { nav: NavItem[]; children: ReactNode; showChild?: boolean; title?: string }) {
  const { brand, L, member } = usePortal();
  const path = usePathname();
  return (
    <div className="min-h-screen bg-slate-50 pb-24 md:pb-8">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-lg focus:bg-white focus:p-3 focus:text-slate-900">{L('c.skip')}</a>
      <header className="bg-[var(--pt-primary)] text-[var(--pt-on-primary)]">
        <div className="mx-auto flex max-w-4xl flex-wrap items-center gap-3 px-4 py-3">
          <Logo />
          <div className="min-w-0 flex-1">
            <div className="truncate text-lg font-bold leading-tight">{title ?? brand.name}</div>
            <div className="truncate text-sm opacity-90">{member?.display_name ?? brand.tagline ?? ''}</div>
          </div>
          {showChild && <ChildSwitcher />}
          <LanguageSelect />
        </div>
      </header>
      <OfflineBar />
      <nav aria-label={L('nav.main')} className="fixed inset-x-0 bottom-0 z-40 border-t border-slate-200 bg-white md:static md:border-b md:border-t-0">
        <ul className="mx-auto flex max-w-4xl justify-around md:justify-start md:gap-2 md:px-4">
          {nav.map((n) => {
            const active = n.exact ? path === n.href : path === n.href || path.startsWith(`${n.href}/`);
            return (
              <li key={n.href} className="flex-1 md:flex-none">
                <Link href={n.href} aria-current={active ? 'page' : undefined} className={cx('flex min-h-14 flex-col items-center justify-center gap-0.5 px-2 text-sm font-medium md:flex-row md:gap-2 md:px-4', active ? 'text-[var(--pt-primary)]' : 'text-slate-700', 'focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-[var(--pt-primary)]')}>
                  <Icon name={n.icon} />
                  <span>{L(n.label)}</span>
                  {active && <span aria-hidden className="h-1 w-6 rounded-full bg-[var(--pt-accent)] md:hidden" />}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      <main id="main" tabIndex={-1} className="mx-auto max-w-4xl px-4 py-4 outline-none">{children}</main>
    </div>
  );
}
