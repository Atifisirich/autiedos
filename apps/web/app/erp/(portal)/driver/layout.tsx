'use client';
import type { ReactNode } from 'react';
import { Guard, PortalShell, type NavItem } from '@/components/erp-portal/shell';

const NAV: NavItem[] = [{ href: '/erp/driver', label: 'nav.trips', icon: 'trips', exact: true }];

/** Driver and attendant app. A staff login assigned to a route; the database functions (erp.driver_*) check the assignment on every call. */
export default function DriverLayout({ children }: { children: ReactNode }) {
  return (
    <Guard allow={['staff']}>
      <PortalShell nav={NAV} showChild={false}>{children}</PortalShell>
    </Guard>
  );
}
