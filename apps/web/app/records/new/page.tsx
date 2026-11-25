'use client';
import { ObjectBuilder } from '@/components/records/object-builder';
import { useRecords } from '@/components/records/root';

export default function NewObjectPage() {
  const { t } = useRecords();
  return (
    <section>
      <h1 className="mb-1 text-xl font-semibold text-slate-800">{t('records.object.new')}</h1>
      <p className="mb-4 text-sm text-slate-600">{t('records.builder.intro')}</p>
      <ObjectBuilder />
    </section>
  );
}
