/**
 * Same API as the web app (rule 10). Reads fall back to the last cached response when offline;
 * writes that can wait go through the outbox (src/outbox.ts).
 */
import { API_BASE } from './config';
import { readJson, secure, writeJson } from './storage';

export class ApiError extends Error {
  constructor(public status: number, public code: string, public details?: unknown) {
    super(code);
  }
}

let token: string | null = null;
let branchId: string | null = null;
let lang = 'en';
let onUnauthorized: (() => void) | null = null;

export const setToken = (t: string | null) => (token = t);
export const getToken = () => token;
export const setContext = (b: string | null, l: string) => ((branchId = b), (lang = l));
export const setUnauthorizedHandler = (f: () => void) => (onUnauthorized = f);

export async function loadToken() {
  token = await secure.get('os_token');
  return token;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-platform': 'android', 'x-lang': lang, ...(branchId ? { 'x-branch-id': branchId } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  const data = (res.headers.get('content-type') ?? '').includes('json') ? await res.json() : null;
  if (res.status === 401 && !path.startsWith('/auth')) {
    onUnauthorized?.();
    throw new ApiError(401, 'unauthorized');
  }
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string })?.error ?? 'error', (data as { details?: unknown })?.details);
  return data as T;
}

export const post = <T = any>(path: string, body?: unknown) => request<T>('POST', path, body);
export const patch = <T = any>(path: string, body?: unknown) => request<T>('PATCH', path, body);

/** GET with an offline fallback: returns { data, stale } so screens can show an "offline" note. */
export async function get<T = any>(path: string): Promise<{ data: T; stale: boolean }> {
  const key = `cache:${path}`;
  try {
    const data = await request<T>('GET', path);
    void writeJson(key, data);
    return { data, stale: false };
  } catch (e) {
    if (e instanceof ApiError) throw e;
    const cached = await readJson<T | null>(key, null);
    if (cached) return { data: cached, stale: true };
    throw e;
  }
}
