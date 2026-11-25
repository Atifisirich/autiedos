'use client';
import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { ObjectBuilder } from '@/components/records/object-builder';
import { errorText, useRecords } from '@/components/records/root';
import { recordsApi, type RecordObject } from '@/lib/records/api';

export default function EditObjectPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = use(params);
  const { t } = useRecords();
  const [object, setObject] = useState<RecordObject | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    recordsApi<{ object: RecordObject }>('GET', `/objects/${key}`)
      .then((r) => setObject(r.object))
      .catch((e) => setError(errorText(t, e)));
  }, [key, t]);

  async function archive(v: boolean) {
    setBusy(true);
    try {
      const r = await recordsApi<{ object: RecordObject }>('PATCH', `/objects/${key}`, { archived: v });
      setObject(r.object);
    } catch (e) {
      setError(errorText(t, e));
    } finally {
      setBusy(false);
    }
  }

  if (error) return <p role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</p>;
  if (!object) return <p role="status" className="text-sm text-slate-500">{t('common.loading')}</p>;
  return (
    <section>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <Link href={`/records/${key}`} className="text-sm text-brand-700 underline">
            {t('common.back')}
          </Link>
          <h1 className="text-xl font-semibold text-slate-800">{t('records.object.editTitle', { name: object.label_plural })}</h1>
          <p className="text-xs text-slate-500">{t('records.object.version', { n: object.version })}</p>
        </div>
        <button type="button" disabled={busy} onClick={() => void archive(!object.archived)} className="min-h-[36px] rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-700 hover:bg-slate-50">
          {object.archived ? t('records.object.unarchive') : t('records.object.archive')}
        </button>
      </div>
      <ObjectBuilder key={object.version} existing={object} />
    </section>
  );
}
