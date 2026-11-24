/**
 * Legal holds (retention schedule principle 3): a hold suspends erasure, retention purge and deletion.
 * Written as platform_admin_server with the signed-in user's claims; the policies on core.legal_holds decide who may
 * (platform admins, or an org member holding compliance.manage).
 */
import { guarded, type ComplianceDb } from './db';
import { ComplianceError, PERSON_TYPES, type PersonType } from './types';

export interface HoldInput {
  orgId: string;
  scope: 'org' | 'person' | 'table';
  reason: string;
  personType?: PersonType;
  personId?: string;
  schema?: string;
  table?: string;
}

export interface Hold {
  id: string;
  org_id: string;
  scope: string;
  person_type: string | null;
  person_id: string | null;
  schema_name: string | null;
  table_name: string | null;
  reason: string;
  placed_by: string | null;
  placed_at: string;
  released_at: string | null;
}

export async function placeHold(db: ComplianceDb, actorUserId: string, i: HoldInput): Promise<string> {
  if (i.personType && !PERSON_TYPES.includes(i.personType)) throw new ComplianceError('invalid', 'unknown person type');
  return guarded(() =>
    db.run('platform_admin_server', { actorUserId }, async (q) => {
      const r = await q.query<{ id: string }>(
        `insert into core.legal_holds (org_id, scope, person_type, person_id, schema_name, table_name, reason, placed_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
        [i.orgId, i.scope, i.personType ?? null, i.personId ?? null, i.schema ?? null, i.table ?? null, i.reason, actorUserId],
      );
      return r.rows[0]!.id;
    }),
  ).catch((e: unknown) => {
    const err = e as { code?: string; message?: string };
    if (err.code === '23514' || err.code === '42501') throw new ComplianceError(err.code === '42501' ? 'forbidden' : 'invalid', err.message ?? 'hold refused');
    throw e;
  });
}

export async function releaseHold(db: ComplianceDb, actorUserId: string, holdId: string, reason: string): Promise<void> {
  const n = await db.run('platform_admin_server', { actorUserId }, async (q) =>
    (await q.query(`update core.legal_holds set released_at = now(), released_by = $2, release_reason = $3 where id = $1 and released_at is null`, [holdId, actorUserId, reason])).rowCount,
  );
  if (!n) throw new ComplianceError('not_found', 'no open hold with that id (or not allowed)');
}

export async function listHolds(db: ComplianceDb, actorUserId: string, orgId: string, openOnly = true): Promise<Hold[]> {
  return db.run('platform_admin_server', { actorUserId }, async (q) =>
    (await q.query<Hold>(`select * from core.legal_holds where org_id = $1 ${openOnly ? 'and released_at is null' : ''} order by placed_at desc`, [orgId])).rows,
  );
}
