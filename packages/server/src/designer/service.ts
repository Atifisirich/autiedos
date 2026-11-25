/**
 * Designer service: plan -> (dry run) -> publish -> undo, plus templates, history and "explain my school".
 *
 * Every function runs in ONE transaction as the actor (os_server role with the actor's claims): the designer tables
 * and every configuration table are under RLS, the platform audit trigger records each row change with the actor
 * and, for a relationship manager, the support session. Nothing is live until publish; publish re-validates against
 * the configuration as it is at that moment; each published changeset gets the org's next version number and keeps
 * the before / after state of every instance, so undo restores exactly what was there (and refuses if the
 * configuration was changed since, or a newer published changeset touches the same item).
 */
import {
  buildTemplate,
  canonical,
  changesetSchema,
  conditionHolds,
  getBlock,
  getTemplate,
  inverseOp,
  listBlocks,
  listTemplates,
  previewOps,
  repairChangeset,
  translate,
  validateChangeset,
  addDays,
  type Changeset,
  type KnownConfig,
  type PreviewLine,
} from '@autoed/shared';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError, asPlatformAdmin, asUser, insert, maybe, one, q } from '../db';
import { localToday, now } from '../core';
import { asActor, designerActor, needWrite, type DesignerActor } from './actor';
import { captureOf, restoreTo, serverBlock, type ApplyCtx, type Settings } from './blocks';
import { explain as explainSchool, familyCount, knownConfig, roleHolders, usableBlocks } from './config';
import { planWithAi } from './planner';

export interface ChangesetRow {
  id: string;
  org_id: string;
  branch_id: string | null;
  product_scope: string[];
  source: 'prompt' | 'template';
  template_key: string | null;
  prompt: string;
  plan: Changeset;
  preview: Preview;
  issues: { op: number | null; code: string; detail?: string }[];
  status: 'draft' | 'validated' | 'published' | 'reverted' | 'rejected';
  author_user_id: string;
  author_kind: 'org_admin' | 'relationship_manager';
  support_session_id: string | null;
  approved_by_user_id: string | null;
  ai_generation_id: string | null;
  credits: number;
  version: number | null;
  published_at: string | null;
  reverted_at: string | null;
  created_at: string;
}

export interface Preview {
  summary: string;
  ops: (ReturnType<typeof previewOps>[number] & { text: string[]; people: number; family_count: number })[];
  unsupported: Changeset['unsupported'];
  questions: string[];
  totals: { ops: number; roles: string[]; people: number; families: number };
}

