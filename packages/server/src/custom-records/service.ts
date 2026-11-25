/**
 * Custom records services (docs/custom-records.md). Each call runs in one transaction as a product role with the
 * caller's claims; the database decides who sees and changes what (per-object policies, validation trigger,
 * transition / approval functions). Nothing here widens access: it only builds queries and formats results.
 */
import { recordIssues, recordObjectSchema, RECORD_LINK_TYPES, type RecordField, type RecordObjectInput } from '@autoed/shared';
import { PRODUCT_ROLES, type Queryable, type RecordsDb, type RecordsRole } from './db';
import { fromDbError, RecordsError, type Access, type ListQuery, type ObjectRow, type ObjectWithAccess, type ProductKey, type RecordRow } from './types';

export interface RecordsCtx {
  db: RecordsDb;
  userId: string;
  /** Products of the signed-in person (session hint; every query re-checks in the database). */
  products: ProductKey[];
}

const PRODUCT_ORDER: ProductKey[] = ['os', 'erp', 'crm'];

/** The product role for an owning product: its own role, or for 'core' the first product the person holds. */
export function roleFor(ctx: RecordsCtx, product: string): RecordsRole {
  if (product !== 'core' && ctx.products.includes(product as ProductKey)) return PRODUCT_ROLES[product as ProductKey];
  const p = PRODUCT_ORDER.find((x) => ctx.products.includes(x));
  if (!p) throw new RecordsError('forbidden', 'no_product');
  return PRODUCT_ROLES[p];
}

async function inTx<T>(ctx: RecordsCtx, product: string, fn: (q: Queryable) => Promise<T>): Promise<T> {
  try {
    return await ctx.db.run(roleFor(ctx, product), ctx.userId, fn);
  } catch (e) {
    return fromDbError(e);
  }
}

const OBJECT_COLS = `o.id, o.org_id, o.product_key, o.key, o.label_singular, o.label_plural, o.labels_i18n, o.description, o.icon, o.fields, o.title_field,
  o.list_columns, o.form_layout, o.permissions, o.states, o.portal, o.schedule, o.archived, o.version, o.created_at, o.updated_at`;
const ACCESS_COLS = `app.custom_record_level(o.id, 'view') as a_view, app.custom_record_level(o.id, 'create') as a_create,
  app.custom_record_level(o.id, 'edit') as a_edit, app.custom_record_level(o.id, 'delete') as a_delete,
  app.custom_record_level(o.id, 'export') as a_export, app.custom_records_can_manage(o.org_id, o.product_key) as a_manage`;

type ObjectSqlRow = ObjectRow & { a_view: Access['view']; a_create: Access['create']; a_edit: Access['edit']; a_delete: Access['delete']; a_export: Access['export']; a_manage: boolean };
function withAccess(r: ObjectSqlRow): ObjectWithAccess {
  const { a_view, a_create, a_edit, a_delete, a_export, a_manage, ...o } = r;
  return { ...o, access: { view: a_view, create: a_create, edit: a_edit, delete: a_delete, export: a_export, manage: a_manage } };
}

// ---------------------------------------------------------------- objects
export async function listObjects(ctx: RecordsCtx, opts: { includeArchived?: boolean } = {}): Promise<ObjectWithAccess[]> {
  return inTx(ctx, 'core', async (q) => {
    const r = await q.query<ObjectSqlRow>(`select ${OBJECT_COLS}, ${ACCESS_COLS} from core.custom_objects o
      where o.deleted_at is null and ($1 or not o.archived) order by o.label_plural`, [!!opts.includeArchived]);
    return r.rows.map(withAccess);
  });
}

export async function getObject(ctx: RecordsCtx, key: string): Promise<ObjectWithAccess> {
  return inTx(ctx, 'core', (q) => loadObject(q, key));
}

async function loadObject(q: Queryable, key: string): Promise<ObjectWithAccess> {
  const r = await q.query<ObjectSqlRow>(`select ${OBJECT_COLS}, ${ACCESS_COLS} from core.custom_objects o where o.key = $1 and o.deleted_at is null`, [key]);
  if (!r.rows[0]) throw new RecordsError('not_found', 'object_not_found');
  return withAccess(r.rows[0]);
}

