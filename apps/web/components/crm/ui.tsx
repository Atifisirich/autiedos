'use client';
import Link from 'next/link';
import { useEffect, useRef, type ReactNode } from 'react';

const TONES: Record<string, string> = {
  slate: 'bg-slate-100 text-slate-800', sky: 'bg-sky-100 text-sky-900', violet: 'bg-violet-100 text-violet-900', amber: 'bg-amber-100 text-amber-900', orange: 'bg-orange-100 text-orange-900',
  teal: 'bg-teal-100 text-teal-900', green: 'bg-green-100 text-green-900', rose: 'bg-rose-100 text-rose-900', red: 'bg-red-100 text-red-800',
};
export const DOTS: Record<string, string> = { slate: 'bg-slate-400', sky: 'bg-sky-500', violet: 'bg-violet-500', amber: 'bg-amber-500', orange: 'bg-orange-500', teal: 'bg-teal-500', green: 'bg-green-600', rose: 'bg-rose-500', red: 'bg-red-500' };

export function Badge({ tone = 'slate', children, title }: { tone?: string; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={`badge ${TONES[tone] ?? TONES.slate}`}>
      {children}
    </span>
  );
}

export function Temp({ t }: { t?: string | null }) {
  if (!t) return null;
  return (
    <Badge tone={t === 'Hot' ? 'red' : t === 'Warm' ? 'amber' : 'slate'}>
      {t === 'Hot' ? '▲ ' : t === 'Warm' ? '● ' : '▽ '}
      {t}
    </Badge>
  );
}

export function PageHeader({ title, sub, children }: { title: string; sub?: ReactNode; children?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold text-slate-900">{title}</h1>
        {sub && <p className="muted mt-0.5">{sub}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

/** Empty states explain what the screen is for and offer the first action (UX 15.2). */
export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="px-6 py-10 text-center">
      <p className="font-medium text-slate-800">{title}</p>
      {children && <div className="muted mx-auto mt-1 max-w-md">{children}</div>}
    </div>
  );
}

export function Loading({ label = 'Loading' }: { label?: string }) {
  return (
    <p role="status" className="muted py-10 text-center">
      {label}…
    </p>
  );
}
export function ErrorBox({ message }: { message: string }) {
  return (
    <p role="alert" className="rounded-md bg-rose-50 px-3 py-2 text-rose-800">
      {message}
    </p>
  );
}

export function Stat({ label, value, sub, href, tone }: { label: string; value: ReactNode; sub?: ReactNode; href?: string; tone?: 'bad' | 'good' }) {
  const body = (
    <div className={`card h-full px-4 py-3 ${href ? 'hover:border-teal-600' : ''}`}>
      <div className="text-xs font-medium text-slate-700">{label}</div>
      <div className={`mt-1 text-2xl font-semibold ${tone === 'bad' ? 'text-rose-700' : tone === 'good' ? 'text-green-800' : 'text-slate-900'}`}>{value}</div>
      {sub && <div className="muted mt-0.5 text-xs">{sub}</div>}
    </div>
  );
  return href ? (
    <Link href={href} className="block">
      {body}
    </Link>
  ) : (
    body
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      {children}
      {hint && <span className="muted mt-1 block text-xs">{hint}</span>}
    </label>
  );
}

export function Avatar({ name }: { name: string }) {
  const i = name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('');
  return (
    <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-teal-100 text-[10px] font-semibold text-teal-900" title={name}>
      {i}
    </span>
  );
}

/** Horizontal bar list. One hue; the label and number carry the meaning, the bar the comparison. */
export function Bars({ rows, max, unit = '' }: { rows: { label: string; value: number; href?: string; note?: string }[]; max?: number; unit?: string }) {
  const m = max ?? Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className="space-y-1.5">
      {rows.map((r) => {
        const inner = (
          <div className="grid grid-cols-[minmax(6rem,10rem)_1fr_auto] items-center gap-2">
            <span className="truncate text-xs text-slate-700" title={r.label}>
              {r.label}
            </span>
            <span className="h-4 rounded-sm bg-slate-100">
              <span className="block h-4 rounded-sm bg-teal-600" style={{ width: `${Math.max(r.value ? 2 : 0, (r.value / m) * 100)}%` }} />
            </span>
            <span className="min-w-12 text-right text-xs font-semibold tabular-nums text-slate-900">
              {r.value}
              {unit}
              {r.note && <span className="muted ml-1 font-normal">{r.note}</span>}
            </span>
          </div>
        );
        return r.href ? (
          <Link key={r.label} href={r.href} className="block rounded hover:bg-slate-50">
            {inner}
          </Link>
        ) : (
          <div key={r.label}>{inner}</div>
        );
      })}
    </div>
  );
}

export function Meter({ value, max, label }: { value: number; max: number; label?: string }) {
  const p = max ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div className="flex items-center gap-2" title={label}>
      <span className="h-2 w-24 rounded-full bg-slate-100">
        <span className={`block h-2 rounded-full ${p >= 100 ? 'bg-rose-500' : 'bg-teal-600'}`} style={{ width: `${p}%` }} />
      </span>
      <span className="text-xs tabular-nums text-slate-700">{p}%</span>
    </div>
  );
}

/** A modal dialog the browser manages (focus trap, Escape, backdrop). */
export function Modal({ open, onClose, title, children, wide = false, side = false }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean; side?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-label={title}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      className={side ? 'm-0 ml-auto h-full max-h-full w-full max-w-md bg-white p-0 shadow-xl' : `m-auto w-[calc(100%-1.5rem)] ${wide ? 'max-w-2xl' : 'max-w-md'} rounded-lg bg-white p-0 shadow-xl`}
    >
      {open && children}
    </dialog>
  );
}

/** Buttons that submit a form with their own name and value need the value after the click: this reads it for a controlled call. */
export const confirmThen = (message: string, fn: () => void) => {
  if (typeof window !== 'undefined' && window.confirm(message)) fn();
};

export function Tabs({ tabs, current, href }: { tabs: [string, string, (string | number)?][]; current: string; href: (key: string) => string }) {
  return (
    <div className="mb-3 flex gap-1 overflow-x-auto border-b border-slate-200" role="tablist">
      {tabs.map(([k, l, n]) => (
        <Link key={k} href={href(k)} role="tab" aria-selected={current === k} className={`tab ${current === k ? 'tab-on' : ''}`}>
          {l}
          {n !== undefined && <span className="muted ml-1">{n}</span>}
        </Link>
      ))}
    </div>
  );
}
