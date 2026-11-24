import { ENTITIES, type EntityDef, type FieldDef } from './entities.gen';
import type { Ctx } from './ctx';

export type Row = Record<string, unknown>;
type Opt = { value: string; label: string };

export function entity(key: string): EntityDef | null {
  return Object.prototype.hasOwnProperty.call(ENTITIES, key) ? ENTITIES[key]! : null;
}
export const entKey = (e: EntityDef) => e.table;
const tableOf = (ctx: Ctx, e: EntityDef) => ctx.sb.schema(e.schema).from(e.table);
export const idCol = (e: EntityDef) => e.idCol ?? 'id';

export function labelOf(ent: EntityDef, row: Row | null | undefined) {
  return row ? ent.label.map((l) => row[l] ?? '').join(' ').trim() : '';
}
export function show(ent: EntityDef, f: FieldDef, row: Row): string {
  const v = row[f.k];
  if (f.t === 'ref') { const r = row[`${f.k}__ref`] as Row | null | undefined; return r ? labelOf(ENTITIES[f.ref!]!, r) : ''; }
  if (v === null || v === undefined) return '';
  if (f.t === 'bool') return v ? 'Yes' : 'No';
  if (f.t === 'json') return JSON.stringify(v);
  if (f.t === 'date') return new Date(String(v)).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
  if (f.t === 'datetime') return new Date(String(v)).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });
  return String(v);
}

/** Resolve the label of every referenced record on a page of rows (one query per reference field), under the caller's permissions. */
export async function attachRefs(ctx: Ctx, ent: EntityDef, rows: Row[], fields: FieldDef[] = ent.fields) {
  await Promise.all(fields.filter((f) => f.t === 'ref' && ENTITIES[f.ref!]).map(async (f) => {
    const target = ENTITIES[f.ref!]!;
    const ids = [...new Set(rows.map((r) => r[f.k]).filter((x): x is string => typeof x === 'string'))];
    if (!ids.length) return;
    const key = idCol(target);
    const { data } = await ctx.sb.schema(target.schema).from(target.table).select([...new Set([key, ...target.label])].join(',')).in(key, ids);
    const map = new Map(((data ?? []) as unknown as Row[]).map((d) => [String(d[key]), d]));
    for (const r of rows) r[`${f.k}__ref`] = map.get(String(r[f.k])) ?? null;
  }));
  return rows;
}

/** Options for every reference field on a form, loaded under the caller's permissions. */
export async function refOptions(ctx: Ctx, ent: EntityDef) {
  const out: Record<string, Opt[]> = {};
  await Promise.all(ent.fields.filter((f) => f.t === 'ref' && ENTITIES[f.ref!]).map(async (f) => {
    const r = ENTITIES[f.ref!]!;
    const key = idCol(r);
    let q = ctx.sb.schema(r.schema).from(r.table).select([...new Set([key, ...r.label])].join(',')).order(r.label[0]!).limit(1000);
    if (r.table === 'students') q = q.in('status', ['active', 'admitted']);
    const { data } = await q;
    out[f.k] = ((data ?? []) as unknown as Row[]).map((d) => ({ value: String(d[key]), label: labelOf(r, d) }));
  }));
  return out;
}

/** Turn a submitted form into a row, coercing by field type. */
export function rowFromForm(ent: EntityDef, fd: FormData) {
  const row: Row = {};
  for (const f of ent.fields) {
    if (f.t === 'bool') { row[f.k] = fd.get(f.k) === 'on'; continue; }
    if (!fd.has(f.k)) continue;
    const raw = String(fd.get(f.k) ?? '').trim();
    if (raw === '') { row[f.k] = null; continue; }
    if (f.t === 'number') row[f.k] = Number(raw);
    else if (f.t === 'json') { try { row[f.k] = JSON.parse(raw); } catch { throw new Error(`${f.label} is not valid JSON.`); } }
    else if (f.t === 'datetime') row[f.k] = new Date(raw + '+05:30').toISOString();
    else row[f.k] = raw;
  }
  return row;
}

/** A list query for an entity with the branch and year filters of the header applied. */
export function listQuery(ctx: Ctx, ent: EntityDef, select = '*', opts: { count?: boolean } = {}) {
  let q = tableOf(ctx, ent).select(select, opts.count ? { count: 'exact' } : undefined).is('deleted_at', null);
  if (ent.branch && ctx.branchId) q = q.or(`branch_id.eq.${ctx.branchId},branch_id.is.null`);
  return q;
}
export { tableOf };
