'use client';
/** Custom records home: the registers this person may use, and (management) "New register" and archived ones. */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { errorText, useRecords } from '@/components/records/root';
import { recordsApi, type RecordObject } from '@/lib/records/api';

export default function RecordsHome() {
  const { t } = useRecords();
  const [objects, setObjects] = useState<RecordObject[] | null>(null);
  const [manage, setManage] = useState<string[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    Promise.all([recordsApi<{ objects: RecordObject[] }>('GET', `/objects${showArchived ? '?archived=1' : ''}`), recordsApi<{ manage: string[] }>('GET', '/meta')])
      .then(([o, m]) => {
        if (!live) return;
        setObjects(o.objects);
        setManage(m.manage);
      })
      .catch((e) => live && setError(errorText(t, e)));
    return () => {
      live = false;
    };
  }, [showArchived, t]);

  return (
    <section aria-labelledby="records-title">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <h1 id="records-title" className="text-xl font-semibold text-slate-800">
            {t('records.title')}
          </h1>
          <p className="text-sm text-slate-600">{t('records.subtitle')}</p>
        </div>
        {manage.length > 0 && (
          <>
            <label className="flex min-h-[36px] items-center gap-2 text-sm text-slate-600">
              <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
              {t('records.showArchived')}
            </label>
            <Link href="/records/new" data-testid="new-object" className="min-h-[40px] rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700">
              {t('records.object.new')}
            </Link>
          </>
        )}
      </div>
      {error && (
        <p role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-700">
          {error}
        </p>
      )}
      {!objects && !error && (
        <p role="status" className="text-sm text-slate-500">
          {t('common.loading')}
        </p>
      )}
      {objects && objects.length === 0 && <p className="rounded-md border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-600">{manage.length ? t('records.emptyManage') : t('records.empty')}</p>}
      {objects && objects.length > 0 && (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="object-list">
          {objects.map((o) => (
            <li key={o.id}>
              <Link href={`/records/${o.key}`} data-object={o.key} className="flex h-full min-h-[110px] flex-col rounded-xl border border-slate-200 bg-white p-4 shadow-sm hover:border-slate-300 hover:shadow">
                <span className="text-base font-semibold text-slate-800">{o.label_plural}</span>
                {o.description && <span className="mt-1 line-clamp-2 text-sm text-slate-600">{o.description}</span>}
                <span className="mt-auto flex flex-wrap gap-1 pt-3 text-xs text-slate-500">
                  <span className="rounded bg-slate-100 px-1.5 py-0.5">{t(`records.product.${o.product_key}`)}</span>
                  <span className="rounded bg-slate-100 px-1.5 py-0.5">{t('records.fieldCount', { n: o.fields.length })}</span>
                  {o.archived && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-800">{t('records.archived')}</span>}
                  {o.access.view === 'own' && <span className="rounded bg-blue-50 px-1.5 py-0.5 text-blue-700">{t('records.access.ownOnly')}</span>}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
