'use client';
/**
 * Landing after sign-in (decision 35: one web app, three products). Shows the school's branding and only the
 * products the school bought AND this person was given (GET /session). Platform admins without a school get a
 * link to the console.
 */
import Link from 'next/link';
import { LANGUAGES, LANGUAGE_NAMES, type Lang } from '@autoed/shared';
import { SchoolBrand, brandColor, signOut, usePlatformSession, useShellLang } from '@/components/shell';

const ICON: Record<string, string> = { os: '☀', crm: '✉', erp: '▤' };

export default function ProductLanding() {
  const { session, error } = usePlatformSession();
  const { t, lang, setLang } = useShellLang(null, session?.lang ?? null);
  const color = brandColor(session?.org?.branding) ?? '#1d4ed8';

  if (!session) {
    return (
      <div role="status" className="p-10 text-center text-sm text-slate-500">
        {error && error !== 401 ? t('shell.error.generic') : t('common.loading')}
      </div>
    );
  }
  const products = session.products;
  return (
    <div className="mx-auto max-w-4xl px-4 py-6 sm:py-10">
      <header className="mb-8 flex flex-wrap items-center gap-3">
        <SchoolBrand session={session} subtitle={t('shell.signedInAs', { name: session.user.name })} />
        <div className="flex-1" />
        <select aria-label={t('settings.language')} value={lang} onChange={(e) => setLang(e.target.value as Lang)} className="min-h-[36px] rounded-md border border-slate-300 bg-white px-2 text-sm">
          {LANGUAGES.map((l) => (
            <option key={l} value={l}>
              {LANGUAGE_NAMES[l]}
            </option>
          ))}
        </select>
        <Link href="/account/password" className="min-h-[36px] rounded-md px-2 py-1.5 text-sm text-slate-700 hover:bg-slate-100">
          {session.password_set ? t('shell.password.changeLink') : t('shell.password.setLink')}
        </Link>
        <button type="button" onClick={() => void signOut()} className="min-h-[36px] rounded-md px-2 text-sm text-slate-600 hover:bg-slate-100">
          {t('nav.signOut')}
        </button>
      </header>

      <h1 className="text-2xl font-semibold text-slate-800">{t('shell.landing.title')}</h1>
      <p className="mt-1 text-sm text-slate-600">{products.length ? t('shell.landing.subtitle') : t('shell.landing.none')}</p>

      <ul className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3" data-testid="product-list">
        {products.map((p) => (
          <li key={p.key}>
            <Link
              href={p.home}
              prefetch={false}
              data-product={p.key}
              className="flex h-full min-h-[140px] flex-col rounded-xl border border-slate-200 bg-white p-5 shadow-sm transition hover:border-slate-300 hover:shadow"
            >
              <span aria-hidden className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg text-lg text-white" style={{ backgroundColor: color }}>
                {ICON[p.key] ?? '▦'}
              </span>
              <span className="text-lg font-semibold text-slate-800">{t(`shell.product.${p.key}.name`)}</span>
              <span className="mt-1 text-sm text-slate-600">{t(`shell.product.${p.key}.blurb`)}</span>
            </Link>
          </li>
        ))}
      </ul>

      {products.length > 0 && (
        <p className="mt-6 text-sm">
          <Link href="/records" data-testid="landing-records" className="text-brand-700 underline">
            {t('shell.landing.records')}
          </Link>
        </p>
      )}

      {session.is_platform_admin && (
        <p className="mt-8 text-sm">
          <Link href="/admin" className="text-purple-700 underline">
            {t('shell.landing.console')}
          </Link>
        </p>
      )}
    </div>
  );
}
