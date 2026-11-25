/**
 * CHANGESET: what the AI proposes and what is published. A list of operations, each creating, updating or deleting
 * one instance of a catalogue block, referring to existing configuration by stable keys (never by database ids).
 *
 *   { summary, ops: [{ op: 'create', block: 'os.checklist', key: 'daily_opening', settings: {...} }], unsupported, questions }
 *
 * validateChangeset() checks every op against its block (schema + business checks + the school's current
 * configuration); repairChangeset() applies deterministic fixes; inverseOp() gives the undo of an applied op.
 */
import { z } from 'zod';
import { DESIGNER_PRODUCTS, getBlock, listBlocks, type BlockDef, type DesignerProduct, type OpKind, type PreviewLine } from './catalogue';
import { zodToJsonSchema, type JsonSchema } from './jsonSchema';

export const OP_KINDS = ['create', 'update', 'delete'] as const;

export const changeOpSchema = z.object({
  op: z.enum(OP_KINDS),
  block: z.string().regex(/^(os|crm|erp|core)\.[a-z][a-z0-9_]*$/),
  /** Stable instance key (the block's keyOf(settings) for create/update). */
  key: z.string().trim().min(1).max(160),
  /** Required for create and update; ignored for delete. */
  settings: z.record(z.string(), z.unknown()).nullable().optional(),
  /** One plain sentence: why this op is part of the plan. */
  reason: z.string().max(400).optional(),
});
export type ChangeOp = z.infer<typeof changeOpSchema>;

export const unsupportedSchema = z.object({
  product: z.enum(DESIGNER_PRODUCTS),
  request: z.string().max(400),
  note: z.string().max(600),
});

export const changesetSchema = z.object({
  summary: z.string().trim().min(1).max(800),
  ops: z.array(changeOpSchema).max(40),
  /** Parts of the request that need a product or block AutoEd does not have yet. */
  unsupported: z.array(unsupportedSchema).max(10).default([]),
  /** Questions back to the school when the request is unclear. */
  questions: z.array(z.string().max(400)).max(5).default([]),
  /** The starter template the plan came from, if any. */
  template_key: z.string().max(80).nullable().optional(),
});
export type Changeset = z.infer<typeof changesetSchema>;

/** What the planner knows about the school's configuration (keys only). */
export interface KnownConfig {
  /** Products the school has (and the user was given). */
  products: string[];
  /** Role keys per product, e.g. { os: ['principal', ...] }. */
  roles: Record<string, string[]>;
  /** Existing instance keys per block. */
  instances: Record<string, string[]>;
  /** Branch codes the user can act in (module flags). */
  branches?: string[];
  /** Instance keys that are system rows (cannot be deleted). */
  system?: Record<string, string[]>;
}

export interface Issue {
  /** Index of the op (null: the changeset as a whole). */
  op: number | null;
  code: string;
  detail?: string;
}

export interface ValidatedOp {
  op: OpKind;
  block: string;
  product: DesignerProduct;
  key: string;
  settings: Record<string, unknown> | null;
  reason?: string;
}

export interface Validation {
  ok: boolean;
  ops: ValidatedOp[];
  issues: Issue[];
}

/** Issue codes the AI can fix by regenerating (the planner asks again up to the attempt limit). */
export const AI_FIXABLE = new Set(['unknown_block', 'invalid_settings', 'missing_settings', 'key_mismatch', 'duplicate_op', 'op_not_allowed', 'block_check']);

