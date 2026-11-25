'use client';
/**
 * Product switcher (decision 35): one control, mounted in the header of every product layout, listing only the
 * products the school bought AND this person was given. Usage (see docs/shell.md):
 *
 *   import { ProductSwitcher } from '@/components/shell';
 *   <ProductSwitcher current="crm" />
 */
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { Lang } from '@autoed/shared';
import { usePlatformSession, useShellLang, type ProductKeyName } from './session';

export function ProductSwitcher({ current, lang, className }: { current?: ProductKeyName | null; lang?: Lang; className?: string }) {
  const { session } = usePlatformSession({ redirectToLogin: false, enforcePasswordChange: false });
  const { t } = useShellLang(lang ?? null, session?.lang ?? null);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);
  if (!session) return null;
  const label = current ? t(`shell.product.${current}.short`) : t('shell.switcher.choose');
  return (
    <div ref={box} className={`relative ${className ?? ''}`} data-testid="product-switcher">
      <button
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex min-h-[36px] items-center gap-1 rounded-md border border-slate-300 bg-white px-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
      >
        <span className="sr-only">{t('shell.switcher.label')}</span>
        <span aria-hidden>▦</span>
        <span>{label}</span>
        <span aria-hidden className="text-xs text-slate-400">
          ▾
        </span>
      </button>
      {open && (
        <div className="absolute left-0 z-50 mt-1 w-64 rounded-md border border-slate-200 bg-white p-1 shadow-lg">
          <nav aria-label={t('shell.switcher.label')}>
            <ul>
              {session.products.map((p) => (
                <li key={p.key}>
                  <Link
                    href={p.home}
                    prefetch={false}
                    data-product={p.key}
                    aria-current={p.key === current ? 'page' : undefined}
                    onClick={() => setOpen(false)}
                    className={`flex min-h-[40px] flex-col justify-center rounded px-2 py-1 text-sm ${p.key === current ? 'bg-brand-50 font-medium text-brand-700' : 'text-slate-700 hover:bg-slate-50'}`}
                  >
                    <span>{t(`shell.product.${p.key}.name`)}</span>
                    <span className="text-xs font-normal text-slate-500">{t(`shell.product.${p.key}.blurb`)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
          <Link href="/records" onClick={() => setOpen(false)} data-testid="switcher-records" className="mt-1 flex min-h-[36px] items-center border-t border-slate-100 px-2 text-xs text-slate-600 hover:bg-slate-50">
            {t('shell.switcher.records')}
          </Link>
          <Link href="/" onClick={() => setOpen(false)} className="flex min-h-[36px] items-center border-t border-slate-100 px-2 text-xs text-slate-600 hover:bg-slate-50">
            {t('shell.switcher.allProducts')}
          </Link>
        </div>
      )}
    </div>
  );
}
