'use client';
/**
 * Small UI kit of the portals: large touch targets (48 px), 16 px inputs (no zoom on phones), visible focus, colours from the
 * school's brand through CSS variables set by the portal session (--pt-primary, --pt-accent, --pt-on-primary).
 * Components take text that is already translated; no literal strings live here.
 */
import Link from 'next/link';
import { useId, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { usePortal } from '@/lib/erp-portal/session';

export const cx = (...xs: (string | false | null | undefined)[]) => xs.filter(Boolean).join(' ');

const FOCUS = 'focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-[var(--pt-primary)]';

export function Btn({ variant = 'primary', className, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'danger' | 'ghost' }) {
  return (
    <button
      type="button"
      {...p}
      className={cx(
        'inline-flex min-h-12 items-center justify-center gap-2 rounded-xl px-5 text-base font-semibold transition active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50', FOCUS,
        variant === 'primary' && 'bg-[var(--pt-primary)] text-[var(--pt-on-primary)]',
        variant === 'secondary' && 'border-2 border-slate-300 bg-white text-slate-900',
        variant === 'danger' && 'bg-red-700 text-white',
        variant === 'ghost' && 'text-slate-800 hover:bg-slate-100',
        className,
      )}
    />
  );
}

export function LinkBtn({ href, children, variant = 'primary', className }: { href: string; children: ReactNode; variant?: 'primary' | 'secondary'; className?: string }) {
  return (
    <Link href={href} className={cx('inline-flex min-h-12 items-center justify-center rounded-xl px-5 text-base font-semibold', FOCUS, variant === 'primary' ? 'bg-[var(--pt-primary)] text-[var(--pt-on-primary)]' : 'border-2 border-slate-300 bg-white text-slate-900', className)}>
      {children}
    </Link>
  );
}

export function Card({ title, actions, children, className, flush }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; flush?: boolean }) {
  const id = useId();
  return (
    <section aria-labelledby={title ? id : undefined} className={cx('rounded-2xl border border-slate-200 bg-white shadow-sm', className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
          <h2 id={id} className="text-base font-semibold text-slate-900">{title}</h2>
          {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
        </header>
      )}
      <div className={flush ? '' : 'p-4'}>{children}</div>
    </section>
  );
}

export type Tone = 'good' | 'bad' | 'warn' | 'info' | 'none';
const TONE: Record<Tone, string> = {
  good: 'bg-emerald-50 text-emerald-900 ring-emerald-200', bad: 'bg-red-50 text-red-900 ring-red-200', warn: 'bg-amber-50 text-amber-900 ring-amber-200',
  info: 'bg-sky-50 text-sky-900 ring-sky-200', none: 'bg-slate-100 text-slate-800 ring-slate-200',
};
export function Badge({ tone = 'none', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={cx('inline-flex items-center rounded-full px-2.5 py-0.5 text-sm font-medium ring-1 ring-inset', TONE[tone])}>{children}</span>;
}

export function Stat({ label, value, hint, tone = 'none', href }: { label: string; value: ReactNode; hint?: ReactNode; tone?: Tone; href?: string }) {
  const body = (
    <div className={cx('h-full rounded-2xl border bg-white p-4 shadow-sm', tone === 'bad' ? 'border-red-300' : tone === 'good' ? 'border-emerald-300' : 'border-slate-200')}>
      <div className="text-sm text-slate-700">{label}</div>
      <div className="mt-1 text-xl font-bold text-slate-900">{value}</div>
      {hint && <div className="mt-0.5 text-sm text-slate-700">{hint}</div>}
    </div>
  );
  return href ? <Link href={href} className={cx('block rounded-2xl', FOCUS)}>{body}</Link> : body;
}

export function Empty({ title, hint }: { title: ReactNode; hint?: ReactNode }) {
  return (
    <div className="px-4 py-8 text-center">
      <p className="font-medium text-slate-900">{title}</p>
      {hint && <p className="mt-1 text-sm text-slate-700">{hint}</p>}
    </div>
  );
}

export function Notice({ tone = 'info', children }: { tone?: Tone; children: ReactNode }) {
  return (
    <div role={tone === 'bad' ? 'alert' : 'status'} className={cx('rounded-xl px-4 py-3 text-base ring-1 ring-inset', TONE[tone])}>
      {children}
    </div>
  );
}

export function Spinner({ label }: { label: string }) {
  return (
    <div role="status" className="flex items-center gap-3 p-6 text-slate-800">
      <span aria-hidden className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-slate-300 border-t-[var(--pt-primary)]" />
      <span>{label}</span>
    </div>
  );
}

/** A screen that failed to load: the message, and a retry unless a saved copy is on screen. */
export function LoadError({ retry }: { retry: () => void }) {
  const { L } = usePortal();
  return (
    <Card>
      <Notice tone="bad">{L('c.error')}</Notice>
      <div className="mt-3"><Btn variant="secondary" onClick={retry}>{L('c.retry')}</Btn></div>
    </Card>
  );
}

export function PageHead({ title, sub, right }: { title: ReactNode; sub?: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-2">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">{title}</h1>
        {sub && <p className="text-base text-slate-700">{sub}</p>}
      </div>
      {right}
    </div>
  );
}

// ---------------------------------------------------------------- form controls
const INPUT = cx('block min-h-12 w-full rounded-xl border-2 border-slate-300 bg-white px-3 text-base text-slate-900 placeholder:text-slate-500', FOCUS);

export function Field({ label, hint, error, children, htmlFor }: { label: ReactNode; hint?: ReactNode; error?: ReactNode; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="block">
      <label htmlFor={htmlFor} className="mb-1 block text-base font-medium text-slate-900">{label}</label>
      {children}
      {hint && <p className="mt-1 text-sm text-slate-700">{hint}</p>}
      {error && <p role="alert" className="mt-1 text-sm font-medium text-red-800">{error}</p>}
    </div>
  );
}
export function Input({ label, hint, error, id, className, ...p }: InputHTMLAttributes<HTMLInputElement> & { label: ReactNode; hint?: ReactNode; error?: ReactNode }) {
  const auto = useId();
  const i = id ?? auto;
  return <Field label={label} hint={hint} error={error} htmlFor={i}><input id={i} aria-invalid={error ? true : undefined} {...p} className={cx(INPUT, className)} /></Field>;
}
export function Select({ label, hint, error, id, className, children, ...p }: SelectHTMLAttributes<HTMLSelectElement> & { label: ReactNode; hint?: ReactNode; error?: ReactNode }) {
  const auto = useId();
  const i = id ?? auto;
  return <Field label={label} hint={hint} error={error} htmlFor={i}><select id={i} aria-invalid={error ? true : undefined} {...p} className={cx(INPUT, className)}>{children}</select></Field>;
}
export function Textarea({ label, hint, error, id, className, ...p }: TextareaHTMLAttributes<HTMLTextAreaElement> & { label: ReactNode; hint?: ReactNode; error?: ReactNode }) {
  const auto = useId();
  const i = id ?? auto;
  return <Field label={label} hint={hint} error={error} htmlFor={i}><textarea id={i} rows={4} aria-invalid={error ? true : undefined} {...p} className={cx(INPUT, 'py-2', className)} /></Field>;
}

/** A list row that is a link or a plain block with consistent spacing. */
export function Row({ children, href, className }: { children: ReactNode; href?: string; className?: string }) {
  const base = cx('flex min-h-12 items-center justify-between gap-3 px-4 py-3', className);
  return href ? <Link href={href} className={cx(base, FOCUS, 'hover:bg-slate-50')}>{children}</Link> : <div className={base}>{children}</div>;
}

export function Checkbox({ label, checked, onChange, id, disabled }: { label: ReactNode; checked: boolean; onChange: (v: boolean) => void; id?: string; disabled?: boolean }) {
  const auto = useId();
  const i = id ?? auto;
  return (
    <label htmlFor={i} className="flex min-h-12 cursor-pointer items-center gap-3 text-base text-slate-900">
      <input id={i} type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className={cx('h-6 w-6 shrink-0 rounded border-2 border-slate-400 accent-[var(--pt-primary)]', FOCUS)} />
      <span>{label}</span>
    </label>
  );
}
