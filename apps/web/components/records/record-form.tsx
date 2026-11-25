'use client';
/**
 * Form for one record: an input per field type (link fields search the school's staff, learners, classes, branches).
 * Values are sent as they are; the database validates them (types, required, choices, unique, same-school links)
 * and its messages are shown above the buttons.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { useRecords } from './root';
import { recordsApi, type RecordField, type RecordObject } from '@/lib/records/api';

const input = 'min-h-[40px] w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-200';

function LinkPicker({ field, value, label, onChange }: { field: RecordField; value: string | null; label?: string; onChange: (id: string | null, label?: string) => void }) {
  const { t } = useRecords();
  const [q, setQ] = useState('');
  const [options, setOptions] = useState<{ id: string; label: string }[]>([]);
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState(label ?? '');
  const listId = useId();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => setCurrent(label ?? ''), [label]);
  useEffect(() => {
    if (!open) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      recordsApi<{ options: { id: string; label: string }[] }>('GET', `/lookup/${field.type}?q=${encodeURIComponent(q)}`)
        .then((r) => setOptions(r.options))
        .catch(() => setOptions([]));
    }, 200);
  }, [q, open, field.type]);
  return (
    <div className="relative">
      {value && !open ? (
        <div className="flex items-center gap-2">
          <span className="min-h-[40px] flex-1 rounded-md border border-slate-200 bg-slate-50 px-2 py-2 text-sm" data-testid={`link-${field.key}`}>
            {current || value}
          </span>
          <button type="button" className="min-h-[36px] rounded-md border border-slate-300 px-2 text-sm" onClick={() => setOpen(true)}>
            {t('records.change')}
          </button>
          {!field.required && (
            <button type="button" className="min-h-[36px] rounded-md border border-slate-300 px-2 text-sm" onClick={() => onChange(null)} aria-label={t('records.clear')}>
              ×
            </button>
          )}
        </div>
      ) : (
        <>
          <input
            role="combobox"
            aria-expanded={open}
            aria-controls={listId}
            aria-autocomplete="list"
            name={`f-${field.key}`}
            placeholder={t('records.search')}
            value={q}
            onFocus={() => setOpen(true)}
            onChange={(e) => {
              setQ(e.target.value);
              setOpen(true);
            }}
            className={input}
          />
          {open && (
            <ul id={listId} role="listbox" className="absolute z-30 mt-1 max-h-60 w-full overflow-auto rounded-md border border-slate-200 bg-white shadow-lg">
              {options.length === 0 && <li className="px-2 py-2 text-sm text-slate-500">{t('records.noMatches')}</li>}
              {options.map((o) => (
                <li key={o.id} role="option" aria-selected={o.id === value}>
                  <button
                    type="button"
                    className="block min-h-[40px] w-full px-2 py-2 text-left text-sm hover:bg-slate-50"
                    onClick={() => {
                      onChange(o.id, o.label);
                      setCurrent(o.label);
                      setOpen(false);
                      setQ('');
                    }}
                  >
                    {o.label}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

export function FieldInput({ field, value, label, onChange }: { field: RecordField; value: unknown; label?: string; onChange: (v: unknown, label?: string) => void }) {
  const { t } = useRecords();
  const name = `f-${field.key}`;
  const s = typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
  switch (field.type) {
    case 'long_text':
      return <textarea id={name} name={name} rows={3} value={s} onChange={(e) => onChange(e.target.value)} className={input} />;
    case 'number':
    case 'money':
      return <input id={name} name={name} type="number" step={field.type === 'money' ? '0.01' : 'any'} value={s} onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)} className={input} />;
    case 'date':
      return <input id={name} name={name} type="date" value={s.slice(0, 10)} onChange={(e) => onChange(e.target.value || null)} className={input} />;
    case 'datetime':
      return <input id={name} name={name} type="datetime-local" value={s ? s.slice(0, 16) : ''} onChange={(e) => onChange(e.target.value ? new Date(e.target.value).toISOString() : null)} className={input} />;
    case 'yes_no':
      return (
        <select id={name} name={name} value={value === true ? 'true' : value === false ? 'false' : ''} onChange={(e) => onChange(e.target.value === '' ? null : e.target.value === 'true')} className={input}>
          <option value="">{t('common.choose')}</option>
          <option value="true">{t('common.yes')}</option>
          <option value="false">{t('common.no')}</option>
        </select>
      );
    case 'choice':
      return (
        <select id={name} name={name} value={s} onChange={(e) => onChange(e.target.value || null)} className={input}>
          <option value="">{t('common.choose')}</option>
          {(field.options ?? []).map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      );
    case 'multi_choice': {
      const arr = Array.isArray(value) ? (value as string[]) : [];
      return (
        <div className="flex flex-wrap gap-x-4 gap-y-1" role="group" aria-labelledby={`${name}-label`}>
          {(field.options ?? []).map((o) => (
            <label key={o} className="flex min-h-[32px] items-center gap-1.5 text-sm">
              <input type="checkbox" name={name} value={o} checked={arr.includes(o)} onChange={(e) => onChange(e.target.checked ? [...arr, o] : arr.filter((x) => x !== o))} />
              {o}
            </label>
          ))}
        </div>
      );
    }
    case 'person':
    case 'learner':
    case 'section':
    case 'branch':
    case 'file':
      return <LinkPicker field={field} value={s || null} label={label} onChange={(id, l) => onChange(id, l)} />;
    default:
      return <input id={name} name={name} type={field.type === 'email' ? 'email' : field.type === 'url' ? 'url' : field.type === 'phone' ? 'tel' : 'text'} value={s} onChange={(e) => onChange(e.target.value)} className={input} />;
  }
}

/** Orders fields by the object's form layout (sections), else in definition order. */
export function formSections(o: RecordObject): { title?: string; fields: RecordField[] }[] {
  if (o.form_layout?.length) {
    const used = new Set<string>();
    const out = o.form_layout.map((s) => ({ title: s.title, fields: s.fields.map((k) => o.fields.find((f) => f.key === k)).filter((f): f is RecordField => !!f && !used.has(f.key) && !!used.add(f.key)) }));
    const rest = o.fields.filter((f) => !used.has(f.key));
    if (rest.length) out.push({ title: undefined, fields: rest });
    return out;
  }
  return [{ fields: o.fields }];
}

