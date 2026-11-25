'use client';
import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { RecordForm } from '@/components/records/record-form';
import { errorText, useRecords } from '@/components/records/root';
import { recordsApi, type RecordItem, type RecordObject } from '@/lib/records/api';

export default function NewRecordPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = use(params);
  const { t } = useRecords();
  const router = useRouter();
  const [object, setObject] = useState<RecordObject | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    recordsApi<{ object: RecordObject }>('GET', `/objects/${key}`)
      .then((r) => setObject(r.object))
      .catch((e) => setError(errorText(t, e)));
  }, [key, t]);

  async function save(data: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const r = await recordsApi<{ record: RecordItem }>('POST', `/objects/${key}/records`, { data });
      router.push(`/records/${key}/${r.record.id}`);
    } catch (e) {
      setError(errorText(t, e));
      setBusy(false);
    }
  }

  if (!object) return error ? <p role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</p> : <p role="status" className="text-sm text-slate-500">{t('common.loading')}</p>;
  return (
    <section className="max-w-2xl">
      <Link href={`/records/${key}`} className="text-sm text-brand-700 underline">
        {object.label_plural}
      </Link>
      <h1 className="mb-3 text-xl font-semibold text-slate-800">{t('records.add', { name: object.label_singular })}</h1>
      {error && (
        <p role="alert" className="mb-3 rounded-md bg-red-50 p-3 text-sm text-red-700" data-testid="form-error">
          {error}
        </p>
      )}
      <RecordForm object={object} onSubmit={(d) => void save(d)} submitLabel={t('common.save')} busy={busy} />
    </section>
  );
}
