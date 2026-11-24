import { cacheKey, readCache, wrapCache } from '@autoed/shared/erp-portal';
import type { Kv } from './chunked';

/** Offline copy of the last good answer of each screen, per user and child (a shared phone never shows another family's data). */
export function screenCache(kv: Kv, userId: string) {
  return {
    async read<T>(screen: string, childId?: string | null) {
      return readCache<T>(await kv.get(cacheKey(userId, screen, childId)), 30 * 86400000);
    },
    async write<T>(screen: string, data: T, childId?: string | null, now = Date.now()) {
      await kv.set(cacheKey(userId, screen, childId), JSON.stringify(wrapCache(data, now)));
    },
  };
}

/** Which keys of a user to remove on sign out, given every key in the store. */
export const keysOfUser = (userId: string, all: readonly string[]): string[] => all.filter((k) => k.startsWith(`portal:${userId}:`));
