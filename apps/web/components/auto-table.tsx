'use client';
/** Renders server rows whose columns are known only at runtime; headers come from the col.* catalogue. */
import { useApp } from '@/lib/app';
import { DateText, Table } from './ui';

const ISO = /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2})?)?$/;
const HIDDEN = /(^id$|_id$|_ids$)/;

export function cell(v: unknown) {
  if (v == null || v === '') return '—';
  if (typeof v === 'string' && ISO.test(v)) return <DateText value={v} withTime={v.length > 10} />;
  if (typeof v === 'boolean') return v ? '✓' : '—';
  if (typeof v === 'object') return Array.isArray(v) ? v.join(', ') : JSON.stringify(v);
  return String(v);
}

export function AutoTable({ rows, columns }: { rows: Record<string, unknown>[] | null | undefined; columns?: { key: string }[] }) {
  const { t } = useApp();
  const keys = columns?.map((c) => c.key) ?? Object.keys(rows?.[0] ?? {}).filter((k) => !HIDDEN.test(k));
  // A column the catalogue does not know yet falls back to its key with spaces (never blank).
  const header = (k: string) => { const h = t(`col.${k}`); return h === `col.${k}` ? k.replace(/_/g, ' ') : h; };
  return <Table rows={rows} rowKey={(r) => JSON.stringify(r)} columns={keys.map((k) => ({ key: k, header: header(k), render: (r: Record<string, unknown>) => cell(r[k]) }))} />;
}
