'use client';
/**
 * App context: the signed-in user, translation (rule 6), permissions, module flags, branch.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { makeT, isLang, pickLabel, type Lang, type ModuleKey, type PermissionModule, type Action } from '@autoed/shared';
import { get, setApiContext, api } from './api';

export interface Me {
  staff: { id: string; full_name: string; email: string | null; language: Lang; ui_prefs: Record<string, unknown>; is_teaching: boolean; department_id: string | null; wing_id: string | null; branch_id: string | null };
  org: { id: string; name: string; logo_url: string | null; branding: Record<string, string>; setup_step: number };
  branch_id: string;
  branches: { id: string; name: string; code: string; settings: Record<string, unknown> }[];
  roles: { key: string; name: string }[];
  permissions: Record<string, number>;
  modules: Record<string, boolean>;
  terminology: Record<string, Record<string, string>>;
  is_super_admin: boolean;
  lang: Lang;
}

interface AppCtx {
  me: Me | null;
  lang: Lang;
  t: ReturnType<typeof makeT>;
  setLang: (l: Lang) => Promise<void>;
  setBranch: (b: string) => void;
  can: (m: PermissionModule, a: Action, min?: number) => boolean;
  on: (m: ModuleKey | null) => boolean;
  label: (v: Partial<Record<Lang, string>> | null | undefined, fallback?: string) => string;
  term: (key: string, fallback: string) => string;
  reload: () => Promise<void>;
}

const Ctx = createContext<AppCtx | null>(null);

function initialLang(): Lang {
  if (typeof window === 'undefined') return 'en';
  try {
    const l = localStorage.getItem('os_lang');
    if (isLang(l)) return l;
  } catch {
    /* storage blocked */
  }
  return 'en';
}

export function AppProvider({ children, requireAuth = true }: { children: ReactNode; requireAuth?: boolean }) {
  const [me, setMe] = useState<Me | null>(null);
  const [lang, setLangState] = useState<Lang>(initialLang);
  const [branch, setBranchState] = useState<string | null>(() => {
    try {
      return typeof window !== 'undefined' ? localStorage.getItem('os_branch') : null;
    } catch {
      return null;
    }
  });

  const reload = useCallback(async () => {
    setApiContext(branch, null);
    const m = await get<Me>('/me');
    setMe(m);
    setLangState(m.lang);
    setApiContext(m.branch_id, m.lang);
    try {
      localStorage.setItem('os_lang', m.lang);
    } catch {
      /* ignore */
    }
  }, [branch]);

  useEffect(() => {
    if (requireAuth) void reload();
  }, [reload, requireAuth]);

  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.classList.toggle('large-text', !!me?.staff.ui_prefs?.large_text);
  }, [lang, me]);

  const value = useMemo<AppCtx>(() => {
    const t = makeT(lang);
    return {
      me,
      lang,
      t,
      setLang: async (l) => {
        setLangState(l);
        try {
          localStorage.setItem('os_lang', l);
        } catch {
          /* ignore */
        }
        if (me) {
          await api('PATCH', '/me', { language: l });
          await reload();
        }
      },
      setBranch: (b) => {
        try {
          localStorage.setItem('os_branch', b);
        } catch {
          /* ignore */
        }
        setBranchState(b);
      },
      can: (m, a, min = 1) => (me?.permissions[`${m}.${a}`] ?? 0) >= min,
      on: (m) => !m || me?.modules[m] !== false,
      label: (v, fallback = '') => pickLabel(lang, v, fallback),
      term: (key, fallback) => pickLabel(lang, me?.terminology[key], fallback),
      reload,
    };
  }, [me, lang, reload]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useApp outside AppProvider');
  return c;
}

export function useT() {
  return useApp().t;
}

/** Translated error message for an API error code. */
export function useErrorText() {
  const { t } = useApp();
  return (e: unknown) => {
    const code = ((e as { code?: string })?.code ?? 'error').split(':')[0]!;
    const key = `error.${code.replace(/[^a-z0-9_]/gi, '_')}`;
    const msg = t(key);
    return msg === key ? t('error.generic') : msg;
  };
}
