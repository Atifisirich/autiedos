import { useState } from 'react';
import { SafeAreaView, Text, TextInput, View } from 'react-native';
import { LANGUAGES, LANGUAGE_NAMES, makeT, type Lang } from '@autoed/shared';
import { API_BASE, DEV_LOGIN } from '../src/config';
import { post } from '../src/api';
import { useSession } from '../src/session';
import { Btn, colors, s } from '../src/ui';

/**
 * Sign-in. Production: school email/phone + one-time code via Supabase Auth, then the token is exchanged
 * for an AutoEd OS session at POST /auth/session. Dev builds can use the email-only dev login.
 */
export default function Login() {
  const { signIn } = useSession();
  const [lang, setLang] = useState<Lang>('en');
  const t = makeT(lang);
  const [identity, setIdentity] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = { borderWidth: 1, borderColor: colors.border, borderRadius: 10, minHeight: 48, paddingHorizontal: 12, backgroundColor: '#fff', marginVertical: 6, fontSize: 16 } as const;

  const run = async (f: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await f();
    } catch {
      setError(t('login.failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={s.screen}>
      <View style={{ padding: 24, gap: 8 }}>
        <Text style={{ fontSize: 28, fontWeight: '700', color: colors.brand }}>{t('app.name')}</Text>
        <Text style={{ color: colors.sub }}>{t('login.subtitle')}</Text>
        <TextInput style={input} autoCapitalize="none" keyboardType="email-address" placeholder={t(DEV_LOGIN ? 'login.email' : 'login.phoneOrEmail')} value={identity} onChangeText={setIdentity} accessibilityLabel={t('login.email')} />
        {sent && <TextInput style={input} keyboardType="number-pad" placeholder={t('login.code')} value={code} onChangeText={setCode} accessibilityLabel={t('login.code')} />}
        {error && <Text style={{ color: colors.red }}>{error}</Text>}
        {DEV_LOGIN ? (
          <Btn title={t('login.signIn')} disabled={busy || !identity} onPress={() => run(async () => signIn((await post<{ token: string }>('/auth/dev-login', { email: identity.trim() })).token))} />
        ) : !sent ? (
          <Btn title={t('login.sendCode')} disabled={busy || !identity} onPress={() => run(async () => { await sendOtp(identity.trim()); setSent(true); })} />
        ) : (
          <Btn title={t('login.verify')} disabled={busy || code.length < 4} onPress={() => run(async () => signIn((await post<{ token: string }>('/auth/session', { accessToken: await verifyOtp(identity.trim(), code.trim()) })).token))} />
        )}
        <Text style={{ color: colors.sub, fontSize: 12 }}>{t('login.invitedOnly')}</Text>
        <View style={{ flexDirection: 'row', gap: 16, marginTop: 12 }}>
          {LANGUAGES.map((l) => (
            <Text key={l} onPress={() => setLang(l)} style={{ fontWeight: l === lang ? '700' : '400', color: l === lang ? colors.brand : colors.sub }}>{LANGUAGE_NAMES[l]}</Text>
          ))}
        </View>
      </View>
    </SafeAreaView>
  );
}

// Supabase Auth over REST (no SDK needed): the project URL and anon key come from the public env.
const SB = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';
const isEmail = (v: string) => v.includes('@');
async function sendOtp(id: string) {
  const r = await fetch(`${SB}/auth/v1/otp`, { method: 'POST', headers: { apikey: KEY, 'content-type': 'application/json' }, body: JSON.stringify(isEmail(id) ? { email: id, create_user: false } : { phone: id, create_user: false }) });
  if (!r.ok) throw new Error('otp');
}
async function verifyOtp(id: string, token: string): Promise<string> {
  const r = await fetch(`${SB}/auth/v1/verify`, { method: 'POST', headers: { apikey: KEY, 'content-type': 'application/json' }, body: JSON.stringify(isEmail(id) ? { type: 'email', email: id, token } : { type: 'sms', phone: id, token }) });
  const j = (await r.json()) as { access_token?: string };
  if (!r.ok || !j.access_token) throw new Error('verify');
  return j.access_token;
}
void API_BASE;
