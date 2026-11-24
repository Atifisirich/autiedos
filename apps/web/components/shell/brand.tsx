'use client';
/**
 * School branding from core.organizations (name, branding jsonb: app_name / primary_color / color, logo file).
 * The logo file is private storage; until a signed URL is wired, the mark is the school's initials in its colour.
 */
import type { PlatformSession } from './session';
import { brandColor } from './session';

export function SchoolBrand({ session, subtitle }: { session: PlatformSession | null; subtitle?: string }) {
  const org = session?.org;
  const name = org?.branding?.app_name || org?.name || '';
  const color = brandColor(org?.branding) ?? '#1d4ed8';
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');
  return (
    <div className="flex min-w-0 items-center gap-3" data-testid="school-brand">
      <span aria-hidden className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-sm font-semibold text-white" style={{ backgroundColor: color }}>
        {initials || '▦'}
      </span>
      <span className="min-w-0">
        <span className="block truncate font-semibold text-slate-800">{name}</span>
        {subtitle && <span className="block truncate text-xs text-slate-500">{subtitle}</span>}
      </span>
    </div>
  );
}
