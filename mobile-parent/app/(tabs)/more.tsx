import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { NEEDS_NATIVE_REVIEW, PORTAL_LANGS } from '@autoed/shared/erp-portal';
import { registerPushStub } from '../../src/push';
import { useSession } from '../../src/session';
import { Banner, Btn, Card, Screen, T } from '../../src/ui';

const NAMES = { en: 'English', hi: 'हिन्दी (Hindi)', te: 'తెలుగు (Telugu)' } as const;

export default function More() {
  const { L, lang, setLang, signOut, boot, brand, children } = useSession();
  const [push, setPush] = useState<'idle' | 'on' | 'off'>('idle');
  return (
    <Screen title={L('more.title')}>
      <Card title={L('more.profile')}>
        <T bold>{boot?.member.display_name}</T>
        <T>{L('more.school')}: {brand.name}</T>
        {children.map((c) => <T key={c.id} small>{c.full_name ?? c.first_name}</T>)}
      </Card>
      <Card title={L('more.language')}>
        {PORTAL_LANGS.map((l) => (
          <Pressable key={l} accessibilityRole="radio" accessibilityState={{ selected: lang === l }} onPress={() => setLang(l)} style={{ minHeight: 48, justifyContent: 'center' }}>
            <T bold={lang === l}>{lang === l ? '● ' : '○ '}{NAMES[l]}</T>
          </Pressable>
        ))}
        {NEEDS_NATIVE_REVIEW.includes(lang) ? <T small color="#475569">{L('more.languageReview')}</T> : null}
      </Card>
      <Card title={L('more.notifications')}>
        <T>{L('more.notificationsStub')}</T>
        {push === 'on' ? <Banner tone="good" text={L('more.notificationsOn')} /> : <Btn kind="secondary" title={L('more.notificationsOff')} onPress={() => void registerPushStub().then((t) => setPush(t ? 'on' : 'off'))} />}
      </Card>
      <View><Btn kind="secondary" title={L('c.signOut')} onPress={() => void signOut()} /></View>
    </Screen>
  );
}
