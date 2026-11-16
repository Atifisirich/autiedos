'use client';
import Link from 'next/link';
import { useApp } from '@/lib/app';
import { useApi } from '@/lib/api';
import { Card, PageHeader } from '@/components/ui';

export default function ConfigIndex() {
  const { t } = useApp();
  const e = useApi<Record<string, { module: string }>>('/config-entities');
  const groups = Object.entries(e.data ?? {}).reduce<Record<string, string[]>>((g, [k, v]) => ((g[v.module] = [...(g[v.module] ?? []), k]), g), {});
  return (
    <div>
      <PageHeader title={t('setup.configuration')} subtitle={t('setup.configHint')} />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Object.entries(groups).map(([mod, keys]) => (
          <Card key={mod} title={t(`module.${mod}`)}>
            <ul className="space-y-1 text-sm">{keys.map((k) => <li key={k}><Link className="text-brand-700 hover:underline" href={`/os/setup/config/${k}`}>{t(`config.${k}`)}</Link></li>)}</ul>
          </Card>
        ))}
      </div>
    </div>
  );
}
