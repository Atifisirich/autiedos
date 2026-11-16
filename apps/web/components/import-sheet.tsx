'use client';
/** Excel/CSV import with template download, dry run showing row-level errors, then all-or-nothing import. */
import { useState } from 'react';
import { useApp } from '@/lib/app';
import { download, fileToBase64, post } from '@/lib/api';
import { Button, ErrorBox, Table, useAction } from './ui';

interface Result { ok: boolean; created: number; updated: number; errors: { row: number; column?: string; error: string; value?: string }[] }

export function ImportSheet({ kind, onDone }: { kind: string; onDone?: () => void }) {
  const { t } = useApp();
  const a = useAction();
  const [rows, setRows] = useState<Record<string, unknown>[] | null>(null);
  const [res, setRes] = useState<Result | null>(null);
  const [done, setDone] = useState<Result | null>(null);
  return (
    <div className="space-y-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="secondary" onClick={() => download(`/setup/templates/${kind}`)}>{t('setup.downloadTemplate')}</Button>
        <input type="file" accept=".xlsx,.csv" aria-label={t('setup.chooseFile')} onChange={async (e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          setRes(null);
          setDone(null);
          const parsed = await a.run(async () => post<{ rows: Record<string, unknown>[] }>('/setup/parse', { base64: await fileToBase64(f), file_name: f.name }));
          if (!parsed) return;
          setRows(parsed.rows);
          setRes((await a.run(() => post<Result>('/setup/import', { kind, rows: parsed.rows, dry_run: true }))) ?? null);
        }} />
      </div>
      {rows && <p>{t('setup.rowsRead', { n: rows.length })}</p>}
      {res && (res.errors.length ? (
        <>
          <p className="text-red-700">{t('setup.fixErrors', { n: res.errors.length })}</p>
          <Table rows={res.errors} rowKey={(r) => `${r.row}:${r.column}:${r.error}`} columns={[{ key: 'row', header: t('setup.row') }, { key: 'column', header: t('reports.column') }, { key: 'error', header: t('setup.problem'), render: (r) => t(`importError.${r.error}`) }, { key: 'value', header: t('reports.value') }]} />
        </>
      ) : (
        <div className="flex items-center gap-2">
          <p className="text-green-700">{t('setup.dryRunOk', { created: res.created, updated: res.updated })}</p>
          <Button size="sm" disabled={a.busy} onClick={async () => { const r = await a.run(() => post<Result>('/setup/import', { kind, rows, dry_run: false })); if (r) (setDone(r), setRes(null), onDone?.()); }}>{t('setup.importNow')}</Button>
        </div>
      ))}
      {done && <p className="text-green-700">{t('setup.imported', { created: done.created, updated: done.updated })}</p>}
      <ErrorBox error={a.error} />
    </div>
  );
}
