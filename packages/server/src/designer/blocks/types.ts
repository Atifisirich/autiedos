/**
 * Server side of a designer block: how an instance is read from, written to and removed from the product's own
 * configuration tables. Everything runs in the caller's transaction with the actor's claims (os_server role, RLS and
 * the audit / config-history triggers apply exactly as for the settings screens). Blocks never run SQL given by the AI:
 * settings are validated by the shared zod schema first and every statement here is fixed and parameterised.
 */
import { ValidationError, maybe, q, type Tx } from '../../db';
import type { DesignerActor } from '../actor';

export interface ApplyCtx {
  /** The designer's own transaction: the actor's home product login (os_server when the org has the OS). */
  c: Tx;
  actor: DesignerActor;
  /**
   * The transaction of a product's own server login with the actor's claims (crm_server for CRM blocks, erp_server for
   * ERP blocks; the home product gets c). Opened on first use, committed or rolled back together with c.
   */
  tx(product: 'os' | 'crm' | 'erp'): Promise<Tx>;
}

export type Settings = Record<string, unknown>;

/** The other create / update ops of the same plan (a check may accept what an earlier op of the plan creates). */
export interface PlannedOp {
  block: string;
  settings: Settings;
}

export interface ServerBlock {
  key: string;
  /** Current settings of an instance (shape of the block's settings schema), or null when it does not exist. */
  read(x: ApplyCtx, key: string): Promise<Settings | null>;
  /** Every instance of the school (key + display name): the AI's view of the configuration (names only). */
  list(x: ApplyCtx): Promise<{ key: string; name: string; system?: boolean }[]>;
  /** Create or update the instance so that read() returns these settings. */
  write(x: ApplyCtx, key: string, settings: Settings): Promise<void>;
  /** Remove the instance (soft delete where the table has deleted_at). */
  remove(x: ApplyCtx, key: string): Promise<void>;
  /**
   * Checks against the school's configuration beyond the shared schema (the settings screen's own validation, e.g. the
   * custom records engine's adapter). Issue details; empty = fine. Run when a plan is previewed and again on publish.
   */
  check?(x: ApplyCtx, settings: Settings, op: 'create' | 'update', plan: PlannedOp[]): Promise<string[]>;
  /**
   * Exact state for undo when read() does not capture everything (e.g. report recipients kept as staff ids). Default:
   * read(). restore(capture) must put the instance back exactly; default: write / remove.
   */
  capture?(x: ApplyCtx, key: string): Promise<Settings | null>;
  restore?(x: ApplyCtx, key: string, state: Settings | null): Promise<void>;
}

/** Instance state for undo (capture, else read). */
export async function captureOf(b: ServerBlock, x: ApplyCtx, key: string): Promise<Settings | null> {
  return b.capture ? b.capture(x, key) : b.read(x, key);
}

/** Puts an instance back to a captured state (null = it did not exist). */
export async function restoreTo(b: ServerBlock, x: ApplyCtx, key: string, state: Settings | null): Promise<void> {
  if (b.restore) return b.restore(x, key, state);
  if (state === null) {
    if (await b.read(x, key)) await b.remove(x, key);
    return;
  }
  await b.write(x, key, state);
}

// ---------------------------------------------------------------- helpers shared by the OS blocks
/** OS role id of a role key in the actor's org (refuses unknown keys: same rule as the role pickers). */
export async function osRoleId(x: ApplyCtx, key: string): Promise<string> {
  const r = await maybe<{ id: string }>(x.c, `select id from os.roles where org_id = $1 and key = $2 and deleted_at is null`, [x.actor.orgId, key]);
  if (!r) throw new ValidationError('unknown_role', { role: key });
  return r.id;
}

export async function osRoleKey(c: Tx, id: string | null): Promise<string | null> {
  if (!id) return null;
  return (await maybe<{ key: string }>(c, `select key from os.roles where id = $1`, [id]))?.key ?? null;
}

/** Drops null / undefined optional values so a read() matches the settings after zod defaults. */
export function clean<T extends Settings>(s: T): T {
  return Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined)) as T;
}

/** Postgres time -> 'HH:MM'. */
export const hm = (t: string | null | undefined) => (t ? String(t).slice(0, 5) : null);
/** Numeric column -> number | null. */
export const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

export async function rows<T = Record<string, unknown>>(c: Tx, sql: string, params: unknown[] = []): Promise<T[]> {
  return q<T>(c, sql, params);
}
