/**
 * Custom records (docs/custom-records.md): the typed definition of a custom object, shared by the server, the web
 * object builder and the AI designer adapter. The database (core.custom_objects trigger app.custom_object_problems)
 * applies the same rules and is the authority; this schema gives early, field-level messages.
 */
import { z } from 'zod';

export const RECORD_FIELD_TYPES = [
  'text', 'long_text', 'number', 'money', 'date', 'datetime', 'yes_no', 'choice', 'multi_choice',
  'person', 'learner', 'section', 'branch', 'file', 'phone', 'email', 'url',
] as const;
export type RecordFieldType = (typeof RECORD_FIELD_TYPES)[number];

/** Field types that point at a row of the same school (validated in the database). */
export const RECORD_LINK_TYPES = ['person', 'learner', 'section', 'branch', 'file'] as const satisfies readonly RecordFieldType[];
/** Field types whose values identify or describe a person (personal data: export / erasure, docs/custom-records.md). */
export const RECORD_PERSONAL_TYPES = ['person', 'learner', 'text', 'long_text', 'phone', 'email'] as const satisfies readonly RecordFieldType[];

export const RECORD_OWNING_PRODUCTS = ['core', 'crm', 'os', 'erp'] as const;
export type RecordOwningProduct = (typeof RECORD_OWNING_PRODUCTS)[number];
export const RECORD_ACTIONS = ['view', 'create', 'edit', 'delete', 'export'] as const;
export type RecordAction = (typeof RECORD_ACTIONS)[number];
export type RecordScope = 'all' | 'own' | 'none';

const key = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, 'use lower-case letters, digits and _ (start with a letter)');
const label = z.string().trim().min(1, 'required').max(120);
const scope = z.enum(['all', 'own', 'none']);

export const recordFieldSchema = z
  .object({
    key,
    label,
    type: z.enum(RECORD_FIELD_TYPES),
    required: z.boolean().optional(),
    unique: z.boolean().optional(),
    default: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
    options: z.array(z.string().trim().min(1)).max(200).optional().nullable(),
    help: z.string().max(300).optional().nullable(),
    min: z.number().optional().nullable(),
    max: z.number().optional().nullable(),
    max_length: z.number().int().min(1).max(10000).optional().nullable(),
  })
  .superRefine((f, ctx) => {
    const choice = f.type === 'choice' || f.type === 'multi_choice';
    if (choice && !(f.options && f.options.length)) ctx.addIssue({ code: 'custom', path: ['options'], message: 'give the choices' });
    if (choice && f.options && new Set(f.options).size !== f.options.length) ctx.addIssue({ code: 'custom', path: ['options'], message: 'a choice appears twice' });
    if (!choice && f.options && f.options.length) ctx.addIssue({ code: 'custom', path: ['options'], message: 'only choice fields have choices' });
    if (f.unique && ['long_text', 'yes_no', 'multi_choice', 'file'].includes(f.type)) ctx.addIssue({ code: 'custom', path: ['unique'], message: `a ${f.type} field cannot be unique` });
    if (f.default !== undefined && f.default !== null) {
      const d = f.default;
      const ok =
        (['text', 'long_text', 'phone', 'email', 'url'].includes(f.type) && typeof d === 'string') ||
        (['number', 'money'].includes(f.type) && typeof d === 'number') ||
        (f.type === 'yes_no' && typeof d === 'boolean') ||
        (f.type === 'choice' && typeof d === 'string' && !!f.options?.includes(d)) ||
        (f.type === 'date' && typeof d === 'string' && (d === 'today' || /^\d{4}-\d{2}-\d{2}$/.test(d))) ||
        (f.type === 'datetime' && d === 'now') ||
        (f.type === 'person' && d === 'me');
      if (!ok) ctx.addIssue({ code: 'custom', path: ['default'], message: 'the default does not fit the field type' });
    }
  });
export type RecordField = z.infer<typeof recordFieldSchema>;

export const recordPermissionSchema = z
  .object({
    who: z.enum(['all_staff', 'role']),
    product: z.enum(['crm', 'os', 'erp']).optional(),
    role: z.string().regex(/^[a-z][a-z0-9_]*$/).optional(),
    view: scope.optional(),
    create: z.boolean().optional(),
    edit: scope.optional(),
    delete: scope.optional(),
    export: z.boolean().optional(),
  })
  .superRefine((p, ctx) => {
    if (p.who === 'role' && !(p.product && p.role)) ctx.addIssue({ code: 'custom', path: ['role'], message: 'a role rule needs a product and a role' });
  });
export type RecordPermission = z.infer<typeof recordPermissionSchema>;

