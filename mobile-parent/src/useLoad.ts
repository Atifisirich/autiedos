import { useCallback, useEffect, useRef, useState } from 'react';
import { files } from './supabase';
import { screenCache } from './lib/cache';
import { useSession } from './session';

/** Loads a screen's data; shows the saved copy at once and replaces it when the school's server answers. `savedAt` is set while only the copy is on screen. */
export function useLoad<T>(screen: string, fetcher: () => Promise<T>, opts: { child?: boolean; pollMs?: number } = {}) {
  const { session, child } = useSession();
  const uid = session?.user.id;
  const childId = opts.child ? child?.id ?? null : undefined;
  const [data, setData] = useState<T | undefined>();
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const f = useRef(fetcher);
  f.current = fetcher;
  const blocked = !uid || (opts.child && !child);

  const run = useCallback(async () => {
    if (blocked || !uid) return;
    const cache = screenCache(files, uid);
    try { const d = await f.current(); setData(d); setError(null); setSavedAt(null); await cache.write(screen, d, childId); }
    catch (e) { setError(e); const c = await cache.read<T>(screen, childId); if (c) { setData((x) => x ?? c.data); setSavedAt(c.savedAt); } }
    finally { setLoading(false); }
  }, [blocked, uid, screen, childId]);

  useEffect(() => {
    setData(undefined); setLoading(true); setSavedAt(null);
    if (blocked || !uid) return;
    let alive = true;
    void screenCache(files, uid).read<T>(screen, childId).then((c) => { if (alive && c) setData(c.data); });
    void run();
    const t = opts.pollMs ? setInterval(() => void run(), opts.pollMs) : null;
    return () => { alive = false; if (t) clearInterval(t); };
  }, [run, blocked, uid, screen, childId, opts.pollMs]);

  return { data, error, loading, savedAt, reload: run };
}
