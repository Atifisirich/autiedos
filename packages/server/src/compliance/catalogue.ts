/**
 * The catalogue check (data-subject-rights-procedure.md 5.5): every table that has a column identifying a person
 * must be in core.pii_registry, either as `personal` (with the person type and key column the export and erase tools
 * use) or as a reviewed `exempt` row with a reason. CI runs findUnregisteredTables(); a table that is not registered
 * fails the build, so new tables cannot dodge export and erasure.
 *
 * The column patterns are deliberately broad: a false positive costs one registry row, a false negative is a table
 * that is never exported or erased.
 */
import type { Queryable } from './db';

/** Column names that identify a person (matched per underscore-separated token group). */
export const PERSONAL_COLUMN_PATTERN =
  /(^|_)(first_name|last_name|full_name|display_name|date_of_birth|birth_date|user_agent|ip_address)(_|$)|(^|_)(email|phone|mobile|msisdn|whatsapp|dob|aadhaar|aadhar|passport|address|contact|photo|guardian_id|parent_id|father_name|mother_name|student_id|learner_id|staff_id|lead_id|person_id|user_id|owner_id|ip)(_|$)/;

/** Schemas whose tables hold client or AutoEd personal data. audit and private are scrubbed or purged, not registered. */
export const REGISTRY_SCHEMAS = ['core', 'crm', 'os', 'erp', 'billing'] as const;

export interface UnregisteredTable {
  schema: string;
  table: string;
  columns: string[];
}

/** Tables with a person-identifying column and no platform-default registry row. Empty means the catalogue is covered. */
export async function findUnregisteredTables(q: Queryable): Promise<UnregisteredTable[]> {
  const cols = await q.query<{ schema: string; table: string; column: string }>(
    `select n.nspname::text as schema, c.relname::text as "table", a.attname::text as "column"
       from pg_catalog.pg_class c
       join pg_catalog.pg_namespace n on n.oid = c.relnamespace
       join pg_catalog.pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
      where c.relkind in ('r','p') and n.nspname = any($1)
      order by 1, 2, a.attnum`,
    [REGISTRY_SCHEMAS],
  );
  const found = new Map<string, UnregisteredTable>();
  for (const r of cols.rows) {
    if (!PERSONAL_COLUMN_PATTERN.test(r.column)) continue;
    const k = `${r.schema}.${r.table}`;
    const e = found.get(k) ?? { schema: r.schema, table: r.table, columns: [] };
    e.columns.push(r.column);
    found.set(k, e);
  }
  const reg = await q.query<{ k: string }>(`select distinct schema_name || '.' || table_name as k from core.pii_registry where org_id is null`);
  const have = new Set(reg.rows.map((r) => r.k));
  return [...found.entries()].filter(([k]) => !have.has(k)).map(([, v]) => v);
}

/**
 * Registry rows that point at something that no longer exists or cannot work: a dropped table or column, an
 * anonymise on a NOT NULL column without a replacement value, a key column that is not on the table.
 */
export async function findRegistryProblems(q: Queryable): Promise<string[]> {
  const problems: string[] = [];
  const reg = await q.query<{
    id: string; schema_name: string; table_name: string; classification: string; person_type: string | null; key_column: string | null;
    filter_column: string | null; contact_columns: string[]; pii_columns: string[]; anonymise_values: Record<string, unknown>; erasure_mode: string;
  }>(`select id, schema_name, table_name, classification, person_type, key_column, filter_column, contact_columns, pii_columns, anonymise_values, erasure_mode from core.pii_registry where org_id is null`);
  const cols = await q.query<{ schema: string; table: string; column: string; notnull: boolean; hasdefault: boolean }>(
    `select n.nspname::text as schema, c.relname::text as "table", a.attname::text as "column", a.attnotnull as notnull, a.atthasdef as hasdefault
       from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
       join pg_catalog.pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
      where c.relkind in ('r','p') and n.nspname = any($1)`,
    [REGISTRY_SCHEMAS],
  );
  const byTable = new Map<string, Map<string, { notnull: boolean }>>();
  for (const c of cols.rows) {
    const k = `${c.schema}.${c.table}`;
    if (!byTable.has(k)) byTable.set(k, new Map());
    byTable.get(k)!.set(c.column, { notnull: c.notnull });
  }
  for (const r of reg.rows) {
    const k = `${r.schema_name}.${r.table_name}`;
    const t = byTable.get(k);
    if (!t) {
      problems.push(`${k}: registered but the table does not exist`);
      continue;
    }
    if (r.classification === 'exempt') continue;
    const need = [r.key_column, r.filter_column, ...r.contact_columns, ...r.pii_columns, ...Object.keys(r.anonymise_values)].filter((x): x is string => !!x);
    for (const c of need) if (!t.has(c)) problems.push(`${k}: registered column ${c} does not exist`);
    if (!t.has('org_id')) problems.push(`${k}: has no org_id, so exports and erasure cannot be scoped to an organisation`);
    if (r.erasure_mode === 'anonymise') {
      for (const c of new Set([...r.pii_columns, ...Object.keys(r.anonymise_values)])) {
        if (t.get(c)?.notnull && !(c in r.anonymise_values)) problems.push(`${k}: anonymise sets ${c} to null but it is NOT NULL; add a replacement to anonymise_values`);
      }
    }
  }
  const pol = await q.query<{ schema_name: string; table_name: string }>(`select schema_name, table_name from core.table_policy where org_id is null`);
  for (const p of pol.rows) {
    if (!byTable.has(`${p.schema_name}.${p.table_name}`) && p.schema_name !== 'audit') problems.push(`${p.schema_name}.${p.table_name}: table_policy row but the table does not exist`);
  }
  return problems;
}
