/**
 * Calls the CRM API the way the web app does: handle(req) with a platform session token, against real Postgres as the
 * crm_server login. Fixtures (orgs, staff) come from helpers.ts (owner connection).
 */
import { handle, type ApiResponse } from '../src/api';
import { sessionFor } from './helpers';

export type Who = { token: string; userId: string };
export const login = async (userId: string): Promise<Who> => ({ token: await sessionFor(userId), userId });

export async function call(w: Who | null, method: string, path: string, body?: unknown, query: Record<string, string> = {}, headers: Record<string, string> = {}): Promise<ApiResponse & { data: any }> {
  const res = await handle({ method, path, query, headers: { ...(w ? { authorization: `Bearer ${w.token}` } : {}), ...headers }, body: body ?? {} });
  return { ...res, data: res.json ?? (res.text ? res.text.body : null) };
}
export const get = (w: Who | null, path: string, query: Record<string, string> = {}) => call(w, 'GET', path, undefined, query);
export const post = (w: Who | null, path: string, body: unknown = {}) => call(w, 'POST', path, body);

/** A mobile number that no test used yet. */
let n = 0;
export const mobile = () => '97' + String(20000000 + ++n).padStart(8, '0');
