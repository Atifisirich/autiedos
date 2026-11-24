'use client';
/**
 * Portal session: who is signed in, which school (name, colours), which children, which language.
 * Everything comes from the Data API as the user; the last good answer is kept in localStorage so the app opens offline.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import {
  cacheKey, loadBoot, makeL, pickChild, pickLanguage, readCache, resolveBranding, roleOfKind, wrapCache,
  type BootData, type Branding, type Child, type MemberRow, type OrgRow, type PortalLang, type PortalRole, type StringKey,
} from '@autoed/shared/erp-portal';
import { getSb, type Sb } from './client';

export type Member = MemberRow;
export type Org = OrgRow;

export type PortalStatus = 'loading' | 'misconfigured' | 'signedout' | 'ready' | 'nomember';
export type LFn = (key: StringKey | (string & {}), params?: Record<string, string | number>) => string;

interface Ctx {
  status: PortalStatus;
  sb: Sb | null;
  userId: string | null;
  member: Member | null;
  role: PortalRole;
  org: Org | null;
  brand: Branding;
  children: Child[];
  child: Child | null;
  setChildId: (id: string) => void;
  lang: PortalLang;
  setLang: (l: PortalLang) => void;
  L: LFn;
  online: boolean;
  /** The data on screen came from the device's saved copy of this time (ms) because the network failed. */
  offlineSince: number | null;
  signOut: () => Promise<void>;
  reload: () => Promise<void>;
}

const PortalCtx = createContext<Ctx | null>(null);
export function usePortal(): Ctx {
  const c = useContext(PortalCtx);
  if (!c) throw new Error('usePortal outside PortalProvider');
  return c;
}

const safeGet = (k: string): string | null => { try { return localStorage.getItem(k); } catch { return null; } };
const safeSet = (k: string, v: string | null) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* storage blocked: nothing is remembered */ } };

export function PortalProvider({ children: kids }: { children: ReactNode }) {
  const [status, setStatus] = useState<PortalStatus>('loading');
  const [sb, setSb] = useState<Sb | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [boot, setBoot] = useState<BootData | null>(null);
  const [lang, setLangState] = useState<PortalLang>('en');
  const [childId, setChildIdState] = useState<string | null>(null);
  const [online, setOnline] = useState(true);
  const [offlineSince, setOfflineSince] = useState<number | null>(null);
  const userId = session?.user.id ?? null;

  // client + auth state
  useEffect(() => {
    const client = getSb();
    if (!client) { setStatus('misconfigured'); return; }
    setSb(client);
    let alive = true;
    void client.auth.getSession().then(({ data }) => { if (alive) { setSession(data.session); if (!data.session) setStatus('signedout'); } });
    const { data: sub } = client.auth.onAuthStateChange((_e, s) => { if (alive) { setSession(s); if (!s) { setBoot(null); setStatus('signedout'); } } });
    return () => { alive = false; sub.subscription.unsubscribe(); };
  }, []);

  // language: the saved choice, then the phone's language
  useEffect(() => {
    setLangState(pickLanguage(safeGet('portal_lang'), typeof navigator !== 'undefined' ? navigator.language : undefined));
    if (safeGet('portal_large') === '1') document.documentElement.classList.add('large-text');
    const upd = () => setOnline(navigator.onLine);
    upd();
    window.addEventListener('online', upd);
    window.addEventListener('offline', upd);
    return () => { window.removeEventListener('online', upd); window.removeEventListener('offline', upd); };
  }, []);
  useEffect(() => { document.documentElement.lang = lang; }, [lang]);

  const load = useCallback(async () => {
    if (!sb || !userId) return;
    const key = cacheKey(userId, 'boot');
    try {
      const fresh = await loadBoot(sb, userId);
      if (!fresh) { setBoot(null); setStatus('nomember'); return; }
      safeSet(key, JSON.stringify(wrapCache(fresh)));
      setBoot(fresh);
      setOfflineSince(null);
      setStatus('ready');
      if (!safeGet('portal_lang') && fresh.guardian?.language) setLangState(pickLanguage(fresh.guardian.language));
    } catch {
      const cached = readCache<BootData>(safeGet(key), 30 * 86400000);
      if (cached) { setBoot(cached.data); setOfflineSince(cached.savedAt); setStatus('ready'); }
      else setStatus('nomember');
    }
  }, [sb, userId]);
  useEffect(() => { if (userId) void load(); }, [userId, load]);

  const kidsList = useMemo<Child[]>(() => boot?.children ?? [], [boot]);
  useEffect(() => { if (userId) setChildIdState(safeGet(`portal_child:${userId}`)); }, [userId]);
  const child = useMemo(() => pickChild(kidsList, childId), [kidsList, childId]);
  const setChildId = useCallback((id: string) => { setChildIdState(id); if (userId) safeSet(`portal_child:${userId}`, id); }, [userId]);
  const setLang = useCallback((l: PortalLang) => { setLangState(l); safeSet('portal_lang', l); }, []);
  const L = useMemo<LFn>(() => makeL(lang), [lang]);
  const brand = useMemo(() => resolveBranding(boot?.org), [boot]);

  // brand colours as CSS variables on the document (the shell, the sign-in page and the print view all read them)
  useEffect(() => {
    const r = document.documentElement.style;
    r.setProperty('--pt-primary', brand.primary);
    r.setProperty('--pt-accent', brand.accent);
    r.setProperty('--pt-on-primary', brand.onPrimary);
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', brand.primary);
  }, [brand]);

  const signOut = useCallback(async () => {
    if (userId) {
      // a shared phone must not keep this family's saved screens
      try { for (const k of Object.keys(localStorage)) if (k.startsWith(`portal:${userId}:`) || k === `portal_child:${userId}`) localStorage.removeItem(k); } catch { /* nothing to clear */ }
    }
    await sb?.auth.signOut();
    setBoot(null);
    setStatus('signedout');
  }, [sb, userId]);

  const value: Ctx = {
    status, sb, userId, member: boot?.member ?? null, role: roleOfKind(boot?.member.kind), org: boot?.org ?? null, brand, children: kidsList, child,
    setChildId, lang, setLang, L, online, offlineSince, signOut, reload: load,
  };
  return <PortalCtx.Provider value={value}>{kids}</PortalCtx.Provider>;
}
