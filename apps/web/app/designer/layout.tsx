import type { ReactNode } from 'react';

// The designer is per signed-in person (school management, or AutoEd staff in a support session); never prerender.
export const dynamic = 'force-dynamic';

export default function DesignerLayout({ children }: { children: ReactNode }) {
  return <div className="min-h-screen bg-slate-50">{children}</div>;
}
