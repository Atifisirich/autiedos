'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { cacheKey, readCache, wrapCache } from '@autoed/shared/erp-portal';
import { usePortal } from './session';

export interface Loaded<T> {
  data: T | undefined;
  /** Set when the last refresh failed (with or without older data to show). */
  error: unknown;
  loading: boolean;
  /** The data shown is the saved copy from this time (ms) because a refresh has not succeeded yet. */
  savedAt: number | null;
  reload: () => Promise<void>;
}

const get = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const set = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* full or blocked: just no offline copy */ } };

/**
 * Loads a screen's data and keeps the last good copy on the device (scoped to user and child), so the screen opens offline with
 * "saved <time>". `key` null skips loading. The fetcher gets the signed-in client; throw to signal failure.
 */
export function useLoad<T>(screen: string | null, fetcher: () => Promise<T>, deps: unknown[] = [], opts: { childScoped?: boolean; pollMs?: number } = {}): Loaded<T> {
  const { userId, sb, child } = usePortal();
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const fetchRef = useRef(fetcher);
  fetchRef.current = fetcher;
  const key = userId && screen ? cacheKey(userId, screen, opts.childScoped ? child?.id : undefined) : null;
  const scopeReady = !opts.childScoped || Boolean(child);

  const run = useCallback(async () => {
    if (!sb || !key || !scopeReady) return;
    try {
      const fresh = await fetchRef.current();
      setData(fresh);
      setError(null);
      setSavedAt(null);
      set(key, JSON.stringify(wrapCache(fresh)));
    } catch (e) {
      setError(e);
      const cached = readCache<T>(get(key), 30 * 86400000);
      if (cached) { setData((d) => d ?? cached.data); setSavedAt(cached.savedAt); }
    } finally {
      setLoading(false);
    }
  }, [sb, key, scopeReady]);

  useEffect(() => {
    setData(undefined); setError(null); setSavedAt(null); setLoading(true);
    if (!key) return;
    const cached = readCache<T>(get(key), 30 * 86400000);
    if (cached) setData(cached.data); // show the saved copy at once; the fresh one replaces it
    void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, run, ...deps]);

  useEffect(() => {
    if (!opts.pollMs || !key) return;
    const t = setInterval(() => { if (document.visibilityState === 'visible') void run(); }, opts.pollMs);
    return () => clearInterval(t);
  }, [opts.pollMs, key, run]);

  return { data, error, loading, savedAt, reload: run };
}
