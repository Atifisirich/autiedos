/**
 * "View as" support sessions (decision 37: the only way AutoEd staff reach a client's data). The rules live in the
 * database (app.start_support_session): reason of at least 10 characters, 1 to 240 minutes, read-only unless asked,
 * one open session per admin, start and end written to audit.log, every row change tagged with the session id.
 * This module opens and closes sessions and shapes what the banner and the client's own admins see.
 */
import { maybe, q, type Tx } from './db';
import { logEvent, requireOrg } from './util';
import type { AdminDeps } from './deps';

export interface ViewAsBanner {
  id: string;
  org_id: string;
  org_name: string;
  reason: string;
  read_only: boolean;
  started_at: string;
  expires_at: string;
  seconds_left: number;
}

/** The open session of the signed-in admin, or null. Works in any role's transaction that carries the admin's claims. */
export async function currentViewAs(c: Tx): Promise<ViewAsBanner | null> {
  return maybe<ViewAsBanner>(
    c,
    `select s.id, s.org_id, o.name as org_name, s.reason, s.read_only, s.started_at, s.expires_at,
            greatest(0, floor(extract(epoch from (s.expires_at - now()))))::int as seconds_left
       from core.support_sessions s join core.organizations o on o.id = s.org_id
      where s.id = app.support_session_id()`,
  );
}

export async function startViewAs(c: Tx, deps: AdminDeps, orgId: string, input: { reason: string; minutes?: number; read_only: boolean }): Promise<ViewAsBanner> {
  await requireOrg(c, orgId);
  await c.query(`select app.start_support_session($1, $2, $3, $4)`, [orgId, input.reason, input.minutes ?? deps.config.defaultViewAsMinutes, input.read_only]);
  const banner = (await currentViewAs(c))!;
  await logEvent(c, orgId, 'admin.view_as.start', { session_id: banner.id, reason: input.reason, read_only: input.read_only, expires_at: banner.expires_at }, banner.id);
  return banner;
}

export async function endViewAs(c: Tx): Promise<{ ended: boolean }> {
  const had = await currentViewAs(c);
  await c.query(`select app.end_support_session()`);
  if (had) await logEvent(c, had.org_id, 'admin.view_as.end', { session_id: had.id }, had.id);
  return { ended: !!had };
}

export interface SupportSessionRow {
  id: string;
  org_id: string;
  org_name: string;
  admin_name: string | null;
  reason: string;
  read_only: boolean;
  started_at: string;
  expires_at: string;
  ended_at: string | null;
  state: 'open' | 'ended' | 'expired';
}

/** Support sessions across clients (or one client), newest first, for the console. */
export async function listSupportSessions(c: Tx, orgId: string | null, limit = 100): Promise<SupportSessionRow[]> {
  return q<SupportSessionRow>(
    c,
    `select s.id, s.org_id, o.name as org_name, p.name as admin_name, s.reason, s.read_only, s.started_at, s.expires_at, s.ended_at,
            case when s.ended_at is not null then 'ended' when s.expires_at <= now() then 'expired' else 'open' end as state
       from core.support_sessions s join core.organizations o on o.id = s.org_id
       left join core.platform_admins p on p.user_id = s.platform_user_id
      where ($1::uuid is null or s.org_id = $1) order by s.started_at desc limit $2`,
    [orgId, limit],
  );
}

export interface ClientVisibleSession {
  id: string;
  reason: string;
  read_only: boolean;
  started_at: string;
  expires_at: string;
  ended_at: string | null;
  state: 'open' | 'ended' | 'expired';
}

/**
 * For the CLIENT's admins: the support-access log of their own organisation (plan 4.4). Run it inside any product
 * server's request transaction with the client admin's claims; RLS (audit.view in any product) decides who sees rows.
 * The AutoEd staff member's name is deliberately not exposed to the client.
 */
export async function clientSupportSessions(c: Tx, limit = 50): Promise<ClientVisibleSession[]> {
  return q<ClientVisibleSession>(
    c,
    `select s.id, s.reason, s.read_only, s.started_at, s.expires_at, s.ended_at,
            case when s.ended_at is not null then 'ended' when s.expires_at <= now() then 'expired' else 'open' end as state
       from core.support_sessions s where s.org_id = app.current_org_id() order by s.started_at desc limit $1`,
    [limit],
  );
}
