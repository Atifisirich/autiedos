import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './crm.css';

// Every CRM screen is per-user (or per-link); never prerender.
export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'AutoED CRM', description: 'Admissions CRM for schools' };

/** Plain wrapper: styles for the CRM. The signed-in frame (menu, search, pickers) is in (app)/layout.tsx; public pages (form, apply, pay, login) have none. */
export default function CrmLayout({ children }: { children: ReactNode }) {
  return <div className="crm">{children}</div>;
}
