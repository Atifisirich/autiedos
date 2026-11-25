'use client';
/**
 * Client of the custom records API (/api/records, docs/custom-records.md). The platform session cookie is sent by the
 * browser; the server runs every call as a product role with the person's claims.
 */
import type { RecordObjectInput, RecordField, RecordPermission, RecordStates } from '@autoed/shared';

export class RecordsApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    public detail?: string,
    public issues?: { path: string; message: string }[] | string[],
  ) {
    super(code);
  }
}

export type Level = 'all' | 'own' | null;
export interface Access { view: Level; create: Level; edit: Level; delete: Level; export: Level; manage: boolean }
export interface RecordObject {
  id: string;
  key: string;
  product_key: 'core' | 'crm' | 'os' | 'erp';
  label_singular: string;
  label_plural: string;
  description: string | null;
  icon: string;
  fields: RecordField[];
  title_field: string | null;
  list_columns: string[];
  form_layout: { title?: string; fields: string[] }[] | null;
  permissions: RecordPermission[];
  states: RecordStates | null;
  portal: { enabled: boolean; learner_field?: string | null };
  schedule: { reminder?: { date_field: string; days_before: number } | null } | null;
  archived: boolean;
  version: number;
  access: Access;
}
export interface RecordItem {
  id: string;
  branch_id: string | null;
  data: Record<string, unknown>;
  state: string | null;
  pending_state: string | null;
  pending_approval_id: string | null;
  owner_id: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  can_edit?: boolean;
  can_delete?: boolean;
}
export interface HistoryItem { id: string; kind: string; from_state: string | null; to_state: string | null; changes: Record<string, { from?: unknown; to?: unknown }> | null; note: string | null; actor: string | null; created_at: string }
export interface Approval { id: string; title: string; summary: string | null; requested_by_name: string | null; created_at: string; record_id: string; object_key: string; from_state: string; to_state: string }

export async function recordsApi<T = unknown>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/records${path}`, {
    method,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify(body ?? {}),
  });
  if (res.status === 401 && typeof window !== 'undefined') {
    window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname)}`);
    throw new RecordsApiError(401, 'unauthorized');
  }
  const data = (await res.json().catch(() => null)) as { error?: string; message?: string; details?: { path: string; message: string }[] | string[] } | null;
  if (res.status === 403 && data?.error === 'password_change_required' && typeof window !== 'undefined') window.location.assign('/account/password');
  if (!res.ok) throw new RecordsApiError(res.status, data?.error ?? 'error', data?.message, data?.details);
  return data as T;
}

export const qs = (params: Record<string, string | number | boolean | undefined | null>) => {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : '';
};

export type { RecordObjectInput, RecordField, RecordPermission, RecordStates };
