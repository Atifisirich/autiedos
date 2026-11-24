/**
 * Web app manifest of the parent / student / driver portal: installable from the browser menu ("Add to Home screen").
 * The colours are the AutoEd defaults; the school's own colours and name are applied inside the app after sign-in
 * (a manifest is read before anyone is signed in, so it cannot know the school).
 */
export const dynamic = 'force-static';

export function GET() {
  const manifest = {
    name: 'AutoEd Parent and Student',
    short_name: 'AutoEd',
    description: 'Fees, attendance, report cards, homework, bus and messages for your school.',
    id: '/erp/parent',
    start_url: '/erp/parent?source=pwa',
    scope: '/erp/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#f8fafc',
    theme_color: '#1d4ed8',
    lang: 'en',
    categories: ['education'],
    icons: [
      { src: '/erp-portal/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/erp-portal/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/erp-portal/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    shortcuts: [
      { name: 'Fees', url: '/erp/parent/fees' },
      { name: 'School bus', url: '/erp/parent/bus' },
      { name: 'Messages', url: '/erp/parent/messages' },
    ],
  };
  return new Response(JSON.stringify(manifest), { headers: { 'content-type': 'application/manifest+json; charset=utf-8', 'cache-control': 'public, max-age=3600' } });
}
