'use client';
/** Generic list of one register: search, filters, sortable columns, paging, CSV export, add. */
import { use, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { displayValue } from '@/components/records/record-form';
import { errorText, useRecords } from '@/components/records/root';
import { qs, recordsApi, type RecordItem, type RecordObject } from '@/lib/records/api';

interface ListResult { object: RecordObject; rows: RecordItem[]; total: number; page: number; pageSize: number; labels: Record<string, string> }

const ctl = 'min-h-[40px] rounded-md border border-slate-300 bg-white px-2 text-sm';

export default function RecordListPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = use(params);
  const { t } = useRecords();
  const [res, setRes] = useState<ListResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [state, setState] = useState('');
  const [mine, setMine] = useState(false);
  const [sort, setSort] = useState<{ col: string; dir: 'asc' | 'desc' }>({ col: 'created_at', dir: 'desc' });
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [page, setPage] = useState(1);

  const query = useMemo(
    () => ({ q, state, mine: mine ? 1 : undefined, sort: sort.col, dir: sort.dir, page, pageSize: 25, ...Object.fromEntries(Object.entries(filters).map(([k, v]) => [`f.${k}`, v])) }),
    [q, state, mine, sort, page, filters],
  );
  const load = useCallback(() => {
    recordsApi<ListResult>('GET', `/objects/${key}/records${qs(query)}`)
      .then((r) => {
        setRes(r);
        setError(null);
      })
      .catch((e) => setError(errorText(t, e)));
  }, [key, query, t]);
  useEffect(() => {
    const h = setTimeout(load, q ? 250 : 0);
    return () => clearTimeout(h);
  }, [load, q]);

  const o = res?.object;
  const columns = useMemo(() => {
    if (!o) return [];
    const cols = o.list_columns.length ? o.list_columns : [...o.fields.slice(0, 4).map((f) => f.key), ...(o.states ? ['state'] : [])];
    return cols.filter((c) => c === 'state' || o.fields.some((f) => f.key === c));
  }, [o]);
  const filterable = o?.fields.filter((f) => f.type === 'choice' || f.type === 'yes_no') ?? [];
  const stateLabel = (s: string | null) => o?.states?.list.find((x) => x.key === s)?.label ?? s ?? '';
  const pages = res ? Math.max(1, Math.ceil(res.total / res.pageSize)) : 1;
  const exportHref = `/api/records/objects/${key}/export.csv${qs({ ...query, page: undefined, pageSize: undefined })}`;

  if (error && !res) return <p role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</p>;
  if (!o || !res) return <p role="status" className="text-sm text-slate-500">{t('common.loading')}</p>;

  const header = (c: string) => {
    const label = c === 'state' ? t('records.state') : c === 'created_at' ? t('common.created') : o.fields.find((f) => f.key === c)?.label ?? c;
    const active = sort.col === c;
    return (
      <th key={c} scope="col" aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'} className="whitespace-nowrap px-3 py-2 text-left font-medium">
        <button type="button" className="inline-flex min-h-[32px] items-center gap-1 hover:text-slate-900" onClick={() => setSort({ col: c, dir: active && sort.dir === 'asc' ? 'desc' : 'asc' })}>
          {label}
          <span aria-hidden className="text-xs text-slate-400">
            {active ? (sort.dir === 'asc' ? '▲' : '▼') : '↕'}
          </span>
        </button>
      </th>
    );
  };

  return (
    <section aria-labelledby="list-title">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <Link href="/records" className="text-sm text-brand-700 underline">
            {t('records.title')}
          </Link>
          <h1 id="list-title" className="text-xl font-semibold text-slate-800">
            {o.label_plural}
          </h1>
          {o.description && <p className="text-sm text-slate-600">{o.description}</p>}
        </div>
        {o.access.manage && (
          <Link href={`/records/${key}/edit`} data-testid="edit-object" className="min-h-[40px] rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 hover:bg-slate-50">
            {t('records.object.edit')}
          </Link>
        )}
        {o.access.export && (
          <a href={exportHref} download data-testid="export-csv" className="min-h-[40px] rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 hover:bg-slate-50">
            {t('records.exportCsv')}
          </a>
        )}
        {o.access.create && !o.archived && (
          <Link href={`/records/${key}/new`} data-testid="add-record" className="min-h-[40px] rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700">
            {t('records.add', { name: o.label_singular })}
          </Link>
        )}
      </div>

      <div className="mb-3 flex flex-wrap items-end gap-2" role="search">
        <label className="min-w-[12rem] flex-1 text-sm text-slate-700">
          <span className="sr-only">{t('records.search')}</span>
          <input type="search" placeholder={t('records.search')} value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} className={`${ctl} w-full`} />
        </label>
        {o.states && (
          <select aria-label={t('records.state')} value={state} onChange={(e) => { setState(e.target.value); setPage(1); }} className={ctl}>
            <option value="">{t('records.allStates')}</option>
            {o.states.list.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
        )}
        {filterable.map((f) => (
          <select key={f.key} aria-label={f.label} value={filters[f.key] ?? ''} onChange={(e) => { setFilters((x) => ({ ...x, [f.key]: e.target.value })); setPage(1); }} className={ctl}>
            <option value="">{t('records.filterAll', { name: f.label })}</option>
            {(f.type === 'yes_no' ? ['true', 'false'] : f.options ?? []).map((v) => (
              <option key={v} value={v}>
                {f.type === 'yes_no' ? (v === 'true' ? t('common.yes') : t('common.no')) : v}
              </option>
            ))}
          </select>
        ))}
        {o.access.view === 'all' && (
          <label className="flex min-h-[40px] items-center gap-1.5 text-sm text-slate-700">
            <input type="checkbox" checked={mine} onChange={(e) => { setMine(e.target.checked); setPage(1); }} />
            {t('records.mineOnly')}
          </label>
        )}
      </div>
      {error && (
        <p role="alert" className="mb-2 rounded-md bg-red-50 p-2 text-sm text-red-700">
          {error}
        </p>
      )}

      <p className="mb-2 text-sm text-slate-600" aria-live="polite" data-testid="record-total">
        {t('records.total', { n: res.total })}
      </p>
      {res.rows.length === 0 ? (
        <p className="rounded-md border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-600">{t('common.nothingHere')}</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="min-w-full divide-y divide-slate-200 text-sm" data-testid="record-table">
            <thead className="bg-slate-50 text-slate-600">
              <tr>
                {columns.map(header)}
                {header('created_at')}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {res.rows.map((r) => (
                <tr key={r.id} className="hover:bg-slate-50">
                  {columns.map((c, i) => {
                    const text = c === 'state' ? stateLabel(r.state) + (r.pending_state ? ` → ${stateLabel(r.pending_state)}?` : '') : displayValue(o.fields.find((f) => f.key === c), r.data[c], res.labels, t);
                    return (
                      <td key={c} className="max-w-[16rem] truncate px-3 py-2">
                        {i === 0 ? (
                          <Link href={`/records/${key}/${r.id}`} className="font-medium text-brand-700 underline-offset-2 hover:underline">
                            {text || t('records.untitled')}
                          </Link>
                        ) : (
                          text
                        )}
                      </td>
                    );
                  })}
                  <td className="whitespace-nowrap px-3 py-2 text-slate-500">{new Date(r.created_at).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {pages > 1 && (
        <nav aria-label={t('records.paging')} className="mt-3 flex items-center gap-2 text-sm">
          <button type="button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className={`${ctl} px-3`}>
            {t('common.back')}
          </button>
          <span>{t('records.pageOf', { page, pages })}</span>
          <button type="button" disabled={page >= pages} onClick={() => setPage((p) => p + 1)} className={`${ctl} px-3`}>
            {t('common.next')}
          </button>
        </nav>
      )}
    </section>
  );
}
