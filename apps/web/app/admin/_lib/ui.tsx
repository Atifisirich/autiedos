'use client';
/**
 * Small accessible UI kit of the admin console. Components take already-translated text (no literal strings here).
 * Touch targets are at least 40px, focus rings are visible, status is never colour only (the text is always shown).
 */
import { useId, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { useAdmin } from './admin';

export const cx = (...xs: (string | false | null | undefined)[]) => xs.filter(Boolean).join(' ');

const focus = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-700';

export function Button({ variant = 'primary', size = 'md', className, type = 'button', ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'danger' | 'ghost'; size?: 'sm' | 'md' }) {
  return (
    <button
      type={type}
      {...p}
      className={cx(
        'inline-flex items-center justify-center gap-1 rounded-md font-medium transition disabled:cursor-not-allowed disabled:opacity-50',
        focus,
        size === 'sm' ? 'min-h-[36px] px-3 text-sm' : 'min-h-[44px] px-4 text-sm',
        variant === 'primary' && 'bg-brand-700 text-white hover:bg-brand-900',
        variant === 'secondary' && 'border border-slate-400 bg-white text-slate-900 hover:bg-slate-50',
        variant === 'danger' && 'bg-red-700 text-white hover:bg-red-800',
        variant === 'ghost' && 'text-slate-800 hover:bg-slate-100',
        className,
      )}
    />
  );
}

export function Card({ title, actions, children, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx('rounded-lg border border-slate-200 bg-white shadow-sm', className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
          <h2 className="text-base font-semibold text-slate-900">{title}</h2>
          <div className="flex flex-wrap gap-2">{actions}</div>
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function PageTitle({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-slate-600">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

const TONES = {
  gray: 'bg-slate-100 text-slate-800',
  blue: 'bg-blue-100 text-blue-900',
  green: 'bg-green-100 text-green-900',
  amber: 'bg-amber-100 text-amber-900',
  red: 'bg-red-100 text-red-900',
} as const;
export type Tone = keyof typeof TONES;
export const Badge = ({ tone = 'gray', children }: { tone?: Tone; children: ReactNode }) => (
  <span className={cx('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium', TONES[tone])}>{children}</span>
);

const SUB_TONE: Record<string, Tone> = { trial: 'blue', active: 'green', past_due: 'amber', suspended: 'red', cancelled: 'gray' };
export function SubStatus({ status }: { status: string }) {
  const { t } = useAdmin();
  return <Badge tone={SUB_TONE[status] ?? 'gray'}>{t(`console.sub.status.${status}`)}</Badge>;
}

const HEALTH_TONE: Record<string, Tone> = { ok: 'green', attention: 'amber', critical: 'red' };
export function Health({ level, reasons }: { level: string; reasons?: string[] }) {
  const { t } = useAdmin();
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <Badge tone={HEALTH_TONE[level] ?? 'gray'}>{t(`console.health.${level}`)}</Badge>
      {reasons?.map((r) => (
        <span key={r} className="text-xs text-slate-600">
          {t(`console.health.reason.${r}`)}
        </span>
      ))}
    </span>
  );
}

export function Field({ label, hint, error, children, className }: { label: ReactNode; hint?: ReactNode; error?: ReactNode; children: (id: string) => ReactNode; className?: string }) {
  const id = useId();
  return (
    <div className={cx('text-sm', className)}>
      <label htmlFor={id} className="mb-1 block font-medium text-slate-800">
        {label}
      </label>
      {children(id)}
      {hint && <p className="mt-1 text-xs text-slate-600">{hint}</p>}
      {error && (
        <p role="alert" className="mt-1 text-xs text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}

const inputCls = cx('block w-full min-h-[44px] rounded-md border border-slate-400 bg-white px-3 py-2 text-sm', focus);
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
    <label className="inline-flex min-h-[44px] items-center gap-2 text-sm text-slate-800">
      <input type="checkbox" {...p} className={cx('h-5 w-5 rounded border-slate-400 text-brand-700', focus)} />
      {label}
    </label>
  );
}

/** Polite live region for results, assertive for errors. Renders nothing when empty. */
export function Notice({ error, ok }: { error?: string | null; ok?: string | null }) {
  return (
    <>
      <div aria-live="polite">{ok && <p className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-900">{ok}</p>}</div>
      <div role="alert">{error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-900">{error}</p>}</div>
    </>
  );
}

export interface Column<T> {
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  className?: string;
}

/** Table inside a horizontally scrollable region so phones never get a page-wide scroll. */
export function DataTable<T>({ caption, columns, rows, rowKey, empty }: { caption: string; columns: Column<T>[]; rows: T[] | null | undefined; rowKey: (r: T) => string; empty?: ReactNode }) {
  const { t } = useAdmin();
  if (!rows) return <p className="text-sm text-slate-600">{t('console.loading')}</p>;
  if (!rows.length) return <p className="text-sm text-slate-600">{empty ?? t('console.empty')}</p>;
  return (
    <div className="-mx-4 overflow-x-auto" role="region" aria-label={caption} tabIndex={0}>
      <table className="min-w-full divide-y divide-slate-200 text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className="bg-slate-50">
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col" className={cx('whitespace-nowrap px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-700', c.className)}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((r) => (
            <tr key={rowKey(r)}>
              {columns.map((c) => (
                <td key={c.key} className={cx('px-4 py-2 align-top text-slate-900', c.className)}>
                  {c.render(r)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * A button that opens an inline panel asking for a reason (stored in the audit log), then confirms.
 * Inline instead of a modal: no focus trap to get wrong, works with screen readers and on phones.
 */
export function ReasonAction({ label, confirmLabel, onConfirm, variant = 'secondary', minLength = 5, disabled }: { label: string; confirmLabel: string; onConfirm: (reason: string) => Promise<void>; variant?: 'primary' | 'secondary' | 'danger'; minLength?: number; disabled?: boolean }) {
  const { t, errorText } = useAdmin();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function go() {
    setBusy(true);
    setError(null);
    try {
      await onConfirm(reason.trim());
      setOpen(false);
      setReason('');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  if (!open)
    return (
      <Button variant={variant} size="sm" disabled={disabled} onClick={() => setOpen(true)}>
        {label}
      </Button>
    );
  return (
    <form
      className="w-full max-w-md space-y-2 rounded-md border border-slate-300 bg-slate-50 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        void go();
      }}
    >
      <Field label={t('console.reason')} hint={t('console.reason.hint')}>
        {(id) => <Textarea id={id} required minLength={minLength} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />}
      </Field>
      <Notice error={error} />
      <div className="flex gap-2">
        <Button type="submit" variant={variant === 'secondary' ? 'primary' : variant} size="sm" disabled={busy || reason.trim().length < minLength}>
          {confirmLabel}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
          {t('console.cancel')}
        </Button>
      </div>
    </form>
  );
}

export function Tabs({ tabs, active, onChange, label }: { tabs: { key: string; label: string }[]; active: string; onChange: (k: string) => void; label: string }) {
  const onKey = (e: React.KeyboardEvent, i: number) => {
    const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const next = tabs[(i + d + tabs.length) % tabs.length]!;
    onChange(next.key);
    document.getElementById(`tab-${next.key}`)?.focus();
  };
  return (
    <div role="tablist" aria-label={label} className="mb-4 flex gap-1 overflow-x-auto border-b border-slate-300">
      {tabs.map((tb, i) => (
        <button
          key={tb.key}
          id={`tab-${tb.key}`}
          role="tab"
          type="button"
          aria-selected={active === tb.key}
          aria-controls={`panel-${tb.key}`}
          tabIndex={active === tb.key ? 0 : -1}
          onClick={() => onChange(tb.key)}
          onKeyDown={(e) => onKey(e, i)}
          className={cx('min-h-[44px] whitespace-nowrap border-b-2 px-4 text-sm font-medium', focus, active === tb.key ? 'border-brand-700 text-brand-900' : 'border-transparent text-slate-700 hover:text-slate-900')}
        >
          {tb.label}
        </button>
      ))}
    </div>
  );
}