/** 409 with details (which item changed, which versions must be undone first). */
class Conflict extends Error {
  status = 409;
  constructor(
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

const en = (l: PreviewLine) => translate('en', l.messageKey, l.vars);
const ctxOf = (c: ApplyCtx['c'], actor: DesignerActor): ApplyCtx => ({ c, actor });

async function lock(x: ApplyCtx) {
  await x.c.query(`select pg_advisory_xact_lock(hashtext($1))`, [`designer:${x.actor.orgId}`]);
}

async function row(x: ApplyCtx, id: string, forUpdate = false): Promise<ChangesetRow> {
  const r = await maybe<ChangesetRow>(x.c, `select * from core.design_changesets where id = $1 and org_id = $2${forUpdate ? ' for update' : ''}`, [id, x.actor.orgId]);
  if (!r) throw new NotFoundError('changeset');
  return r;
}

/** Plain-language preview with who is affected (counts of role holders and families; never names). */
async function buildPreview(x: ApplyCtx, cs: Changeset, known: KnownConfig): Promise<{ preview: Preview; issues: ReturnType<typeof validateChangeset>['issues']; ok: boolean; scope: string[] }> {
  const v = validateChangeset(cs, known);
  const before: Record<string, Settings | null> = {};
  for (const o of v.ops) {
    const sb = serverBlock(o.block);
    if (sb && o.op !== 'create') before[`${o.block}:${o.key}`] = await sb.read(x, o.key);
  }
  const families = v.ops.some((o) => o.settings && getBlock(o.block)?.reachesFamilies?.(o.settings)) ? await familyCount(x) : 0;
  const ops: Preview['ops'] = [];
  for (const p of previewOps(v.ops, before)) {
    ops.push({ ...p, text: [en(p.title), ...p.lines.map(en)], people: await roleHolders(x, p.roles), family_count: p.families ? families : 0 });
  }
  const roles = [...new Set(ops.flatMap((o) => o.roles))];
  const preview: Preview = {
    summary: cs.summary,
    ops,
    unsupported: cs.unsupported,
    questions: cs.questions,
    totals: { ops: ops.length, roles, people: await roleHolders(x, roles), families: ops.some((o) => o.families) ? families : 0 },
  };
  return { preview, issues: v.issues, ok: v.ok, scope: [...new Set(v.ops.map((o) => o.product))] };
}

async function store(x: ApplyCtx, input: { source: 'prompt' | 'template'; prompt: string; cs: Changeset; known: KnownConfig; templateKey?: string | null; generationId?: string | null; credits?: number }): Promise<ChangesetRow> {
  const cs = repairChangeset(input.cs, input.known);
  const { preview, issues, ok, scope } = await buildPreview(x, cs, input.known);
  const r = await insert<ChangesetRow>(x.c, 'core.design_changesets', {
    org_id: x.actor.orgId,
    branch_id: x.actor.branchId,
    product_scope: scope,
    source: input.source,
    template_key: input.templateKey ?? cs.template_key ?? null,
    prompt: input.prompt,
    plan: cs,
    preview,
    issues,
    status: ok ? 'validated' : 'draft',
    author_user_id: x.actor.userId,
    author_kind: x.actor.kind,
    support_session_id: x.actor.supportSessionId,
    ai_generation_id: input.generationId ?? null,
    credits: input.credits ?? 0,
  });
  return r;
}

// ---------------------------------------------------------------- plan
export async function plan(a: DesignerActor, input: { prompt: string }) {
  needWrite(a);
  return asActor(a, async (c) => {
    const x = ctxOf(c, a);
    const known = await knownConfig(x);
    const out = await planWithAi(x, input.prompt, known);
    return store(x, { source: 'prompt', prompt: input.prompt, cs: out.changeset, known, generationId: out.generationId, credits: out.credits });
  });
}

export async function planTemplate(a: DesignerActor, key: string, params: Record<string, unknown>) {
  needWrite(a);
  const t = getTemplate(key);
  if (!t) throw new NotFoundError('template');
  if (t.product !== 'core' && !a.products.includes(t.product as 'os')) throw new ForbiddenError('product_not_available');
  let cs: Changeset;
  try {
    cs = buildTemplate(key, params);
  } catch (e) {
    throw new ValidationError('invalid_params', { message: (e as Error).message.slice(0, 300) });
  }
  return asActor(a, async (c) => {
    const x = ctxOf(c, a);
    return store(x, { source: 'template', prompt: t.title, cs: changesetSchema.parse(cs), known: await knownConfig(x), templateKey: key });
  });
}

// ---------------------------------------------------------------- read
export async function history(a: DesignerActor, limit = 50) {
  return asActor(a, (c) =>
    q(
      c,
      `select id, status, version, source, template_key, author_kind, product_scope, created_at, published_at, reverted_at, credits,
              plan->>'summary' as summary, jsonb_array_length(coalesce(plan->'ops', '[]'::jsonb)) as ops, prompt,
              (author_user_id = app.uid()) as mine
         from core.design_changesets where org_id = $1 and deleted_at is null order by created_at desc limit $2`,
      [a.orgId, limit],
    ),
  );
}

export async function get(a: DesignerActor, id: string) {
  return asActor(a, async (c) => {
    const x = ctxOf(c, a);
    const r = await row(x, id);
    const items = await q(c, `select seq, product_key, block_key, op, instance_key, settings, before, after, inverse, applied_at, reverted_at from core.design_changeset_items where changeset_id = $1 order by seq`, [id]);
    return { ...r, items };
  });
}

export async function discard(a: DesignerActor, id: string) {
  needWrite(a);
  return asActor(a, async (c) => {
    const x = ctxOf(c, a);
    const r = await row(x, id, true);
    if (!['draft', 'validated'].includes(r.status)) throw new ConflictError(`changeset_${r.status}`);
    await c.query(`update core.design_changesets set status = 'rejected' where id = $1`, [id]);
    return { id, status: 'rejected' };
  });
}

// ---------------------------------------------------------------- apply (publish and dry run share it)
interface Applied {
  seq: number;
  block: string;
  product: string;
  op: 'create' | 'update' | 'delete';
  key: string;
  settings: Settings | null;
  before: Settings | null;
  after: Settings | null;
}

async function applyAll(x: ApplyCtx, r: ChangesetRow): Promise<Applied[]> {
  const known = await knownConfig(x);
  const v = validateChangeset(changesetSchema.parse(r.plan), known);
  if (!v.ok) throw new ValidationError('plan_out_of_date', { issues: v.issues });
  for (const o of v.ops) {
    if (o.product !== 'core' && !x.actor.products.includes(o.product as 'os')) throw new ForbiddenError('product_not_available');
    if (!serverBlock(o.block)) throw new ValidationError('block_not_available', { block: o.block });
  }
  const out: Applied[] = [];
  let seq = 0;
  for (const o of v.ops) {
    const sb = serverBlock(o.block)!;
    const before = await captureOf(sb, x, o.key);
    if (o.op === 'delete') await sb.remove(x, o.key);
    else await sb.write(x, o.key, o.settings!);
    out.push({ seq: ++seq, block: o.block, product: o.product, op: o.op, key: o.key, settings: o.settings, before, after: await captureOf(sb, x, o.key) });
  }
  return out;
}

export async function publish(a: DesignerActor, id: string) {
  needWrite(a);
  return asActor(a, async (c) => {
    const x = ctxOf(c, a);
    await lock(x);
    const r = await row(x, id, true);
    if (r.status !== 'validated') throw new ConflictError(r.status === 'draft' ? 'changeset_has_issues' : `changeset_${r.status}`);
    const applied = await applyAll(x, r);
    for (const i of applied) {
      await insert(c, 'core.design_changeset_items', {
        org_id: a.orgId,
        changeset_id: id,
        seq: i.seq,
        product_key: i.product,
        block_key: i.block,
        op: i.op,
        instance_key: i.key,
        settings: i.settings,
        before: i.before,
        after: i.after,
        inverse: inverseOp({ op: i.op, block: i.block, key: i.key }, i.before),
      });
    }
    const v = await one<{ v: number }>(c, `select coalesce(max(version), 0) + 1 as v from core.design_changesets where org_id = $1`, [a.orgId]);
    await c.query(`update core.design_changesets set status = 'published', version = $2, published_at = now(), approved_by_user_id = $3 where id = $1`, [id, v.v, a.userId]);
    return { id, status: 'published', version: v.v, items: applied.length };
  });
}

/** One-click undo: puts every instance back to its state before publishing, newest item first. */
export async function revert(a: DesignerActor, id: string) {
  needWrite(a);
  return asActor(a, async (c) => {
    const x = ctxOf(c, a);
    await lock(x);
    const r = await row(x, id, true);
    if (r.status !== 'published') throw new ConflictError(`changeset_${r.status}`);
    const items = await q<{ id: string; seq: number; block_key: string; instance_key: string; before: Settings | null; after: Settings | null }>(
      c,
      `select id, seq, block_key, instance_key, before, after from core.design_changeset_items where changeset_id = $1 order by seq desc`,
      [id],
    );
    const newer = await q<{ version: number }>(
      c,
      `select distinct d.version from core.design_changesets d join core.design_changeset_items i on i.changeset_id = d.id
        where d.org_id = $1 and d.status = 'published' and d.version > $2
          and exists (select 1 from core.design_changeset_items m where m.changeset_id = $3 and m.block_key = i.block_key and m.instance_key = i.instance_key)
        order by 1`,
      [a.orgId, r.version, id],
    );
    if (newer.length) throw new Conflict('undo_newer_first', { versions: newer.map((n) => n.version) });
    for (const i of items) {
      const sb = serverBlock(i.block_key);
      if (!sb) throw new ValidationError('block_not_available', { block: i.block_key });
      const current = await captureOf(sb, x, i.instance_key);
      if (canonical(current) !== canonical(i.after)) throw new Conflict('changed_since_publish', { block: i.block_key, key: i.instance_key });
      await restoreTo(sb, x, i.instance_key, i.before);
      await c.query(`update core.design_changeset_items set reverted_at = now() where id = $1`, [i.id]);
    }
    await c.query(`update core.design_changesets set status = 'reverted', reverted_at = now() where id = $1`, [id]);
    return { id, status: 'reverted', items: items.length };
  });
}

// ---------------------------------------------------------------- dry run ("try on sample data")
class DryRunDone extends Error {
  constructor(public result: unknown) {
    super('dry_run');
  }
}

function nextDates(today: string, frequency: string, weekdays: number[], monthDay: number | null | undefined, n = 3): string[] {
  const out: string[] = [];
  for (let i = 0; i < 62 && out.length < n; i++) {
    const d = addDays(today, i);
    const dow = ((new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
    if (frequency === 'daily' && dow !== 7) out.push(d);
    else if (frequency === 'weekly' && weekdays.includes(dow)) out.push(d);
    else if (frequency === 'monthly' && Number(d.slice(8)) === (monthDay ?? 1)) out.push(d);
  }
  return out;
}

async function samples(x: ApplyCtx, a: Applied): Promise<PreviewLine[]> {
  const s = a.settings;
  if (!s || a.op === 'delete') return [{ messageKey: 'designer.sample.removed' }];
  const today = localToday({ now: now() });
  switch (a.block) {
    case 'os.approval_type': {
      const steps = s.steps as { seq: number; approver: string; role_key?: string | null; condition?: { field: string; op: '>' | '>=' | '<' | '<=' | '=' | '!='; value: number | string } | null }[];
      const conds = steps.map((st) => st.condition).filter((cd): cd is NonNullable<typeof cd> => !!cd);
      const yes: Record<string, unknown> = {};
      const no: Record<string, unknown> = {};
      for (const cd of conds) {
        const v = cd.value;
        if (typeof v === 'number') {
          yes[cd.field] = cd.op.startsWith('<') ? v - 1 : cd.op === '!=' ? v + 1 : cd.op === '=' || cd.op.endsWith('=') ? v : v + 1;
          no[cd.field] = cd.op.startsWith('<') ? v + 1 : cd.op === '!=' ? v : v - 1;
        } else {
          yes[cd.field] = cd.op === '!=' ? `not ${v}` : v;
          no[cd.field] = cd.op === '!=' ? v : `not ${v}`;
        }
      }
      const chain = (data: Record<string, unknown>) =>
        steps
          .filter((st) => conditionHolds(st.condition ?? null, data))
          .sort((p, q2) => p.seq - q2.seq)
          .map((st) => (st.approver === 'role' ? String(st.role_key) : 'manager'))
          .join(' → ') || '-';
      const lines: PreviewLine[] = [{ messageKey: 'designer.sample.approval', vars: { data: JSON.stringify(yes), chain: chain(yes) } }];
      if (conds.length) lines.push({ messageKey: 'designer.sample.approval', vars: { data: JSON.stringify(no), chain: chain(no) } });
      return lines;
    }
    case 'os.checklist':
    case 'os.recurring_task': {
      const role = String(s.owner_role_key ?? s.role_key);
      const dates = nextDates(today, String(s.frequency), (s.weekdays as number[]) ?? [], s.month_day as number | null);
      return [{ messageKey: 'designer.sample.schedule', vars: { dates: dates.join(', '), time: String(s.time ?? s.due_time), people: await roleHolders(x, [role]), role } }];
    }
    case 'os.notification_rule':
      return [{ messageKey: 'designer.sample.notify', vars: { event: String(s.event_key), people: await roleHolders(x, (s.role_keys as string[]) ?? []), families: s.audience === 'family' ? await familyCount(x) : 0 } }];
    default:
      return [{ messageKey: 'designer.sample.saved' }];
  }
}

export async function dryRun(a: DesignerActor, id: string) {
  needWrite(a);
  try {
    await asActor(a, async (c) => {
      const x = ctxOf(c, a);
      const r = await row(x, id);
      if (!['draft', 'validated'].includes(r.status)) throw new ConflictError(`changeset_${r.status}`);
      const applied = await applyAll(x, r);
      const ops = [];
      for (const i of applied) {
        const lines = await samples(x, i);
        ops.push({ seq: i.seq, block: i.block, key: i.key, op: i.op, lines, text: lines.map(en) });
      }
      // everything above ran for real under RLS; the transaction is rolled back so nothing is kept
      throw new DryRunDone({ ok: true, ops });
    });
  } catch (e) {
    if (e instanceof DryRunDone) return e.result;
    const err = e as { status?: number; message?: string; details?: unknown; code?: string };
    if (err.status && err.status !== 422) throw e;
    return { ok: false, error: err.message ?? 'failed', details: err.details ?? (err.code ? { sql: err.code } : null), ops: [] };
  }
  throw new Error('unreachable');
}

// ---------------------------------------------------------------- catalogue, templates, explain
export function catalogue(a: DesignerActor) {
  const usable = new Set(usableBlocks(a).map((b) => b.key));
  return listBlocks({ includeStubs: true }).map((b) => ({ key: b.key, product: b.product, title: b.title, description: b.description, available: usable.has(b.key), stub: !!b.stub }));
}

export function templates(a: DesignerActor) {
  return listTemplates().map((t) => ({
    key: t.key,
    product: t.product,
    title: t.title,
    description: t.description,
    params: t.params.map((p) => ({ ...p, default: (t.paramsSchema.parse({}) as Record<string, unknown>)[p.key] })),
    available: t.product === 'core' || a.products.includes(t.product as 'os'),
  }));
}

export async function explain(a: DesignerActor) {
  return asActor(a, async (c) => {
    const r = await explainSchool(ctxOf(c, a));
    return { lines: r.lines, text: r.lines.map(en) };
  });
}

// ---------------------------------------------------------------- relationship managers: support session
/** Opens a read-write support session for the designer (reason and time limit required; audited by the database). */
export async function openSupportSession(userId: string, input: { org_id: string; reason: string; minutes: number }) {
  return asUser({ userId }, async (c) => {
    const admin = await maybe(c, `select 1 from core.platform_admins where user_id = $1 and active`, [userId]);
    if (!admin) throw new ForbiddenError('super_admin_only');
    await c.query(`select app.end_support_session()`);
    const s = await one<{ id: string }>(c, `select app.start_support_session($1, $2, $3, false) as id`, [input.org_id, input.reason, input.minutes]);
    const exp = await one<{ expires_at: string }>(c, `select expires_at from core.support_sessions where id = $1`, [s.id]);
    return { session_id: s.id, expires_at: exp.expires_at, read_only: false };
  });
}

export async function endSupportSession(userId: string) {
  return asUser({ userId }, async (c) => {
    await c.query(`select app.end_support_session()`);
    return { ended: true };
  });
}

/** What the designer page needs to know about the signed-in person (never throws for "not allowed": it says why). */
export async function whoami(userId: string, opts: { viewAs?: string | null; branchId?: string | null; lang?: string | null }) {
  try {
    const a = await designerActor(userId, opts);
    return { kind: a.kind, org: { id: a.orgId, name: a.orgName }, branch_id: a.branchId, branch_code: a.branchCode, branches: a.branches, products: a.products, support_session_id: a.supportSessionId, read_only: a.readOnly, lang: a.lang };
  } catch (e) {
    const err = e as { status?: number; message?: string };
    if (err.status === 401 && err.message === 'view_as_expired') return { kind: 'platform', needs_session: true, expired: true };
    if (err.status !== 403 && err.status !== 401) throw e;
    if (err.message === 'support_session_required' || err.message === 'support_session_not_current') return { kind: 'platform', needs_session: true };
    return { kind: 'none', reason: err.message ?? 'forbidden' };
  }
}

/** Clients a relationship manager can open the designer for (platform console role). */
export async function clientsForRm(userId: string) {
  return asPlatformAdmin(userId, (c) => q(c, `select id, name from core.organizations where status = 'active' order by name`));
}
