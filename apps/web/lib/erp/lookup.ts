/**
 * Cross-schema lookups. PostgREST embeds only inside one schema, so an erp row that points at a core row (student, staff, section, subject ...)
 * gets its label from a second batched query. `look` fetches many tables at once and returns name helpers.
 */
import { core } from './db';
import type { Ctx } from './ctx';
import type { Row } from './crud';

const SELECT: Record<string, string> = {
  students: 'id, first_name, last_name, admission_no, section_id, programme_id, household_id, status, roll_no, branch_id, gender, dob, house',
  staff: 'id, first_name, last_name, employee_code, email, phone, branch_id, position_id, department_id, user_id, status',
  sections: 'id, name, programme_id, class_teacher_id',
  subjects: 'id, name, code',
  programmes: 'id, name, branch_id, level',
  rooms: 'id, name, branch_id',
  households: 'id, family_name, phone, email, address, city',
  guardians: 'id, name, relation, phone, email, household_id, user_id',
  branches: 'id, name, code',
  academic_years: 'id, name',
  departments: 'id, name',
  positions: 'id, name',
  files: 'id, file_name, storage_path, mime',
};
export type LookupTable = keyof typeof SELECT;

const labelOf: Record<string, (r: Row) => string> = {
  students: (r) => `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim(),
  staff: (r) => `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim(),
  households: (r) => String(r.family_name ?? ''),
  files: (r) => String(r.file_name ?? ''),
};
export const nameOf = (table: string, r: Row | undefined | null) => (r ? (labelOf[table] ? labelOf[table]!(r) : String(r.name ?? '')) : '');

export type Looked = { rows: Map<string, Row>; name: (id: unknown) => string; get: (id: unknown) => Row | undefined };

/** Fetch the rows of `table` with these ids (one query, chunked) and return lookup helpers. */
export async function lookup(ctx: Ctx, table: LookupTable, ids: unknown[]): Promise<Looked> {
  const uniq = [...new Set(ids.filter((x): x is string => typeof x === 'string' && x.length > 0))];
  const rows = new Map<string, Row>();
  for (let i = 0; i < uniq.length; i += 150) {
    const { data } = await core(ctx.sb).from(table).select(SELECT[table]!).in('id', uniq.slice(i, i + 150));
    for (const r of (data ?? []) as unknown as Row[]) rows.set(String(r.id), r);
  }
  return { rows, name: (id) => nameOf(table, rows.get(String(id))), get: (id) => rows.get(String(id)) };
}

/** Several tables at once: look(ctx, { students: ids, sections: ids }). */
export async function look<K extends LookupTable>(ctx: Ctx, spec: Record<K, unknown[]>) {
  const entries = await Promise.all((Object.entries(spec) as [K, unknown[]][]).map(async ([t, ids]) => [t, await lookup(ctx, t, ids)] as const));
  return Object.fromEntries(entries) as Record<K, Looked>;
}

/** All active rows of a small core table as { id, label } options. */
export async function options(ctx: Ctx, table: LookupTable, opts: { branch?: boolean; filter?: (r: Row) => boolean; order?: string } = {}) {
  let q = core(ctx.sb).from(table).select(SELECT[table]!).order(opts.order ?? (table === 'students' || table === 'staff' ? 'first_name' : 'name')).limit(2000);
  if (table !== 'branches' && table !== 'academic_years') q = q.is('deleted_at', null);
  if (table === 'students') q = q.in('status', ['active', 'admitted']);
  if (table === 'staff') q = q.eq('status', 'active');
  if (opts.branch && ctx.branchId) q = q.or(`branch_id.eq.${ctx.branchId},branch_id.is.null`);
  const { data } = await q;
  const rows = ((data ?? []) as unknown as Row[]).filter(opts.filter ?? (() => true));
  return rows.map((r) => ({ value: String(r.id), label: nameOf(table, r), row: r }));
}
