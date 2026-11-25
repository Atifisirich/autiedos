/**
 * What the designer knows about a school's configuration, read with the actor's claims (RLS applies):
 *   knownConfig  keys only, for validation (which roles / instances exist);
 *   aiSummary    names and keys of the configuration, the ONLY school data the AI sees, passed through the privacy
 *                filter (roster names -> tokens, phone / e-mail removed; decision 9). No staff, student or guardian
 *                record is ever read into it, only configuration rows;
 *   explain      "Explain my school": a plain-language summary built from the same data (no AI call, no credits);
 *   affected     how many people a plan reaches (counts only, never names).
 */
import { getBlock, listBlocks, MODULE_KEYS, redact, containsContactData, type KnownConfig, type PreviewLine } from '@autoed/shared';
import { q, type Tx } from '../db';
import type { DesignerActor } from './actor';
import { serverBlock, type ApplyCtx } from './blocks';

/** Blocks the actor can use now: real (non-stub), wired on the server, and of a product the school has. */
export function usableBlocks(a: DesignerActor) {
  return listBlocks().filter((b) => !!serverBlock(b.key) && (b.product === 'core' || a.products.includes(b.product as 'os')));
}

export async function instancesByBlock(x: ApplyCtx): Promise<Record<string, { key: string; name: string; system?: boolean }[]>> {
  const out: Record<string, { key: string; name: string; system?: boolean }[]> = {};
  for (const b of usableBlocks(x.actor)) out[b.key] = await serverBlock(b.key)!.list(x);
  return out;
}

export async function osRoles(c: Tx, orgId: string): Promise<{ key: string; name: string }[]> {
  return q<{ key: string; name: string }>(c, `select key, name from os.roles where org_id = $1 and deleted_at is null order by name`, [orgId]);
}

export async function knownConfig(x: ApplyCtx): Promise<KnownConfig> {
  const inst = await instancesByBlock(x);
  const roles = x.actor.products.includes('os') ? (await osRoles(x.c, x.actor.orgId)).map((r) => r.key) : [];
  return {
    products: [...x.actor.products, 'core'],
    roles: { os: roles },
    instances: Object.fromEntries(Object.entries(inst).map(([k, v]) => [k, v.map((i) => i.key)])),
    system: Object.fromEntries(Object.entries(inst).map(([k, v]) => [k, v.filter((i) => i.system).map((i) => i.key)])),
    branches: x.actor.branches.map((b) => b.code),
  };
}

/** Names of people in the org, used ONLY to redact them from text sent to the AI (never sent themselves). */
/** A query that may be refused by RLS for some actors: a failure returns [] without aborting the transaction. */
export async function safeRows<T = Record<string, unknown>>(c: Tx, sql: string, params: unknown[] = []): Promise<T[]> {
  await c.query('savepoint designer_safe');
  try {
    const r = await q<T>(c, sql, params);
    await c.query('release savepoint designer_safe');
    return r;
  } catch {
    await c.query('rollback to savepoint designer_safe');
    return [];
  }
}

export async function roster(c: Tx, orgId: string): Promise<{ staff: { id: string; name: string }[]; students: { id: string; name: string }[] }> {
  const staff = await safeRows<{ id: string; name: string }>(c, `select id, full_name as name from core.staff where org_id = $1 union all select id, first_name from core.staff where org_id = $1 and length(first_name) >= 3`, [orgId]);
  const guardians = await safeRows<{ id: string; name: string }>(c, `select id, name from core.guardians where org_id = $1`, [orgId]);
  const students = await safeRows<{ id: string; name: string }>(c, `select id, full_name as name from core.students where org_id = $1 union all select id, first_name from core.students where org_id = $1 and length(first_name) >= 3`, [orgId]);
  return { staff: [...staff, ...guardians], students };
}

/** Removes people's names, phone numbers and e-mail addresses from text bound for the AI. */
export async function privacyFilter(c: Tx, orgId: string, text: string): Promise<string> {
  const people = await roster(c, orgId);
  // Belt and braces: the shared PHONE pattern misses "+91" numbers written without a separator, so any run of 9+
  // digits (with optional + and spaces / dashes) is treated as a phone number here. Configuration never needs one.
  let out = redact(text, people).text.replace(/\+?\d(?:[\s-]?\d){8,}/g, '[phone]');
  if (containsContactData(out)) out = out.replace(/\S+@\S+/g, '[email]');
  return out;
}

