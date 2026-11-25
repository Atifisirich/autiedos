'use client';
/** Changes of state waiting for my approval (custom records; core approvals with linked_type 'custom_record'). */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { errorText, useRecords } from '@/components/records/root';
import { recordsApi, type Approval } from '@/lib/records/api';

export default function ApprovalsPage() {
  const { t } = useRecords();
  const [items, setItems] = useState<Approval[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(() => {
    recordsApi<{ approvals: Approval[] }>('GET', '/approvals')
      .then((r) => setItems(r.approvals))
      .catch((e) => setError(errorText(t, e)));
  }, [t]);
  useEffect(load, [load]);

  async function decide(id: string, ok: boolean) {
    setBusy(id);
    try {
      await recordsApi('POST', `/approvals/${id}/decide`, { ok });
      load();
    } catch (e) {
      setError(errorText(t, e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section aria-labelledby="appr-title">
      <h1 id="appr-title" className="mb-3 text-xl font-semibold text-slate-800">
        {t('records.approvals.title')}
      </h1>
      {error && (
        <p role="alert" className="mb-3 rounded-md bg-red-50 p-3 text-sm text-red-700">
          {error}
        </p>
      )}
      {!items && !error && <p role="status" className="text-sm text-slate-500">{t('common.loading')}</p>}
      {items && items.length === 0 && <p className="rounded-md border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-600">{t('records.approvals.none')}</p>}
      <ul className="space-y-2">
        {items?.map((a) => (
          <li key={a.id} className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white p-3">
            <div className="min-w-0 flex-1">
              <Link href={`/records/${a.object_key}/${a.record_id}`} className="font-medium text-brand-700 underline-offset-2 hover:underline">
                {a.title}
              </Link>
              <p className="text-xs text-slate-500">
                {a.requested_by_name ?? ''} · {new Date(a.created_at).toLocaleString()}
              </p>
              {a.summary && <p className="text-sm text-slate-600">{a.summary}</p>}
            </div>
            <button type="button" disabled={busy === a.id} onClick={() => void decide(a.id, true)} className="min-h-[40px] rounded-md bg-green-700 px-4 text-sm font-medium text-white hover:bg-green-800">
              {t('records.approvals.approve')}
            </button>
            <button type="button" disabled={busy === a.id} onClick={() => void decide(a.id, false)} className="min-h-[40px] rounded-md border border-slate-300 bg-white px-4 text-sm text-red-700 hover:bg-slate-50">
              {t('records.approvals.reject')}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
