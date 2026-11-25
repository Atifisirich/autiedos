/**
 * Adapter between the AI school designer's block catalogue (decisions 56-59; packages/shared/src/designer and
 * packages/server/src/designer, built separately) and the custom records engine. The designer calls these four
 * functions for a block of type 'custom_object'; it never writes SQL and never sees records (only definitions).
 *
 *   validate(config, ctx?)  -> same rules as the object builder (shared zod schema) + checks against the school's
 *                              configuration when ctx is given (roles exist, management rights, existing object).
 *   preview(config, ctx)    -> plain-language description of what publishing creates or changes and who is affected.
 *   apply(config, ctx)      -> creates or updates the object as the publishing person (RLS: management only);
 *                              returns the snapshot `inverse` needs.
 *   inverse(result, ctx)    -> undo: restores the previous definition, or removes a created object (archives it
 *                              instead when records were added in the meantime, so no data is lost).
 *
 * Interface documented in docs/custom-records.md ("Designer adapter").
 */
import { recordIssues, recordObjectSchema, type RecordObjectDef, type RecordObjectInput } from '@autoed/shared';
import type { RecordsDb } from './db';
import { createObject, deleteObject, getObject, listRoles, managedProducts, setObjectArchived, toInput, updateObject, type RecordsCtx } from './service';
import { RecordsError, type ObjectWithAccess, type ProductKey } from './types';

export const CUSTOM_OBJECT_BLOCK_TYPE = 'custom_object' as const;

/** The block's settings = a custom object definition (RecordObjectInput in @autoed/shared). */
export type CustomObjectBlockConfig = RecordObjectInput;

export interface CustomObjectBlockContext {
  db: RecordsDb;
  /** The signed-in person (management, or an AutoEd relationship manager in a read-write support session). */
  userId: string;
  /** Products of that person (session hint; the database re-checks). */
  products: ProductKey[];
}

export interface BlockIssue {
  path: string;
  message: string;
  severity: 'error' | 'warning';
}

export interface BlockValidation {
  ok: boolean;
  issues: BlockIssue[];
  /** Normalised definition (defaults filled) when ok. */
  config?: RecordObjectDef;
  mode?: 'create' | 'update';
}

export interface BlockPreview {
  mode: 'create' | 'update';
  title: string;
  /** One-paragraph plain-language summary. */
  summary: string;
  /** Plain-language lines: what is created / changed. */
  changes: string[];
  /** Who is affected (roles, families). */
  affects: string[];
  warnings: string[];
}

export interface BlockApplyResult {
  type: typeof CUSTOM_OBJECT_BLOCK_TYPE;
  mode: 'create' | 'update';
  objectId: string;
  key: string;
  version: number;
  /** Definition before the change (null when the object was created). */
  before: RecordObjectInput | null;
}

export interface CustomObjectBlock {
  type: typeof CUSTOM_OBJECT_BLOCK_TYPE;
  schema: typeof recordObjectSchema;
  validate(config: unknown, ctx?: CustomObjectBlockContext): Promise<BlockValidation>;
  preview(config: unknown, ctx: CustomObjectBlockContext): Promise<BlockPreview>;
  apply(config: unknown, ctx: CustomObjectBlockContext): Promise<BlockApplyResult>;
  inverse(result: BlockApplyResult, ctx: CustomObjectBlockContext): Promise<{ undone: 'restored' | 'deleted' | 'archived' }>;
}

const rctx = (c: CustomObjectBlockContext): RecordsCtx => ({ db: c.db, userId: c.userId, products: c.products });

async function existing(ctx: CustomObjectBlockContext, key: string): Promise<ObjectWithAccess | null> {
  try {
    return await getObject(rctx(ctx), key);
  } catch (e) {
    if (e instanceof RecordsError && e.code === 'not_found') return null;
    throw e;
  }
}

const TYPE_WORDS: Record<string, string> = {
  text: 'short text', long_text: 'long text', number: 'number', money: 'amount (₹)', date: 'date', datetime: 'date and time', yes_no: 'yes/no',
  choice: 'one choice', multi_choice: 'several choices', person: 'staff member', learner: 'student', section: 'class/section', branch: 'branch',
  file: 'file', phone: 'phone number', email: 'e-mail', url: 'web link',
};
const scopeWords = (s?: string) => (s === 'all' ? 'all entries' : s === 'own' ? 'their own entries' : null);

