import type { ReactNode } from 'react';

// The shell (decision 35): product landing after sign-in, product hand-off and account pages. Per-user; never prerender.
export const dynamic = 'force-dynamic';

export default function ShellLayout({ children }: { children: ReactNode }) {
  return <div className="min-h-screen bg-slate-50">{children}</div>;
}
