'use client';
import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import '@/components/erp/erp.css';

/**
 * Sign-in for the ERP staff screens. Local development (NEXT_PUBLIC_ERP_AUTH_PROVIDER=dev): the email only, through the dev shim.
 * Production: Supabase Auth (email OTP), then the access token is stored in a cookie by /api/erp/session.
 */
function LoginForm() {
  const sp = useSearchParams();
  const dev = process.env.NEXT_PUBLIC_ERP_AUTH_PROVIDER === 'dev';
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [stage, setStage] = useState<'email' | 'code'>('email');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(sp.get('err'));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (dev) {
        const r = await fetch('/api/erp/dev-login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) });
        if (!r.ok) throw new Error('That email is not a user of this school.');
      } else {
        const { createClient } = await import('@supabase/supabase-js');
        const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
        if (stage === 'email') {
          const r = await sb.auth.signInWithOtp({ email: email.trim(), options: { shouldCreateUser: false } });
          if (r.error) throw new Error(r.error.message);
          setStage('code');
          return;
        }
        const r = await sb.auth.verifyOtp({ email: email.trim(), token: code, type: 'email' });
        if (r.error || !r.data.session) throw new Error(r.error?.message ?? 'Sign-in failed.');
        const s = await fetch('/api/erp/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accessToken: r.data.session.access_token }) });
        if (!s.ok) throw new Error('Sign-in failed.');
      }
      const next = sp.get('next');
      window.location.href = next && next.startsWith('/erp') ? next : '/erp';
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="card w-full max-w-sm space-y-4 p-6">
      <div>
        <h1 className="text-2xl font-semibold text-brand">AutoEd ERP</h1>
        <p className="text-sm text-muted">Sign in to the school office</p>
      </div>
      <label className="block">
        <span className="label">Email</span>
        <input autoFocus required type="email" name="email" value={email} onChange={(e) => setEmail(e.target.value)} className="input" autoComplete="username" />
      </label>
      {stage === 'code' && (
        <label className="block">
          <span className="label">Code from your email</span>
          <input required name="code" value={code} onChange={(e) => setCode(e.target.value)} className="input" inputMode="numeric" autoComplete="one-time-code" />
        </label>
      )}
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      <button disabled={busy} className="btn w-full">{stage === 'code' ? 'Verify and sign in' : dev ? 'Sign in' : 'Send code'}</button>
      <p className="text-xs text-muted">Staff are invited by the school administrator. Parents and students use the family app.</p>
    </form>
  );
}

export default function ErpLogin() {
  return (
    <main className="erp flex min-h-screen items-center justify-center p-4">
      <Suspense><LoginForm /></Suspense>
    </main>
  );
}