async function validate(config: unknown, ctx?: CustomObjectBlockContext): Promise<BlockValidation> {
  const p = recordObjectSchema.safeParse(config);
  if (!p.success) return { ok: false, issues: recordIssues(p.error).map((i) => ({ ...i, severity: 'error' as const })) };
  const d = p.data;
  const issues: BlockIssue[] = [];
  let mode: 'create' | 'update' = 'create';
  if (ctx) {
    const manage = await managedProducts(rctx(ctx));
    if (!manage.includes(d.product_key)) issues.push({ path: 'product_key', message: `you cannot manage ${d.product_key} objects`, severity: 'error' });
    const cur = await existing(ctx, d.key);
    if (cur) {
      mode = 'update';
      if (cur.product_key !== d.product_key) issues.push({ path: 'product_key', message: `${d.key} already belongs to ${cur.product_key}; the owning product cannot change`, severity: 'error' });
      for (const f of cur.fields) {
        const n = d.fields.find((x) => x.key === f.key);
        if (!n) issues.push({ path: 'fields', message: `field "${f.label}" is removed: its values are dropped the next time each record is saved`, severity: 'warning' });
        else if (n.type !== f.type) issues.push({ path: `fields.${f.key}`, message: `field "${f.label}" changes type (${f.type} -> ${n.type}); existing values must fit the new type before those records can be saved`, severity: 'warning' });
      }
    }
    if (manage.length) {
      const roles = await listRoles(rctx(ctx));
      const all = [...d.permissions.filter((x) => x.who === 'role').map((x) => `${x.product}:${x.role}`),
        ...(d.states?.transitions ?? []).flatMap((t) => [...(t.approver_roles ?? []), ...(t.roles ?? [])])];
      for (const r of new Set(all)) if (!roles.some((x) => `${x.product}:${x.key}` === r)) issues.push({ path: 'permissions', message: `role ${r} does not exist in this school`, severity: 'error' });
    }
  }
  if (!d.permissions.length) issues.push({ path: 'permissions', message: 'only management will see these records until a rule is added', severity: 'warning' });
  return { ok: !issues.some((i) => i.severity === 'error'), issues, config: d, mode };
}

