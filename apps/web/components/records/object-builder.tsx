'use client';
/**
 * Object builder (management): a simple form to define a register — name, fields and their types, who may do what,
 * an optional workflow with approvals, family visibility and a reminder. The shared schema gives early messages;
 * the database applies the same rules on save (docs/custom-records.md).
 */
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { RECORD_FIELD_TYPES, recordIssues, recordKeyFromLabel, recordObjectSchema, type RecordFieldType } from '@autoed/shared';
import { errorText, useRecords } from './root';
import { recordsApi, type RecordField, type RecordObject, type RecordObjectInput, type RecordPermission, type RecordStates } from '@/lib/records/api';

interface Role { product: string; key: string; name: string }
type FieldDraft = RecordField & { _id: number; _new: boolean; _optionsText: string };
type StateDraft = { key: string; label: string; final?: boolean; _new: boolean };
type TransitionDraft = { from: string; to: string; label?: string; approval?: boolean; approver_roles?: string[] };

const input = 'min-h-[40px] w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-200';
const small = 'min-h-[36px] max-w-full rounded-md border border-slate-300 bg-white px-2 text-sm';
const btn = 'min-h-[36px] rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-700 hover:bg-slate-50';
let seq = 0;

function uniqueKey(base: string, taken: string[]): string {
  let k = base || 'field';
  let n = 2;
  while (taken.includes(k)) k = `${base.slice(0, 36)}_${n++}`;
  return k;
}

function Section({ title, hint, children, id }: { title: string; hint?: string; children: React.ReactNode; id: string }) {
  return (
    <fieldset className="min-w-0 rounded-xl border border-slate-200 bg-white p-4" aria-labelledby={id}>
      <legend id={id} className="px-1 text-base font-semibold text-slate-800">
        {title}
      </legend>
      {hint && <p className="mb-3 text-sm text-slate-600">{hint}</p>}
      {children}
    </fieldset>
  );
}

