import { Tabs } from 'expo-router';
import { Text } from 'react-native';
import { useEffect, useState } from 'react';
import { onOutboxChange, pending } from '../../src/outbox';
import { useSession } from '../../src/session';
import { colors } from '../../src/ui';

const icon = (c: string) => ({ color }: { color: string }) => <Text style={{ color, fontSize: 20 }}>{c}</Text>;

export default function TabsLayout() {
  const { t, me } = useSession();
  const [queued, setQueued] = useState(0);
  useEffect(() => {
    void pending().then((p) => setQueued(p.length));
    return onOutboxChange(setQueued);
  }, []);
  const teaching = !!me?.staff.is_teaching;
  return (
    <Tabs screenOptions={{ tabBarActiveTintColor: colors.brand, headerTitleStyle: { fontSize: 17 } }}>
      <Tabs.Screen name="index" options={{ title: t('nav.myDay'), tabBarIcon: icon('☀'), tabBarBadge: queued > 0 ? queued : undefined }} />
      <Tabs.Screen name="tasks" options={{ title: t('nav.tasks'), tabBarIcon: icon('☑') }} />
      <Tabs.Screen name="classes" options={{ title: t('nav.studentAttendance'), tabBarIcon: icon('👥'), href: teaching ? undefined : null }} />
      <Tabs.Screen name="inbox" options={{ title: t('nav.inbox'), tabBarIcon: icon('📥') }} />
      <Tabs.Screen name="more" options={{ title: t('nav.menu'), tabBarIcon: icon('☰') }} />
    </Tabs>
  );
}
