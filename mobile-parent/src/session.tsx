import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { cacheKey, loadBoot, makeL, pickChild, pickLanguage, resolveBranding, roleOfKind, type BootData, type Branding, type ChildRow, type PortalLang, type StringKey } from '@autoed/shared/erp-portal';
import type { Session } from '@supabase/supabase-js';
import { files, supabase } from './supabase';
import { keysOfUser, screenCache } from './lib/cache';

type LFn = (key: StringKey | (string & {}), params?: Record<string, string | number>) => string;
interface Ctx {
  ready: boolean; session: Session | null; boot: BootData | null; role: ReturnType<typeof roleOfKind>; brand: Branding;
  children: ChildRow[]; child: ChildRow | null; setChildId: (id: string) => void; lang: PortalLang; setLang: (l: PortalLang) => void; L: LFn;
  /** The screens show a saved copy (the phone is offline or the school's server did not answer). */
  offline: boolean; signOut: () => Promise<void>;
}
const C = createContext<Ctx | null>(null);
export const useSession = (): Ctx => { const c = useContext(C); if (!c) throw new Error('outside SessionProvider'); return c; };

export function SessionProvider({ children: kids }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [boot, setBoot] = useState<BootData | null>(null);
  const [lang, setLangState] = useState<PortalLang>('en');
  const [childId, setChildIdState] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const uid = session?.user.id ?? null;

  useEffect(() => {
    void AsyncStorage.getItem('portal_lang').then((l) => setLangState(pickLanguage(l)));
    void supabase.auth.getSession().then(({ data }) => { setSession(data.session); if (!data.session) setReady(true); });
    const { data } = supabase.auth.onAuthStateChange((_e, s) => { setSession(s); if (!s) { setBoot(null); setReady(true); } });
    return () => data.subscription.unsubscribe();
  }, []);

  // after login: the school's name, logo and colours (core.organizations) and the children; the last answer is kept for offline starts
  useEffect(() => {
    if (!uid) return;
    let alive = true;
    const cache = screenCache(files, uid);
    void (async () => {
      try {
        const fresh = await loadBoot(supabase, uid);
        if (!alive) return;
        setBoot(fresh); setOffline(false);
        if (fresh) await cache.write('boot', fresh);
      } catch {
        const saved = await cache.read<BootData>('boot');
        if (alive && saved) { setBoot(saved.data); setOffline(true); }
      } finally {
        if (alive) setReady(true);
      }
      const savedChild = await AsyncStorage.getItem(`portal_child:${uid}`);
      if (alive) setChildIdState(savedChild);
    })();
    return () => { alive = false; };
  }, [uid]);

  const kidsList = useMemo(() => boot?.children ?? [], [boot]);
  const child = useMemo(() => pickChild(kidsList, childId), [kidsList, childId]);
  const setChildId = useCallback((id: string) => { setChildIdState(id); if (uid) void AsyncStorage.setItem(`portal_child:${uid}`, id); }, [uid]);
  const setLang = useCallback((l: PortalLang) => { setLangState(l); void AsyncStorage.setItem('portal_lang', l); }, []);
  const signOut = useCallback(async () => {
    if (uid) { const all = await AsyncStorage.getAllKeys(); await AsyncStorage.multiRemove([...keysOfUser(uid, all), cacheKey(uid, 'boot'), `portal_child:${uid}`]); }
    await supabase.auth.signOut();
  }, [uid]);

  const value: Ctx = {
    ready, session, boot, role: roleOfKind(boot?.member.kind), brand: resolveBranding(boot?.org), children: kidsList, child, setChildId, lang, setLang, L: useMemo(() => makeL(lang), [lang]), offline, signOut,
  };
  return <C.Provider value={value}>{kids}</C.Provider>;
}
