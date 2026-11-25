/** Shapes returned by the designer API (/api/os/designer/*). */
export interface Line {
  messageKey: string;
  vars?: Record<string, string | number>;
}

export interface OpView {
  op: 'create' | 'update' | 'delete';
  block: string;
  product: string;
  key: string;
  title: Line;
  lines: Line[];
  roles: string[];
  families: boolean;
  people: number;
  family_count: number;
  reason?: string;
}

export interface Changeset {
  id: string;
  status: 'draft' | 'validated' | 'published' | 'reverted' | 'rejected';
  source: 'prompt' | 'template';
  template_key: string | null;
  prompt: string;
  author_kind: 'org_admin' | 'relationship_manager';
  version: number | null;
  credits: number;
  created_at: string;
  plan: { summary: string; ops: unknown[]; unsupported: { product: string; request: string; note: string }[]; questions: string[] };
  preview: { summary: string; ops: OpView[]; unsupported: { product: string; request: string; note: string }[]; questions: string[]; totals: { ops: number; roles: string[]; people: number; families: number } };
  issues: { op: number | null; code: string; detail?: string }[];
}

export interface HistoryRow {
  id: string;
  status: Changeset['status'];
  version: number | null;
  source: string;
  template_key: string | null;
  author_kind: Changeset['author_kind'];
  created_at: string;
  published_at: string | null;
  summary: string | null;
  ops: number;
  prompt: string;
}

export interface Who {
  kind: 'org_admin' | 'relationship_manager' | 'platform' | 'none';
  org?: { id: string; name: string };
  branch_id?: string;
  branches?: { id: string; code: string; name: string }[];
  products?: string[];
  support_session_id?: string | null;
  read_only?: boolean;
  needs_session?: boolean;
  expired?: boolean;
  reason?: string;
  lang?: string;
}

export interface TemplateView {
  key: string;
  product: string;
  title: string;
  description: string;
  params: { key: string; labelKey: string; type: 'number' | 'time' | 'role' | 'text' | 'boolean'; default: unknown }[];
  available: boolean;
}

export interface DryRun {
  ok: boolean;
  error?: string;
  ops: { seq: number; block: string; key: string; op: string; lines: Line[] }[];
}
