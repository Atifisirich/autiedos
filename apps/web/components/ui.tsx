'use client';
/**
 * Small UI kit. Components take already-translated text; no literal strings live here.
 */
import { useEffect, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import Link from 'next/link';
import { useApp, useErrorText } from '@/lib/app';

export function cx(...xs: (string | false | null | undefined)[]) {
  return xs.filter(Boolean).join(' ');
}

export function Button({ variant = 'primary', size = 'md', className, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'danger' | 'ghost'; size?: 'sm' | 'md' }) {
  return (
    <button
      {...p}
      className={cx(
        'inline-flex items-center justify-center gap-1 rounded-md font-medium transition disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600',
        size === 'sm' ? 'min-h-[32px] px-2.5 text-sm' : 'min-h-[40px] px-4 text-sm',
        variant === 'primary' && 'bg-brand-600 text-white hover:bg-brand-700',
        variant === 'secondary' && 'border border-slate-300 bg-white text-slate-800 hover:bg-slate-50',
        variant === 'danger' && 'bg-red-600 text-white hover:bg-red-700',
        variant === 'ghost' && 'text-slate-700 hover:bg-slate-100',
        className,
      )}
    />
  );
}

export function LinkButton({ href, children, variant = 'primary' }: { href: string; children: ReactNode; variant?: 'primary' | 'secondary' }) {
  return (
    <Link href={href} className={cx('inline-flex min-h-[40px] items-center rounded-md px-4 text-sm font-medium', variant === 'primary' ? 'bg-brand-600 text-white hover:bg-brand-700' : 'border border-slate-300 bg-white text-slate-800 hover:bg-slate-50')}>
      {children}
    </Link>
  );
}

export function Card({ title, actions, children, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx('rounded-lg border border-slate-200 bg-white shadow-sm', className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
          <h2 className="text-sm font-semibold text-slate-800">{title}</h2>
          <div className="flex flex-wrap gap-2">{actions}</div>
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-slate-500">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

const TONES: Record<string, string> = {
  gray: 'bg-slate-100 text-slate-700',
  blue: 'bg-blue-100 text-blue-800',
  green: 'bg-green-100 text-green-800',
  amber: 'bg-amber-100 text-amber-800',
  red: 'bg-red-100 text-red-800',
  purple: 'bg-purple-100 text-purple-800',
};
export function Badge({ tone = 'gray', children }: { tone?: keyof typeof TONES; children: ReactNode }) {
  return <span className={cx('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium', TONES[tone])}>{children}</span>;
}

const STATUS_TONE: Record<string, keyof typeof TONES> = {
  todo: 'gray', requested: 'purple', in_progress: 'blue', blocked: 'red', done: 'amber', verified: 'green', reopened: 'amber', not_done: 'red', cancelled: 'gray', declined: 'gray',
  pending: 'amber', approved: 'green', rejected: 'red', returned: 'amber', draft: 'gray', submitted: 'blue', in_review: 'blue', delivered: 'green', reflected: 'green',
  open: 'amber', assigned: 'blue', waiting: 'purple', resolved: 'green', closed: 'gray', completed: 'green', missed: 'red', valid: 'green', expiring: 'amber', overdue: 'red', missing: 'red',
  on_track: 'green', at_risk: 'amber', critical: 'red', suggested: 'amber', uncovered: 'red', resolved_other: 'blue', present: 'green', late: 'amber', absent: 'red', half_day: 'amber', on_leave: 'blue',
  generated: 'blue', published: 'green', generating: 'amber', failed: 'red', scheduled: 'blue', shared: 'green', acknowledged: 'green', hod_review: 'blue', coordinator_review: 'blue', sent: 'green', held: 'green', planning: 'blue', follow_up: 'amber',
};
export function StatusBadge({ status }: { status: string | null | undefined }) {
  const { t } = useApp();
  if (!status) return null;
  return <Badge tone={STATUS_TONE[status] ?? 'gray'}>{t(`status.${status}`)}</Badge>;
}

export function Field({ label, hint, children, error }: { label: ReactNode; hint?: ReactNode; children: ReactNode; error?: ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block font-medium text-slate-700">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-slate-500">{hint}</span>}
      {error && <span className="mt-1 block text-xs text-red-600">{error}</span>}
    </label>
  );
}

const inputCls = 'block w-full min-h-[40px] rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500';
export const Input = (p: InputHTMLAttributes<HTMLInputElement>) => <input {...p} className={cx(inputCls, p.className)} />;
export const Textarea = (p: TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea rows={3} {...p} className={cx(inputCls, p.className)} />;
export function Select({ options, placeholder, ...p }: SelectHTMLAttributes<HTMLSelectElement> & { options: { value: string; label: string }[]; placeholder?: string }) {
  return (
    <select {...p} className={cx(inputCls, p.className)}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Checkbox({ label, ...p }: InputHTMLAttributes<HTMLInputElement> & { label: ReactNode }) {
  return (
    <label className="inline-flex min-h-[32px] items-center gap-2 text-sm text-slate-700">
      <input type="checkbox" {...p} className="h-4 w-4 rounded border-slate-300 text-brand-600" />
      {label}
    </label>
  );
}

export interface Column<T> {
  key: string;
  header: ReactNode;
  render?: (row: T) => ReactNode;
  className?: string;
}

export function Table<T extends Record<string, any>>({ columns, rows, onRow, empty, rowKey }: { columns: Column<T>[]; rows: T[] | null | undefined; onRow?: (r: T) => void; empty?: ReactNode; rowKey?: (r: T, i: number) => string }) {
  const { t } = useApp();
  if (!rows) return <Loading />;
  if (!rows.length) return <Empty>{empty ?? t('common.nothingHere')}</Empty>;
  return (
    <div className="-mx-4 overflow-x-auto">
      <table className="min-w-full divide-y divide-slate-200 text-sm">
        <thead className="bg-slate-50">
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col" className={cx('whitespace-nowrap px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500', c.className)}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((r, i) => (
            <tr key={rowKey ? rowKey(r, i) : (r.id as string) ?? i} onClick={onRow ? () => onRow(r) : undefined} className={cx(onRow && 'cursor-pointer hover:bg-slate-50')}>
              {columns.map((c) => (
                <td key={c.key} className={cx('px-4 py-2 align-top text-slate-700', c.className)}>
                  {c.render ? c.render(r) : fmt(r[c.key])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function fmt(v: unknown): ReactNode {
  if (v == null || v === '') return '—';
  if (typeof v === 'boolean') return v ? '✓' : '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-md border border-dashed border-slate-200 p-6 text-center text-sm text-slate-500">{children}</div>;
}

export function Loading() {
  const { t } = useApp();
  return (
    <div role="status" className="p-6 text-center text-sm text-slate-500">
      {t('common.loading')}
    </div>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  const text = useErrorText();
  if (!error) return null;
  return (
    <div role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
      {text(error)}
    </div>
  );
}

export function Stat({ label, value, href, tone }: { label: ReactNode; value: ReactNode; href?: string; tone?: 'red' | 'amber' | 'green' }) {
  const body = (
    <div className={cx('rounded-lg border bg-white p-4 shadow-sm', href && 'hover:border-brand-500', tone === 'red' ? 'border-red-200' : tone === 'amber' ? 'border-amber-200' : 'border-slate-200')}>
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className={cx('mt-1 text-2xl font-semibold', tone === 'red' ? 'text-red-700' : tone === 'amber' ? 'text-amber-700' : 'text-slate-900')}>{value}</div>
    </div>
  );
  return href ? <Link href={href}>{body}</Link> : body;
}

export function Tabs({ tabs, value, onChange }: { tabs: { value: string; label: ReactNode }[]; value: string; onChange: (v: string) => void }) {
  return (
    <div role="tablist" className="mb-4 flex flex-wrap gap-1 border-b border-slate-200">
      {tabs.map((t) => (
        <button key={t.value} role="tab" aria-selected={value === t.value} onClick={() => onChange(t.value)} className={cx('-mb-px min-h-[40px] border-b-2 px-3 text-sm font-medium', value === t.value ? 'border-brand-600 text-brand-700' : 'border-transparent text-slate-600 hover:text-slate-900')}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function Modal({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; wide?: boolean }) {
  const { t } = useApp();
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    if (open) window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4" role="dialog" aria-modal="true">
      <div className={cx('mt-10 w-full rounded-lg bg-white shadow-xl', wide ? 'max-w-4xl' : 'max-w-lg')}>
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h2 className="font-semibold">{title}</h2>
          <button onClick={onClose} aria-label={t('common.close')} className="min-h-[32px] min-w-[32px] rounded text-slate-500 hover:bg-slate-100">
            ×
          </button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}

/** Runs an async action with busy state and error capture. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const run = async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(e);
      return undefined;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run, setError };
}

export function DateText({ value, withTime }: { value: string | null | undefined; withTime?: boolean }) {
  const { lang } = useApp();
  if (!value) return <>—</>;
  const d = new Date(value.length === 10 ? `${value}T00:00:00` : value);
  const locale = lang === 'hi' ? 'hi-IN' : lang === 'te' ? 'te-IN' : 'en-IN';
  return <>{withTime ? d.toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' }) : d.toLocaleDateString(locale, { dateStyle: 'medium' })}</>;
}

export function Grid({ children, cols = 3 }: { children: ReactNode; cols?: 2 | 3 | 4 }) {
  return <div className={cx('grid gap-3', cols === 2 ? 'sm:grid-cols-2' : cols === 3 ? 'sm:grid-cols-2 lg:grid-cols-3' : 'sm:grid-cols-2 lg:grid-cols-4')}>{children}</div>;
}
