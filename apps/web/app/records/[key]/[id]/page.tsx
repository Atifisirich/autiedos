'use client';
/** One record: its values, workflow buttons, edit form, delete and the history of every change. */
import { use, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { displayValue, formSections, RecordForm } from '@/components/records/record-form';
import { errorText, useRecords } from '@/components/records/root';
import { recordsApi, type HistoryItem, type RecordItem, type RecordObject } from '@/lib/records/api';

interface Detail { object: RecordObject; record: RecordItem; labels: Record<string, string>; history: HistoryItem[]; transitions: { to: string; label: string; approval: boolean }[] }

const btn = 'min-h-[40px] rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 hover:bg-slate-50';

export default function RecordDetailPage({ params }: { params: Promise<{ key: string; id: string }> }) {
  const { key, id } = use(params);
  const { t } = useRecords();
  const router = useRouter();
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(() => {
    recordsApi<Detail>('GET', `/objects/${key}/records/${id}`)
      .then((r) => setD(r))
      .catch((e) => setError(errorText(t, e)));
  }, [key, id, t]);
  useEffect(load, [load]);

  async function run(fn: () => Promise<unknown>, done?: string) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await fn();
      if (done) setMessage(done);
      load();
      return true;
    } catch (e) {
      setError(errorText(t, e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  if (!d) return error ? <p role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</p> : <p role="status" className="text-sm text-slate-500">{t('common.loading')}</p>;
  const { object: o, record: r } = d;
  const stateLabel = (s: string | null) => o.states?.list.find((x) => x.key === s)?.label ?? s ?? '';
  const title = displayValue(o.fields.find((f) => f.key === o.title_field), r.data[o.title_field ?? ''], d.labels, t) || t('records.untitled');
  const fieldLabel = (k: string) => o.fields.find((f) => f.key === k)?.label ?? k;
  const kindText = (h: HistoryItem) => {
    if (h.kind === 'state' || h.kind === 'approval_requested' || h.kind === 'approved' || h.kind === 'rejected') return t(`records.event.${h.kind}`, { from: stateLabel(h.from_state), to: stateLabel(h.to_state) });
    return t(`records.event.${h.kind}`, { from: '', to: '' });
  };

  return (
    <section aria-labelledby="rec-title" className="grid gap-4 lg:grid-cols-[1fr_20rem]">
      <div className="min-w-0">
        <Link href={`/records/${key}`} className="text-sm text-brand-700 underline">
          {o.label_plural}
        </Link>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <h1 id="rec-title" className="min-w-0 flex-1 truncate text-xl font-semibold text-slate-800" data-testid="record-title">
            {title}
          </h1>
          {o.states && (
            <span className="rounded-full bg-slate-100 px-2.5 py-1 text-sm text-slate-700" data-testid="record-state">
              {stateLabel(r.state)}
            </span>
          )}
          {r.pending_state && <span className="rounded-full bg-amber-100 px-2.5 py-1 text-sm text-amber-800">{t('records.waitingApproval', { state: stateLabel(r.pending_state) })}</span>}
          {r.deleted_at && <span className="rounded-full bg-red-100 px-2.5 py-1 text-sm text-red-700">{t('records.deleted')}</span>}
        </div>
        {error && (
          <p role="alert" className="mb-3 rounded-md bg-red-50 p-3 text-sm text-red-700">
            {error}
          </p>
        )}
        {message && (
          <p role="status" className="mb-3 rounded-md bg-green-50 p-3 text-sm text-green-800">
            {message}
          </p>
        )}

        {editing ? (
          <RecordForm
            object={o}
            initial={r.data}
            labels={d.labels}
            busy={busy}
            submitLabel={t('common.save')}
            onSubmit={(data) => {
              // fields emptied in the form are cleared
              const patch: Record<string, unknown> = { ...data };
              for (const f of o.fields) if (!(f.key in patch)) patch[f.key] = null;
              void run(() => recordsApi('PATCH', `/objects/${key}/records/${id}`, { data: patch }), t('records.saved')).then((ok) => ok && setEditing(false));
            }}
          />
        ) : (
          <div className="space-y-3">
            {formSections(o).map((sec, i) => (
              <div key={i} className="rounded-xl border border-slate-200 bg-white p-4">
                {sec.title && <h2 className="mb-2 text-sm font-semibold text-slate-700">{sec.title}</h2>}
                <dl className="grid gap-x-4 gap-y-2 sm:grid-cols-[12rem_1fr]">
                  {sec.fields.map((f) => (
                    <div key={f.key} className="contents">
                      <dt className="text-sm text-slate-500">{f.label}</dt>
                      <dd className="break-words text-sm text-slate-800" data-field={f.key}>
                        {displayValue(f, r.data[f.key], d.labels, t) || '—'}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            ))}
          </div>
        )}

        <div className="mt-4 flex flex-wrap gap-2">
          {r.can_edit && !r.deleted_at && (
            <button type="button" className={btn} onClick={() => setEditing((e) => !e)} data-testid="edit-record">
              {editing ? t('common.cancel') : t('common.edit')}
            </button>
          )}
          {r.can_delete && !r.deleted_at && (
            <button
              type="button"
              className={`${btn} text-red-700`}
              disabled={busy}
              onClick={() => {
                if (window.confirm(t('records.confirmDelete'))) void run(() => recordsApi('DELETE', `/objects/${key}/records/${id}`)).then((ok) => ok && router.push(`/records/${key}`));
              }}
            >
              {t('common.delete')}
            </button>
          )}
          {r.deleted_at && o.access.delete && (
            <button type="button" className={btn} disabled={busy} onClick={() => void run(() => recordsApi('POST', `/objects/${key}/records/${id}/restore`), t('records.restored'))}>
              {t('records.restore')}
            </button>
          )}
        </div>

        {d.transitions.length > 0 && (
          <div className="mt-4 rounded-xl border border-slate-200 bg-white p-4" data-testid="transitions">
            <h2 className="mb-2 text-sm font-semibold text-slate-700">{t('records.nextStep')}</h2>
            <label className="mb-2 block text-sm text-slate-700">
              {t('records.note')}
              <input value={note} onChange={(e) => setNote(e.target.value)} className="min-h-[40px] w-full rounded-md border border-slate-300 px-2 text-sm" />
            </label>
            <div className="flex flex-wrap gap-2">
              {d.transitions.map((x) => (
                <button
                  key={x.to}
                  type="button"
                  disabled={busy}
                  className="min-h-[40px] rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
                  onClick={() =>
                    void run(async () => {
                      const res = await recordsApi<{ result: string }>('POST', `/objects/${key}/records/${id}/transition`, { to: x.to, note: note || null });
                      setNote('');
                      return res;
                    }, x.approval ? t('records.sentForApproval') : t('records.saved'))
                  }
                >
                  {x.label}
                  {x.approval ? ` (${t('records.needsApproval')})` : ''}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <aside aria-labelledby="hist-title" className="rounded-xl border border-slate-200 bg-white p-4">
        <h2 id="hist-title" className="mb-2 text-sm font-semibold text-slate-700">
          {t('records.history')}
        </h2>
        <ol className="space-y-3" data-testid="history">
          {d.history.map((h) => (
            <li key={h.id} className="border-l-2 border-slate-200 pl-3 text-sm">
              <p className="font-medium text-slate-800">{kindText(h)}</p>
              <p className="text-xs text-slate-500">
                {new Date(h.created_at).toLocaleString()}
                {h.actor ? ` · ${h.actor}` : ''}
              </p>
              {h.kind === 'updated' && h.changes && (
                <ul className="mt-1 text-xs text-slate-600">
                  {Object.keys(h.changes).map((k) => (
                    <li key={k}>{t('records.changedField', { field: fieldLabel(k) })}</li>
                  ))}
                </ul>
              )}
              {h.note && <p className="mt-1 text-xs italic text-slate-600">{h.note}</p>}
            </li>
          ))}
        </ol>
      </aside>
    </section>
  );
}
