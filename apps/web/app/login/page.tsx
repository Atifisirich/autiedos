'use client';
import { useState } from 'react';
import { LANGUAGES, LANGUAGE_NAMES, makeT, isLang, type Lang } from '@autoed/shared';
import { post, ApiError } from '@/lib/api';

/**
 * Login. Production: phone OTP or email via Supabase Auth (staff are invited, no self sign-up).
 * Local development (NEXT_PUBLIC_AUTH_PROVIDER=dev): email only.
 */
export default function LoginPage() {
  const [lang, setLang] = useState<Lang>(() => {
    try {
      const l = typeof window !== 'undefined' ? localStorage.getItem('os_lang') : null;
      return isLang(l) ? l : 'en';
    } catch {
      return 'en';
    }
  });
  const t = makeT(lang);
  const dev = process.env.NEXT_PUBLIC_AUTH_PROVIDER === 'dev';
  const [identity, setIdentity] = useState('');
  const [code, setCode] = useState('');
  const [stage, setStage] = useState<'identity' | 'code'>('identity');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const finish = () => {
    const next = new URLSearchParams(window.location.search).get('next');
    window.location.href = next && next.startsWith('/os') ? next : '/os';
  };

  async function supabase() {
    const { createClient } = await import('@supabase/supabase-js');
    return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (dev) {
        await post('/auth/dev-login', { email: identity.trim() });
        return finish();
      }
      const sb = await supabase();
      const isPhone = /^\+?\d{10,13}$/.test(identity.replace(/\s/g, ''));
      if (stage === 'identity') {
        const r = isPhone ? await sb.auth.signInWithOtp({ phone: identity.replace(/\s/g, ''), options: { shouldCreateUser: false } }) : await sb.auth.signInWithOtp({ email: identity.trim(), options: { shouldCreateUser: false } });
        if (r.error) throw new Error(r.error.message);
        setStage('code');
      } else {
        const r = isPhone ? await sb.auth.verifyOtp({ phone: identity.replace(/\s/g, ''), token: code, type: 'sms' }) : await sb.auth.verifyOtp({ email: identity.trim(), token: code, type: 'email' });
        if (r.error || !r.data.session) throw new Error(r.error?.message ?? 'no_session');
        await post('/auth/session', { accessToken: r.data.session.access_token });
        finish();
      }
    } catch (err) {
      setError(err instanceof ApiError && err.code === 'rate_limited' ? t('error.rate_limited') : t('login.failed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-xl border bg-white p-6 shadow-sm">
        <div>
          <h1 className="text-2xl font-semibold text-brand-700">{t('app.name')}</h1>
          <p className="text-sm text-slate-500">{t('login.subtitle')}</p>
        </div>
        <label className="block text-sm">
          <span className="mb-1 block font-medium">{dev ? t('login.email') : t('login.phoneOrEmail')}</span>
          <input autoFocus required value={identity} onChange={(e) => setIdentity(e.target.value)} className="block w-full min-h-[44px] rounded-md border border-slate-300 px-3" inputMode={dev ? 'email' : 'text'} autoComplete="username" />
        </label>
        {stage === 'code' && (
          <label className="block text-sm">
            <span className="mb-1 block font-medium">{t('login.code')}</span>
            <input required value={code} onChange={(e) => setCode(e.target.value)} className="block w-full min-h-[44px] rounded-md border border-slate-300 px-3" inputMode="numeric" autoComplete="one-time-code" />
          </label>
        )}
        {error && (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        )}
        <button disabled={busy} className="w-full min-h-[44px] rounded-md bg-brand-600 font-medium text-white disabled:opacity-50">
          {stage === 'code' ? t('login.verify') : dev ? t('login.signIn') : t('login.sendCode')}
        </button>
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