export function ObjectBuilder({ existing }: { existing?: RecordObject }) {
  const { t } = useRecords();
  const router = useRouter();
  const [manage, setManage] = useState<string[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [labelSingular, setLabelSingular] = useState(existing?.label_singular ?? '');
  const [labelPlural, setLabelPlural] = useState(existing?.label_plural ?? '');
  const [key, setKey] = useState(existing?.key ?? '');
  const [keyTouched, setKeyTouched] = useState(!!existing);
  const [description, setDescription] = useState(existing?.description ?? '');
  const [product, setProduct] = useState<RecordObjectInput['product_key']>(existing?.product_key ?? 'core');
  const [fields, setFields] = useState<FieldDraft[]>(() =>
    (existing?.fields ?? [{ key: '', label: '', type: 'text' as RecordFieldType, required: true }]).map((f) => ({ ...f, _id: ++seq, _new: !existing, _optionsText: (f.options ?? []).join('\n') })),
  );
  const [titleField, setTitleField] = useState(existing?.title_field ?? '');
  const [listColumns, setListColumns] = useState<string[]>(existing?.list_columns ?? []);
  const [permissions, setPermissions] = useState<RecordPermission[]>(existing?.permissions ?? []);
  const [useStates, setUseStates] = useState(!!existing?.states);
  const [states, setStates] = useState<StateDraft[]>(
    existing?.states?.list.map((s) => ({ ...s, _new: false })) ?? [
      { key: 'open', label: t('records.builder.stateOpen'), _new: true },
      { key: 'closed', label: t('records.builder.stateClosed'), final: true, _new: true },
    ],
  );
  const [initial, setInitial] = useState(existing?.states?.initial ?? 'open');
  const [transitions, setTransitions] = useState<TransitionDraft[]>(existing?.states?.transitions ?? [{ from: 'open', to: 'closed', label: '', approval: false }]);
  const [portal, setPortal] = useState(existing?.portal ?? { enabled: false, learner_field: null });
  const [reminder, setReminder] = useState(existing?.schedule?.reminder ?? null);
  const [problems, setProblems] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    recordsApi<{ manage: string[]; roles: Role[] }>('GET', '/meta')
      .then((m) => {
        setManage(m.manage);
        setRoles(m.roles);
      })
      .catch((e) => setProblems([errorText(t, e)]));
  }, [t]);

  // keys follow labels for new items until saved (existing keys never change: records use them)
  const withKeys = useMemo(() => {
    const taken: string[] = [];
    return fields.map((f) => {
      const k = f._new ? uniqueKey(recordKeyFromLabel(f.label || 'field'), taken) : f.key;
      taken.push(k);
      return { ...f, key: k };
    });
  }, [fields]);
  const stateKeys = states;
  const effectiveKey = keyTouched ? key : recordKeyFromLabel(labelPlural || labelSingular || 'register', 'register');
  const productRoles = roles.filter((r) => product === 'core' || r.product === product);
  const learnerFields = withKeys.filter((f) => f.type === 'learner');
  const dateFields = withKeys.filter((f) => f.type === 'date' || f.type === 'datetime');

  const setField = (id: number, patch: Partial<FieldDraft>) => setFields((fs) => fs.map((f) => (f._id === id ? { ...f, ...patch } : f)));
  const moveField = (i: number, d: number) =>
    setFields((fs) => {
      const j = i + d;
      if (j < 0 || j >= fs.length) return fs;
      const c = [...fs];
      [c[i], c[j]] = [c[j]!, c[i]!];
      return c;
    });

  function build(): RecordObjectInput {
    const keys = withKeys.map((f) => f.key);
    const mapState = (k: string) => k;
    return {
      key: effectiveKey,
      product_key: product,
      label_singular: labelSingular.trim(),
      label_plural: labelPlural.trim(),
      description: description.trim() || null,
      icon: existing?.icon ?? 'list',
      fields: withKeys.map((f) => {
        const choice = f.type === 'choice' || f.type === 'multi_choice';
        const out: RecordField = { key: f.key, label: f.label.trim(), type: f.type, required: !!f.required };
        if (f.unique) out.unique = true;
        if (choice) out.options = f._optionsText.split(/\n|,/).map((x) => x.trim()).filter(Boolean);
        if (f.default !== undefined && f.default !== null && f.default !== '') out.default = f.default;
        if (f.help) out.help = f.help;
        return out;
      }),
      title_field: titleField && keys.includes(titleField) ? titleField : keys[0] ?? null,
      list_columns: listColumns.filter((c) => keys.includes(c) || c === 'state'),
      permissions,
      states: useStates
        ? ({ list: stateKeys.map((s) => ({ key: s.key, label: s.label.trim(), ...(s.final ? { final: true } : {}) })), initial: mapState(initial), transitions: transitions.map((x) => ({ ...x, from: mapState(x.from), to: mapState(x.to), label: x.label || undefined, approver_roles: x.approval ? x.approver_roles ?? [] : undefined })) } as RecordStates)
        : null,
      portal: portal.enabled ? { enabled: true, learner_field: portal.learner_field ?? learnerFields[0]?.key ?? null } : { enabled: false },
      schedule: reminder ? { reminder: { date_field: reminder.date_field || dateFields[0]?.key || '', days_before: Number(reminder.days_before) || 0 } } : null,
    };
  }

  async function save() {
    const def = build();
    const p = recordObjectSchema.safeParse(def);
    if (!p.success) {
      setProblems(recordIssues(p.error).map((i) => `${i.path}: ${i.message}`));
      return;
    }
    setSaving(true);
    setProblems([]);
    try {
      if (existing) await recordsApi('PATCH', `/objects/${existing.key}`, def);
      else await recordsApi('POST', '/objects', def);
      router.push(`/records/${def.key}`);
    } catch (e) {
      setProblems([errorText(t, e)]);
      setSaving(false);
    }
  }

  const scopeSelect = (value: string | undefined, onChange: (v: 'all' | 'own' | 'none') => void, label: string) => (
    <select aria-label={label} value={value ?? 'none'} onChange={(e) => onChange(e.target.value as 'all' | 'own' | 'none')} className={small}>
      <option value="none">{t('records.scope.none')}</option>
      <option value="own">{t('records.scope.own')}</option>
      <option value="all">{t('records.scope.all')}</option>
    </select>
  );
  const roleLabel = (r: string) => {
    const x = roles.find((y) => `${y.product}:${y.key}` === r);
    return x ? `${x.name} (${t(`records.product.${x.product}`)})` : r;
  };

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      data-testid="object-builder"
    >
      <Section id="b-basics" title={t('records.builder.basics')} hint={t('records.builder.basicsHint')}>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-sm text-slate-700">
            {t('records.builder.labelPlural')}
            <input name="label_plural" required value={labelPlural} onChange={(e) => setLabelPlural(e.target.value)} className={input} />
          </label>
          <label className="text-sm text-slate-700">
            {t('records.builder.labelSingular')}
            <input name="label_singular" required value={labelSingular} onChange={(e) => setLabelSingular(e.target.value)} className={input} />
          </label>
          <label className="text-sm text-slate-700 sm:col-span-2">
            {t('common.description')}
            <input name="description" value={description} onChange={(e) => setDescription(e.target.value)} className={input} />
          </label>
          <label className="text-sm text-slate-700">
            {t('records.builder.product')}
            <select name="product_key" value={product} disabled={!!existing} onChange={(e) => setProduct(e.target.value as RecordObjectInput['product_key'])} className={input}>
              {(['core', 'os', 'erp', 'crm'] as const).filter((p) => p === product || manage.includes(p)).map((p) => (
                <option key={p} value={p}>
                  {t(`records.product.${p}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm text-slate-700">
            {t('records.builder.key')}
            <input
              name="key"
              value={effectiveKey}
              disabled={!!existing}
              onChange={(e) => {
                setKeyTouched(true);
                setKey(e.target.value);
              }}
              className={input}
            />
          </label>
        </div>
      </Section>

      <Section id="b-fields" title={t('records.builder.fields')} hint={t('records.builder.fieldsHint')}>
        <ol className="space-y-3">
          {withKeys.map((f, i) => (
            <li key={f._id} className="rounded-lg border border-slate-200 p-3" data-testid="field-row">
              <div className="grid gap-2 sm:grid-cols-[1fr_12rem_auto]">
                <label className="text-sm text-slate-700">
                  {t('records.builder.fieldLabel')}
                  <input name={`field-${i}-label`} required value={f.label} onChange={(e) => setField(f._id, { label: e.target.value })} className={input} />
                </label>
                <label className="text-sm text-slate-700">
                  {t('records.builder.fieldType')}
                  <select name={`field-${i}-type`} value={f.type} onChange={(e) => setField(f._id, { type: e.target.value as RecordFieldType, default: undefined })} className={input}>
                    {RECORD_FIELD_TYPES.map((x) => (
                      <option key={x} value={x}>
                        {t(`records.type.${x}`)}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="flex items-end gap-1">
                  <button type="button" className={btn} onClick={() => moveField(i, -1)} disabled={i === 0} aria-label={t('records.builder.moveUp')}>
                    ↑
                  </button>
                  <button type="button" className={btn} onClick={() => moveField(i, 1)} disabled={i === withKeys.length - 1} aria-label={t('records.builder.moveDown')}>
                    ↓
                  </button>
                  <button type="button" className={btn} onClick={() => setFields((fs) => fs.filter((x) => x._id !== f._id))} disabled={withKeys.length === 1} aria-label={t('records.builder.removeField')}>
                    ×
                  </button>
                </div>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-4 text-sm text-slate-700">
                <label className="flex items-center gap-1.5">
                  <input type="checkbox" name={`field-${i}-required`} checked={!!f.required} onChange={(e) => setField(f._id, { required: e.target.checked })} />
                  {t('records.builder.required')}
                </label>
                {!['long_text', 'yes_no', 'multi_choice', 'file'].includes(f.type) && (
                  <label className="flex items-center gap-1.5">
                    <input type="checkbox" checked={!!f.unique} onChange={(e) => setField(f._id, { unique: e.target.checked })} />
                    {t('records.builder.unique')}
                  </label>
                )}
                {f.type === 'date' && (
                  <label className="flex items-center gap-1.5">
                    <input type="checkbox" checked={f.default === 'today'} onChange={(e) => setField(f._id, { default: e.target.checked ? 'today' : undefined })} />
                    {t('records.builder.defaultToday')}
                  </label>
                )}
                {f.type === 'datetime' && (
                  <label className="flex items-center gap-1.5">
                    <input type="checkbox" checked={f.default === 'now'} onChange={(e) => setField(f._id, { default: e.target.checked ? 'now' : undefined })} />
                    {t('records.builder.defaultNow')}
                  </label>
                )}
                {f.type === 'person' && (
                  <label className="flex items-center gap-1.5">
                    <input type="checkbox" checked={f.default === 'me'} onChange={(e) => setField(f._id, { default: e.target.checked ? 'me' : undefined })} />
                    {t('records.builder.defaultMe')}
                  </label>
                )}
                <span className="text-xs text-slate-400">{f.key}</span>
              </div>
              {(f.type === 'choice' || f.type === 'multi_choice') && (
                <label className="mt-2 block text-sm text-slate-700">
                  {t('records.builder.options')}
                  <textarea name={`field-${i}-options`} rows={3} value={f._optionsText} onChange={(e) => setField(f._id, { _optionsText: e.target.value })} className={input} />
                </label>
              )}
            </li>
          ))}
        </ol>
        <button
          type="button"
          className={`${btn} mt-3`}
          data-testid="add-field"
          onClick={() => setFields((fs) => [...fs, { key: '', label: '', type: 'text', required: false, _id: ++seq, _new: true, _optionsText: '' }])}
        >
          {t('records.builder.addField')}
        </button>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="text-sm text-slate-700">
            {t('records.builder.titleField')}
            <select value={titleField || withKeys[0]?.key || ''} onChange={(e) => setTitleField(e.target.value)} className={input}>
              {withKeys.map((f) => (
                <option key={f._id} value={f.key}>
                  {f.label || f.key}
                </option>
              ))}
            </select>
          </label>
          <div className="text-sm text-slate-700">
            <span>{t('records.builder.listColumns')}</span>
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
              {[...withKeys.map((f) => ({ k: f.key, l: f.label || f.key })), ...(useStates ? [{ k: 'state', l: t('records.state') }] : [])].map((c) => (
                <label key={c.k} className="flex items-center gap-1.5">
                  <input type="checkbox" checked={listColumns.includes(c.k)} onChange={(e) => setListColumns((l) => (e.target.checked ? [...l, c.k] : l.filter((x) => x !== c.k)))} />
                  {c.l}
                </label>
              ))}
            </div>
          </div>
        </div>
      </Section>

      <Section id="b-perm" title={t('records.builder.permissions')} hint={t('records.builder.permissionsHint')}>
        <div className="space-y-2">
          {permissions.map((p, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 p-2" data-testid="permission-row">
              <select
                aria-label={t('records.builder.who')}
                value={p.who === 'all_staff' ? 'all_staff' : `${p.product}:${p.role}`}
                onChange={(e) => {
                  const v = e.target.value;
                  setPermissions((ps) => ps.map((x, j) => (j === i ? (v === 'all_staff' ? { ...x, who: 'all_staff', product: undefined, role: undefined } : { ...x, who: 'role', product: v.split(':')[0] as 'os', role: v.split(':')[1] }) : x)));
                }}
                className={small}
              >
                <option value="all_staff">{t('records.builder.allStaff')}</option>
                {productRoles.map((r) => (
                  <option key={`${r.product}:${r.key}`} value={`${r.product}:${r.key}`}>
                    {roleLabel(`${r.product}:${r.key}`)}
                  </option>
                ))}
              </select>
              <span className="text-xs text-slate-500">{t('records.action.view')}</span>
              {scopeSelect(p.view, (v) => setPermissions((ps) => ps.map((x, j) => (j === i ? { ...x, view: v } : x))), t('records.action.view'))}
              <label className="flex items-center gap-1 text-sm">
                <input type="checkbox" checked={!!p.create} onChange={(e) => setPermissions((ps) => ps.map((x, j) => (j === i ? { ...x, create: e.target.checked } : x)))} />
                {t('records.action.create')}
              </label>
              <span className="text-xs text-slate-500">{t('records.action.edit')}</span>
              {scopeSelect(p.edit, (v) => setPermissions((ps) => ps.map((x, j) => (j === i ? { ...x, edit: v } : x))), t('records.action.edit'))}
              <span className="text-xs text-slate-500">{t('records.action.delete')}</span>
              {scopeSelect(p.delete, (v) => setPermissions((ps) => ps.map((x, j) => (j === i ? { ...x, delete: v } : x))), t('records.action.delete'))}
              <label className="flex items-center gap-1 text-sm">
                <input type="checkbox" checked={!!p.export} onChange={(e) => setPermissions((ps) => ps.map((x, j) => (j === i ? { ...x, export: e.target.checked } : x)))} />
                {t('records.action.export')}
              </label>
              <button type="button" className={btn} onClick={() => setPermissions((ps) => ps.filter((_, j) => j !== i))} aria-label={t('records.builder.removeRule')}>
                ×
              </button>
            </div>
          ))}
        </div>
        <button type="button" className={`${btn} mt-2`} data-testid="add-permission" onClick={() => setPermissions((ps) => [...ps, { who: 'all_staff', view: 'own', create: true, edit: 'own', delete: 'none' }])}>
          {t('records.builder.addRule')}
        </button>
        <p className="mt-2 text-xs text-slate-500">{t('records.builder.managementNote')}</p>
      </Section>

      <Section id="b-flow" title={t('records.builder.workflow')} hint={t('records.builder.workflowHint')}>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={useStates} onChange={(e) => setUseStates(e.target.checked)} data-testid="use-states" />
          {t('records.builder.useStates')}
        </label>
        {useStates && (
          <div className="mt-3 space-y-3">
            <ol className="space-y-2">
              {stateKeys.map((s, i) => (
                <li key={i} className="flex flex-wrap items-center gap-2">
                  <input aria-label={t('records.builder.stateLabel')} value={s.label} onChange={(e) => setStates((ss) => ss.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} className={`${small} w-48`} />
                  <label className="flex items-center gap-1 text-sm">
                    <input type="checkbox" checked={!!s.final} onChange={(e) => setStates((ss) => ss.map((x, j) => (j === i ? { ...x, final: e.target.checked } : x)))} />
                    {t('records.builder.final')}
                  </label>
                  <button type="button" className={btn} disabled={states.length <= 2} onClick={() => setStates((ss) => ss.filter((_, j) => j !== i))} aria-label={t('records.builder.removeState')}>
                    ×
                  </button>
                </li>
              ))}
            </ol>
            <button type="button" className={btn} onClick={() => setStates((ss) => [...ss, { key: uniqueKey(`state_${ss.length + 1}`, ss.map((x) => x.key)), label: '', _new: true }])}>
              {t('records.builder.addState')}
            </button>
            <label className="block text-sm text-slate-700">
              {t('records.builder.initial')}
              <select value={initial} onChange={(e) => setInitial(e.target.value)} className={input}>
                {states.map((s, i) => (
                  <option key={i} value={s.key}>
                    {s.label || s.key}
                  </option>
                ))}
              </select>
            </label>
            <div className="space-y-2">
              <p className="text-sm font-medium text-slate-700">{t('records.builder.transitions')}</p>
              {transitions.map((x, i) => (
                <div key={i} className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 p-2">
                  <select aria-label={t('records.builder.from')} value={x.from} onChange={(e) => setTransitions((ts) => ts.map((y, j) => (j === i ? { ...y, from: e.target.value } : y)))} className={small}>
                    {states.map((s, k) => (
                      <option key={k} value={s.key}>
                        {s.label || s.key}
                      </option>
                    ))}
                  </select>
                  <span aria-hidden>→</span>
                  <select aria-label={t('records.builder.to')} value={x.to} onChange={(e) => setTransitions((ts) => ts.map((y, j) => (j === i ? { ...y, to: e.target.value } : y)))} className={small}>
                    {states.map((s, k) => (
                      <option key={k} value={s.key}>
                        {s.label || s.key}
                      </option>
                    ))}
                  </select>
                  <input aria-label={t('records.builder.buttonLabel')} placeholder={t('records.builder.buttonLabel')} value={x.label ?? ''} onChange={(e) => setTransitions((ts) => ts.map((y, j) => (j === i ? { ...y, label: e.target.value } : y)))} className={`${small} w-40`} />
                  <label className="flex items-center gap-1 text-sm">
                    <input type="checkbox" checked={!!x.approval} onChange={(e) => setTransitions((ts) => ts.map((y, j) => (j === i ? { ...y, approval: e.target.checked } : y)))} />
                    {t('records.builder.needsApproval')}
                  </label>
                  {x.approval && (
                    <select
                      aria-label={t('records.builder.approvers')}
                      multiple
                      value={x.approver_roles ?? []}
                      onChange={(e) => setTransitions((ts) => ts.map((y, j) => (j === i ? { ...y, approver_roles: [...e.target.selectedOptions].map((o) => o.value) } : y)))}
                      className="min-h-[72px] rounded-md border border-slate-300 bg-white px-2 text-sm"
                    >
                      {productRoles.map((r) => (
                        <option key={`${r.product}:${r.key}`} value={`${r.product}:${r.key}`}>
                          {roleLabel(`${r.product}:${r.key}`)}
                        </option>
                      ))}
                    </select>
                  )}
                  <button type="button" className={btn} onClick={() => setTransitions((ts) => ts.filter((_, j) => j !== i))} aria-label={t('records.builder.removeTransition')}>
                    ×
                  </button>
                </div>
              ))}
              <button type="button" className={btn} onClick={() => setTransitions((ts) => [...ts, { from: states[0]?.key ?? '', to: states[1]?.key ?? '' }])}>
                {t('records.builder.addTransition')}
              </button>
            </div>
          </div>
        )}
      </Section>

      <Section id="b-more" title={t('records.builder.more')}>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={portal.enabled} disabled={!learnerFields.length} onChange={(e) => setPortal({ enabled: e.target.checked, learner_field: learnerFields[0]?.key ?? null })} />
          {t('records.builder.portal')}
        </label>
        {portal.enabled && (
          <label className="mt-2 block text-sm text-slate-700">
            {t('records.builder.portalField')}
            <select value={portal.learner_field ?? ''} onChange={(e) => setPortal({ enabled: true, learner_field: e.target.value })} className={input}>
              {learnerFields.map((f) => (
                <option key={f._id} value={f.key}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>
        )}
        <p className="mt-1 text-xs text-slate-500">{t('records.builder.portalHint')}</p>
        <label className="mt-4 flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={!!reminder} disabled={!dateFields.length} onChange={(e) => setReminder(e.target.checked ? { date_field: dateFields[0]?.key ?? '', days_before: 0 } : null)} />
          {t('records.builder.reminder')}
        </label>
        {reminder && (
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <label className="text-sm text-slate-700">
              {t('records.builder.reminderField')}
              <select value={reminder.date_field} onChange={(e) => setReminder({ ...reminder, date_field: e.target.value })} className={input}>
                {dateFields.map((f) => (
                  <option key={f._id} value={f.key}>
                    {f.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm text-slate-700">
              {t('records.builder.daysBefore')}
              <input type="number" min={0} max={365} value={reminder.days_before} onChange={(e) => setReminder({ ...reminder, days_before: Number(e.target.value) })} className={input} />
            </label>
          </div>
        )}
      </Section>

      {problems.length > 0 && (
        <div role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-700">
          <ul className="list-inside list-disc">
            {problems.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={saving} data-testid="save-object" className="min-h-[40px] rounded-md bg-brand-600 px-5 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60">
          {saving ? t('records.saving') : existing ? t('records.builder.saveChanges') : t('records.builder.create')}
        </button>
        <button type="button" className={btn} onClick={() => router.back()}>
          {t('common.cancel')}
        </button>
      </div>
    </form>
  );
}
