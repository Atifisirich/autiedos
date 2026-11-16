'use client';
/** Generic editor for structured plan/paper content: strings, numbers, lists and nested objects. */
import { useApp } from '@/lib/app';
import { Button, Checkbox, Input, Textarea } from './ui';

type V = unknown;

export function ValueView({ value }: { value: V }) {
  const { t } = useApp();
  if (value == null || value === '') return <span className="text-slate-400">—</span>;
  if (typeof value === 'string' || typeof value === 'number') return <p className="whitespace-pre-wrap">{String(value)}</p>;
  if (typeof value === 'boolean') return <span>{value ? t('common.yes') : t('common.no')}</span>;
  if (Array.isArray(value)) {
    if (value.every((x) => typeof x !== 'object')) return <ul className="list-disc pl-5">{value.map((x, i) => <li key={i}>{String(x)}</li>)}</ul>;
    return <ol className="space-y-2">{value.map((x, i) => <li key={i} className="rounded border border-slate-100 p-2"><ValueView value={x} /></li>)}</ol>;
  }
  return (
    <dl className="space-y-1">
      {Object.entries(value as Record<string, V>).map(([k, v]) => (
        <div key={k}>
          <dt className="text-xs font-medium text-slate-500">{t(`planField.${k}`)}</dt>
          <dd><ValueView value={v} /></dd>
        </div>
      ))}
    </dl>
  );
}

export function ValueEditor({ value, onChange }: { value: V; onChange: (v: V) => void }) {
  const { t } = useApp();
  if (typeof value === 'number') return <Input type="number" value={value} onChange={(e) => onChange(Number(e.target.value))} />;
  if (typeof value === 'boolean') return <Checkbox label={t('common.yes')} checked={value} onChange={(e) => onChange(e.target.checked)} />;
  if (typeof value === 'string' || value == null) return <Textarea value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} />;
  if (Array.isArray(value)) {
    if (value.length === 0 || value.every((x) => typeof x !== 'object')) {
      return <Textarea rows={Math.max(3, value.length + 1)} value={(value as string[]).join('\n')} onChange={(e) => onChange(e.target.value.split('\n').filter((x, i, all) => x.trim() || i === all.length - 1))} aria-label={t('plans.onePerLine')} />;
    }
    const blank = Object.fromEntries(Object.entries(value[0] as Record<string, V>).map(([k, v]) => [k, typeof v === 'number' ? 0 : typeof v === 'boolean' ? false : Array.isArray(v) ? [] : '']));
    return (
      <div className="space-y-2">
        {value.map((x, i) => (
          <div key={i} className="rounded border border-slate-200 p-2">
            <ValueEditor value={x} onChange={(nv) => onChange(value.map((y, j) => (j === i ? nv : y)))} />
            <Button size="sm" variant="ghost" onClick={() => onChange(value.filter((_, j) => j !== i))}>{t('common.remove')}</Button>
          </div>
        ))}
        <Button size="sm" variant="secondary" onClick={() => onChange([...value, blank])}>{t('common.add')}</Button>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {Object.entries(value as Record<string, V>).map(([k, v]) => (
        <label key={k} className="block">
          <span className="text-xs font-medium text-slate-500">{t(`planField.${k}`)}</span>
          <ValueEditor value={v} onChange={(nv) => onChange({ ...(value as Record<string, V>), [k]: nv })} />
        </label>
      ))}
    </div>
  );
}
