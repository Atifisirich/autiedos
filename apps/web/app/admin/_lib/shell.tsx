'use client';
import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LANGUAGES, LANGUAGE_NAMES } from '@autoed/shared';
import { AdminProvider, apost, useAdmin } from './admin';
import { Button, cx } from './ui';

const NAV = [
  { href: '/admin', labelKey: 'console.nav.clients', match: (p: string) => p === '/admin' || p.startsWith('/admin/clients') },
  { href: '/admin/audit', labelKey: 'console.nav.audit', match: (p: string) => p.startsWith('/admin/audit') },
  { href: '/admin/plans', labelKey: 'console.nav.plans', match: (p: string) => p.startsWith('/admin/plans') },
  { href: '/admin/support', labelKey: 'console.nav.support', match: (p: string) => p.startsWith('/admin/support') },
];

export function AdminRoot({ children }: { children: ReactNode }) {
  const path = usePathname() ?? '/admin';
  const bare = path.startsWith('/admin/login');
  return (
    <AdminProvider requireAuth={!bare}>
      {bare ? children : <Shell path={path}>{children}</Shell>}
    </AdminProvider>
  );
}

function Shell({ path, children }: { path: string; children: ReactNode }) {
  const { t, lang, setLang, me } = useAdmin();
  async function signOut() {
    await apost('/auth/logout').catch(() => undefined);
    window.location.href = '/admin/login';
  }
  return (
    <div className="min-h-screen">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-white focus:px-3 focus:py-2">
        {t('console.skipToContent')}
      </a>
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-2">
          <div className="flex min-w-0 max-w-full items-center gap-4">
            <Link href="/admin" className="text-lg font-semibold text-brand-700">
              {t('console.app.name')}
            </Link>
            <nav aria-label={t('console.nav.label')} className="flex min-w-0 gap-1 overflow-x-auto">
              {NAV.map((n) => (
                <Link
                  key={n.href}
                  href={n.href}
                  aria-current={n.match(path) ? 'page' : undefined}
                  className={cx('inline-flex min-h-[44px] items-center whitespace-nowrap rounded-md px-3 text-sm font-medium', n.match(path) ? 'bg-brand-50 text-brand-900' : 'text-slate-700 hover:bg-slate-100')}
                >
                  {t(n.labelKey)}
                </Link>
              ))}
            </nav>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <div role="group" aria-label={t('console.language')} className="flex gap-1">
              {LANGUAGES.map((l) => (
                <button
                  key={l}
                  type="button"
                  onClick={() => setLang(l)}
                  aria-pressed={l === lang}
                  lang={l}
                  className={cx('min-h-[44px] rounded-md px-2', l === lang ? 'bg-brand-50 font-semibold text-brand-900' : 'text-slate-700 hover:bg-slate-100')}
                >
                  {LANGUAGE_NAMES[l]}
                </button>
              ))}
            </div>
            {me && <span className="text-slate-700">{me.name}</span>}
            <Button variant="ghost" size="sm" onClick={() => void signOut()}>
              {t('console.signOut')}
            </Button>
          </div>
        </div>
      </header>
      <ViewAsBanner />
      <main id="main" className="mx-auto max-w-6xl px-4 py-6">
        {children}
      </main>
    </div>
  );
}

/** While the signed-in admin has an open "view as" session, every console page shows who, why and how long. */
function ViewAsBanner() {
  const { t, me, reloadMe, errorText } = useAdmin();
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(id);
  }, []);
  const v = me?.view_as;
  if (!v) return null;
  const mins = Math.max(0, Math.round((new Date(v.expires_at).getTime() - now) / 60000));
  return (
    <div role="status" className="border-b border-amber-300 bg-amber-100 text-amber-950">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 px-4 py-2 text-sm">
        <p>
          <strong>{t('console.viewAs.banner', { org: v.org_name, minutes: mins })}</strong> {v.read_only ? t('console.viewAs.readOnly') : t('console.viewAs.readWrite')} {t('console.viewAs.reasonIs', { reason: v.reason })}
        </p>
        <div className="flex items-center gap-2">
          {error && <span role="alert">{error}</span>}
          <Link href={`/admin/clients/${v.org_id}`} className="min-h-[36px] rounded-md border border-amber-700 px-3 py-1.5 font-medium">
            {t('console.viewAs.openClient')}
          </Link>
          <Button
            size="sm"
            variant="danger"
            onClick={() =>
              void apost('/view-as/end')
                .then(reloadMe)
                .catch((e) => setError(errorText(e)))
            }
          >
            {t('console.viewAs.end')}
          </Button>
        </div>
      </div>
    </div>
  );
}
