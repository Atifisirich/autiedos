'use client';
/**
 * Chrome of the custom records screens (/records): the shared session and language, the product switcher, and a
 * header with the way back. Open to any signed-in staff member of a school with at least one product; what each person
 * sees inside is decided by the database (per-object permissions).
 */
import { createContext, useContext, type ReactNode } from 'react';
import Link from 'next/link';
import { LANGUAGES, LANGUAGE_NAMES, type Lang, type TFn } from '@autoed/shared';
import { ProductSwitcher, SchoolBrand, signOut, usePlatformSession, useShellLang, type PlatformSession } from '@/components/shell';

interface Ctx {
  t: TFn;
  lang: Lang;
  session: PlatformSession;
}
const RecordsCtx = createContext<Ctx | null>(null);

export function useRecords(): Ctx {
  const c = useContext(RecordsCtx);
  if (!c) throw new Error('useRecords outside RecordsRoot');
  return c;
}

export function RecordsRoot({ children }: { children: ReactNode }) {
  const { session, error } = usePlatformSession();
  const { t, lang, setLang } = useShellLang(null, session?.lang ?? null);
  if (!session) {
    return (
      <div role="status" className="p-10 text-center text-sm text-slate-500">
        {error && error !== 401 ? t('shell.error.generic') : t('common.loading')}
      </div>
    );
  }
  return (
    <RecordsCtx.Provider value={{ t, lang, session }}>
      <div className="min-h-screen bg-slate-50">
        <header className="sticky top-0 z-40 border-b border-slate-200 bg-white">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-2 px-3 py-2 sm:px-4">
            <ProductSwitcher lang={lang} />
            <SchoolBrand session={session} />
            <nav aria-label={t('records.nav.label')} className="flex items-center gap-1">
              <Link href="/records" className="min-h-[36px] rounded-md px-2 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100">
                {t('records.title')}
              </Link>
              <Link href="/records/approvals" className="min-h-[36px] rounded-md px-2 py-1.5 text-sm text-slate-700 hover:bg-slate-100">
                {t('records.approvals.title')}
              </Link>
            </nav>
            <div className="flex-1" />
            <select aria-label={t('settings.language')} value={lang} onChange={(e) => setLang(e.target.value as Lang)} className="min-h-[36px] rounded-md border border-slate-300 bg-white px-2 text-sm">
              {LANGUAGES.map((l) => (
                <option key={l} value={l}>
                  {LANGUAGE_NAMES[l]}
                </option>
              ))}
            </select>
            <button type="button" onClick={() => void signOut()} className="min-h-[36px] rounded-md px-2 text-sm text-slate-600 hover:bg-slate-100">
              {t('nav.signOut')}
            </button>
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-3 py-4 sm:px-4 sm:py-6">{children}</main>
      </div>
    </RecordsCtx.Provider>
  );
}

/** Error text for an API failure (server messages from the database validation are shown as they are). */
export function errorText(t: TFn, e: unknown): string {
  const err = e as { status?: number; code?: string; detail?: string; issues?: unknown };
  if (err?.status === 403) return t('records.error.forbidden');
  if (err?.status === 404) return t('records.error.notFound');
  if (err?.status === 409) return err.detail === 'object_has_records' ? t('records.error.hasRecords') : t('records.error.conflict');
  if (err?.status === 422) {
    const issues = Array.isArray(err.issues) ? err.issues.map((i) => (typeof i === 'string' ? i : `${(i as { path: string }).path}: ${(i as { message: string }).message}`)) : [];
    return `${t('records.error.invalid')} ${issues.length ? issues.join('; ') : err.detail ?? ''}`.trim();
  }
  return t('shell.error.generic');
}
