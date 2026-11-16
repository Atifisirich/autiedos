'use client';
/** Private files are served through short-lived signed URLs from POST /downloads. */
import { useEffect, useState } from 'react';
import { post } from '@/lib/api';
import { useApp } from '@/lib/app';

export function useSignedUrl(path: string | null | undefined) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    setUrl(null);
    if (path) post<{ url: string }>('/downloads', { path }).then((r) => setUrl(r.url)).catch(() => setUrl(null));
  }, [path]);
  return url;
}

export function SignedImage({ path, alt }: { path: string; alt: string }) {
  const url = useSignedUrl(path);
  return url ? <img src={url} alt={alt} className="mt-2 max-h-64 rounded" /> : null;
}

export function SignedAudio({ path }: { path: string }) {
  const url = useSignedUrl(path);
  return url ? <audio controls src={url} className="mt-2" /> : null;
}

export function FileLink({ path, name }: { path: string; name?: string }) {
  const { t } = useApp();
  return (
    <button type="button" className="text-brand-700 hover:underline" onClick={async () => window.open((await post<{ url: string }>('/downloads', { path })).url, '_blank', 'noopener')}>
      {name ?? path.split('/').pop()?.replace(/^[0-9a-f-]{36}-/, '') ?? t('common.open')}
    </button>
  );
}