export function RecordForm({ object, initial, labels, onSubmit, submitLabel, busy }: {
  object: RecordObject;
  initial?: Record<string, unknown>;
  labels?: Record<string, string>;
  onSubmit: (data: Record<string, unknown>) => void;
  submitLabel: string;
  busy?: boolean;
}) {
  const { t } = useRecords();
  const [data, setData] = useState<Record<string, unknown>>(initial ?? {});
  const [names, setNames] = useState<Record<string, string>>(labels ?? {});
  return (
    <form
      className="space-y-4"
      data-testid="record-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(data);
      }}
    >
      {formSections(object).map((sec, i) => (
        <fieldset key={i} className="min-w-0 space-y-3 rounded-xl border border-slate-200 bg-white p-4">
          {sec.title && <legend className="px-1 text-sm font-semibold text-slate-700">{sec.title}</legend>}
          {sec.fields.map((f) => (
            <div key={f.key}>
              <label id={`f-${f.key}-label`} htmlFor={`f-${f.key}`} className="mb-1 block text-sm font-medium text-slate-700">
                {f.label}
                {f.required && (
                  <span className="text-red-600" aria-label={t('records.builder.required')}>
                    {' '}
                    *
                  </span>
                )}
              </label>
              <FieldInput
                field={f}
                value={data[f.key]}
                label={typeof data[f.key] === 'string' ? names[data[f.key] as string] : undefined}
                onChange={(v, l) => {
                  setData((d) => ({ ...d, [f.key]: v }));
                  if (l && typeof v === 'string') setNames((n) => ({ ...n, [v]: l }));
                }}
              />
              {f.help && <p className="mt-1 text-xs text-slate-500">{f.help}</p>}
            </div>
          ))}
        </fieldset>
      ))}
      <button type="submit" disabled={busy} data-testid="save-record" className="min-h-[40px] rounded-md bg-brand-600 px-5 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60">
        {busy ? t('records.saving') : submitLabel}
      </button>
    </form>
  );
}

/** Display text of a value (links through the label map, yes/no, lists). */
export function displayValue(f: RecordField | undefined, v: unknown, labels: Record<string, string>, t: (k: string) => string): string {
  if (v === null || v === undefined || v === '') return '';
  if (Array.isArray(v)) return v.join(', ');
  if (typeof v === 'boolean') return v ? t('common.yes') : t('common.no');
  if (f && ['person', 'learner', 'section', 'branch', 'file'].includes(f.type) && typeof v === 'string') return labels[v] ?? '—';
  if (f?.type === 'datetime' && typeof v === 'string') return new Date(v).toLocaleString();
  return String(v);
}
