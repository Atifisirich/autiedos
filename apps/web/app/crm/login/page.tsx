'use client';
import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { CrmError, post, get } from '@/lib/crm/api';

/**
 * Sign-in. Production: phone or email one-time code through the platform's sign-in (Supabase Auth), exchanged for the
 * platform session. Local development and tests (AUTH_PROVIDER=dev): email only. The session cookie is the platform's,
 * so signing in here also signs in the other products.
 */
export default function CrmLogin() {
  return (
    <Suspense fallback={null}>
      <Login />
    </Suspense>
  );
}

function Login() {
  const next = useSearchParams().get('next');
  const [provider, setProvider] = useState<'dev' | 'supabase' | null>(null);
  const [identity, setIdentity] = useState('');
  const [code, setCode] = useState('');
  const [stage, setStage] = useState<'identity' | 'code'>('identity');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    get<{ provider: 'dev' | 'supabase' }>('/auth/provider')
      .then((r) => setProvider(r.provider))
      .catch(() => setProvider('supabase'));
  }, []);
  const finish = () => {
    window.location.href = next && next.startsWith('/crm') ? next : '/crm';
  };
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (provider === 'dev') {
        await post('/auth/dev-login', { email: identity.trim() });
        return finish();
      }
      const { createClient } = await import('@supabase/supabase-js');
      const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
      const phone = /^\+?\d{10,13}$/.test(identity.replace(/\s/g, ''));
      const id = phone ? identity.replace(/\s/g, '') : identity.trim();
      if (stage === 'identity') {
        const r = await sb.auth.signInWithOtp(phone ? { phone: id, options: { shouldCreateUser: false } } : { email: id, options: { shouldCreateUser: false } });
        if (r.error) throw new Error(r.error.message);
        setStage('code');
      } else {
        const r = phone ? await sb.auth.verifyOtp({ phone: id, token: code, type: 'sms' }) : await sb.auth.verifyOtp({ email: id, token: code, type: 'email' });
        if (r.error || !r.data.session) throw new Error(r.error?.message ?? 'no_session');
        await post('/auth/session', { accessToken: r.data.session.access_token });
        finish();
      }
    } catch (err) {
      setError(err instanceof CrmError && err.status === 429 ? 'Too many tries. Wait a minute and try again.' : err instanceof CrmError && err.status === 403 ? 'This sign-in has no access to the admissions CRM. Ask your admin.' : 'We could not sign you in. Check the details and try again. Staff are invited by their school; there is no self sign-up.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 p-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-xl border bg-white p-6 shadow-sm" aria-label="Sign in">
        <div>
          <h1 className="text-2xl font-semibold text-teal-900">AutoED CRM</h1>
          <p className="muted">Sign in to the admissions CRM</p>
        </div>
        <label className="block text-sm">
          <span className="label">{provider === 'dev' ? 'Email' : 'Phone or email'}</span>
          <input autoFocus required value={identity} onChange={(e) => setIdentity(e.target.value)} className="input !min-h-[44px]" inputMode={provider === 'dev' ? 'email' : 'text'} autoComplete="username" />
        </label>
        {stage === 'code' && (
          <label className="block text-sm">
            <span className="label">Code we sent you</span>
            <input required value={code} onChange={(e) => setCode(e.target.value)} className="input !min-h-[44px]" inputMode="numeric" autoComplete="one-time-code" />
          </label>
        )}
        {error && (
          <p role="alert" className="text-sm text-rose-700">
            {error}
          </p>
        )}
        <button className="btn btn-primary w-full !min-h-[44px]" disabled={busy || !provider}>
          {stage === 'code' ? 'Verify and sign in' : provider === 'dev' ? 'Sign in' : 'Send me a code'}
        </button>
        <p className="muted text-xs">Staff are invited by their school. There is no self sign-up.</p>
      </form>
    </main>
  );
}
