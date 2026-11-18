import { useCallback, useEffect, useState } from 'react';
import { ApiError, get } from './api';

/** Loads a GET path; keeps the cached copy visible when offline (stale = true). */
export function useLoad<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!path);
  const reload = useCallback(async () => {
    if (!path) return;
    setLoading(true);
    try {
      const r = await get<T>(path);
      setData(r.data);
      setStale(r.stale);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.code : 'generic');
    } finally {
      setLoading(false);
    }
  }, [path]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, stale, error, loading, reload };
}
