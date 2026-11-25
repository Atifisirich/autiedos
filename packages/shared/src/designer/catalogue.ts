/**
 * AI school designer (DECISIONS 56-59): the typed BLOCK CATALOGUE.
 *
 * A block is one kind of configuration a school can have (an approval type, a checklist, a leave type...). The AI
 * never writes code or SQL: it only picks blocks from this catalogue and fills their settings, and every setting is
 * validated by the block's zod schema (built from the same shared schemas the settings screens use).
 *
 * Adding a block (another product, docs/designer.md "Add a block"):
 *   1. defineBlock({...}) in packages/shared/src/designer/<product>-blocks.ts and add it to that file's list;
 *   2. register the list in packages/shared/src/designer/index.ts (registerBlocks);
 *   3. implement the server side (read / write / remove) in packages/server/src/designer/blocks/<product>/ and add it
 *      to packages/server/src/designer/blocks/index.ts;
 *   4. add designer.block.<key>.* and the preview keys it uses to packages/shared/src/i18n/source/08-designer.txt.
 */
import type { z, ZodTypeAny } from 'zod';

/** Products a block can belong to ('core' = shared master data, e.g. custom records). */
export const DESIGNER_PRODUCTS = ['os', 'crm', 'erp', 'core'] as const;
export type DesignerProduct = (typeof DESIGNER_PRODUCTS)[number];

/** One line of a plain-language preview: an i18n key (designer.preview.*) and its variables. */
export interface PreviewLine {
  messageKey: string;
  vars?: Record<string, string | number>;
}

export type OpKind = 'create' | 'update' | 'delete';

export interface BlockExample<S> {
  /** What a school might say. */
  prompt: string;
  settings: S;
}

export interface BlockDef<S extends ZodTypeAny = ZodTypeAny> {
  /** Stable key '<product>.<name>', e.g. 'os.approval_type'. Stored in changesets: never rename. */
  key: string;
  product: DesignerProduct;
  /** English title (catalogue screen, AI prompt, docs). The UI shows designer.block.<key>.title. */
  title: string;
  /** What the block does, written for the AI: when to use it and what each setting means. */
  description: string;
  /** zod schema of the settings. Reuse the shared schemas of the settings screens where they exist. */
  settings: S;
  /** The stable instance key inside the settings (e.g. the approval type key). Changesets refer to instances by it. */
  keyOf: (settings: z.infer<S>) => string;
  /** Plain-language description of an instance (i18n keys under designer.preview.*). */
  describe: (settings: z.infer<S>) => PreviewLine[];
  /** OS / product role keys the instance names (who is affected; checked against the school's roles). */
  roles?: (settings: z.infer<S>) => string[];
  /** Whether the instance reaches families (parents) as well as staff. */
  reachesFamilies?: (settings: z.infer<S>) => boolean;
  /** Operations the block supports (default: all three). */
  ops?: OpKind[];
  /** Business checks beyond the schema (same rules as the settings screens). Return issue codes. */
  check?: (settings: z.infer<S>, op: OpKind) => string[];
  examples: BlockExample<z.infer<S>>[];
  /**
   * Not wired yet: listed so the catalogue is complete, but the planner turns any use into an "unsupported" note and
   * publishing refuses it. Another stream replaces the stub with the real block.
   */
  stub?: boolean;
}

const registry = new Map<string, BlockDef>();

/** Typed helper; does not register (see registerBlocks). */
export function defineBlock<S extends ZodTypeAny>(def: BlockDef<S>): BlockDef<S> {
  if (!/^(os|crm|erp|core)\.[a-z][a-z0-9_]*$/.test(def.key)) throw new Error(`designer: bad block key ${def.key}`);
  if (!def.key.startsWith(`${def.product}.`)) throw new Error(`designer: block ${def.key} must start with its product`);
  return def;
}

/** Adds blocks to the catalogue. A key registered twice replaces the earlier one (a stub replaced by the real block). */
export function registerBlocks(defs: readonly BlockDef[]): void {
  for (const d of defs) registry.set(d.key, d);
}

export function getBlock(key: string): BlockDef | undefined {
  return registry.get(key);
}

export function listBlocks(filter: { product?: DesignerProduct; includeStubs?: boolean } = {}): BlockDef[] {
  return [...registry.values()].filter((b) => (!filter.product || b.product === filter.product) && (filter.includeStubs || !b.stub)).sort((a, b) => a.key.localeCompare(b.key));
}

/** Products that have at least one real (non-stub) block: the planner calls requests for other products "not yet supported". */
export function productsWithBlocks(): DesignerProduct[] {
  return DESIGNER_PRODUCTS.filter((p) => listBlocks({ product: p }).length > 0);
}
