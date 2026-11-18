import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { SessionProvider, useSession } from '../src/session';
import { Loading } from '../src/ui';

function Gate() {
  const { me, ready } = useSession();
  const segments = useSegments();
  const router = useRouter();
  useEffect(() => {
    if (!ready) return;
    const inLogin = segments[0] === 'login';
    if (!me && !inLogin) router.replace('/login');
    if (me && inLogin) router.replace('/(tabs)');
  }, [me, ready, segments, router]);
  if (!ready) return <Loading />;
  return <Stack screenOptions={{ headerShown: false }} />;
}

export default function Root() {
  return (
    <SessionProvider>
      <StatusBar style="auto" />
      <Gate />
    </SessionProvider>
  );
}
