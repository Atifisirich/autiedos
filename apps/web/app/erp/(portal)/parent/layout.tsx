'use client';
import type { ReactNode } from 'react';
import { Guard, PortalShell, type NavItem } from '@/components/erp-portal/shell';

const NAV: NavItem[] = [
  { href: '/erp/parent', label: 'nav.home', icon: 'home', exact: true },
  { href: '/erp/parent/fees', label: 'nav.fees', icon: 'fees' },
  { href: '/erp/parent/academics', label: 'nav.academics', icon: 'academics' },
  { href: '/erp/parent/messages', label: 'nav.messages', icon: 'messages' },
  { href: '/erp/parent/more', label: 'nav.more', icon: 'more' },
];

export default function ParentLayout({ children }: { children: ReactNode }) {
  return (
    <Guard allow={['parent']}>
      <PortalShell nav={NAV}>{children}</PortalShell>
    </Guard>
  );
}