async function preview(config: unknown, ctx: CustomObjectBlockContext): Promise<BlockPreview> {
  const v = await validate(config, ctx);
  if (!v.config) throw new RecordsError('invalid', 'invalid_definition', v.issues);
  const d = v.config;
  const roles = (await managedProducts(rctx(ctx))).length ? await listRoles(rctx(ctx)) : [];
  const roleName = (r: string) => roles.find((x) => `${x.product}:${x.key}` === r)?.name ?? r;
  const changes: string[] = [];
  const affects: string[] = [];
  const cur = v.mode === 'update' ? await existing(ctx, d.key) : null;
  if (!cur) {
    changes.push(`Creates a new list "${d.label_plural}" (${d.product_key === 'core' ? 'all products' : d.product_key.toUpperCase()}) with ${d.fields.length} field${d.fields.length === 1 ? '' : 's'}:`);
    for (const f of d.fields) changes.push(`  • ${f.label} — ${TYPE_WORDS[f.type]}${f.required ? ', required' : ''}${f.unique ? ', unique' : ''}${f.options?.length ? ` (${f.options.join(', ')})` : ''}`);
  } else {
    changes.push(`Changes the list "${cur.label_plural}" (version ${cur.version} -> ${cur.version + 1}).`);
    for (const f of d.fields) if (!cur.fields.some((x) => x.key === f.key)) changes.push(`  • adds ${f.label} — ${TYPE_WORDS[f.type]}${f.required ? ', required' : ''}`);
    for (const f of cur.fields) if (!d.fields.some((x) => x.key === f.key)) changes.push(`  • removes ${f.label}`);
    for (const f of d.fields) {
      const o = cur.fields.find((x) => x.key === f.key);
      if (o && JSON.stringify(o) !== JSON.stringify(f)) changes.push(`  • changes ${f.label}`);
    }
    if (JSON.stringify(cur.permissions) !== JSON.stringify(d.permissions)) changes.push('  • changes who can see and edit entries');
    if (JSON.stringify(cur.states ?? null) !== JSON.stringify(d.states ?? null)) changes.push('  • changes the workflow');
    if (cur.portal.enabled !== d.portal.enabled) changes.push(d.portal.enabled ? '  • lets families see entries about their own child' : '  • hides entries from families');
  }
  for (const p of d.permissions) {
    const who = p.who === 'all_staff' ? 'All staff' : roleName(`${p.product}:${p.role}`);
    const can = [scopeWords(p.view) && `see ${scopeWords(p.view)}`, p.create && 'add entries', scopeWords(p.edit) && `edit ${scopeWords(p.edit)}`, scopeWords(p.delete) && `delete ${scopeWords(p.delete)}`, p.export && 'export'].filter(Boolean);
    affects.push(`${who}: ${can.length ? can.join(', ') : 'no access'}`);
  }
  affects.push('Management: full access');
  if (d.states) {
    const lab = (k: string) => d.states!.list.find((s) => s.key === k)?.label ?? k;
    changes.push(`Workflow: ${d.states.list.map((s) => s.label).join(' → ')} (new entries start as ${lab(d.states.initial)}).`);
    for (const t of d.states.transitions) if (t.approval) changes.push(`  • ${lab(t.from)} → ${lab(t.to)} needs approval${t.approver_roles?.length ? ` by ${t.approver_roles.map(roleName).join(' or ')}` : ' by management'}`);
  }
  if (d.portal.enabled) {
    const f = d.fields.find((x) => x.key === d.portal.learner_field);
    affects.push(`Parents and students: see entries whose "${f?.label}" is their own child (read only)`);
  }
  if (d.schedule?.reminder) {
    const f = d.fields.find((x) => x.key === d.schedule!.reminder!.date_field);
    changes.push(`Reminder to the person who added the entry ${d.schedule.reminder.days_before ? `${d.schedule.reminder.days_before} day(s) before` : 'on the day of'} "${f?.label}".`);
  }
  return {
    mode: cur ? 'update' : 'create',
    title: d.label_plural,
    summary: cur ? `Updates "${cur.label_plural}".` : `Adds "${d.label_plural}", a new register the school can fill in from the web and mobile app.`,
    changes,
    affects,
    warnings: v.issues.filter((i) => i.severity === 'warning').map((i) => i.message).concat(v.ok ? [] : v.issues.filter((i) => i.severity === 'error').map((i) => i.message)),
  };
}

async function apply(config: unknown, ctx: CustomObjectBlockContext): Promise<BlockApplyResult> {
  const v = await validate(config, ctx);
  if (!v.ok || !v.config) throw new RecordsError('invalid', 'invalid_definition', v.issues);
  const cur = await existing(ctx, v.config.key);
  const o = cur ? await updateObject(rctx(ctx), cur.key, v.config) : await createObject(rctx(ctx), v.config);
  return { type: CUSTOM_OBJECT_BLOCK_TYPE, mode: cur ? 'update' : 'create', objectId: o.id, key: o.key, version: o.version, before: cur ? toInput(cur) : null };
}

async function inverse(result: BlockApplyResult, ctx: CustomObjectBlockContext): Promise<{ undone: 'restored' | 'deleted' | 'archived' }> {
  if (result.mode === 'update' && result.before) {
    await updateObject(rctx(ctx), result.key, result.before);
    return { undone: 'restored' };
  }
  try {
    await deleteObject(rctx(ctx), result.key);
    return { undone: 'deleted' };
  } catch (e) {
    if (e instanceof RecordsError && e.code === 'conflict') {
      await setObjectArchived(rctx(ctx), result.key, true);
      return { undone: 'archived' };
    }
    throw e;
  }
}

export const customObjectBlock: CustomObjectBlock = { type: CUSTOM_OBJECT_BLOCK_TYPE, schema: recordObjectSchema, validate, preview, apply, inverse };
