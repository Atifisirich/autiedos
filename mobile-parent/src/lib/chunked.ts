/**
 * The Auth session is longer than the 2 KB the OS keychain accepts per value, so it is stored in chunks.
 * Pure: the key-value store is passed in (SecureStore on the phone, a Map in the tests).
 */
export interface Kv { get(k: string): Promise<string | null>; set(k: string, v: string): Promise<void>; del(k: string): Promise<void> }

export function chunkedStorage(kv: Kv, size = 1800) {
  return {
    async getItem(key: string): Promise<string | null> {
      const n = await kv.get(`${key}.n`);
      if (n === null) return null;
      let out = '';
      for (let i = 0; i < Number(n); i++) {
        const part = await kv.get(`${key}.${i}`);
        if (part === null) return null; // a torn write: treat as signed out rather than parse half a token
        out += part;
      }
      return out;
    },
    async setItem(key: string, value: string): Promise<void> {
      const old = Number((await kv.get(`${key}.n`)) ?? 0);
      const parts = value.match(new RegExp(`[\\s\\S]{1,${size}}`, 'g')) ?? [''];
      for (let i = 0; i < parts.length; i++) await kv.set(`${key}.${i}`, parts[i]!);
      await kv.set(`${key}.n`, String(parts.length));
      for (let i = parts.length; i < old; i++) await kv.del(`${key}.${i}`);
    },
    async removeItem(key: string): Promise<void> {
      const n = Number((await kv.get(`${key}.n`)) ?? 0);
      for (let i = 0; i < n; i++) await kv.del(`${key}.${i}`);
      await kv.del(`${key}.n`);
    },
  };
}
