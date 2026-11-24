import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { PortalProvider } from '@/lib/erp-portal/session';
import { SwRegister } from '@/components/erp-portal/pwa';
import './portal.css';

export const metadata: Metadata = {
  title: { default: 'AutoEd', template: '%s · AutoEd' },
  description: 'Fees, attendance, report cards, homework, bus and messages for your school.',
  manifest: '/erp/portal.webmanifest',
  appleWebApp: { capable: true, title: 'AutoEd', statusBarStyle: 'default' },
  icons: { icon: '/erp-portal/icon.svg', apple: '/erp-portal/apple-touch-icon.png' },
  robots: { index: false, follow: false },
};
export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#1d4ed8' };

/** Parent, student, driver and gate portals (decision 30: the portals belong to the ERP product). One provider for all four. */
export default function PortalLayout({ children }: { children: ReactNode }) {
  return (
    <PortalProvider>
      <SwRegister />
      {children}
    </PortalProvider>
  );
}