export function validateChangeset(cs: Changeset, known?: KnownConfig): Validation {
  const issues: Issue[] = [];
  const ops: ValidatedOp[] = [];
  const seen = new Set<string>();
  cs.ops.forEach((raw, i) => {
    const block = getBlock(raw.block);
    if (!block) return issues.push({ op: i, code: 'unknown_block', detail: raw.block });
    if (block.stub) return issues.push({ op: i, code: 'block_not_available', detail: raw.block });
    if (block.ops && !block.ops.includes(raw.op)) return issues.push({ op: i, code: 'op_not_allowed', detail: `${raw.op} ${raw.block}` });
    if (known && !known.products.includes(block.product) && block.product !== 'core') issues.push({ op: i, code: 'product_not_available', detail: block.product });
    const id = `${raw.block}:${raw.key}`;
    if (seen.has(id)) issues.push({ op: i, code: 'duplicate_op', detail: id });
    seen.add(id);
    const exists = known ? (known.instances[raw.block] ?? []).includes(raw.key) : null;
    if (raw.op === 'delete') {
      if (exists === false) issues.push({ op: i, code: 'not_found', detail: id });
      if (known?.system?.[raw.block]?.includes(raw.key)) issues.push({ op: i, code: 'system_item', detail: id });
      ops.push({ op: 'delete', block: block.key, product: block.product, key: raw.key, settings: null, reason: raw.reason });
      return;
    }
    if (!raw.settings) return issues.push({ op: i, code: 'missing_settings', detail: id });
    const parsed = block.settings.safeParse(raw.settings);
    if (!parsed.success) {
      return issues.push({ op: i, code: 'invalid_settings', detail: parsed.error.issues.slice(0, 4).map((x) => `${x.path.join('.')}: ${x.message}`).join('; ') });
    }
    const settings = parsed.data as Record<string, unknown>;
    const key = block.keyOf(settings);
    if (key !== raw.key) issues.push({ op: i, code: 'key_mismatch', detail: `${raw.key} != ${key}` });
    if (raw.op === 'update' && exists === false) issues.push({ op: i, code: 'not_found', detail: id });
    if (raw.op === 'create' && exists === true) issues.push({ op: i, code: 'already_exists', detail: id });
    for (const code of block.check?.(settings, raw.op) ?? []) issues.push({ op: i, code: 'block_check', detail: code });
    if (known) {
      const roles = known.roles[block.product === 'core' ? 'os' : block.product] ?? [];
      for (const r of block.roles?.(settings) ?? []) if (!roles.includes(r)) issues.push({ op: i, code: 'unknown_role', detail: r });
      if (block.key === 'os.module_flag' && known.branches && !known.branches.includes(String(settings.branch_code))) issues.push({ op: i, code: 'unknown_branch', detail: String(settings.branch_code) });
    }
    ops.push({ op: raw.op, block: block.key, product: block.product, key, settings, reason: raw.reason });
  });
  if (!cs.ops.length) issues.push({ op: null, code: 'no_changes' });
  return { ok: issues.length === 0, ops, issues };
}

/**
 * Deterministic fixes before validation: the instance key is taken from the settings, a "create" of something
 * that already exists becomes an "update" (and the reverse), and ops on blocks that are not available yet move to
 * the "unsupported" list instead of failing the whole plan.
 */
export function repairChangeset(cs: Changeset, known?: KnownConfig): Changeset {
  const unsupported = [...cs.unsupported];
  const ops: ChangeOp[] = [];
  for (const raw of cs.ops) {
    const block = getBlock(raw.block);
    if (!block) {
      ops.push(raw);
      continue;
    }
    if (block.stub || (known && block.product !== 'core' && !known.products.includes(block.product))) {
      unsupported.push({ product: block.product, request: raw.reason ?? block.title, note: block.stub ? 'stub_block' : 'product_not_in_plan' });
      continue;
    }
    let op = { ...raw };
    if (op.op !== 'delete' && op.settings) {
      const parsed = block.settings.safeParse(op.settings);
      if (parsed.success) op = { ...op, key: block.keyOf(parsed.data) };
    }
    if (known) {
      const exists = (known.instances[op.block] ?? []).includes(op.key);
      if (op.op === 'create' && exists) op.op = 'update';
      else if (op.op === 'update' && !exists) op.op = 'create';
    }
    ops.push(op);
  }
  return { ...cs, ops, unsupported };
}

