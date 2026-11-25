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

/** Role keys (and names) per product: OS roles (os.roles), CRM roles (crm.roles), ERP roles (core.roles product erp). */
export async function productRoles(x: ApplyCtx): Promise<Record<string, { key: string; name: string }[]>> {
  const out: Record<string, { key: string; name: string }[]> = {};
  if (x.actor.products.includes('os')) out.os = await osRoles(await x.tx('os'), x.actor.orgId);
  if (x.actor.products.includes('crm')) out.crm = await safeRows(await x.tx('crm'), `select key, name from crm.roles where org_id = $1 and key <> 'system' order by name`, [x.actor.orgId]);
  if (x.actor.products.includes('erp')) out.erp = await safeRows(await x.tx('erp'), `select key, name from core.roles where org_id = $1 and product_key = 'erp' and key <> 'portal' order by name`, [x.actor.orgId]);
  return out;
}

/** Role keys usable in custom registers ("product:key" of core.roles, as the records builder lists them). */
export async function recordRoles(x: ApplyCtx): Promise<string[]> {
  return (await safeRows<{ r: string }>(x.c, `select r.product_key || ':' || r.key as r from core.roles r where r.org_id = $1 and app.org_has_product(r.org_id, r.product_key) and r.key not in ('os_system', 'portal', 'system') order by 1`, [x.actor.orgId])).map((r) => r.r);
}

export async function knownConfig(x: ApplyCtx): Promise<KnownConfig> {
  const inst = await instancesByBlock(x);
  const roles = await productRoles(x);
  return {
    products: [...x.actor.products, 'core'],
    roles: Object.fromEntries(Object.entries(roles).map(([p, rs]) => [p, rs.map((r) => r.key)])),
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
  const roles = await productRoles(x);
  const off = x.actor.products.includes('os') ? await safeRows<{ module_key: string; code: string }>(x.c, `select f.module_key, b.code from os.module_flags f join core.branches b on b.id = f.branch_id where f.org_id = $1 and not f.enabled and f.deleted_at is null`, [x.actor.orgId]) : [];
  const summary = {
    products: x.actor.products,
    active_branch: x.actor.branchCode,
    branches: x.actor.branches.map((b) => b.code),
    ...(x.actor.products.includes('os') ? { os_modules: MODULE_KEYS, modules_off: off.map((o) => `${o.module_key}@${o.code}`) } : {}),
    roles: roles.os ?? [],
    product_roles: Object.fromEntries(Object.entries(roles).filter(([p]) => p !== 'os').map(([p, rs]) => [p, rs])),
    record_roles: await recordRoles(x),
    configuration: Object.fromEntries(Object.entries(inst).filter(([, v]) => v.length).map(([k, v]) => [k, v.slice(0, 60).map((i) => ({ key: i.key, name: i.name }))])),
  };
  return privacyFilter(x.c, x.actor.orgId, JSON.stringify(summary));
}

// ---------------------------------------------------------------- who is affected (counts only)
/** Active staff holding any of the role keys of a product (OS: os.staff_roles; CRM / ERP: their product access). */
export async function roleHolders(x: ApplyCtx, roleKeys: string[], product: string = 'os'): Promise<number> {
  if (!roleKeys.length) return 0;
  if (product === 'crm' || product === 'erp') {
    const r = await safeRows<{ n: number }>(
      x.c,
      `select count(distinct s.id)::int as n from core.staff s join core.user_product_access a on a.org_id = s.org_id and a.user_id = s.user_id and a.product_key = $3 and a.revoked_at is null
        where s.org_id = $1 and a.role_key = any($2) and s.status = 'active' and s.deleted_at is null`,
      [x.actor.orgId, roleKeys, product],
    );
    return r[0]?.n ?? 0;
  }
  if (product !== 'os' || !x.actor.products.includes('os')) return 0;
  const r = await safeRows<{ n: number }>(
    await x.tx('os'),
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
  const count = (b: string) => (inst[b] ?? []).length;
  const roles = await productRoles(x);
  const allRoles = Object.values(roles).flat();
  const staff = await safeRows<{ n: number }>(x.c, `select count(*)::int as n from core.staff where org_id = $1 and status = 'active' and deleted_at is null`, [x.actor.orgId]);
  const changes = await q<{ n: number }>(x.c, `select count(*)::int as n from core.design_changesets where org_id = $1 and status = 'published'`, [x.actor.orgId]);
  const lines: PreviewLine[] = [
    { messageKey: 'designer.explain.org', vars: { org: x.actor.orgName, products: x.actor.products.map((p) => p.toUpperCase()).join(', '), branches: x.actor.branches.length } },
    { messageKey: 'designer.explain.people', vars: { staff: staff[0]?.n ?? 0, roles: allRoles.length, list: list((roles.os ?? allRoles).map((r) => r.name)) } },
  ];
  const add = (block: string, key: string) => {
    const n = names(block);
    if (n.length) lines.push({ messageKey: key, vars: { n: n.length, list: list(n) } });
  };
  if (x.actor.products.includes('os')) {
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
    const off = names('os.module_flag');
    lines.push(off.length ? { messageKey: 'designer.explain.modulesOff', vars: { list: list(off) } } : { messageKey: 'designer.explain.modulesOn' });
  }
  if (x.actor.products.includes('crm')) {
    const wfs = names('crm.workflow');
    lines.push({ messageKey: 'designer.explain.crm', vars: { stages: count('crm.stage'), sources: count('crm.lead_source'), rules: count('crm.assignment_rule'), workflows: wfs.filter((w) => w.endsWith('(published)')).length, templates: count('crm.message_template'), forms: count('crm.enquiry_form') } });
    const sla = await serverBlock('crm.follow_up_sla')?.read(x, 'first_response');
    const lim = await serverBlock('crm.messaging_limits')?.read(x, 'messaging');
    if (sla && lim) {
      const h = Number(sla.first_response_hours);
      lines.push({ messageKey: 'designer.explain.crmSla', vars: { time: h >= 1 ? `${h} h` : `${Math.round(h * 60)} min`, from: Number(lim.quiet_from), to: Number(lim.quiet_to), n: Number(lim.max_auto_per_day) } });
    }
    if (roles.crm?.length) lines.push({ messageKey: 'designer.explain.crmRoles', vars: { list: list(roles.crm.map((r) => r.name)) } });
  }
  if (x.actor.products.includes('erp')) {
    lines.push({ messageKey: 'designer.explain.erp', vars: { heads: count('erp.fee_head'), plans: count('erp.fee_plan'), concessions: count('erp.concession_type'), rules: count('erp.approval_rule'), automations: count('erp.automation'), templates: count('erp.message_template') } });
    const late = await serverBlock('erp.late_fee_rule')?.read(x, 'late_fee');
    const off = (inst['erp.module_flag'] ?? []).map((i) => i.name);
    lines.push({
      messageKey: 'designer.explain.erpFees',
      vars: { late: !late || late.type === 'none' ? '-' : `${late.type} ${late.amount ?? ''}`.trim(), scales: count('erp.grading_scale'), schemes: count('erp.assessment_scheme'), off: off.length ? list(off) : '-' },
    });
    if (roles.erp?.length) lines.push({ messageKey: 'designer.explain.erpRoles', vars: { list: list(roles.erp.map((r) => r.name)) } });
  }
  add('core.custom_object', 'designer.explain.records');
  lines.push({ messageKey: 'designer.explain.changes', vars: { n: changes[0]?.n ?? 0 } });
  return { lines, text: lines.map((l) => l.messageKey) };
}

export function blockTitle(key: string): string {
  return getBlock(key)?.title ?? key;
}
