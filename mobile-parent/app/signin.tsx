import { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { parseIdentifier } from '@autoed/shared/erp-portal';
import { supabase } from '../src/supabase';
import { useSession } from '../src/session';
import { Banner, Btn, Card, Field, T } from '../src/ui';

/** Phone OTP, e-mail OTP or password (decision 36) with Supabase Auth. Every failure says the same thing, so the screen cannot reveal who has an account. */
export default function SignIn() {
  const { L, brand, boot, session, signOut } = useSession();
  const [ident, setIdent] = useState('');
  const [secret, setSecret] = useState('');
  const [mode, setMode] = useState<'code' | 'password'>('code');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const id = parseIdentifier(ident);

  async function send() {
    if (!id) return setErr(L('signin.invalidId'));
    setBusy(true); setErr(null);
    const { error } = id.kind === 'phone' ? await supabase.auth.signInWithOtp({ phone: `+${id.phone}`, options: { shouldCreateUser: false } }) : await supabase.auth.signInWithOtp({ email: id.email, options: { shouldCreateUser: false } });
    setBusy(false);
    if (error) setErr(L('signin.bad')); else setSent(true);
  }
  async function verify() {
    if (!id) return;
    setBusy(true); setErr(null);
    const { error } = mode === 'password'
      ? await supabase.auth.signInWithPassword(id.kind === 'phone' ? { phone: `+${id.phone}`, password: secret } : { email: id.email, password: secret })
      : await supabase.auth.verifyOtp(id.kind === 'phone' ? { phone: `+${id.phone}`, token: secret.trim(), type: 'sms' } : { email: id.email, token: secret.trim(), type: 'email' });
    setBusy(false);
    if (error) setErr(L('signin.bad'));
  }

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12, paddingTop: 64 }} keyboardShouldPersistTaps="handled">
      <T bold style={{ fontSize: 26 }}>{L('signin.title')}</T>
      <T color="#475569">{brand.name === 'School' ? 'AutoEd' : brand.name}</T>
      <Card>
        <T>{L('signin.subtitle')}</T>
        <Field label={L('signin.identifier')} value={ident} onChangeText={setIdent} autoCapitalize="none" autoComplete="username" editable={!(sent && mode === 'code')} />
        {(sent || mode === 'password') && <Field label={mode === 'password' ? L('signin.password') : L('signin.code')} value={secret} onChangeText={setSecret} secureTextEntry={mode === 'password'} keyboardType={mode === 'code' ? 'number-pad' : 'default'} autoComplete={mode === 'password' ? 'current-password' : 'sms-otp'} />}
        {err ? <Banner tone="bad" text={err} /> : null}
        {session && !boot ? <View style={{ gap: 6 }}><Banner tone="bad" text={L('signin.notLinked')} /><Btn kind="secondary" title={L('c.signOut')} onPress={() => void signOut()} /></View> : null}
        <Btn disabled={busy || !ident} title={mode === 'password' ? L('signin.signIn') : sent ? L('signin.verify') : L('signin.sendCode')} onPress={() => void (mode === 'code' && !sent ? send() : verify())} />
        <Btn kind="secondary" title={mode === 'code' ? L('signin.usePassword') : L('signin.useCode')} onPress={() => { setMode(mode === 'code' ? 'password' : 'code'); setSent(false); setSecret(''); setErr(null); }} />
      </Card>
    </ScrollView>
  );
}