/** Which owning products may the person manage objects for ('core' = any). */
export async function managedProducts(ctx: RecordsCtx): Promise<string[]> {
  return inTx(ctx, 'core', async (q) => {
    const r = await q.query<{ p: string }>(`select p from unnest(array['core','crm','os','erp']) p where app.custom_records_can_manage(app.current_org_id(), p)`);
    return r.rows.map((x) => x.p);
  });
}

/** Parses a definition with the shared schema; throws invalid with field-level issues. */
export function parseObject(input: unknown) {
  const p = recordObjectSchema.safeParse(input);
  if (!p.success) throw new RecordsError('invalid', 'invalid_definition', recordIssues(p.error));
  return p.data;
}

const DEF_COLUMNS = ['label_singular', 'label_plural', 'labels_i18n', 'description', 'icon', 'fields', 'title_field', 'list_columns', 'form_layout', 'permissions', 'states', 'portal', 'schedule', 'archived'] as const;
const JSON_COLS = new Set(['labels_i18n', 'fields', 'form_layout', 'permissions', 'states', 'portal', 'schedule']);
const val = (k: string, v: unknown) => (v === undefined ? null : JSON_COLS.has(k) ? (v === null ? null : JSON.stringify(v)) : v);

export async function createObject(ctx: RecordsCtx, input: RecordObjectInput): Promise<ObjectWithAccess> {
  const d = parseObject(input);
  return inTx(ctx, d.product_key, async (q) => {
    const ok = (await q.query<{ ok: boolean }>(`select app.custom_records_can_manage(app.current_org_id(), $1) as ok`, [d.product_key])).rows[0]?.ok;
    if (!ok) throw new RecordsError('forbidden', 'management_only');
    const cols = ['product_key', 'key', ...DEF_COLUMNS];
    const values = cols.map((c) => (c === 'product_key' ? d.product_key : c === 'key' ? d.key : c === 'archived' ? d.archived ?? false : val(c, d[c as keyof typeof d])));
    await q.query(
      `insert into core.custom_objects (org_id, ${cols.join(', ')}) values (app.current_org_id(), ${cols.map((c, i) => `$${i + 1}${c === 'labels_i18n' ? `::jsonb` : ''}`).join(', ')})`,
      values.map((v, i) => (cols[i] === 'labels_i18n' && v === null ? '{}' : cols[i] === 'portal' && v === null ? '{"enabled":false}' : cols[i] === 'list_columns' && v === null ? [] : v)),
    );
    return loadObject(q, d.key);
  });
}

/** Replaces the definition (key and owning product cannot change). `patch` is merged over the current definition. */
export async function updateObject(ctx: RecordsCtx, key: string, patch: Partial<RecordObjectInput>): Promise<ObjectWithAccess> {
  const cur = await getObject(ctx, key);
  if (!cur.access.manage) throw new RecordsError('forbidden', 'management_only');
  const d = parseObject({ ...toInput(cur), ...patch, key: cur.key, product_key: cur.product_key });
  return inTx(ctx, cur.product_key, async (q) => {
    const sets = DEF_COLUMNS.map((c, i) => `${c} = $${i + 2}`);
    const r = await q.query(`update core.custom_objects set ${sets.join(', ')} where id = $1`, [
      cur.id,
      ...DEF_COLUMNS.map((c) => (c === 'archived' ? d.archived ?? cur.archived : c === 'labels_i18n' ? JSON.stringify(d.labels_i18n ?? {}) : c === 'list_columns' ? d.list_columns : val(c, d[c as keyof typeof d]))),
    ]);
    if (!r.rowCount) throw new RecordsError('forbidden', 'management_only');
    return loadObject(q, key);
  });
}

export async function setObjectArchived(ctx: RecordsCtx, key: string, archived: boolean): Promise<ObjectWithAccess> {
  return updateObject(ctx, key, { archived });
}

