'use client';
import { useEffect, useState } from 'react';
import { usePortal } from '@/lib/erp-portal/session';
import { Btn, Card } from './ui';

/** Registers the portal's service worker (production only: a worker in `next dev` would serve stale pages). */
export function SwRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production' || !('serviceWorker' in navigator)) return;
    void navigator.serviceWorker.register('/erp/portal-sw.js', { scope: '/erp/' }).catch(() => undefined);
  }, []);
  return null;
}

interface InstallEvent extends Event { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> }

export function InstallCard() {
  const { L } = usePortal();
  const [ev, setEv] = useState<InstallEvent | null>(null);
  const [standalone, setStandalone] = useState(false);
  const [ios, setIos] = useState(false);
  useEffect(() => {
    const h = (e: Event) => { e.preventDefault(); setEv(e as InstallEvent); };
    window.addEventListener('beforeinstallprompt', h);
    setStandalone(window.matchMedia('(display-mode: standalone)').matches);
    setIos(/iphone|ipad|ipod/i.test(navigator.userAgent));
    return () => window.removeEventListener('beforeinstallprompt', h);
  }, []);
  if (standalone) return null;
  return (
    <Card title={L('more.install')}>
      <p className="text-base text-slate-800">{L('more.installHint')}</p>
      {ev && <div className="mt-3"><Btn onClick={() => { void ev.prompt(); setEv(null); }}>{L('more.install')}</Btn></div>}
      {!ev && ios && <p className="mt-2 text-sm text-slate-800">{L('more.installIos')}</p>}
    </Card>
  );
}