export const recordStatesSchema = z
  .object({
    list: z.array(z.object({ key, label, final: z.boolean().optional() })).min(2, 'a workflow needs at least two states'),
    initial: key,
    transitions: z
      .array(
        z.object({
          from: key,
          to: key,
          label: z.string().trim().max(60).optional(),
          approval: z.boolean().optional(),
          approver_roles: z.array(z.string().regex(/^(crm|os|erp):[a-z][a-z0-9_]*$/)).optional(),
          roles: z.array(z.string().regex(/^(crm|os|erp):[a-z][a-z0-9_]*$/)).optional(),
        }),
      )
      .default([]),
  })
  .superRefine((s, ctx) => {
    const keys = s.list.map((x) => x.key);
    if (new Set(keys).size !== keys.length) ctx.addIssue({ code: 'custom', path: ['list'], message: 'a state appears twice' });
    if (!keys.includes(s.initial)) ctx.addIssue({ code: 'custom', path: ['initial'], message: 'the first state must be one of the states' });
    s.transitions.forEach((t, i) => {
      if (!keys.includes(t.from) || !keys.includes(t.to) || t.from === t.to) ctx.addIssue({ code: 'custom', path: ['transitions', i], message: 'both ends must be different states' });
    });
  });
export type RecordStates = z.infer<typeof recordStatesSchema>;

export const recordObjectSchema = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/, 'use lower-case letters, digits and _ (2-40 characters)').refine((k) => k !== 'new' && k !== 'approvals', 'this key is reserved'),
    product_key: z.enum(RECORD_OWNING_PRODUCTS).default('core'),
    label_singular: z.string().trim().min(1).max(80),
    label_plural: z.string().trim().min(1).max(80),
    labels_i18n: z.record(z.enum(['hi', 'te']), z.object({ singular: z.string().max(80), plural: z.string().max(80) })).optional(),
    description: z.string().max(500).optional().nullable(),
    icon: z.string().regex(/^[a-z][a-z0-9_-]{0,30}$/).default('list'),
    fields: z.array(recordFieldSchema).min(1, 'add at least one field').max(100),
    title_field: key.optional().nullable(),
    list_columns: z.array(z.string()).max(12).default([]),
    form_layout: z.array(z.object({ title: z.string().max(80).optional(), fields: z.array(key) })).optional().nullable(),
    permissions: z.array(recordPermissionSchema).max(50).default([]),
    states: recordStatesSchema.optional().nullable(),
    portal: z.object({ enabled: z.boolean(), learner_field: key.optional().nullable() }).default({ enabled: false }),
    schedule: z.object({ reminder: z.object({ date_field: key, days_before: z.number().int().min(0).max(365) }).optional().nullable() }).optional().nullable(),
    archived: z.boolean().optional(),
  })
  .superRefine((o, ctx) => {
    const keys = o.fields.map((f) => f.key);
    keys.forEach((k, i) => keys.indexOf(k) !== i && ctx.addIssue({ code: 'custom', path: ['fields', i, 'key'], message: `field ${k} appears twice` }));
    if (o.title_field && !keys.includes(o.title_field)) ctx.addIssue({ code: 'custom', path: ['title_field'], message: 'not a field' });
    o.list_columns.forEach((c, i) => !keys.includes(c) && !['state', 'created_at', 'updated_at', 'owner'].includes(c) && ctx.addIssue({ code: 'custom', path: ['list_columns', i], message: `${c} is not a field` }));
    o.form_layout?.forEach((s, i) => s.fields.forEach((k) => !keys.includes(k) && ctx.addIssue({ code: 'custom', path: ['form_layout', i], message: `${k} is not a field` })));
    o.permissions.forEach((p, i) => {
      if (p.who === 'role' && o.product_key !== 'core' && p.product !== o.product_key) ctx.addIssue({ code: 'custom', path: ['permissions', i], message: `role must belong to ${o.product_key}` });
    });
    if (o.portal.enabled && !o.fields.some((f) => f.key === o.portal.learner_field && f.type === 'learner'))
      ctx.addIssue({ code: 'custom', path: ['portal', 'learner_field'], message: 'families can see records only through a learner field' });
    const r = o.schedule?.reminder;
    if (r && !o.fields.some((f) => f.key === r.date_field && (f.type === 'date' || f.type === 'datetime')))
      ctx.addIssue({ code: 'custom', path: ['schedule', 'reminder', 'date_field'], message: 'a reminder needs a date field' });
  });
export type RecordObjectInput = z.input<typeof recordObjectSchema>;
export type RecordObjectDef = z.infer<typeof recordObjectSchema>;

/** A field key from a plain label ("Visitor name" -> visitor_name). */
export function recordKeyFromLabel(text: string, fallback = 'field'): string {
  const k = text.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
  return /^[a-z]/.test(k) ? k : `${fallback}_${k}`.slice(0, 40).replace(/_+$/, '') || fallback;
}

/** Flattens zod issues to "path: message" strings. */
export function recordIssues(e: z.ZodError): { path: string; message: string }[] {
  return e.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
}
