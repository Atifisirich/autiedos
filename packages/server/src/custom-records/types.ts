import type { RecordField, RecordPermission, RecordStates } from '@autoed/shared';

export type ProductKey = 'crm' | 'os' | 'erp';

export class RecordsError extends Error {
  constructor(
    public code: 'unauthorized' | 'forbidden' | 'not_found' | 'invalid' | 'conflict' | 'password_change_required',
    message?: string,
    public details?: unknown,
  ) {
    super(message ?? code);
  }
  get status() {
    return { unauthorized: 401, forbidden: 403, not_found: 404, invalid: 422, conflict: 409, password_change_required: 403 }[this.code];
  }
}

export interface ObjectRow {
  id: string;
  org_id: string;
  product_key: 'core' | ProductKey;
  key: string;
  label_singular: string;
  label_plural: string;
  labels_i18n: Record<string, { singular: string; plural: string }>;
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
  created_at: string;
  updated_at: string;
}

export interface Access {
  view: 'all' | 'own' | null;
  create: 'all' | 'own' | null;
  edit: 'all' | 'own' | null;
  delete: 'all' | 'own' | null;
  export: 'all' | 'own' | null;
  manage: boolean;
}

export interface ObjectWithAccess extends ObjectRow {
  access: Access;
}

export interface RecordRow {
  id: string;
  object_id: string;
  branch_id: string | null;
  data: Record<string, unknown>;
  state: string | null;
  pending_state: string | null;
  pending_approval_id: string | null;
  owner_id: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  /** id -> display label for link fields (staff, learners, sections, branches, files) */
  labels?: Record<string, string>;
  can_edit?: boolean;
  can_delete?: boolean;
}

export interface ListQuery {
  q?: string;
  state?: string;
  mine?: boolean;
  sort?: string;
  dir?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
  /** field key -> value (choice / text / link equality, yes_no, multi_choice contains); `<key>.from` / `<key>.to` for dates and numbers */
  filters?: Record<string, string>;
  includeDeleted?: boolean;
}

/** Maps a database error raised by the engine's triggers and functions onto RecordsError. */
export function fromDbError(e: unknown): never {
  if (e instanceof RecordsError) throw e;
  const err = e as { code?: string; message?: string; constraint?: string };
  const msg = (err.message ?? '').replace(/^(custom_records|custom_objects): /, '');
  if (err.code === '42501') throw new RecordsError('forbidden', msg || 'forbidden');
  if (err.code === '23514' || err.code === '22023' || err.code === '22P02') throw new RecordsError('invalid', msg, msg.split('; '));
  if (err.code === '23505') throw new RecordsError('conflict', err.constraint?.includes('key') ? 'an object with this key already exists' : msg);
  if (err.code === '23503') throw new RecordsError('invalid', 'a linked row does not exist in this school');
  throw e;
}
