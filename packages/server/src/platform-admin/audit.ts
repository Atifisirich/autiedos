/**
 * Audit viewer: audit.log (row changes and named events) and audit.config_history (entitlement and configuration
 * changes), with filters and keyset paging. Read only.
 */
import { q, type Tx } from './db';

export interface AuditFilters {
  source: 'log' | 'config';
  org_id?: string;
  actor?: string;
  action?: string;
  table?: string;
  row_id?: string;
  from?: string;
  to?: string;
  q?: string;
  before_id?: number;
  limit: number;
}

export async function queryAudit(c: Tx, f: AuditFilters) {
  const config = f.source === 'config';
  const params: unknown[] = [];
  const where: string[] = [];
  const add = (sql: string, v: unknown) => {
    params.push(v);
    where.push(sql.replaceAll('?', `$${params.length}`));
  };
  if (f.org_id) add('l.org_id = ?', f.org_id);
  if (f.actor) add('l.actor_user_id = ?', f.actor);
  if (f.action) add(config ? 'l.action = ?' : `(l.action = ? or l.action like ? || '.%')`, f.action);
  if (f.table) add('l.table_name = ?', f.table);
  if (f.row_id) add('l.row_id = ?', f.row_id);
  if (f.from) add('l.created_at >= ?::timestamptz', f.from);
  if (f.to) add('l.created_at < ?::timestamptz', f.to);
  if (f.before_id) add('l.id < ?', f.before_id);
  if (f.q) add(config ? `(coalesce(l.before::text,'') || coalesce(l.after::text,'')) ilike '%' || ? || '%'` : `(coalesce(l.before::text,'') || coalesce(l.after::text,'') || coalesce(l.detail::text,'')) ilike '%' || ? || '%'`, f.q);
  params.push(f.limit + 1);
  const detailCol = config ? 'null::jsonb as detail' : 'l.detail';
  const sql = `
    select l.id, l.org_id, o.name as org_name, l.actor_user_id, a.name as actor_name, l.support_session_id, l.action,
           l.schema_name, l.table_name, l.row_id, l.before, l.after, ${detailCol}, l.created_at
      from audit.${config ? 'config_history' : 'log'} l
      left join core.organizations o on o.id = l.org_id
      left join core.platform_admins a on a.user_id = l.actor_user_id
     ${where.length ? `where ${where.join(' and ')}` : ''}
     order by l.id desc limit $${params.length}`;
  const rows = await q<{ id: number }>(c, sql, params);
  const more = rows.length > f.limit;
  const page = more ? rows.slice(0, f.limit) : rows;
  return { rows: page, next_before_id: more ? (page[page.length - 1]?.id ?? null) : null };
}
