'use client';
/**
 * Client for the AutoEd OS API (/api/os). Same endpoints the mobile app uses.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    public details?: unknown,
  ) {
    super(code);
  }
}

let branchId: string | null = null;
let lang: string | null = null;
export function setApiContext(b: string | null, l: string | null) {
  branchId = b;
  lang = l;
}

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/os${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(branchId ? { 'x-branch-id': branchId } : {}), ...(lang ? { 'x-lang': lang } : {}) },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    credentials: 'same-origin',
  });
  if (res.status === 401 && typeof window !== 'undefined' && !path.startsWith('/auth')) {
    window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
    throw new ApiError(401, 'unauthorized');
  }
  const ct = res.headers.get('content-type') ?? '';
  const data = ct.includes('json') ? await res.json() : null;
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string })?.error ?? 'error', (data as { details?: unknown })?.details);
  return data as T;
}

export const get = <T = any>(p: string) => api<T>('GET', p);
export const post = <T = any>(p: string, b?: unknown) => api<T>('POST', p, b);

/** Small data hook: loads on mount and when the path changes; `reload` refetches. */
export function useApi<T = any>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(!!path);
  const seq = useRef(0);
  const reload = useCallback(async () => {
    if (!path) return;
    const n = ++seq.current;
    setLoading(true);
    try {
      const d = await get<T>(path);
      if (n === seq.current) {
        setData(d);
        setError(null);
      }
    } catch (e) {
      if (n === seq.current) setError(e as ApiError);
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }, [path]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, error, loading, reload, setData };
}

/** Downloads a binary export (xlsx/docx) through the API. */
export async function download(path: string) {
  const res = await fetch(`/api/os${path}`, { headers: { ...(branchId ? { 'x-branch-id': branchId } : {}), ...(lang ? { 'x-lang': lang } : {}) } });
  if (!res.ok) throw new ApiError(res.status, 'download_failed');
  const blob = await res.blob();
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'export';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

/** Uploads a file: asks the API for a signed URL, then PUTs the bytes. Returns the storage path. */
export async function uploadFile(file: File, purpose: string): Promise<string> {
  const u = await post<{ path: string; url: string; method: string }>('/uploads', { purpose, file_name: file.name, mime: file.type || 'application/octet-stream', size_bytes: file.size });
  const res = await fetch(u.url, { method: u.method, body: file, headers: { 'content-type': file.type || 'application/octet-stream' } });
  if (!res.ok) throw new ApiError(res.status, 'upload_failed');
  return u.path;
}

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}
