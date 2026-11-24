import type { Metadata, Viewport } from 'next';
import './globals.css';

// One web app for CRM, ERP and OS (decision 35): the product landing is app/(shell), each product mounts the
// switcher from components/shell (docs/shell.md).
export const metadata: Metadata = { title: 'AutoEd', description: 'CRM, ERP and OS for schools, coaching centres and colleges' };
export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#1d4ed8' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link href="https://fonts.googleapis.com/css2?family=Noto+Sans:wght@400;500;600&family=Noto+Sans+Devanagari:wght@400;500;600&family=Noto+Sans+Telugu:wght@400;500;600&display=swap" rel="stylesheet" />
      </head>
      <body>{children}</body>
    </html>
  );
}
