'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { parseIdentifier } from '@autoed/shared/erp-portal';
import { usePortal } from '@/lib/erp-portal/session';
import { Btn, Card, Input, Notice } from '@/components/erp-portal/ui';
import { LanguageSelect, Logo } from '@/components/erp-portal/shell';

const HOME = { parent: '/erp/parent', student: '/erp/student', staff: '/erp/driver', unknown: '/erp/signin' } as const;

/**
 * Sign in with Supabase Auth: phone OTP, e-mail OTP or password (decision 36). The page never says whether a number exists
 * ("That did not work" for every failure), so it cannot be used to find out who has an account at a school.
 */
export default function SignIn() {
  const { sb, status, role, L, brand } = usePortal();
  const router = useRouter();
  const [ident, setIdent] = useState('');
  const [mode, setMode] = useState<'code' | 'password'>('code');
  const [stage, setStage] = useState<'ident' | 'code'>('ident');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const dev = process.env.NEXT_PUBLIC_PORTAL_DEV_AUTH === '1';

  useEffect(() => {
    if (status !== 'ready') return;
    const next = new URLSearchParams(window.location.search).get('next');
    router.replace(next && next.startsWith('/erp/') && !next.startsWith('//') ? next : HOME[role]);
  }, [status, role, router]);

  const id = parseIdentifier(ident);

  async function sendCode() {
    if (!sb) return;
    if (!id) return setError(L('signin.invalidId'));
    setBusy(true); setError(null);
    const { error: e } = id.kind === 'phone' ? await sb.auth.signInWithOtp({ phone: `+${id.phone}`, options: { shouldCreateUser: false } }) : await sb.auth.signInWithOtp({ email: id.email, options: { shouldCreateUser: false } });
    setBusy(false);
    if (e) return setError(L('signin.bad'));
    setStage('code'); setSecret('');
    setInfo(L('signin.codeSent', { to: id.kind === 'phone' ? `+${id.phone}` : id.email }));
  }
  async function verify() {
    if (!sb || !id) return;
    setBusy(true); setError(null);
    const { error: e } = mode === 'password'
      ? await sb.auth.signInWithPassword(id.kind === 'phone' ? { phone: `+${id.phone}`, password: secret } : { email: id.email, password: secret })
      : await sb.auth.verifyOtp(id.kind === 'phone' ? { phone: `+${id.phone}`, token: secret.trim(), type: 'sms' } : { email: id.email, token: secret.trim(), type: 'email' });
    setBusy(false);
    if (e) setError(L('signin.bad'));
  }

  const submit = (ev: React.FormEvent) => { ev.preventDefault(); void (mode === 'code' && stage === 'ident' ? sendCode() : verify()); };

  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 px-4 py-8">
      <div className="flex items-center gap-3">
        <span className="rounded-xl bg-[var(--pt-primary)] p-1"><Logo /></span>
        <div className="flex-1"><h1 className="text-2xl font-bold text-slate-900">{L('signin.title')}</h1><p className="text-base text-slate-700">{brand.name === 'School' ? 'AutoEd' : brand.name}</p></div>
        <LanguageSelect />
      </div>
      <Card>
        <p className="mb-3 text-base text-slate-800">{L('signin.subtitle')}</p>
        <form onSubmit={submit} className="space-y-3" noValidate>
          <Input label={L('signin.identifier')} name="identifier" autoComplete="username" inputMode="text" value={ident} onChange={(e) => setIdent(e.target.value)} disabled={stage === 'code' && mode === 'code'} />
          {(stage === 'code' || mode === 'password') && (
            <Input label={mode === 'password' ? L('signin.password') : L('signin.code')} name="secret" type={mode === 'password' ? 'password' : 'text'} inputMode={mode === 'password' ? undefined : 'numeric'}
              autoComplete={mode === 'password' ? 'current-password' : 'one-time-code'} value={secret} onChange={(e) => setSecret(e.target.value)} />
          )}
          {info && stage === 'code' && mode === 'code' && <Notice>{info}</Notice>}
          {error && <Notice tone="bad">{error}</Notice>}
          {status === 'misconfigured' && <Notice tone="bad">{L('c.error')}</Notice>}
          <Btn type="submit" className="w-full" disabled={busy || !ident || status === 'misconfigured'}>
            {busy ? L('c.sending') : mode === 'password' ? L('signin.signIn') : stage === 'ident' ? L('signin.sendCode') : L('signin.verify')}
          </Btn>
          <div className="flex flex-wrap justify-between gap-2">
            <Btn variant="ghost" onClick={() => { setMode(mode === 'code' ? 'password' : 'code'); setStage('ident'); setSecret(''); setError(null); }}>
              {mode === 'code' ? L('signin.usePassword') : L('signin.useCode')}
            </Btn>
            {stage === 'code' && mode === 'code' && <Btn variant="ghost" onClick={() => { setStage('ident'); setError(null); }}>{L('signin.change')}</Btn>}
          </div>
        </form>
        {dev && <p className="mt-3 text-sm text-slate-700">{L('signin.devHint')}</p>}
      </Card>
      <p className="text-center text-sm text-slate-700">{L('signin.staffNote')}</p>
    </div>
  );
}