/** Hard delete: management only, and only while the object holds no records (archive it otherwise). */
export async function deleteObject(ctx: RecordsCtx, key: string): Promise<void> {
  const cur = await getObject(ctx, key);
  if (!cur.access.manage) throw new RecordsError('forbidden', 'management_only');
  await inTx(ctx, cur.product_key, async (q) => {
    const n = (await q.query<{ n: number }>(`select count(*)::int as n from core.custom_records where object_id = $1`, [cur.id])).rows[0]!.n;
    if (n > 0) throw new RecordsError('conflict', 'object_has_records');
    await q.query(`delete from core.custom_objects where id = $1`, [cur.id]);
  });
}

export function toInput(o: ObjectRow): RecordObjectInput {
  return {
    key: o.key, product_key: o.product_key, label_singular: o.label_singular, label_plural: o.label_plural, labels_i18n: o.labels_i18n as RecordObjectInput['labels_i18n'],
    description: o.description, icon: o.icon, fields: o.fields, title_field: o.title_field, list_columns: o.list_columns, form_layout: o.form_layout,
    permissions: o.permissions, states: o.states, portal: o.portal, schedule: o.schedule, archived: o.archived,
  };
}

// ---------------------------------------------------------------- records
const RECORD_COLS = `r.id, r.object_id, r.branch_id, r.data, r.state, r.pending_state, r.pending_approval_id, r.owner_id, r.created_at, r.updated_at, r.deleted_at,
  app.custom_record_can(r.object_id, 'edit', r.branch_id, r.owner_id, r.data) as can_edit,
  app.custom_record_can(r.object_id, 'delete', r.branch_id, r.owner_id, r.data) as can_delete`;

function fieldOf(o: ObjectRow, k: string): RecordField | undefined {
  return o.fields.find((f) => f.key === k);
}

/** Builds the WHERE / ORDER BY of a list from validated field keys; values are always parameters. */
function listSql(o: ObjectRow, lq: ListQuery, userId: string) {
  const params: unknown[] = [o.id];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const where = ['r.object_id = $1'];
  if (!lq.includeDeleted) where.push('r.deleted_at is null');
  if (lq.state) where.push(`r.state = ${p(lq.state)}`);
  if (lq.mine) where.push(`r.owner_id = ${p(userId)}`);
  if (lq.q && lq.q.trim()) where.push(`exists (select 1 from jsonb_each_text(r.data) e where e.value ilike ${p(`%${lq.q.trim().slice(0, 100).replace(/[\\%_]/g, (m) => `\\${m}`)}%`)})`);
  for (const [raw, value] of Object.entries(lq.filters ?? {})) {
    if (value === undefined || value === '') continue;
    const [k, bound] = raw.split('.') as [string, string | undefined];
    const f = fieldOf(o, k);
    if (!f) throw new RecordsError('invalid', `unknown_filter ${k}`);
    if (bound === 'from' || bound === 'to') {
      const op = bound === 'from' ? '>=' : '<=';
      if (f.type === 'number' || f.type === 'money') where.push(`(r.data->>${p(k)}::text)::numeric ${op} ${p(Number(value))}`);
      else if (f.type === 'date' || f.type === 'datetime') where.push(`left(r.data->>${p(k)}::text, ${f.type === 'date' ? 10 : 30}) ${op} ${p(value)}`);
      else throw new RecordsError('invalid', `range_filter_not_supported ${k}`);
    } else if (f.type === 'multi_choice') where.push(`r.data->${p(k)}::text ? ${p(value)}::text`);
    else if (f.type === 'yes_no') where.push(`r.data->${p(k)}::text = ${p(value === 'true' ? 'true' : 'false')}::jsonb`);
    else if (f.type === 'text' || f.type === 'long_text') where.push(`r.data->>${p(k)}::text ilike ${p(`%${value.replace(/[\\%_]/g, (m) => `\\${m}`)}%`)}`);
    else where.push(`r.data->>${p(k)}::text = ${p(value)}`);
  }
  let order = 'r.created_at desc';
  if (lq.sort) {
    const dir = lq.dir === 'asc' ? 'asc' : 'desc';
    if (['created_at', 'updated_at', 'state'].includes(lq.sort)) order = `r.${lq.sort} ${dir} nulls last, r.id`;
    else {
      const f = fieldOf(o, lq.sort);
      if (!f) throw new RecordsError('invalid', `unknown_sort ${lq.sort}`);
      // the key is a field of the definition (validated as ^[a-z][a-z0-9_]*$ by the database): inlined, so the count query needs no extra parameter
      if (!/^[a-z][a-z0-9_]{0,39}$/.test(f.key)) throw new RecordsError('invalid', 'bad_field_key');
      order = f.type === 'number' || f.type === 'money' ? `(r.data->>'${f.key}')::numeric ${dir} nulls last, r.id` : `r.data->>'${f.key}' ${dir} nulls last, r.id`;
    }
  }
  return { where: where.join(' and '), order, params };
}

