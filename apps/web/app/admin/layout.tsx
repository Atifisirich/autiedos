import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { AdminRoot } from './_lib/shell';

// Every console screen is per signed-in admin; never prerender or index.
export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'AutoEd Admin', robots: { index: false, follow: false } };

export default function AdminLayout({ children }: { children: ReactNode }) {
  return <AdminRoot>{children}</AdminRoot>;
}
