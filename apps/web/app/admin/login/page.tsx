'use client';
import { useState } from 'react';
import { adminApi, useAdmin } from '../_lib/admin';
import { Button, Field, Input, Notice, Card } from '../_lib/ui';

/**
 * Sign-in for AutoEd staff. Production: e-mail OTP through Supabase Auth, then the console session.
 * Local development (NEXT_PUBLIC_AUTH_PROVIDER=dev): e-mail only. Being a platform admin is checked by the server.
 */
export default function AdminLoginPage() {
  const { t, errorText } = useAdmin();
  const dev = process.env.NEXT_PUBLIC_AUTH_PROVIDER === 'dev';
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [stage, setStage] = useState<'email' | 'code'>('email');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const finish = () => {
    const next = new URLSearchParams(window.location.search).get('next');
    window.location.href = next && next.startsWith('/admin') ? next : '/admin';
  };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (dev) {
        await adminApi('POST', '/auth/dev-login', { email: email.trim() });
        return finish();
      }
      const { createClient } = await import('@supabase/supabase-js');
      const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
      if (stage === 'email') {
        const r = await sb.auth.signInWithOtp({ email: email.trim(), options: { shouldCreateUser: false } });
        if (r.error) throw new Error(r.error.message);
        setStage('code');
      } else {
        const r = await sb.auth.verifyOtp({ email: email.trim(), token: code, type: 'email' });
        if (r.error || !r.data.session) throw new Error(r.error?.message ?? 'no_session');
        await adminApi('POST', '/auth/session', { accessToken: r.data.session.access_token });
        finish();
      }
    } catch (err) {
      setError(err instanceof Error && 'code' in err ? errorText(err) : t('console.login.failed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <form onSubmit={submit} className="w-full max-w-sm">
        <Card title={t('console.login.title')}>
          <div className="space-y-4">
            <p className="text-sm text-slate-700">{t('console.login.subtitle')}</p>
            <Field label={t('console.login.email')}>
              {(id) => <Input id={id} type="email" required autoFocus autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />}
            </Field>
            {stage === 'code' && (
              <Field label={t('console.login.code')}>
                {(id) => <Input id={id} required inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} />}
              </Field>
            )}
            <Notice error={error} />
            <Button type="submit" disabled={busy} className="w-full">
              {stage === 'code' ? t('console.login.verify') : dev ? t('console.login.signIn') : t('console.login.sendCode')}
            </Button>
          </div>
        </Card>
      </form>
    </main>
  );
}