/** Display labels for link values (staff, learners, sections, branches, files), read under RLS. */
async function linkLabels(q: Queryable, o: ObjectRow, rows: { data: Record<string, unknown> }[]): Promise<Record<string, string>> {
  const ids: Record<string, Set<string>> = {};
  for (const f of o.fields) {
    if (!(RECORD_LINK_TYPES as readonly string[]).includes(f.type)) continue;
    for (const r of rows) {
      const v = r.data[f.key];
      if (typeof v === 'string') (ids[f.type] ??= new Set()).add(v);
    }
  }
  const out: Record<string, string> = {};
  const sql: Record<string, string> = {
    person: `select id::text, full_name as label from core.staff where id = any($1::uuid[])`,
    learner: `select id::text, full_name || coalesce(' (' || admission_no || ')', '') as label from core.students where id = any($1::uuid[])`,
    section: `select s.id::text, coalesce(p.name || ' ', '') || s.name as label from core.sections s left join core.programmes p on p.org_id = s.org_id and p.id = s.programme_id where s.id = any($1::uuid[])`,
    branch: `select id::text, name as label from core.branches where id = any($1::uuid[])`,
    file: `select id::text, file_name as label from core.files where id = any($1::uuid[])`,
  };
  for (const [t, set] of Object.entries(ids)) {
    const r = await q.query<{ id: string; label: string }>(sql[t]!, [[...set]]);
    for (const x of r.rows) out[x.id] = x.label;
  }
  return out;
}

export async function listRecords(ctx: RecordsCtx, key: string, lq: ListQuery = {}): Promise<{ object: ObjectWithAccess; rows: RecordRow[]; total: number; page: number; pageSize: number; labels: Record<string, string> }> {
  const object = await getObject(ctx, key);
  const pageSize = Math.min(Math.max(Math.floor(lq.pageSize ?? 25), 1), 200);
  const page = Math.max(Math.floor(lq.page ?? 1), 1);
  const { where, order, params } = listSql(object, lq, ctx.userId);
  return inTx(ctx, object.product_key, async (q) => {
    const total = (await q.query<{ n: number }>(`select count(*)::int as n from core.custom_records r where ${where}`, params)).rows[0]!.n;
    const rows = (await q.query<RecordRow>(`select ${RECORD_COLS} from core.custom_records r where ${where} order by ${order} limit ${pageSize} offset ${(page - 1) * pageSize}`, params)).rows;
    return { object, rows, total, page, pageSize, labels: await linkLabels(q, object, rows) };
  });
}

export interface RecordDetail {
  object: ObjectWithAccess;
  record: RecordRow;
  labels: Record<string, string>;
  history: { id: string; kind: string; from_state: string | null; to_state: string | null; changes: Record<string, { from?: unknown; to?: unknown }> | null; note: string | null; actor: string | null; created_at: string }[];
  transitions: { to: string; label: string; approval: boolean }[];
}

export async function getRecord(ctx: RecordsCtx, key: string, id: string): Promise<RecordDetail> {
  const object = await getObject(ctx, key);
  return inTx(ctx, object.product_key, async (q) => {
    const record = (await q.query<RecordRow>(`select ${RECORD_COLS} from core.custom_records r where r.object_id = $1 and r.id = $2`, [object.id, id])).rows[0];
    if (!record) throw new RecordsError('not_found', 'record_not_found');
    const history = (await q.query<RecordDetail['history'][number]>(
      `select e.id, e.kind, e.from_state, e.to_state, e.changes, e.note, e.created_at,
              (select u.display_name from core.org_users u where u.org_id = e.org_id and u.user_id = e.actor_user_id) as actor
         from core.custom_record_events e where e.record_id = $1 order by e.created_at, e.id`, [id])).rows;
    const transitions = (object.states?.transitions ?? [])
      .filter((t) => t.from === record.state && record.can_edit && !record.pending_approval_id && !record.deleted_at)
      .map((t) => ({ to: t.to, label: t.label || object.states!.list.find((s) => s.key === t.to)?.label || t.to, approval: !!t.approval }));
    return { object, record, labels: await linkLabels(q, object, [record]), history, transitions };
  });
}

