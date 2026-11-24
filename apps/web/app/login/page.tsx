'use client';
import { useEffect, useState } from 'react';
import { LANGUAGES, LANGUAGE_NAMES, isLang, makeT, type Lang, type SignInResult } from '@autoed/shared';
import { authErrorText, shellApi } from '@/components/shell';

/**
 * Unified staff sign-in for CRM, OS and ERP (decisions 35-37): a one-time code by SMS or e-mail, or a password.
 * Every attempt goes through the server (POST /api/os/auth/*), which asks Supabase Auth, applies the rate limits
 * and the lockout, logs the attempt and returns the platform session (org + products). "Forgot password" is a
 * code sign-in that lets the person set a new password. Staff are invited by their school; no self sign-up.
 * Local development (NEXT_PUBLIC_AUTH_PROVIDER=dev) adds the e-mail-only demo sign-in.
 */
type Mode = 'demo' | 'code' | 'password' | 'reset';

const field = 'block w-full min-h-[44px] rounded-md border border-slate-300 px-3';

function safeNext(): string | null {
  const next = new URLSearchParams(window.location.search).get('next');
  return next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/login') ? next : null;
}

export default function LoginPage() {
  const dev = process.env.NEXT_PUBLIC_AUTH_PROVIDER === 'dev';
  const [lang, setLangState] = useState<Lang>('en');
  useEffect(() => {
    try {
      const l = localStorage.getItem('os_lang');
      if (isLang(l)) setLangState(l);
    } catch {
      /* storage blocked */
    }
  }, []);
  const setLang = (l: Lang) => {
    setLangState(l);
    try {
      localStorage.setItem('os_lang', l);
    } catch {
      /* ignore */
    }
  };
  const t = makeT(lang);
  const [mode, setMode] = useState<Mode>(dev ? 'demo' : 'code');
  const [identity, setIdentity] = useState('');
  const [secret, setSecret] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const switchMode = (m: Mode) => {
    setMode(m);
    setSecret('');
    setCodeSent(false);
    setError(null);
    setInfo(null);
  };

  const finish = (r: SignInResult, reset = false) => {
    if (reset || r.must_change_password) return window.location.assign(reset ? '/account/password?reset=1' : '/account/password');
    window.location.assign(safeNext() ?? '/');
  };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === 'demo') return finish(await shellApi<SignInResult>('POST', '/auth/dev-login', { email: identity.trim() }));
      if (mode === 'password') return finish(await shellApi<SignInResult>('POST', '/auth/password', { identifier: identity.trim(), password: secret }));
      if (!codeSent) {
        const r = await shellApi<{ channel: 'email' | 'phone' }>('POST', '/auth/otp/start', { identifier: identity.trim() });
        setCodeSent(true);
        setInfo(r.channel === 'phone' ? t('shell.login.codeSentPhone') : t('shell.login.codeSentEmail'));
        return;
      }
      const r = await shellApi<SignInResult>('POST', '/auth/otp/verify', { identifier: identity.trim(), code: secret.trim(), purpose: mode === 'reset' ? 'reset' : 'login' });
      finish(r, mode === 'reset');
    } catch (err) {
      setError(authErrorText(t, err));
    } finally {
      setBusy(false);
    }
  }

  const tabs: { m: Mode; label: string }[] = [...(dev ? [{ m: 'demo' as const, label: t('shell.login.demo') }] : []), { m: 'code', label: t('shell.login.withCode') }, { m: 'password', label: t('shell.login.withPassword') }];
  const submitLabel = mode === 'demo' ? t('login.signIn') : mode === 'password' ? t('login.signIn') : codeSent ? (mode === 'reset' ? t('shell.login.verifyReset') : t('login.verify')) : t('login.sendCode');

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 p-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-xl border bg-white p-6 shadow-sm" data-testid="login-form">
        <div>
          <h1 className="text-2xl font-semibold text-brand-700">{t('shell.appName')}</h1>
          <p className="text-sm text-slate-500">{mode === 'reset' ? t('shell.login.resetSubtitle') : t('shell.login.subtitle')}</p>
        </div>
        {mode !== 'reset' && (
          <div role="tablist" aria-label={t('shell.login.method')} className="flex rounded-md bg-slate-100 p-1 text-sm">
            {tabs.map((x) => (
              <button key={x.m} type="button" role="tab" aria-selected={mode === x.m} data-mode={x.m} onClick={() => switchMode(x.m)} className={`min-h-[36px] flex-1 rounded ${mode === x.m ? 'bg-white font-medium text-brand-700 shadow-sm' : 'text-slate-600'}`}>
                {x.label}
              </button>
            ))}
          </div>
        )}
        <label className="block text-sm">
          <span className="mb-1 block font-medium">{mode === 'demo' ? t('login.email') : t('login.phoneOrEmail')}</span>
          <input autoFocus required name="identity" value={identity} onChange={(e) => setIdentity(e.target.value)} disabled={codeSent} className={field} inputMode={mode === 'demo' ? 'email' : 'text'} autoComplete="username" />
        </label>
        {mode === 'password' && (
          <label className="block text-sm">
            <span className="mb-1 block font-medium">{t('shell.login.password')}</span>
            <input type="password" required name="password" value={secret} onChange={(e) => setSecret(e.target.value)} className={field} autoComplete="current-password" />
          </label>
        )}
        {(mode === 'code' || mode === 'reset') && codeSent && (
          <label className="block text-sm">
            <span className="mb-1 block font-medium">{t('login.code')}</span>
            <input required name="code" value={secret} onChange={(e) => setSecret(e.target.value)} className={field} inputMode="numeric" autoComplete="one-time-code" />
          </label>
        )}
        {info && !error && (
          <p role="status" className="text-sm text-slate-600">
            {info}
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        )}
        <button disabled={busy} className="w-full min-h-[44px] rounded-md bg-brand-600 font-medium text-white disabled:opacity-50">
          {submitLabel}
        </button>
        <div className="flex justify-between text-sm">
          {mode === 'reset' ? (
            <button type="button" className="text-brand-700 underline" onClick={() => switchMode('password')}>
              {t('shell.login.backToSignIn')}
            </button>
          ) : (
            <button type="button" className="text-brand-700 underline" onClick={() => switchMode('reset')}>
              {t('shell.login.forgot')}
            </button>
          )}
          {codeSent && (
            <button type="button" className="text-slate-600 underline" onClick={() => switchMode(mode)}>
              {t('shell.login.changeIdentity')}
            </button>
          )}
        </div>
        <p className="text-xs text-slate-500">{t('login.invitedOnly')}</p>
        <div className="flex justify-center gap-3 text-sm">
          {LANGUAGES.map((l) => (
            <button type="button" key={l} onClick={() => setLang(l)} className={l === lang ? 'font-semibold text-brand-700' : 'text-slate-500'}>
              {LANGUAGE_NAMES[l]}
            </button>
          ))}
        </div>
      </form>
    </main>
  );
}
