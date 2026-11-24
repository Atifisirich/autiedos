'use client';
/**
 * Product gate and "not part of your plan" page (plan 4.3 layer 3 in the UI; layers 1-2 are the database and the
 * product servers). A product layout wraps its screens:
 *
 *   <ProductGate product="erp">{children}</ProductGate>
 *
 * Signed-out visitors go to /login, a person who must change their password goes to /account/password, and a
 * person whose school did not buy the product (or who was not given it) sees NotInPlan instead of the screens.
 */
import type { ReactNode } from 'react';
import Link from 'next/link';
import type { Lang } from '@autoed/shared';
import { brandColor, hasProduct, usePlatformSession, useShellLang, type PlatformSession, type ProductKeyName } from './session';

export function ProductGate({ product, children, lang, fallback = null }: { product: ProductKeyName; children: ReactNode; lang?: Lang; fallback?: ReactNode }) {
  const { session, loading } = usePlatformSession();
  if (loading || !session) return <>{fallback}</>;
  if (session.must_change_password) return <>{fallback}</>;
  if (!hasProduct(session, product)) return <NotInPlan product={product} session={session} lang={lang} />;
  return <>{children}</>;
}

export function NotInPlan({ product, session, lang }: { product: ProductKeyName; session: PlatformSession | null; lang?: Lang }) {
  const { t } = useShellLang(lang ?? null, session?.lang ?? null);
  const color = brandColor(session?.org?.branding);
  const others = session?.products.filter((p) => p.key !== product) ?? [];
  return (
    <main className="mx-auto flex min-h-[60vh] max-w-lg flex-col items-center justify-center p-8 text-center" data-testid="not-in-plan">
      <div aria-hidden className="mb-4 flex h-12 w-12 items-center justify-center rounded-full text-xl text-white" style={{ backgroundColor: color ?? '#1d4ed8' }}>
        ▦
      </div>
      <h1 className="text-xl font-semibold text-slate-800">{t('shell.notInPlan.title', { product: t(`shell.product.${product}.name`) })}</h1>
      <p className="mt-2 text-sm text-slate-600">{t('shell.notInPlan.body', { org: session?.org?.name ?? t('shell.yourSchool'), product: t(`shell.product.${product}.name`) })}</p>
      <div className="mt-6 flex flex-wrap justify-center gap-2">
        {others.map((p) => (
          <Link key={p.key} href={p.home} prefetch={false} className="min-h-[40px] rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white">
            {t('shell.open', { product: t(`shell.product.${p.key}.name`) })}
          </Link>
        ))}
        <Link href="/" className="min-h-[40px] rounded-md border border-slate-300 px-4 py-2 text-sm text-slate-700">
          {t('shell.switcher.allProducts')}
        </Link>
      </div>
    </main>
  );
}