/** The school's configuration as the AI sees it: products, branch codes, roles, and every instance by key and name. */
export async function aiSummary(x: ApplyCtx): Promise<string> {
  const inst = await instancesByBlock(x);
  const roles = x.actor.products.includes('os') ? await osRoles(x.c, x.actor.orgId) : [];
  const off = await safeRows<{ module_key: string; code: string }>(x.c, `select f.module_key, b.code from os.module_flags f join core.branches b on b.id = f.branch_id where f.org_id = $1 and not f.enabled and f.deleted_at is null`, [x.actor.orgId]);
  const summary = {
    products: x.actor.products,
    active_branch: x.actor.branchCode,
    branches: x.actor.branches.map((b) => b.code),
    os_modules: MODULE_KEYS,
    modules_off: off.map((o) => `${o.module_key}@${o.code}`),
    roles: roles.map((r) => ({ key: r.key, name: r.name })),
    configuration: Object.fromEntries(Object.entries(inst).filter(([, v]) => v.length).map(([k, v]) => [k, v.slice(0, 60).map((i) => ({ key: i.key, name: i.name }))])),
  };
  return privacyFilter(x.c, x.actor.orgId, JSON.stringify(summary));
}

// ---------------------------------------------------------------- who is affected (counts only)
export async function roleHolders(x: ApplyCtx, roleKeys: string[]): Promise<number> {
  if (!roleKeys.length) return 0;
  const r = await safeRows<{ n: number }>(
    x.c,
    `select count(distinct s.id)::int as n from core.staff s join os.staff_roles sr on sr.staff_id = s.id and sr.deleted_at is null join os.roles r on r.id = sr.role_id
      where s.org_id = $1 and r.key = any($2) and s.status = 'active' and s.deleted_at is null`,
    [x.actor.orgId, roleKeys],
  );
  return r[0]?.n ?? 0;
}

export async function familyCount(x: ApplyCtx): Promise<number> {
  const r = await safeRows<{ n: number }>(x.c, `select count(distinct coalesce(household_id, id))::int as n from core.students where org_id = $1 and status = 'active' and deleted_at is null`, [x.actor.orgId]);
  return r[0]?.n ?? 0;
}

// ---------------------------------------------------------------- explain my school
const list = (xs: string[], n = 8) => (xs.length > n ? `${xs.slice(0, n).join(', ')} +${xs.length - n}` : xs.join(', '));

export async function explain(x: ApplyCtx): Promise<{ lines: PreviewLine[]; text: string[] }> {
  const inst = await instancesByBlock(x);
  const names = (b: string) => (inst[b] ?? []).map((i) => i.name);
  const roles = x.actor.products.includes('os') ? await osRoles(x.c, x.actor.orgId) : [];
  const staff = await safeRows<{ n: number }>(x.c, `select count(*)::int as n from core.staff where org_id = $1 and status = 'active' and deleted_at is null`, [x.actor.orgId]);
  const changes = await q<{ n: number }>(x.c, `select count(*)::int as n from core.design_changesets where org_id = $1 and status = 'published'`, [x.actor.orgId]);
  const off = names('os.module_flag');
  const lines: PreviewLine[] = [
    { messageKey: 'designer.explain.org', vars: { org: x.actor.orgName, products: x.actor.products.map((p) => p.toUpperCase()).join(', '), branches: x.actor.branches.length } },
    { messageKey: 'designer.explain.people', vars: { staff: staff[0]?.n ?? 0, roles: roles.length, list: list(roles.map((r) => r.name)) } },
  ];
  const add = (block: string, key: string) => {
    const n = names(block);
    if (n.length) lines.push({ messageKey: key, vars: { n: n.length, list: list(n) } });
  };
  add('os.approval_type', 'designer.explain.approvals');
  add('os.checklist', 'designer.explain.checklists');
  add('os.leave_type', 'designer.explain.leave');
  add('os.recurring_task', 'designer.explain.recurring');
  add('os.task_category', 'designer.explain.taskCategories');
  add('os.duty_type', 'designer.explain.duties');
  add('os.event_template', 'designer.explain.events');
  add('os.plan_review_chain', 'designer.explain.planReview');
  const notif = inst['os.notification_rule'] ?? [];
  if (notif.length) lines.push({ messageKey: 'designer.explain.notifications', vars: { n: notif.length } });
  lines.push(off.length ? { messageKey: 'designer.explain.modulesOff', vars: { list: list(off) } } : { messageKey: 'designer.explain.modulesOn' });
  lines.push({ messageKey: 'designer.explain.changes', vars: { n: changes[0]?.n ?? 0 } });
  for (const p of ['crm', 'erp'] as const) if (x.actor.products.includes(p) && !listBlocks({ product: p }).length) lines.push({ messageKey: 'designer.explain.productLater', vars: { product: p.toUpperCase() } });
  return { lines, text: lines.map((l) => l.messageKey) };
}

export function blockTitle(key: string): string {
  return getBlock(key)?.title ?? key;
}
