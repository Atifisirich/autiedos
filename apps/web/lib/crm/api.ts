'use client';
/**
 * Client for the AutoEd CRM API (/api/crm). Every screen reads and writes through it; nothing here knows SQL or roles:
 * the server decides what the signed-in person may see and do, the screens only ask and show the answer.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export class CrmError extends Error {
  constructor(public status: number, message: string, public data?: any) {
    super(message);
  }
}

// ---------------------------------------------------------------- year and branch pickers (sent as headers)
type Prefs = { year: string | null; branch: string | null };
const PREFS_KEY = 'crm_prefs';
let prefs: Prefs = { year: null, branch: null };
const listeners = new Set<() => void>();
export function loadPrefs() {
  try {
    prefs = { year: null, branch: null, ...JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') };
  } catch {
    /* private mode: the pickers simply do not persist */
  }
  return prefs;
}
export function setPrefs(p: Partial<Prefs>) {
  prefs = { ...prefs, ...p };
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* storage blocked */
  }
  listeners.forEach((f) => f());
}
export const getPrefs = () => prefs;

// ---------------------------------------------------------------- toasts
export type Flash = { message: string; kind: 'ok' | 'error' | 'keep' };
const flashers = new Set<(f: Flash | null) => void>();
export function flash(message: string, kind: Flash['kind'] = 'ok') {
  flashers.forEach((f) => f({ message, kind }));
}
export function onFlash(f: (x: Flash | null) => void) {
  flashers.add(f);
  return () => void flashers.delete(f);
}

// ---------------------------------------------------------------- calls
let prefsLoaded = false;
export async function crm<T = any>(method: string, path: string, body?: unknown, query?: Record<string, string | undefined>): Promise<T> {
  if (!prefsLoaded && typeof window !== 'undefined') {
    prefsLoaded = true;
    loadPrefs();
  }
  const qs = query ? new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== '') as [string, string][]).toString() : '';
  const res = await fetch(`/api/crm${path}${qs ? '?' + qs : ''}`, {
    method,
    headers: { 'content-type': 'application/json', ...(prefs.year ? { 'x-crm-year': prefs.year } : {}), ...(prefs.branch ? { 'x-crm-branch': prefs.branch } : {}) },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    credentials: 'same-origin',
  });
  const ct = res.headers.get('content-type') ?? '';
  const data = ct.includes('json') ? await res.json().catch(() => null) : null;
  if (res.status === 401 && typeof window !== 'undefined' && !path.startsWith('/auth') && !window.location.pathname.startsWith('/crm/login')) {
    window.location.href = `/crm/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`;
  }
  if (!res.ok) throw new CrmError(res.status, (data as { error?: string } | null)?.error ?? 'Something went wrong. Please try again.', data);
  return data as T;
}
export const get = <T = any>(path: string, query?: Record<string, string | undefined>) => crm<T>('GET', path, undefined, query);
export const post = <T = any>(path: string, body?: unknown) => crm<T>('POST', path, body);

/**
 * Runs a write, shows the server's message (or its refusal) as a toast and returns the result, or null when it failed.
 * `quiet` skips the success toast (the screen shows the change itself).
 */
export async function act<T = any>(path: string, body?: unknown, opts: { quiet?: boolean; keep?: boolean } = {}): Promise<T | null> {
  try {
    const r = await post<T & { message?: string; ok?: boolean }>(path, body);
    if (r && (r as { ok?: boolean }).ok === false) {
      flash((r as { message?: string }).message ?? 'Not done.', 'error');
      return null;
    }
    if (!opts.quiet && r && (r as { message?: string }).message) flash((r as { message?: string }).message!, opts.keep ? 'keep' : 'ok');
    return r;
  } catch (e) {
    flash(e instanceof CrmError ? e.message : 'Could not reach the server.', 'error');
    return null;
  }
}

/** Loads on mount, when the path or query change, and when the year or branch picker changes. `reload` refetches. */
export function useCrm<T = any>(path: string | null, query?: Record<string, string | undefined>) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<CrmError | null>(null);
  const [loading, setLoading] = useState(!!path);
  const seq = useRef(0);
  const key = path ? path + '?' + JSON.stringify(query ?? {}) : '';
  const reload = useCallback(async () => {
    if (!path) return;
    const n = ++seq.current;
    setLoading(true);
    try {
      const d = await get<T>(path, query);
      if (n === seq.current) {
        setData(d);
        setError(null);
      }
    } catch (e) {
      if (n === seq.current) setError(e instanceof CrmError ? e : new CrmError(0, 'Could not reach the server.'));
    } finally {
      if (n === seq.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(() => {
    void reload();
  }, [reload]);
  useEffect(() => {
    const f = () => void reload();
    listeners.add(f);
    return () => void listeners.delete(f);
  }, [reload]);
  return { data, error, loading, reload, setData };
}

/** Form values as an object: fields with the same name become arrays, checkboxes are true when ticked. */
export function formObj(form: HTMLFormElement | FormData): Record<string, any> {
  const fd = form instanceof FormData ? form : new FormData(form);
  const out: Record<string, any> = {};
  for (const [k, v] of fd.entries()) {
    const val = typeof v === 'string' ? v : v.name;
    if (k in out) out[k] = [].concat(out[k], val as never);
    else out[k] = val;
  }
  return out;
}
