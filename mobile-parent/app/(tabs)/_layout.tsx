import { Tabs } from 'expo-router';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { childName } from '@autoed/shared/erp-portal';
import { useSession } from '../../src/session';

/** School-branded header (name and colour come from core.organizations after login) with a child switcher. */
function Header() {
  const { brand, children, child, setChildId, L } = useSession();
  return (
    <View style={{ backgroundColor: brand.primary, paddingTop: 44, paddingBottom: 8, paddingHorizontal: 12 }}>
      <Text accessibilityRole="header" style={{ color: brand.onPrimary, fontSize: 18, fontWeight: '800' }}>{brand.name}</Text>
      {children.length > 1 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 6 }} accessibilityLabel={L('c.child')}>
          {children.map((c) => (
            <Pressable key={c.id} accessibilityRole="button" accessibilityState={{ selected: child?.id === c.id }} onPress={() => setChildId(c.id)}
              style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: 14, marginRight: 8, borderRadius: 22, backgroundColor: child?.id === c.id ? brand.onPrimary : 'transparent', borderWidth: 2, borderColor: brand.onPrimary }}>
              <Text style={{ color: child?.id === c.id ? brand.primary : brand.onPrimary, fontWeight: '700' }}>{childName(c)}</Text>
            </Pressable>
          ))}
        </ScrollView>
      )}
    </View>
  );
}

export default function TabsLayout() {
  const { L, brand } = useSession();
  const hidden = { href: null } as const;
  return (
    <Tabs screenOptions={{ header: () => <Header />, tabBarActiveTintColor: brand.primary, tabBarLabelStyle: { fontSize: 12 } }}>
      <Tabs.Screen name="index" options={{ title: L('nav.home') }} />
      <Tabs.Screen name="fees" options={{ title: L('nav.fees') }} />
      <Tabs.Screen name="academics" options={{ title: L('nav.academics') }} />
      <Tabs.Screen name="messages" options={{ title: L('nav.messages') }} />
      <Tabs.Screen name="more" options={{ title: L('nav.more') }} />
      <Tabs.Screen name="attendance" options={hidden} />
      <Tabs.Screen name="homework" options={hidden} />
      <Tabs.Screen name="bus" options={hidden} />
      <Tabs.Screen name="requests" options={hidden} />
    </Tabs>
  );
}
