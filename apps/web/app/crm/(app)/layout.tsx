import type { ReactNode } from 'react';
import { CrmRoot } from '@/components/crm/shell';

export default function CrmAppLayout({ children }: { children: ReactNode }) {
  return <CrmRoot>{children}</CrmRoot>;
}
