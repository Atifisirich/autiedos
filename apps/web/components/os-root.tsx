'use client';
import type { ReactNode } from 'react';
import { AppProvider } from '@/lib/app';
import { Shell } from './shell';

export function OsRoot({ children }: { children: ReactNode }) {
  return (
    <AppProvider>
      <Shell>{children}</Shell>
    </AppProvider>
  );
}
