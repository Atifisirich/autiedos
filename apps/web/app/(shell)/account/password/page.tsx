'use client';
/**
 * Set or change the password (decision 36). The current password is asked for only when one is set and the
 * person is neither forced to change it (must_change_password) nor coming from "forgot password" (?reset=1; the
 * server decides from the session token). Rules: PASSWORD_MIN_LENGTH (default 10), not the e-mail or phone,
 * not a well-known password, optional breached-password check.
 */
import { useState } from 'react';
import Link from 'next/link';
import { checkPassword, type SignInResult } from '@autoed/shared';
import { SchoolBrand, authErrorText, shellApi, ShellApiError, usePlatformSession, useShellLang } from '@/components/shell';

const field = 'block w-full min-h-[44px] rounded-md border border-slate-300 px-3';

export default function PasswordPage() {
  const { session } = usePlatformSession({ enforcePasswordChange: false });
  const { t } = useShellLang(null, session?.lang ?? null);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  if (!session) {
    return (
      <div role="status" className="p-10 text-center text-sm text-slate-500">
        {t('common.loading')}
      </div>
    );
  }
  const reset = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('reset') === '1';
  const askCurrent = session.password_set && !session.must_change_password && !reset;
  const min = session.password_min_length;
  const problems = next ? checkPassword(next, { minLength: min, identifiers: [session.user.email, session.user.phone] }) : [];

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (next !== confirm) return setError(t('shell.password.mismatch'));
    if (problems.length) return setError(t(`shell.password.problem.${problems[0]}`, { min }));
    setBusy(true);
    try {
      const r = await shellApi<SignInResult>('POST', '/auth/password/change', { current_password: askCurrent ? current : null, new_password: next });
      setDone(true);
      window.setTimeout(() => window.location.assign(r.products.length === 1 ? `/go/${r.products[0]}` : '/'), 600);
    } catch (err) {
      if (err instanceof ShellApiError && err.code === 'weak_password' && Array.isArray(err.details) && err.details.length) setError(t(`shell.password.problem.${String(err.details[0])}`, { min }));
      else setError(authErrorText(t, err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-xl border bg-white p-6 shadow-sm" data-testid="password-form">
        <SchoolBrand session={session} />
        <div>
          <h1 className="text-xl font-semibold text-slate-800">{session.password_set ? t('shell.password.changeTitle') : t('shell.password.setTitle')}</h1>
          {session.must_change_password && (
            <p role="status" className="mt-1 rounded-md bg-amber-50 p-2 text-sm text-amber-800">
              {t('shell.password.mustChange')}
            </p>
          )}
          <p className="mt-1 text-xs text-slate-500">{t('shell.password.rules', { min })}</p>
        </div>
        {askCurrent && (
          <label className="block text-sm">
            <span className="mb-1 block font-medium">{t('shell.password.current')}</span>
            <input type="password" required value={current} onChange={(e) => setCurrent(e.target.value)} className={field} autoComplete="current-password" />
          </label>
        )}
        <label className="block text-sm">
          <span className="mb-1 block font-medium">{t('shell.password.new')}</span>
          <input type="password" required value={next} onChange={(e) => setNext(e.target.value)} className={field} autoComplete="new-password" aria-describedby="pw-hint" />
          <span id="pw-hint" className="mt-1 block text-xs text-slate-500">
            {next && problems.length ? t(`shell.password.problem.${problems[0]}`, { min }) : next ? t('shell.password.ok') : ''}
          </span>
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium">{t('shell.password.confirm')}</span>
          <input type="password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} className={field} autoComplete="new-password" />
        </label>
        {error && (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        )}
        {done && (
          <p role="status" className="text-sm text-green-700">
            {t('shell.password.saved')}
          </p>
        )}
        <button disabled={busy || done} className="w-full min-h-[44px] rounded-md bg-brand-600 font-medium text-white disabled:opacity-50">
          {t('shell.password.save')}
        </button>
        {!session.must_change_password && (
          <Link href="/" className="block text-center text-sm text-slate-600 underline">
            {t('shell.switcher.allProducts')}
          </Link>
        )}
      </form>
    </main>
  );
}
