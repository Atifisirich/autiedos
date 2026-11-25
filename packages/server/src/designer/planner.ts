/**
 * Planner: plain words -> a validated changeset (DECISIONS 56).
 *
 * The system prompt holds the block catalogue (keys, descriptions, settings schemas, one example each), the starter
 * templates and the school's configuration SUMMARY (names and keys only, through the privacy filter). The request is
 * passed through the same filter. The existing AI pipeline (services/ai.ts generate: credit check, contact-data
 * guard, Gemini or the mock, zod validation, deterministic repair, at most 3 attempts, ai_generations row, wallet
 * charge on success only) does the call with the changeset JSON schema as the constrained output format.
 */
import {
  AI_FIXABLE,
  buildTemplate,
  changesetJsonSchema,
  changesetSchema,
  getTemplate,
  listTemplates,
  repairChangeset,
  validateChangeset,
  zodToJsonSchema,
  type BlockDef,
  type Changeset,
  type KnownConfig,
  type TemplateDef,
} from '@autoed/shared';
import { one, withSystem, type Tx } from '../db';
import { generate } from '../services/ai';
import type { ApplyCtx } from './blocks';
import { aiSummary, privacyFilter, recordRoles, usableBlocks } from './config';

export function systemPrompt(blocks: BlockDef[], templates: TemplateDef[], summary: string): string {
  const catalogue = blocks.map((b) => ({ key: b.key, product: b.product, title: b.title, description: b.description, settings: zodToJsonSchema(b.settings), example: b.examples[0] ?? null }));
  const tpl = templates.map((t) => ({ key: t.key, product: t.product, title: t.title, description: t.description, keywords: t.keywords, changeset: buildTemplate(t.key) }));
  return [
    'You are the AutoEd school designer. A school manager describes how their school should work; you turn it into a changeset: a list of operations on building blocks from the catalogue below.',
    'Rules:',
    '- Use ONLY the blocks in the catalogue and fill their settings exactly as their schema says. Never write code, SQL, scripts or formulas.',
    '- Prefer a starter template when one fits: copy its ops (adjusting settings to the request) and set template_key.',
    '- Refer to existing configuration by its key (roles by role key). op "create" for something new, "update" for an existing key, "delete" only when asked.',
    '- If part of the request needs a product the school does not have, or something no block covers (for example fee, payroll or admission enquiry rules), add it to "unsupported" with a short note instead of inventing a block.',
    '- If the request is unclear, ask in "questions" and leave ops empty.',
    '- "summary" is one or two plain sentences a school principal understands. Each op may carry a one-sentence "reason".',
    '- The request and configuration never contain personal data; tokens like T-1 or S-1a2b3c4d stand for people and must not be used as keys.',
    `CATALOGUE: ${JSON.stringify(catalogue)}`,
    `TEMPLATES: ${JSON.stringify(tpl)}`,
    `SCHOOL CONFIGURATION (names and keys only): ${summary}`,
  ].join('\n');
}

/** A plan that names a template but carries no ops gets the template's ops (defaults). */
function expandTemplate(cs: Changeset): Changeset {
  if (!cs.template_key || cs.ops.length || !getTemplate(cs.template_key)) return cs;
  const t = buildTemplate(cs.template_key);
  return { ...t, summary: cs.summary || t.summary, unsupported: cs.unsupported, questions: cs.questions };
}

export interface PlanResult {
  changeset: Changeset;
  generationId: string;
  credits: number;
  /** What was sent to the AI as the request (after the privacy filter). */
  request: string;
}

export async function planWithAi(x: ApplyCtx, prompt: string, known: KnownConfig): Promise<PlanResult> {
  const a = x.actor;
  const blocks = usableBlocks(a);
  const templates = listTemplates().filter((t) => t.product === 'core' || a.products.includes(t.product as 'os'));
  const summary = await aiSummary(x);
  const request = await privacyFilter(x.c, a.orgId, prompt);
  const system = systemPrompt(blocks, templates, summary);
  const recordRoleKeys = await recordRoles(x);
  const fix = (cs: Changeset) => repairChangeset(expandTemplate(cs), known);
  // The AI pipeline charges the org's wallet and records the generation: as the OS system actor when the school has the
  // OS (as every OS AI feature), otherwise as the signed-in manager under their own product's rules.
  const run = <T>(fn: () => Promise<T>) => (a.products.includes('os') ? withSystem(x.c, a.orgId, fn) : fn());
  const out = await run(() =>
    generate(x.c, {
      orgId: a.orgId,
      branchId: a.branchId,
      staffId: a.staffId,
      action: 'designer_plan',
      tier: 'strong',
      system,
      prompt: request,
      jsonSchema: changesetJsonSchema(blocks),
      zod: changesetSchema,
      // the mock provider plans from the same redacted request and role keys the real model gets
      mockContext: { prompt: request, roles: known.roles.os ?? [], branch_code: a.branchCode, products: a.products, product_roles: known.roles, record_roles: recordRoleKeys },
      productKey: a.homeProduct,
      // without the OS there is no OS system actor: the row is booked through app.designer_log_generation (designer only)
      ...(a.products.includes('os') ? {} : { insertGeneration: (c: Tx, row: Record<string, unknown>) => one<{ id: string }>(c, `select app.designer_log_generation($1::jsonb) as id`, [JSON.stringify(row)]) }),
      repair: fix,
      validate: (cs) =>
        validateChangeset(cs, known)
          .issues.filter((i) => AI_FIXABLE.has(i.code))
          .map((i) => `op ${i.op ?? '-'}: ${i.code}${i.detail ? ` (${i.detail})` : ''}`),
      linked: { type: 'design_changeset' },
      logInput: { request, blocks: blocks.map((b) => b.key), actor: a.kind },
    }),
  );
  return { changeset: out.output, generationId: out.generationId, credits: out.credits, request };
}