function cleanData(o: ObjectRow, data: unknown): Record<string, unknown> {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new RecordsError('invalid', 'data must be an object');
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
    const f = fieldOf(o, k);
    // numbers typed into a form arrive as text: convert, the database checks the rest
    if (f && (f.type === 'number' || f.type === 'money') && typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) out[k] = Number(v);
    else out[k] = v;
  }
  return out;
}

export async function createRecord(ctx: RecordsCtx, key: string, input: { data: unknown; branch_id?: string | null }): Promise<RecordRow> {
  const object = await getObject(ctx, key);
  if (!object.access.create) throw new RecordsError('forbidden', 'cannot_create');
  const data = cleanData(object, input.data);
  return inTx(ctx, object.product_key, async (q) => {
    const r = await q.query<RecordRow>(
      `insert into core.custom_records (org_id, branch_id, object_id, data) values (app.current_org_id(), $1, $2, $3)
       returning id, object_id, branch_id, data, state, pending_state, pending_approval_id, owner_id, created_at, updated_at, deleted_at`,
      [input.branch_id ?? null, object.id, JSON.stringify(data)],
    );
    return r.rows[0]!;
  });
}

/** Merges `data` over the record (a null or empty value clears the field). */
export async function updateRecord(ctx: RecordsCtx, key: string, id: string, input: { data?: unknown; branch_id?: string | null }): Promise<RecordRow> {
  const object = await getObject(ctx, key);
  const data = input.data === undefined ? {} : cleanData(object, input.data);
  return inTx(ctx, object.product_key, async (q) => {
    const r = await q.query<RecordRow>(
      `update core.custom_records r set data = r.data || $3::jsonb, branch_id = case when $4 then $5::uuid else r.branch_id end
        where r.object_id = $1 and r.id = $2 and r.deleted_at is null
        returning id, object_id, branch_id, data, state, pending_state, pending_approval_id, owner_id, created_at, updated_at, deleted_at`,
      [object.id, id, JSON.stringify(data), input.branch_id !== undefined, input.branch_id ?? null],
    );
    if (!r.rows[0]) throw new RecordsError('not_found', 'record_not_found');
    return r.rows[0];
  });
}

export async function deleteRecord(ctx: RecordsCtx, key: string, id: string, restore = false): Promise<void> {
  const object = await getObject(ctx, key);
  await inTx(ctx, object.product_key, async (q) => {
    const r = await q.query(`update core.custom_records set deleted_at = ${restore ? 'null' : 'now()'} where object_id = $1 and id = $2 and deleted_at is ${restore ? 'not null' : 'null'}`, [object.id, id]);
    if (!r.rowCount) throw new RecordsError('not_found', 'record_not_found');
  });
}

export async function transitionRecord(ctx: RecordsCtx, key: string, id: string, to: string, note?: string | null): Promise<{ result: 'done' | 'pending' }> {
  const object = await getObject(ctx, key);
  return inTx(ctx, object.product_key, async (q) => {
    const r = await q.query<{ r: 'done' | 'pending' }>(`select core.custom_record_transition($1, $2, $3) as r`, [id, to, note ?? null]);
    return { result: r.rows[0]!.r };
  });
}

export async function listApprovals(ctx: RecordsCtx) {
  return inTx(ctx, 'core', async (q) =>
    (await q.query(`select a.id, a.title, a.summary, a.requested_by_name, a.created_at, a.linked_id as record_id, a.data->>'object_key' as object_key,
                           a.data->>'from' as from_state, a.data->>'to' as to_state from core.custom_record_approvals() a`)).rows);
}

export async function decideApproval(ctx: RecordsCtx, requestId: string, ok: boolean, comment?: string | null) {
  return inTx(ctx, 'core', async (q) => ({ result: (await q.query<{ d: string }>(`select core.custom_record_decide($1, $2, $3) as d`, [requestId, ok, comment ?? null])).rows[0]!.d }));
}