/**
 * The undo of an applied op, from the instance's state before it (null = did not exist).
 * create -> delete; update -> update back to `before` (or delete when it did not exist); delete -> create `before`.
 */
export function inverseOp(op: Pick<ChangeOp, 'op' | 'block' | 'key'>, before: Record<string, unknown> | null): ChangeOp {
  if (before === null) return { op: 'delete', block: op.block, key: op.key, settings: null };
  return { op: op.op === 'delete' ? 'create' : 'update', block: op.block, key: op.key, settings: before };
}

/** Undo of a whole applied changeset: inverse ops in reverse order. */
export function inverseChangeset(items: { op: ChangeOp; before: Record<string, unknown> | null }[]): ChangeOp[] {
  return [...items].reverse().map((i) => inverseOp(i.op, i.before));
}

/** Stable JSON (sorted keys) for comparing configuration snapshots. */
export function canonical(v: unknown): string {
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.keys(v as Record<string, unknown>)
    .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
    .join(',')}}`;
}

// ---------------------------------------------------------------- preview
export interface OpPreview {
  op: OpKind;
  block: string;
  product: DesignerProduct;
  key: string;
  title: PreviewLine;
  lines: PreviewLine[];
  roles: string[];
  families: boolean;
  reason?: string;
}

/** Plain-language preview of validated ops (before = current settings of updated / deleted instances). */
export function previewOps(ops: ValidatedOp[], before: Record<string, Record<string, unknown> | null> = {}): OpPreview[] {
  return ops.map((o) => {
    const block = getBlock(o.block) as BlockDef;
    const s = (o.op === 'delete' ? before[`${o.block}:${o.key}`] : o.settings) ?? null;
    const name = s ? String(s.name ?? s.title ?? s.label ?? o.key) : o.key;
    return {
      op: o.op,
      block: o.block,
      product: o.product,
      key: o.key,
      title: { messageKey: `designer.op.${o.op}`, vars: { what: block.title, name } },
      lines: s && o.op !== 'delete' ? block.describe(s) : [],
      roles: s ? [...new Set(block.roles?.(s) ?? [])] : [],
      families: s ? !!block.reachesFamilies?.(s) : false,
      reason: o.reason,
    };
  });
}

// ---------------------------------------------------------------- JSON schema for constrained AI output
/** JSON schema of a changeset whose ops may use the given blocks (default: every real block). */
export function changesetJsonSchema(blocks: BlockDef[] = listBlocks()): JsonSchema {
  const opVariants = blocks.flatMap((b) => [
    {
      type: 'object',
      properties: { op: { type: 'string', enum: ['create', 'update'] }, block: { type: 'string', enum: [b.key] }, key: { type: 'string', maxLength: 160 }, settings: zodToJsonSchema(b.settings), reason: { type: 'string', maxLength: 400 } },
      required: ['op', 'block', 'key', 'settings'],
      additionalProperties: false,
    },
  ]);
  const deleteVariant = {
    type: 'object',
    properties: { op: { type: 'string', enum: ['delete'] }, block: { type: 'string', enum: blocks.map((b) => b.key) }, key: { type: 'string', maxLength: 160 }, reason: { type: 'string', maxLength: 400 } },
    required: ['op', 'block', 'key'],
    additionalProperties: false,
  };
  return {
    type: 'object',
    properties: {
      summary: { type: 'string', maxLength: 800 },
      ops: { type: 'array', maxItems: 40, items: { anyOf: [...opVariants, deleteVariant] } },
      unsupported: { type: 'array', maxItems: 10, items: zodToJsonSchema(unsupportedSchema) },
      questions: { type: 'array', maxItems: 5, items: { type: 'string', maxLength: 400 } },
      template_key: { type: ['string', 'null'], maxLength: 80 },
    },
    required: ['summary', 'ops', 'unsupported', 'questions'],
    additionalProperties: false,
  };
}
