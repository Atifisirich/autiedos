'use client';
import type { ReactNode } from 'react';
import { Guard, PortalShell, type NavItem } from '@/components/erp-portal/shell';

const NAV: NavItem[] = [{ href: '/erp/gate', label: 'nav.pickup', icon: 'gate', exact: true }];

/** The gate's pickup check: the portal-like side of the ERP gate (collector codes). Visitors and the gate register stay in the staff screens. */
export default function GateLayout({ children }: { children: ReactNode }) {
  return (
    <Guard allow={['staff']}>
      <PortalShell nav={NAV} showChild={false}>{children}</PortalShell>
    </Guard>
  );
}
