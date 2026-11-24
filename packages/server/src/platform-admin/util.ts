import { addDays, fromLocal, toLocal } from '@autoed/shared';
import { q, type Tx } from './db';
import { invalid, notFound } from './errors';

export const IST = 'Asia/Kolkata';

export function istToday(now: Date): string {
  return toLocal(now, IST).date;
}

/** Instant at which the (inclusive) date `isoDate` is over, in IST: the start of the next day. */
export function endOfDateIST(isoDate: string): Date {
  return fromLocal(addDays(isoDate, 1), '00:00', IST);
}

/** Last IST date on which access still applied for something that stopped at instant `stamp`. */
export function lastAccessDate(stamp: Date): string {
  return toLocal(new Date(stamp.getTime() - 1), IST).date;
}

/** Named, audited console event (row changes are also logged by the table triggers). */
export async function logEvent(c: Tx, orgId: string | null, action: string, detail: Record<string, unknown> = {}, rowId: string | null = null): Promise<void> {
  await c.query(`select app.admin_log_event($1, $2, $3::jsonb, $4)`, [orgId, action, JSON.stringify(detail), rowId]);
}

export interface OrgRow {
  id: string;
  name: string;
  slug: string;
  kind: string;
  legal_name: string | null;
  time_zone: string;
  default_locale: string;
  status: 'active' | 'closed';
  created_at: string;
  updated_at: string;
}

export async function requireOrg(c: Tx, orgId: string): Promise<OrgRow> {
  const r = (await q<OrgRow>(c, `select id, name, slug, kind, legal_name, time_zone, default_locale, status, created_at, updated_at from core.organizations where id = $1`, [orgId]))[0];
  if (!r) throw notFound('client_not_found');
  return r;
}

export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

export function needUuid(v: unknown, code = 'invalid_id'): string {
  if (!isUuid(v)) throw invalid(code);
  return v;
}
