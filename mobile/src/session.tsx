import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { makeT, type Lang, type PermissionModule, type Action } from '@autoed/shared';
import { ApiError, get, loadToken, patch, post, setContext, setToken, setUnauthorizedHandler } from './api';
import { flush, startOutboxWatcher } from './outbox';
import { registerPush } from './push';
import { readJson, secure, writeJson } from './storage';

export interface Me {
  staff: { id: string; full_name: string; language: Lang; ui_prefs: { large_text?: boolean; simplified_home?: boolean }; is_teaching: boolean };
  org: { name: string };
  branch_id: string;
  branches: { id: string; name: string }[];
  permissions: Record<string, number>;
  modules: Record<string, boolean>;
  lang: Lang;
}

interface S {
  me: Me | null;
  ready: boolean;
  t: ReturnType<typeof makeT>;
  lang: Lang;
  can: (m: PermissionModule, a: Action, min?: number) => boolean;
  signIn: (token: string) => Promise<void>;
  signOut: () => Promise<void>;
  setLang: (l: Lang) => Promise<void>;
  refresh: () => Promise<void>;
}
const Ctx = createContext<S | null>(null);
export const useSession = () => {
  const v = useContext(Ctx);
  if (!v) throw new Error('SessionProvider missing');
  return v;
};

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [ready, setReady] = useState(false);
  const [lang, setLangState] = useState<Lang>('en');

  const refresh = useCallback(async () => {
    const { data } = await get<Me>('/me');
    setMe(data);
    setLangState(data.lang);
    setContext(data.branch_id, data.lang);
    void writeJson('me', data);
  }, []);

  const signOut = useCallback(async () => {
    await post('/auth/logout').catch(() => undefined);
    await secure.del('os_token');
    setToken(null);
    setMe(null);
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      void secure.del('os_token');
      setToken(null);
      setMe(null);
    });
    (async () => {
      if (await loadToken()) {
        try {
          await refresh();
          void registerPush();
          void flush();
        } catch (e) {
          if (!(e instanceof ApiError)) {
            const cached = await readJson<Me | null>('me', null); // offline start
            if (cached) (setMe(cached), setLangState(cached.lang), setContext(cached.branch_id, cached.lang));
          }
        }
      }
      setReady(true);
    })();
    return startOutboxWatcher();
  }, [refresh]);

  const value = useMemo<S>(
    () => ({
      me,
      ready,
      lang,
      t: makeT(lang),
      can: (m, a, min = 1) => (me?.permissions[`${m}.${a}`] ?? 0) >= min,
      signIn: async (token) => {
        await secure.set('os_token', token);
        setToken(token);
        await refresh();
        void registerPush();
      },
      signOut,
      setLang: async (l) => {
        setLangState(l);
        setContext(me?.branch_id ?? null, l);
        await patch('/me', { language: l }).catch(() => undefined); // saved on the server so the web app and push messages follow
      },
      refresh,
    }),
    [me, ready, lang, signOut, refresh],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
