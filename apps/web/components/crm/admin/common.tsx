'use client';
import { useState, type ReactNode } from 'react';
import { act, formObj, useCrm } from '@/lib/crm/api';
import { ErrorBox, Loading } from '../ui';

export type Row = Record<string, any>;

/** Loads one admin section; renders a spinner or the refusal until it arrives. */
export function useAdmin<T = any>(path: string, query?: Record<string, string | undefined>) {
  const r = useCrm<T>(path, query);
  const gate = r.error ? <ErrorBox message={r.error.status === 403 ? 'Your role cannot open this part of the admin console.' : r.error.message} /> : !r.data ? <Loading /> : null;
  return { ...r, gate };
}

/**
 * A form that sends its fields to an admin action and shows the server's answer as a toast. `map` reshapes the fields
 * (for example turns repeated names into arrays); `keep` shows the message until it is dismissed (secrets shown once).
 */
export function AForm({ path, children, className = '', map, onDone, reset = false, keep = false, confirm }: { path: string; children: ReactNode; className?: string; map?: (f: Row) => Row; onDone?: (r: any) => void; reset?: boolean; keep?: boolean; confirm?: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <form
      className={className}
      onSubmit={async (e) => {
        e.preventDefault();
        const form = e.currentTarget;
        const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
        if (confirm && !window.confirm(confirm)) return;
        const f = formObj(form);
        if (submitter?.name) f[submitter.name] = submitter.value;
        setBusy(true);
        const r = await act(path, map ? map(f) : f, { keep });
        setBusy(false);
        if (r) {
          if (reset) form.reset();
          onDone?.(r);
        }
      }}
      aria-busy={busy}
    >
      {children}
    </form>
  );
}

export const asArray = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : v ? [String(v)] : []);

/** Multi-select values come out of FormData as one entry per option; this reads them as an array whatever their number. */
export function multi(form: Row, name: string) {
  return asArray(form[name]);
}

export function CardSection({ title, children, actions, className = '' }: { title: ReactNode; children: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`} aria-label={typeof title === 'string' ? title : undefined}>
      <div className="card-h">
        <h2>{title}</h2>
        {actions}
      </div>
      <div className="min-w-0 overflow-x-auto">{children}</div>
    </section>
  );
}
