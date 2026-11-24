import type { ReactNode } from 'react';
import { OsRoot } from '@/components/os-root';
import { ProductGate } from '@/components/shell';

// Every OS screen is per-user; never prerender.
export const dynamic = 'force-dynamic';

export default function OsLayout({ children }: { children: ReactNode }) {
  // The shell's gate first (docs/shell.md): a person without the OS sees "not part of your plan" instead of the OS
  // asking /me for a staff profile they may not have (ERP- or CRM-only staff).
  return (
    <ProductGate product="os">
      <OsRoot>{children}</OsRoot>
    </ProductGate>
  );
}
