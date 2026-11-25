'use client';
import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { NAV_ITEMS, LANGUAGES, LANGUAGE_NAMES, type Lang } from '@autoed/shared';
import { useApp } from '@/lib/app';
import { getViewAs, post, setViewAs, useApi } from '@/lib/api';
import { cx, Loading } from './ui';
import { HelpBot } from './help-bot';
import { ProductSwitcher } from './shell';

const GROUPS = ['day', 'academic', 'admin', 'insight', 'settings'] as const;
const ICON: Record<string, string> = {
  sun: '☀', 'check-square': '☑', 'list-checks': '✓', 'map-pin': '⌖', users: '👥', plane: '✈', stamp: '✎', grid: '▦', shuffle: '⇄', shield: '⛨', book: '📘', gauge: '◔', notebook: '📓', 'file-text': '📄', eye: '👁', wrench: '🔧', megaphone: '📣', calendar: '📅', 'message-circle': '💬', party: '🎉', alert: '⚠', 'shield-check': '✔', 'bar-chart': '📊', inbox: '📥', sparkles: '✨', settings: '⚙',
};

export function Shell({ children }: { children: ReactNode }) {
  const { me, t, on, can, setLang, lang, setBranch, hasProduct } = useApp();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const inbox = useApi<{ id: string }[]>(me ? '/inbox?unread=1' : null);
  useEffect(() => { setOpen(false); }, [pathname]);
  if (!me) return <Loading />;
  // Layer 3 (plan 4.3): without the OS product for this org and user, show "not part of your plan", not the OS.
  if (!hasProduct('os')) {
    return (
      <main className="mx-auto max-w-lg p-8 text-center">
        <h1 className="text-xl font-semibold text-slate-800">{t('plan.osNotIncluded')}</h1>
        <p className="mt-2 text-sm text-slate-600">{t('plan.osNotIncludedBody', { org: me.org.name })}</p>
      </main>
    );
  }
  const items = NAV_ITEMS.filter((i) => on(i.module) && (!i.perm || can(i.perm.module, i.perm.action, i.key === 'setup' ? 5 : 1)));
  const isActive = (href: string) => (href === '/os' ? pathname === '/os' : pathname?.startsWith(href));
  const unread = inbox.data?.length ?? 0;
  return (
    <div className="min-h-screen md:flex">
      <aside className={cx('no-print fixed inset-y-0 left-0 z-40 w-64 overflow-y-auto border-r border-slate-200 bg-white transition-transform md:static md:translate-x-0', open ? 'translate-x-0' : '-translate-x-full')}>
        <div className="border-b px-4 py-4">
          <div className="text-lg font-semibold text-brand-700">{t('app.name')}</div>
          <div className="truncate text-xs text-slate-500">{me.org.name}</div>
        </div>
        <nav aria-label={t('nav.main')} className="p-2">
          {GROUPS.map((g) => {
            const list = items.filter((i) => i.group === g);
            if (!list.length) return null;
            return (
              <div key={g} className="mb-3">
                <div className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400">{t(`nav.group.${g}`)}</div>
                {list.map((i) => (
                  <Link key={i.key} href={i.href} className={cx('flex min-h-[40px] items-center gap-2 rounded-md px-2 text-sm', isActive(i.href) ? 'bg-brand-50 font-medium text-brand-700' : 'text-slate-700 hover:bg-slate-50')}>
                    <span aria-hidden className="w-5 text-center">
                      {ICON[i.icon] ?? '•'}
                    </span>
                    <span className="flex-1">{t(i.labelKey)}</span>
                    {i.key === 'inbox' && unread > 0 && <span className="rounded-full bg-red-600 px-1.5 text-[11px] text-white">{unread}</span>}
                  </Link>
                ))}
              </div>
            );
          })}
          {can('setup', 'configure', 5) && (
            <Link href="/designer" className="flex min-h-[40px] items-center gap-2 rounded-md px-2 text-sm text-brand-700 hover:bg-brand-50" data-testid="nav-designer">
              <span aria-hidden className="w-5 text-center">
                ✨
              </span>
              {t('designer.nav')}
            </Link>
          )}
          {me.is_super_admin && (
            <Link href="/os/admin" className="flex min-h-[40px] items-center gap-2 rounded-md px-2 text-sm text-purple-700 hover:bg-purple-50">
              <span aria-hidden className="w-5 text-center">
                ★
              </span>
              {t('nav.superAdmin')}
            </Link>
          )}
        </nav>
      </aside>
      {open && <div className="fixed inset-0 z-30 bg-black/30 md:hidden" onClick={() => setOpen(false)} />}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="no-print sticky top-0 z-20 flex flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-3 py-2">
          <button className="min-h-[40px] min-w-[40px] rounded md:hidden" onClick={() => setOpen(true)} aria-label={t('nav.menu')}>
            ☰
          </button>
          <ProductSwitcher current="os" lang={lang} />
          {me.branches.length > 1 && (
            <select aria-label={t('nav.branch')} value={me.branch_id} onChange={(e) => setBranch(e.target.value)} className="min-h-[36px] rounded-md border border-slate-300 px-2 text-sm">
              {me.branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          )}
          <div className="flex-1" />
          <select aria-label={t('settings.language')} value={lang} onChange={(e) => void setLang(e.target.value as Lang)} className="min-h-[36px] rounded-md border border-slate-300 px-2 text-sm">
            {LANGUAGES.map((l) => (
              <option key={l} value={l}>
                {LANGUAGE_NAMES[l]}
              </option>
            ))}
          </select>
          <Link href="/os/inbox" className="relative min-h-[36px] rounded-md px-2 py-1.5 text-sm hover:bg-slate-100" aria-label={t('nav.inbox')}>
            📥{unread > 0 && <span className="absolute -right-1 -top-1 rounded-full bg-red-600 px-1 text-[10px] text-white">{unread}</span>}
          </Link>
          <Link href="/os/settings" className="min-h-[36px] rounded-md px-2 py-1.5 text-sm hover:bg-slate-100">
            {me.staff.full_name}
          </Link>
          <button
            className="min-h-[36px] rounded-md px-2 text-sm text-slate-600 hover:bg-slate-100"
            onClick={async () => {
              await post('/auth/logout');
              window.location.href = '/login';
            }}
          >
            {t('nav.signOut')}
          </button>
        </header>
        <main className="mx-auto w-full max-w-7xl flex-1 p-3 sm:p-6">
          {getViewAs() && (
            <div role="status" className="mb-3 flex items-center justify-between rounded-md border border-purple-200 bg-purple-50 p-2 text-sm text-purple-800">
              <span>{t('admin.viewingAs', { org: me.org.name })}</span>
              <button type="button" className="underline" onClick={() => (setViewAs(null), window.location.assign('/os/admin'))}>{t('admin.exitViewAs')}</button>
            </div>
          )}
          {children}
        </main>
      </div>
      {on('help_bot') && <HelpBot />}
    </div>
  );
}
