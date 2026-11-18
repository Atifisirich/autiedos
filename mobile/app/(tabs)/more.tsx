import { ScrollView, Switch, View } from 'react-native';
import { LANGUAGES, LANGUAGE_NAMES } from '@autoed/shared';
import { patch } from '../../src/api';
import { useSession } from '../../src/session';
import { Btn, Card, s, T } from '../../src/ui';

export default function More() {
  const { t, me, lang, setLang, signOut, refresh } = useSession();
  return (
    <ScrollView style={s.screen}>
      <Card>
        <T bold>{me?.staff.full_name}</T>
        <T sub>{me?.org.name}</T>
      </Card>
      <Card>
        <T bold>{t('settings.language')}</T>
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          {LANGUAGES.map((l) => <Btn key={l} title={LANGUAGE_NAMES[l]} kind={l === lang ? 'primary' : 'secondary'} onPress={() => setLang(l)} />)}
        </View>
      </Card>
      <Card>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <T>{t('settings.largeText')}</T>
          <Switch value={!!me?.staff.ui_prefs?.large_text} onValueChange={async (v) => { await patch('/me', { ui_prefs: { ...me?.staff.ui_prefs, large_text: v } }).catch(() => undefined); await refresh(); }} />
        </View>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <T>{t('settings.simplifiedHome')}</T>
          <Switch value={!!me?.staff.ui_prefs?.simplified_home} onValueChange={async (v) => { await patch('/me', { ui_prefs: { ...me?.staff.ui_prefs, simplified_home: v } }).catch(() => undefined); await refresh(); }} />
        </View>
      </Card>
      <Btn title={t('nav.signOut')} kind="danger" onPress={signOut} />
    </ScrollView>
  );
}
