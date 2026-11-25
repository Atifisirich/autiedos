import type { ReactNode } from 'react';
import { RecordsRoot } from '@/components/records/root';

export const dynamic = 'force-dynamic';

export default function RecordsLayout({ children }: { children: ReactNode }) {
  return <RecordsRoot>{children}</RecordsRoot>;
}
