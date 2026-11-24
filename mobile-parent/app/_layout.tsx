import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { SessionProvider, useSession } from '../src/session';
import { Loading } from '../src/ui';

function Gate() {
  const { ready, session, role, boot } = useSession();
  const seg = useSegments();
  const router = useRouter();
  useEffect(() => {
    if (!ready) return;
    const inSignin = seg[0] === 'signin';
    if (!session && !inSignin) router.replace('/signin');
    if (session && inSignin && boot) router.replace('/(tabs)');
  }, [ready, session, boot, role, seg, router]);
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