// ---------------------------------------------------------------- export
const csvCell = (v: unknown): string => {
  let s = v === null || v === undefined ? '' : Array.isArray(v) ? v.join('; ') : typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // spreadsheet formula injection
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** CSV of every row the person may see that matches the filters (10 000 at most), logged in audit.log and the history. */
export async function exportCsv(ctx: RecordsCtx, key: string, lq: ListQuery = {}): Promise<{ filename: string; csv: string; rows: number }> {
  const object = await getObject(ctx, key);
  if (!object.access.export) throw new RecordsError('forbidden', 'cannot_export');
  const { where, order, params } = listSql(object, lq, ctx.userId);
  return inTx(ctx, object.product_key, async (q) => {
    const rows = (await q.query<RecordRow>(`select ${RECORD_COLS} from core.custom_records r where ${where} order by ${order} limit 10000`, params)).rows;
    const labels = await linkLabels(q, object, rows);
    const head = [...object.fields.map((f) => f.label), ...(object.states ? ['State'] : []), 'Created', 'Updated'];
    const stateLabel = (s: string | null) => object.states?.list.find((x) => x.key === s)?.label ?? s ?? '';
    const lines = rows.map((r) => [
      ...object.fields.map((f) => {
        const v = r.data[f.key];
        return (RECORD_LINK_TYPES as readonly string[]).includes(f.type) && typeof v === 'string' ? labels[v] ?? v : v;
      }),
      ...(object.states ? [stateLabel(r.state)] : []),
      r.created_at,
      r.updated_at,
    ]);
    await q.query(`select core.custom_records_log_export($1, $2, 'csv')`, [object.id, rows.length]);
    const csv = [head, ...lines].map((l) => l.map(csvCell).join(',')).join('\r\n') + '\r\n';
    return { filename: `${object.key}-${new Date().toISOString().slice(0, 10)}.csv`, csv: `\uFEFF${csv}`, rows: rows.length };
  });
}

// ---------------------------------------------------------------- lookups for link fields and the builder
export async function lookup(ctx: RecordsCtx, type: string, term = '', limit = 20): Promise<{ id: string; label: string }[]> {
  const like = `%${term.trim().slice(0, 60).replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  const sql: Record<string, string> = {
    person: `select id, full_name as label from core.staff where deleted_at is null and status <> 'left' and full_name ilike $1 order by full_name limit $2`,
    learner: `select id, full_name || coalesce(' (' || admission_no || ')', '') as label from core.students where deleted_at is null and (full_name ilike $1 or admission_no ilike $1) order by full_name limit $2`,
    section: `select s.id, coalesce(p.name || ' ', '') || s.name as label from core.sections s left join core.programmes p on p.org_id = s.org_id and p.id = s.programme_id
               where s.deleted_at is null and (coalesce(p.name || ' ', '') || s.name) ilike $1 order by p.seq nulls last, p.name, s.name limit $2`,
    branch: `select id, name as label from core.branches where name ilike $1 order by name limit $2`,
    file: `select id, file_name as label from core.files where deleted_at is null and file_name ilike $1 order by created_at desc limit $2`,
  };
  if (!sql[type]) throw new RecordsError('invalid', 'unknown_lookup');
  return inTx(ctx, 'core', async (q) => (await q.query<{ id: string; label: string }>(sql[type]!, [like, Math.min(Math.max(limit, 1), 50)])).rows);
}

/** Roles of the school's products, for permission rules in the builder (management only). */
export async function listRoles(ctx: RecordsCtx): Promise<{ product: string; key: string; name: string }[]> {
  if (!(await managedProducts(ctx)).length) throw new RecordsError('forbidden', 'management_only');
  return inTx(ctx, 'core', async (q) =>
    (await q.query<{ product: string; key: string; name: string }>(
      `select r.product_key as product, r.key, r.name from core.roles r
        where r.org_id = app.current_org_id() and app.org_has_product(r.org_id, r.product_key) and r.key not in ('os_system','portal')
        order by r.product_key, r.name`)).rows);
}
