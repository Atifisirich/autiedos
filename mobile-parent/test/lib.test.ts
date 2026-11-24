import { describe, expect, it } from 'vitest';
import { chunkedStorage, type Kv } from '../src/lib/chunked';
import { keysOfUser, screenCache } from '../src/lib/cache';
import { resolveBranding, parseIdentifier, lookup } from '@autoed/shared/erp-portal';

const mem = (): Kv & { m: Map<string, string> } => {
  const m = new Map<string, string>();
  return { m, get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, v), del: async (k) => void m.delete(k) };
};

describe('chunked session storage', () => {
  it('round-trips a value longer than one chunk and cleans up when it shrinks', async () => {
    const kv = mem();
    const s = chunkedStorage(kv, 10);
    const big = 'x'.repeat(95) + 'END';
    await s.setItem('sess', big);
    expect(await s.getItem('sess')).toBe(big);
    expect([...kv.m.keys()].filter((k) => k.startsWith('sess.') && k !== 'sess.n').length).toBe(10);
    await s.setItem('sess', 'short');
    expect(await s.getItem('sess')).toBe('short');
    expect(kv.m.size).toBe(2);
    await s.removeItem('sess');
    expect(kv.m.size).toBe(0);
    expect(await s.getItem('sess')).toBeNull();
  });
  it('a torn write reads as signed out, not as a broken token', async () => {
    const kv = mem();
    const s = chunkedStorage(kv, 4);
    await s.setItem('k', 'abcdefghij');
    kv.m.delete('k.1');
    expect(await s.getItem('k')).toBeNull();
  });
});

describe('screen cache', () => {
  it('is scoped to user and child and reports stale copies', async () => {
    const kv = mem();
    const a = screenCache(kv, 'u1');
    await a.write('fees', { due: 3000 }, 'c1', 1000);
    expect((await a.read<{ due: number }>('fees', 'c1'))?.data.due).toBe(3000);
    expect(await a.read('fees', 'c2')).toBeNull();
    expect(await screenCache(kv, 'u2').read('fees', 'c1')).toBeNull();
    await a.write('fees', { due: 1 }, 'c1', 0);
    expect((await a.read('fees', 'c1'))?.stale).toBe(true);
  });
  it('lists only the signed-out user\'s keys for removal', () => {
    expect(keysOfUser('u1', ['portal:u1:fees:c1', 'portal:u2:fees:c1', 'other'])).toEqual(['portal:u1:fees:c1']);
  });
});

describe('shared logic used by the app', () => {
  it('branding, sign-in identifier and strings', () => {
    expect(resolveBranding({ name: 'Greenfield', branding: { primary: '#0f766e' } }).onPrimary).toBe('#ffffff');
    expect(parseIdentifier('98765 43210')).toEqual({ kind: 'phone', phone: '919876543210' });
    expect(lookup('te', 'nav.fees')).toBe('ఫీజులు');
  });
});
