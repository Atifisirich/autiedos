'use client';
import type { ReactNode } from 'react';
import { Guard, PortalShell, type NavItem } from '@/components/erp-portal/shell';

const NAV: NavItem[] = [
  { href: '/erp/student', label: 'nav.home', icon: 'home', exact: true },
  { href: '/erp/student/homework', label: 'nav.homework', icon: 'homework' },
  { href: '/erp/student/results', label: 'nav.results', icon: 'results' },
  { href: '/erp/student/tests', label: 'nav.tests', icon: 'tests' },
];

/** The student portal: a student login is linked to its own row only, so every query below returns the student's data and nobody else's. */
export default function StudentLayout({ children }: { children: ReactNode }) {
  return (
    <Guard allow={['student']}>
      <PortalShell nav={NAV} showChild={false}>{children}</PortalShell>
    </Guard>
  );
}
