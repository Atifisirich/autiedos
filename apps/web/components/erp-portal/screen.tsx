'use client';
import type { ReactNode } from 'react';
import { fmtDate, fmtTime } from '@autoed/shared/erp-portal';
import { usePortal } from '@/lib/erp-portal/session';
import type { Loaded as LoadedQ } from '@/lib/erp-portal/use-load';
import { Card, Empty, LoadError, Notice, Spinner } from './ui';

/** The child of the screen, or an explanation when the login has none (parents) . */
export function NeedChild({ children }: { children: (child: NonNullable<ReturnType<typeof usePortal>['child']>) => ReactNode }) {
  const { child, L } = usePortal();
  if (!child) return <Card><Empty title={L('home.noChildren')} hint={L('home.noChildrenHint')} /></Card>;
  return <>{children(child)}</>;
}

/**
 * Shows loading, the error (with retry) or the data, and says "saved <time>" when the data on screen is the device's saved copy
 * because the network failed.
 */
export function WithData<T>({ q, children }: { q: LoadedQ<T>; children: (data: T) => ReactNode }) {
  const { L, lang } = usePortal();
  if (q.data === undefined) return q.loading ? <Spinner label={L('c.loading')} /> : <LoadError retry={() => void q.reload()} />;
  return (
    <>
      {q.savedAt && <div className="mb-3"><Notice tone="warn">{L('c.offline', { when: `${fmtDate(new Date(q.savedAt).toISOString(), lang)} ${fmtTime(new Date(q.savedAt).toISOString(), lang)}` })}</Notice></div>}
      {children(q.data)}
    </>
  );
}
