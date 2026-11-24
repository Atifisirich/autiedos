'use client';
import { use, useMemo, useState } from 'react';
import Link from 'next/link';
import { friendlyError, loadForms, readFormFields, submitForm, validateAnswers, type FormField } from '@autoed/shared/erp-portal';
import { usePortal } from '@/lib/erp-portal/session';
import { useLoad } from '@/lib/erp-portal/use-load';
import { Btn, Card, Empty, Field, Input, Notice, PageHead, Select, Textarea } from '@/components/erp-portal/ui';
import { WithData } from '@/components/erp-portal/screen';

export default function FormPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { sb, userId, org, child, L } = usePortal();
  const q = useLoad('forms', () => loadForms(sb!, userId!), []);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, 'required' | 'number' | 'option'>>({});
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const form = q.data?.forms.find((f) => f.id === id);
  const fields = useMemo(() => readFormFields(form?.fields), [form]);
  const set = (k: string, v: string) => setAnswers((a) => ({ ...a, [k]: v }));

  async function submit() {
    const errs = validateAnswers(fields, answers);
    setErrors(errs);
    if (Object.keys(errs).length || !org) return;
    setBusy(true); setError(null);
    try { await submitForm(sb!, org.id, id, child?.id ?? null, answers); setDone(true); await q.reload(); }
    catch (e) { setError(friendlyError(e, L('c.error'))); }
    finally { setBusy(false); }
  }
  const err = (f: FormField) => (errors[f.key] ? L(`forms.err.${errors[f.key]}`) : undefined);

  return (
    <>
      <p className="mb-2"><Link href="/erp/parent/forms" className="text-base text-[var(--pt-primary)] underline">‹ {L('nav.forms')}</Link></p>
      <WithData q={q}>
        {(d) => !form ? <Card><Empty title={L('forms.none')} /></Card> : (
          <div className="space-y-4">
            <PageHead title={form.title} sub={form.description} />
            {done || d.done.has(id) ? <Notice tone="good">{L('forms.thanks')}</Notice> : fields.length === 0 ? <Card><Empty title={L('forms.emptyForm')} /></Card> : (
              <Card>
                <form className="space-y-4" noValidate onSubmit={(e) => { e.preventDefault(); void submit(); }}>
                  {fields.map((f) => {
                    const label = <>{f.label}{f.required ? <span className="text-red-800"> *</span> : <span className="text-sm text-slate-700"> ({L('c.optional')})</span>}</>;
                    if (f.type === 'textarea') return <Textarea key={f.key} label={label} value={answers[f.key] ?? ''} onChange={(e) => set(f.key, e.target.value)} error={err(f)} />;
                    if (f.type === 'select') return <Select key={f.key} label={label} value={answers[f.key] ?? ''} onChange={(e) => set(f.key, e.target.value)} error={err(f)}><option value="">{L('forms.choose')}</option>{f.options.map((o) => <option key={o} value={o}>{o}</option>)}</Select>;
                    if (f.type === 'yesno') return <Select key={f.key} label={label} value={answers[f.key] ?? ''} onChange={(e) => set(f.key, e.target.value)} error={err(f)}><option value="">{L('forms.choose')}</option><option value="Yes">{L('c.yes')}</option><option value="No">{L('c.no')}</option></Select>;
                    if (f.type === 'rating') return (
                      <Field key={f.key} label={label} error={err(f)}>
                        <div role="radiogroup" aria-label={f.label} className="flex gap-2">
                          {[1, 2, 3, 4, 5].map((n) => <button key={n} type="button" role="radio" aria-checked={answers[f.key] === String(n)} onClick={() => set(f.key, String(n))} className={`min-h-12 min-w-12 rounded-xl border-2 text-lg font-semibold ${answers[f.key] === String(n) ? 'border-[var(--pt-primary)] bg-[var(--pt-primary)] text-[var(--pt-on-primary)]' : 'border-slate-300 bg-white text-slate-900'}`}>{n}</button>)}
                        </div>
                      </Field>
                    );
                    return <Input key={f.key} label={label} type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'} inputMode={f.type === 'number' ? 'decimal' : undefined} value={answers[f.key] ?? ''} onChange={(e) => set(f.key, e.target.value)} error={err(f)} />;
                  })}
                  {error && <Notice tone="bad">{error}</Notice>}
                  <Btn type="submit" disabled={busy}>{busy ? L('c.sending') : L('forms.submit')}</Btn>
                </form>
              </Card>
            )}
          </div>
        )}
      </WithData>
    </>
  );
}
