import type { ReactNode } from 'react';
import { OsRoot } from '@/components/os-root';

// Every OS screen is per-user; never prerender.
export const dynamic = 'force-dynamic';

export default function OsLayout({ children }: { children: ReactNode }) {
  return <OsRoot>{children}</OsRoot>;
}
