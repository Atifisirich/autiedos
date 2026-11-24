'use client';
/**
 * The platform session in the web shell (decision 35: one web app, CRM / ERP / OS). Reads GET /api/os/session once
 * per page load (product-neutral: it answers for any signed-in person, with or without the OS) and shares it with
 * every shell component on the page. Products listed are the ones the org bought AND the person was given.
 * Language: the same `os_lang` choice the OS screens use, else the person's saved language.
 */
import { useCallback, useEffect, useState } from 'react';
import { isLang, makeT, type Lang, type PlatformSession, type ProductKeyName } from '@autoed/shared';

export type { PlatformSession, ProductKeyName };

type State = { session: PlatformSession | null; error: number | null; loading: boolean };
let cache: Promise<PlatformSession> | null = null;

export class ShellApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    public details?: unknown,
  ) {
    super(code);
  }
}

/** JSON call to the platform API (sign-in routes and /session live on the same handler as the OS API). */
export async function shellApi<T = unknown>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/os${path}`, { method, credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
  const data = (await res.json().catch(() => null)) as { error?: string; details?: unknown } | null;
  if (!res.ok) throw new ShellApiError(res.status, data?.error ?? 'error', data?.details);
  return data as T;
}

function loadSession(force = false): Promise<PlatformSession> {
  if (!cache || force) cache = shellApi<PlatformSession>('GET', '/session');
  const p = cache;
  p.catch(() => {
    if (cache === p) cache = null;
  });
  return p;
}

/** Signs out everywhere in this browser (all three products share the session cookie). */
export async function signOut() {
  await shellApi('POST', '/auth/logout').catch(() => undefined);
  cache = null;
  window.location.assign('/login');
}

/**
 * The platform session. `redirectToLogin` (default true) sends a signed-out visitor to /login?next=<this page>;
 * a session that must change its password goes to /account/password.
 */
export function usePlatformSession(opts: { redirectToLogin?: boolean; enforcePasswordChange?: boolean } = {}) {
  const { redirectToLogin = true, enforcePasswordChange = true } = opts;
  const [state, setState] = useState<State>({ session: null, error: null, loading: true });
  const reload = useCallback(async (force = true) => {
    try {
      const s = await loadSession(force);
      setState({ session: s, error: null, loading: false });
    } catch (e) {
      const status = e instanceof ShellApiError ? e.status : 500;
      setState({ session: null, error: status, loading: false });
    }
  }, []);
  useEffect(() => {
    void reload(false);
  }, [reload]);
  useEffect(() => {
    if (state.error === 401 && redirectToLogin) window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
    if (state.session?.must_change_password && enforcePasswordChange && !window.location.pathname.startsWith('/account/password')) window.location.assign('/account/password');
  }, [state, redirectToLogin, enforcePasswordChange]);
  return { ...state, reload };
}

/** Language for shell screens: `lang` prop, else the saved choice (applied after mount so hydration matches). */
export function useShellLang(preferred?: Lang | null, fallback?: Lang | null) {
  const [lang, setLangState] = useState<Lang>(preferred ?? 'en');
  useEffect(() => {
    if (preferred) return setLangState(preferred);
    let saved: string | null = null;
    try {
      saved = localStorage.getItem('os_lang');
    } catch {
      /* storage blocked */
    }
    setLangState(isLang(saved) ? saved : (fallback ?? 'en'));
  }, [preferred, fallback]);
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);
  const setLang = (l: Lang) => {
    try {
      localStorage.setItem('os_lang', l);
    } catch {
      /* ignore */
    }
    setLangState(l);
  };
  return { lang, setLang, t: makeT(lang) };
}

export const hasProduct = (s: PlatformSession | null | undefined, p: ProductKeyName) => !!s?.products.some((x) => x.key === p);

/** School colour from core.organizations.branding (`primary_color`, or the older `color`), if it is a hex colour. */
export function brandColor(branding: Record<string, string> | null | undefined): string | null {
  const c = branding?.primary_color ?? branding?.color ?? null;
  return c && /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(c) ? c : null;
}

/** Translated text for an API error code from the sign-in routes. */
export function authErrorText(t: ReturnType<typeof makeT>, e: unknown): string {
  const code = e instanceof ShellApiError ? e.code : 'error';
  const key = `shell.error.${code.replace(/[^a-z0-9_]/gi, '_')}`;
  const msg = t(key);
  return msg === key ? t('shell.error.generic') : msg;
}
