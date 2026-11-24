'use client';
/**
 * Client side of the platform admin console: API client, language (English, Hindi, Telugu) and the signed-in admin.
 * Nothing here knows the OS app context; the console is a separate area with its own session cookie.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { isLang, makeT, type Lang, type TFn } from '@autoed/shared';

export class AdminApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    public details?: unknown,
  ) {
    super(code);
  }
}

export async function adminApi<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/admin${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-admin-client': '1' },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    credentials: 'same-origin',
  });
  if (res.status === 401 && typeof window !== 'undefined' && !path.startsWith('/auth')) {
    window.location.href = `/admin/login?next=${encodeURIComponent(window.location.pathname)}`;
    throw new AdminApiError(401, 'unauthorized');
  }
  const data = (res.headers.get('content-type') ?? '').includes('json') ? await res.json() : null;
  if (!res.ok) throw new AdminApiError(res.status, (data as { error?: string } | null)?.error ?? 'error', (data as { details?: unknown } | null)?.details);
  return data as T;
}

export const aget = <T = any>(p: string) => adminApi<T>('GET', p);
export const apost = <T = any>(p: string, b?: unknown) => adminApi<T>('POST', p, b);
export const aput = <T = any>(p: string, b?: unknown) => adminApi<T>('PUT', p, b);
export const apatch = <T = any>(p: string, b?: unknown) => adminApi<T>('PATCH', p, b);
export const adel = <T = any>(p: string) => adminApi<T>('DELETE', p);

/** Loads a path on mount and when it changes; `reload` refetches. A null path loads nothing. */
export function useAdminApi<T = any>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<AdminApiError | null>(null);
  const [loading, setLoading] = useState(!!path);
  const seq = useRef(0);
  const reload = useCallback(async () => {
    if (!path) return;
    const n = ++seq.current;
    setLoading(true);
    try {
      const d = await aget<T>(path);
      if (n === seq.current) {
        setData(d);
        setError(null);
      }
    } catch (e) {
      if (n === seq.current) setError(e as AdminApiError);
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }, [path]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, error, loading, reload };
}

export interface AdminMe {
  user_id: string;
  name: string;
  view_as: { id: string; org_id: string; org_name: string; reason: string; read_only: boolean; expires_at: string; seconds_left: number } | null;
}

interface Ctx {
  t: TFn;
  lang: Lang;
  setLang: (l: Lang) => void;
  me: AdminMe | null;
  reloadMe: () => Promise<void>;
  /** Text for an API error: the translated message for its code, else the generic one. */
  errorText: (e: unknown) => string;
  money: (paise: number | null | undefined) => string;
  dateTime: (v: string | Date | null | undefined) => string;
  date: (v: string | Date | null | undefined) => string;
}

const C = createContext<Ctx | null>(null);
const LOCALE: Record<Lang, string> = { en: 'en-IN', hi: 'hi-IN', te: 'te-IN' };

function savedLang(): Lang {
  try {
    const l = localStorage.getItem('admin_lang');
    if (isLang(l)) return l;
  } catch {
    /* storage blocked: English */
  }
  return 'en';
}

export function AdminProvider({ children, requireAuth = true }: { children: ReactNode; requireAuth?: boolean }) {
  // English on the server and for the first client render (hydration matches); the saved language applies after mount.
  const [lang, setLangState] = useState<Lang>('en');
  const [me, setMe] = useState<AdminMe | null>(null);
  useEffect(() => {
    setLangState(savedLang());
  }, []);
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);
  const reloadMe = useCallback(async () => {
    setMe(await aget<AdminMe>('/me'));
  }, []);
  useEffect(() => {
    if (requireAuth) void reloadMe().catch(() => undefined);
  }, [requireAuth, reloadMe]);

  const value = useMemo<Ctx>(() => {
    const t = makeT(lang);
    const loc = LOCALE[lang];
    const asDate = (v: string | Date | null | undefined) => (v ? new Date(v) : null);
    return {
      t,
      lang,
      setLang: (l) => {
        setLangState(l);
        try {
          localStorage.setItem('admin_lang', l);
        } catch {
          /* ignore */
        }
      },
      me,
      reloadMe,
      errorText: (e) => {
        const code = e instanceof AdminApiError ? e.code : 'unknown';
        const s = t(`console.error.${code}`);
        return s === `console.error.${code}` ? t('console.error.unknown') : s;
      },
      money: (paise) => (paise === null || paise === undefined ? t('console.none') : new Intl.NumberFormat(loc, { style: 'currency', currency: 'INR' }).format(paise / 100)),
      dateTime: (v) => {
        const d = asDate(v);
        return d && !Number.isNaN(d.getTime()) ? d.toLocaleString(loc, { dateStyle: 'medium', timeStyle: 'short' }) : t('console.none');
      },
      date: (v) => {
        const d = asDate(v);
        return d && !Number.isNaN(d.getTime()) ? d.toLocaleDateString(loc, { dateStyle: 'medium' }) : t('console.none');
      },
    };
  }, [lang, me, reloadMe]);

  return <C.Provider value={value}>{children}</C.Provider>;
}

export function useAdmin(): Ctx {
  const v = useContext(C);
  if (!v) throw new Error('useAdmin outside AdminProvider');
  return v;
}
