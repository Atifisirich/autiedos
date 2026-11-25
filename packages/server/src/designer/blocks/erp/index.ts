/**
 * ERP blocks. The ERP screens talk to the Data API as the signed-in person (decision 51); the designer writes the same
 * erp.* and core rows as the erp_server login with the person's claims (x.tx('erp')), so the same row policies, the
 * erp.* functions and every trigger (audit, immutability of posted fee rows, config history) apply. Nothing here
 * touches demands, receipts or vouchers: a fee plan whose items already have demands keeps its items.
 *
 *   erp.fee_head          erp.fee_heads                  erp.fee_plan          erp.fee_plans + erp.fee_plan_items (current year, active branch)
 *   erp.late_fee_rule     core.organizations.settings.late_fee
 *   erp.concession_type   erp.concession_types           erp.approval_rule     erp.approval_rules (read by erp.submit_approval)
 *   erp.automation        erp.automations (by recipe key) erp.message_template core.message_templates (product erp)
 *   erp.leave_type        core.leave_types               erp.doc_template      erp.doc_templates
 *   erp.campus_settings   core.organizations.settings (library fine, homework approval, quiet hours)
 *   erp.grading_scale     erp.grading_scales             erp.assessment_scheme erp.assessment_schemes (current year)
 *   erp.role_permission   core.role_permissions of an ERP role (levels as the ERP roles screen writes them)
 *   erp.module_flag       erp.module_flags
 */
import { ERP_CAP_MODULES, erpLevelOf, erpLevelRows, slugKey } from '@autoed/shared';
import { SCHEME_CONFIG } from '@autoed/shared/erp';
import { ValidationError, maybe, q, type Tx } from '../../../db';
import { clean, num, type ApplyCtx, type ServerBlock, type Settings } from '../types';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- rows of many tables
const erp = (x: ApplyCtx): Promise<Tx> => x.tx('erp');
const rows = async (x: ApplyCtx, sql: string, params: unknown[] = []): Promise<Row[]> => q<Row>(await erp(x), sql, params);
/** Runs a statement; an update / delete of one row by id that the row policies refused (no row changed) is a 403, never a silent no-op. */
const exec = async (x: ApplyCtx, sql: string, params: unknown[] = []) => {
  const r = await (await erp(x)).query(sql, params);
  if (/^\s*(update|delete)\b[\s\S]*where id = \$1(\s|$)/i.test(sql) && !r.rowCount) throw Object.assign(new Error('forbidden'), { status: 403 });
  return r;
};
const json = (v: unknown) => JSON.stringify(v);
const bySlug = (list: Row[], key: string, field = 'name') => list.find((r) => slugKey(String(r[field])) === key) ?? null;
const branchOf = (x: ApplyCtx, code: string | null | undefined) => {
  if (!code) return null;
  const b = x.actor.branches.find((br) => br.code === code);
  if (!b) throw new ValidationError('unknown_branch', { branch: code });
  return b.id;
};
async function currentYear(x: ApplyCtx): Promise<string> {
  const y = (await rows(x, `select id from core.academic_years where org_id = $1 and is_current and deleted_at is null order by starts_on desc limit 1`, [x.actor.orgId]))[0];
  if (!y) throw new ValidationError('no_current_academic_year');
  return y.id;
}
async function programmeId(x: ApplyCtx, name: unknown): Promise<string | null> {
  if (!name) return null;
  const p = (await rows(x, `select id from core.programmes where org_id = $1 and lower(name) = lower($2) and deleted_at is null order by (branch_id = $3) desc nulls last limit 1`, [x.actor.orgId, name, x.actor.branchId]))[0];
  if (!p) throw new ValidationError('unknown_programme', { programme: name });
  return p.id;
}

/** A table identified by the slug of its name (soft delete or inactive = absent). */
function namedTable(o: {
  key: string;
  table: string;
  cols: string[];
  /** Extra condition (e.g. active) for "exists". */
  live?: string;
  removeSql?: string;
  toSettings: (r: Row) => Settings;
  toRow?: (s: Settings) => Row;
}): ServerBlock {
  const all = (x: ApplyCtx) => rows(x, `select * from ${o.table} where org_id = $1 and deleted_at is null order by created_at`, [x.actor.orgId]);
  const live = (r: Row) => (o.live ? !!r[o.live] : true);
  const toRow = o.toRow ?? ((s: Settings) => Object.fromEntries(o.cols.map((c) => [c, s[c] ?? null])));
  return {
    key: o.key,
    async read(x, key) {
      const r = bySlug((await all(x)).filter(live), key);
      return r ? o.toSettings(r) : null;
    },
    async list(x) {
      return (await all(x)).filter(live).map((r) => ({ key: slugKey(r.name), name: r.name }));
    },
    async write(x, key, s) {
      const data = toRow(s);
      if (o.live) data[o.live] = s[o.live] ?? true;
      const cols = Object.keys(data);
      const vals = cols.map((c) => (data[c] !== null && typeof data[c] === 'object' ? json(data[c]) : data[c]));
      const cur = bySlug(await all(x), key);
      if (cur) await exec(x, `update ${o.table} set ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} where id = $1`, [cur.id, ...vals]);
      else await exec(x, `insert into ${o.table} (org_id, ${cols.join(', ')}) values ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')})`, [x.actor.orgId, ...vals]);
    },
    async remove(x, key) {
      const cur = bySlug((await all(x)).filter(live), key);
      if (cur) await exec(x, o.removeSql ?? `update ${o.table} set deleted_at = now() where id = $1`, [cur.id]);
    },
  };
}

// ---------------------------------------------------------------- fees
export const erpFeeHeadServer = namedTable({
  key: 'erp.fee_head',
  table: 'erp.fee_heads',
  cols: ['name', 'type', 'gst_rate', 'tax_certificate'],
  live: 'active',
  removeSql: 'update erp.fee_heads set active = false where id = $1',
  toSettings: (r) => ({ name: r.name, type: r.type, gst_rate: num(r.gst_rate) ?? 0, tax_certificate: !!r.tax_certificate, active: true }),
});

const planRows = async (x: ApplyCtx) =>
  rows(x, `select p.*, pr.name as programme_name from erp.fee_plans p left join core.programmes pr on pr.org_id = p.org_id and pr.id = p.programme_id
            where p.org_id = $1 and p.deleted_at is null and p.academic_year_id = $2 and p.branch_id is not distinct from $3 order by p.created_at`, [x.actor.orgId, await currentYear(x), x.actor.branchId]);
async function planItems(x: ApplyCtx, planId: string) {
  return rows(x, `select h.name as head, i.instalment, i.amount, i.due_date from erp.fee_plan_items i join erp.fee_heads h on h.org_id = i.org_id and h.id = i.head_id
                   where i.plan_id = $1 and i.deleted_at is null order by i.due_date, i.instalment, h.name`, [planId]);
}
export const erpFeePlanServer: ServerBlock = {
  key: 'erp.fee_plan',
  async read(x, key) {
    const p = bySlug((await planRows(x)).filter((r) => r.active), key);
    if (!p) return null;
    const items = (await planItems(x, p.id)).map((i) => ({ head: i.head, instalment: i.instalment, amount: Number(i.amount), due_date: i.due_date }));
    return clean({ name: p.name, programme: p.programme_name ?? undefined, category: p.category ?? undefined, items, active: true });
  },
  async list(x) {
    return (await planRows(x)).filter((r) => r.active).map((r) => ({ key: slugKey(r.name), name: r.name }));
  },
  async check(x, s, _op, plan) {
    const heads = new Set((await rows(x, `select name from erp.fee_heads where org_id = $1 and deleted_at is null and active`, [x.actor.orgId])).map((h) => slugKey(h.name)));
    for (const o of plan) if (o.block === 'erp.fee_head') heads.add(slugKey(String(o.settings.name)));
    return [...new Set(((s.items as Row[]) ?? []).map((i) => String(i.head)).filter((h) => !heads.has(slugKey(h))))].map((h) => `unknown_fee_head: ${h}`);
  },
  async write(x, key, s) {
    const year = await currentYear(x);
    const prog = await programmeId(x, s.programme);
    let plan = bySlug(await planRows(x), key);
    if (plan) await exec(x, `update erp.fee_plans set name = $2, programme_id = $3, category = $4, active = $5 where id = $1`, [plan.id, s.name, prog, s.category ?? null, s.active !== false]);
    else plan = (await rows(x, `insert into erp.fee_plans (org_id, branch_id, academic_year_id, name, programme_id, category, active) values ($1, $2, $3, $4, $5, $6, $7) returning id`, [x.actor.orgId, x.actor.branchId, year, s.name, prog, s.category ?? null, s.active !== false]))[0]!;
    const raised = await rows(x, `select 1 from erp.fee_demands d join erp.fee_plan_items i on i.org_id = d.org_id and i.id = d.plan_item_id where i.plan_id = $1 limit 1`, [plan.id]);
    const want = (s.items as Row[]) ?? [];
    if (raised.length) {
      // demands were raised from this plan: its items are part of the fee ledger and stay as they are
      const have = (await planItems(x, plan.id)).map((i) => `${slugKey(i.head)}|${i.instalment}|${Number(i.amount)}|${i.due_date}`).sort();
      const next = want.map((i) => `${slugKey(String(i.head))}|${i.instalment}|${Number(i.amount)}|${i.due_date}`).sort();
      if (have.join() !== next.join()) throw new ValidationError('fee_plan_has_demands', { plan: s.name });
      return;
    }
    await exec(x, `delete from erp.fee_plan_items where plan_id = $1`, [plan.id]);
    const heads = await rows(x, `select id, name from erp.fee_heads where org_id = $1 and deleted_at is null and active`, [x.actor.orgId]);
    for (const i of want) {
      const h = bySlug(heads, slugKey(String(i.head)));
      if (!h) throw new ValidationError('unknown_fee_head', { head: i.head });
      await exec(x, `insert into erp.fee_plan_items (org_id, plan_id, head_id, instalment, amount, due_date) values ($1, $2, $3, $4, $5, $6)`, [x.actor.orgId, plan.id, h.id, i.instalment, i.amount, i.due_date]);
    }
  },
  async remove(x, key) {
    const p = bySlug((await planRows(x)).filter((r) => r.active), key);
    if (!p) return;
    const raised = await rows(x, `select 1 from erp.fee_demands d join erp.fee_plan_items i on i.org_id = d.org_id and i.id = d.plan_item_id where i.plan_id = $1 limit 1`, [p.id]);
    if (raised.length) await exec(x, `update erp.fee_plans set active = false where id = $1`, [p.id]);
    else await exec(x, `delete from erp.fee_plans where id = $1`, [p.id]);
  },
};

// ---------------------------------------------------------------- organisation settings (late fee, campus)
const orgSettings = async (x: ApplyCtx): Promise<Row> => ((await rows(x, `select settings from core.organizations where id = $1`, [x.actor.orgId]))[0]?.settings ?? {}) as Row;
async function patchOrg(x: ApplyCtx, set: Row, unset: string[] = []) {
  const r = await exec(x, `update core.organizations set settings = (coalesce(settings, '{}'::jsonb) - $3::text[]) || $2::jsonb where id = $1`, [x.actor.orgId, json(set), unset]);
  if (!r.rowCount) throw Object.assign(new Error('forbidden'), { status: 403 });
}

export const erpLateFeeServer: ServerBlock = {
  key: 'erp.late_fee_rule',
  async read(x) {
    const r = (await orgSettings(x)).late_fee as Row | undefined;
    return clean({ type: r?.type ?? 'none', amount: r?.amount ?? undefined, grace_days: Number(r?.grace_days ?? 0), cap: r?.cap ?? undefined, slabs: r?.slabs ?? undefined });
  },
  async list() {
    return [{ key: 'late_fee', name: 'Late fee rule', system: true }];
  },
  async write(x, _k, s) {
    await patchOrg(x, { late_fee: clean({ type: s.type, amount: s.amount ?? undefined, grace_days: s.grace_days ?? 0, cap: s.cap ?? undefined, slabs: s.slabs ?? undefined }) });
  },
  async remove(x) {
    await patchOrg(x, { late_fee: { type: 'none' } });
  },
  async capture(x) {
    return { late_fee: (await orgSettings(x)).late_fee ?? null };
  },
  async restore(x, _k, state) {
    if (state?.late_fee) await patchOrg(x, { late_fee: state.late_fee });
    else await patchOrg(x, {}, ['late_fee']);
  },
};

const CAMPUS_KEYS = ['library_fine_per_day', 'homework_approval', 'quiet_hours'] as const;
export const erpCampusServer: ServerBlock = {
  key: 'erp.campus_settings',
  async read(x) {
    const s = await orgSettings(x);
    return clean({ library_fine_per_day: s.library_fine_per_day ?? undefined, homework_approval: s.homework_approval ?? undefined, quiet_from: s.quiet_hours?.from ?? undefined, quiet_to: s.quiet_hours?.to ?? undefined });
  },
  async list() {
    return [{ key: 'campus', name: 'Campus settings', system: true }];
  },
  async write(x, _k, s) {
    const cur = await orgSettings(x);
    const set: Row = {};
    if (s.library_fine_per_day != null) set.library_fine_per_day = s.library_fine_per_day;
    if (s.homework_approval != null) set.homework_approval = s.homework_approval;
    if (s.quiet_from != null && s.quiet_to != null) set.quiet_hours = { ...(cur.quiet_hours ?? {}), from: s.quiet_from, to: s.quiet_to };
    await patchOrg(x, set);
  },
  async remove() {
    throw new ValidationError('setting_cannot_be_removed', { block: 'erp.campus_settings' });
  },
  async capture(x) {
    const s = await orgSettings(x);
    return Object.fromEntries(CAMPUS_KEYS.map((k) => [k, s[k] ?? null]));
  },
  async restore(x, _k, state) {
    const st = (state ?? {}) as Row;
    const set = Object.fromEntries(CAMPUS_KEYS.filter((k) => st[k] != null).map((k) => [k, st[k]]));
    await patchOrg(x, set, CAMPUS_KEYS.filter((k) => st[k] == null));
  },
};

// ---------------------------------------------------------------- concessions, approvals, automations
export const erpConcessionTypeServer = namedTable({
  key: 'erp.concession_type',
  table: 'erp.concession_types',
  cols: ['name', 'kind', 'value', 'head_type', 'max_amount', 'auto_rule', 'stackable'],
  toSettings: (r) => clean({ name: r.name, kind: r.kind, value: Number(r.value), head_type: r.head_type, max_amount: num(r.max_amount) ?? undefined, auto_rule: r.auto_rule, stackable: !!r.stackable }),
});

const ruleRows = (x: ApplyCtx) => rows(x, `select * from erp.approval_rules where org_id = $1 and deleted_at is null order by seq, created_at`, [x.actor.orgId]);
export const erpApprovalRuleServer: ServerBlock = {
  key: 'erp.approval_rule',
  async read(x, key) {
    const r = (await ruleRows(x)).find((y) => y.key === key);
    return r ? clean({ key: r.key, name: r.name, approval_type: r.approval_type, min_amount: num(r.min_amount) ?? undefined, min_percent: num(r.min_percent) ?? undefined, steps: r.steps, seq: r.seq, active: r.active }) : null;
  },
  async list(x) {
    return (await ruleRows(x)).map((r) => ({ key: r.key, name: `${r.name} (${r.approval_type})` }));
  },
  async write(x, key, s) {
    const vals = [s.name, s.approval_type, s.min_amount ?? null, s.min_percent ?? null, json(s.steps), s.seq ?? 1, s.active !== false];
    // a removed rule keeps its key (unique per org): writing it again brings that row back
    const cur = (await rows(x, `select id from erp.approval_rules where org_id = $1 and key = $2`, [x.actor.orgId, key]))[0];
    if (cur) await exec(x, `update erp.approval_rules set name = $2, approval_type = $3, min_amount = $4, min_percent = $5, steps = $6, seq = $7, active = $8, deleted_at = null where id = $1`, [cur.id, ...vals]);
    else await exec(x, `insert into erp.approval_rules (org_id, key, name, approval_type, min_amount, min_percent, steps, seq, active) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`, [x.actor.orgId, key, ...vals]);
  },
  async remove(x, key) {
    await exec(x, `update erp.approval_rules set deleted_at = now() where org_id = $1 and key = $2 and deleted_at is null`, [x.actor.orgId, key]);
  },
};

const autoRows = (x: ApplyCtx) => rows(x, `select * from erp.automations where org_id = $1 and deleted_at is null order by created_at`, [x.actor.orgId]);
const autoKey = (r: Row) => (r.recipe_key ? String(r.recipe_key) : slugKey(r.name));
export const erpAutomationServer: ServerBlock = {
  key: 'erp.automation',
  async read(x, key) {
    const r = (await autoRows(x)).find((y) => autoKey(y) === key);
    return r ? { key, name: r.name, trigger: r.trigger, conditions: r.conditions ?? {}, actions: r.actions ?? [], enabled: r.enabled, test_mode: r.test_mode } : null;
  },
  async list(x) {
    return (await autoRows(x)).map((r) => ({ key: autoKey(r), name: `${r.name}${r.enabled ? '' : ' (paused)'}` }));
  },
  async write(x, key, s) {
    const vals = [s.name, s.trigger, json(s.conditions ?? {}), json(s.actions ?? []), s.enabled !== false, !!s.test_mode];
    const cur = (await autoRows(x)).find((y) => autoKey(y) === key);
    if (cur) await exec(x, `update erp.automations set name = $2, trigger = $3, conditions = $4, actions = $5, enabled = $6, test_mode = $7 where id = $1`, [cur.id, ...vals]);
    else await exec(x, `insert into erp.automations (org_id, recipe_key, name, trigger, conditions, actions, enabled, test_mode) values ($1, $2, $3, $4, $5, $6, $7, $8)`, [x.actor.orgId, key, ...vals]);
  },
  async remove(x, key) {
    const cur = (await autoRows(x)).find((y) => autoKey(y) === key);
    if (cur) await exec(x, `update erp.automations set deleted_at = now() where id = $1`, [cur.id]);
  },
};

// ---------------------------------------------------------------- message templates, leave types, documents
const tplRows = (x: ApplyCtx) => rows(x, `select * from core.message_templates where org_id = $1 and product_key = 'erp' and deleted_at is null order by created_at`, [x.actor.orgId]);
const tplFind = (list: Row[], key: string) => list.find((r) => `${slugKey(r.name)}__${r.channel}` === key) ?? null;
export const erpTemplateServer: ServerBlock = {
  key: 'erp.message_template',
  async read(x, key) {
    const t = tplFind(await tplRows(x), key);
    return t ? clean({ name: t.name, channel: t.channel, event_key: t.event_key ?? undefined, category: t.category ?? 'utility', language: t.language ?? 'en', body: t.body }) : null;
  },
  async list(x) {
    return (await tplRows(x)).map((t) => ({ key: `${slugKey(t.name)}__${t.channel}`, name: `${t.name} (${t.channel})` }));
  },
  async write(x, key, s) {
    const cur = tplFind(await tplRows(x), key);
    const vals = [s.name, s.channel, s.event_key ?? null, s.category ?? 'utility', s.language ?? 'en', s.body];
    if (cur) await exec(x, `update core.message_templates set name = $2, channel = $3, event_key = $4, category = $5, language = $6, body = $7 where id = $1`, [cur.id, ...vals]);
    else await exec(x, `insert into core.message_templates (org_id, product_key, name, channel, event_key, category, language, body, status) values ($1, 'erp', $2, $3, $4, $5, $6, $7, $8)`, [x.actor.orgId, ...vals, s.channel === 'whatsapp' ? 'submitted' : 'approved']);
  },
  async remove(x, key) {
    const cur = tplFind(await tplRows(x), key);
    if (cur) await exec(x, `update core.message_templates set deleted_at = now() where id = $1`, [cur.id]);
  },
  async capture(x, key) {
    const t = tplFind(await tplRows(x), key);
    return t ? { name: t.name, channel: t.channel, event_key: t.event_key, category: t.category, language: t.language, body: t.body, status: t.status } : null;
  },
  async restore(x, key, state) {
    const cur = tplFind(await tplRows(x), key);
    if (!state) {
      if (cur) await exec(x, `update core.message_templates set deleted_at = now() where id = $1`, [cur.id]);
      return;
    }
    const vals = [state.name, state.channel, state.event_key ?? null, state.category, state.language, state.body, state.status];
    if (cur) await exec(x, `update core.message_templates set name = $2, channel = $3, event_key = $4, category = $5, language = $6, body = $7, status = $8 where id = $1`, [cur.id, ...vals]);
    else await exec(x, `insert into core.message_templates (org_id, product_key, name, channel, event_key, category, language, body, status) values ($1, 'erp', $2, $3, $4, $5, $6, $7, $8)`, [x.actor.orgId, ...vals]);
  },
};

const LEAVE_COLS = ['name', 'unit', 'yearly_quota', 'accrual', 'carry_forward', 'carry_forward_max', 'half_day_allowed', 'notice_days', 'doc_required_after_days', 'sandwich_rule', 'paid'] as const;
export const erpLeaveTypeServer: ServerBlock = {
  key: 'erp.leave_type',
  async read(x, key) {
    const r = (await rows(x, `select key, ${LEAVE_COLS.join(', ')} from core.leave_types where org_id = $1 and key = $2 and applies_to = 'staff' and active and deleted_at is null`, [x.actor.orgId, key]))[0];
    return r ? clean({ ...r, yearly_quota: num(r.yearly_quota), carry_forward_max: num(r.carry_forward_max) }) : null;
  },
  list: (x) => rows(x, `select key, name from core.leave_types where org_id = $1 and applies_to = 'staff' and active and deleted_at is null order by name`, [x.actor.orgId]) as Promise<{ key: string; name: string }[]>,
  async write(x, key, s) {
    await exec(
      x,
      `insert into core.leave_types (org_id, key, applies_to, active, ${LEAVE_COLS.join(', ')}) values ($1, $2, 'staff', true, ${LEAVE_COLS.map((_, i) => `$${i + 3}`).join(', ')})
       on conflict (org_id, key) do update set active = true, deleted_at = null, ${LEAVE_COLS.map((k) => `${k} = excluded.${k}`).join(', ')}`,
      [x.actor.orgId, key, ...LEAVE_COLS.map((k) => s[k] ?? null)],
    );
  },
  async remove(x, key) {
    await exec(x, `update core.leave_types set deleted_at = now() where org_id = $1 and key = $2 and deleted_at is null`, [x.actor.orgId, key]);
  },
};

export const erpDocTemplateServer = namedTable({
  key: 'erp.doc_template',
  table: 'erp.doc_templates',
  cols: ['name', 'type', 'body'],
  live: 'active',
  removeSql: 'update erp.doc_templates set active = false where id = $1',
  toSettings: (r) => ({ name: r.name, type: r.type, body: r.body, active: true }),
});

// ---------------------------------------------------------------- grading
export const erpGradingScaleServer = namedTable({
  key: 'erp.grading_scale',
  table: 'erp.grading_scales',
  cols: ['name', 'bands'],
  toSettings: (r) => ({ name: r.name, bands: r.bands }),
});

const schemeRows = async (x: ApplyCtx) =>
  rows(x, `select s.*, g.name as scale_name, p.name as programme_name from erp.assessment_schemes s left join erp.grading_scales g on g.org_id = s.org_id and g.id = s.scale_id
            left join core.programmes p on p.org_id = s.org_id and p.id = s.programme_id where s.org_id = $1 and s.deleted_at is null and s.academic_year_id is not distinct from $2 order by s.created_at`, [x.actor.orgId, await currentYear(x)]);
export const erpAssessmentSchemeServer: ServerBlock = {
  key: 'erp.assessment_scheme',
  async read(x, key) {
    const s = bySlug(await schemeRows(x), key);
    return s ? clean({ name: s.name, pack: s.pack, scale: s.scale_name ?? undefined, programme: s.programme_name ?? undefined, pass_percent: s.config?.pass_percent ?? undefined, active: s.active }) : null;
  },
  async list(x) {
    return (await schemeRows(x)).map((s) => ({ key: slugKey(s.name), name: `${s.name} (${s.pack})` }));
  },
  async check(x, s, _op, plan) {
    if (!s.scale) return [];
    const scales = [...(await rows(x, `select name from erp.grading_scales where org_id = $1 and deleted_at is null`, [x.actor.orgId])), ...plan.filter((o) => o.block === 'erp.grading_scale').map((o) => ({ name: o.settings.name }))];
    return bySlug(scales, slugKey(String(s.scale))) ? [] : [`unknown_scale: ${s.scale}`];
  },
  async write(x, key, s) {
    const year = await currentYear(x);
    let scaleId: string | null = null;
    if (s.scale) {
      const g = bySlug(await rows(x, `select id, name from erp.grading_scales where org_id = $1 and deleted_at is null`, [x.actor.orgId]), slugKey(String(s.scale)));
      if (!g) throw new ValidationError('unknown_scale', { scale: s.scale });
      scaleId = g.id;
    }
    const cur = bySlug(await schemeRows(x), key);
    const base = (cur?.config as Row | undefined) ?? ((SCHEME_CONFIG as Record<string, object>)[String(s.pack)] ?? SCHEME_CONFIG.default) as Row;
    const config = { ...base, ...(s.pass_percent != null ? { pass_percent: s.pass_percent } : {}) };
    const vals = [s.name, s.pack, scaleId, await programmeId(x, s.programme), json(config), s.active !== false];
    if (cur) await exec(x, `update erp.assessment_schemes set name = $2, pack = $3, scale_id = $4, programme_id = $5, config = $6, active = $7 where id = $1`, [cur.id, ...vals]);
    else await exec(x, `insert into erp.assessment_schemes (org_id, academic_year_id, name, pack, scale_id, programme_id, config, active) values ($1, $2, $3, $4, $5, $6, $7, $8)`, [x.actor.orgId, year, ...vals]);
  },
  async remove(x, key) {
    const cur = bySlug(await schemeRows(x), key);
    if (cur) await exec(x, `update erp.assessment_schemes set deleted_at = now() where id = $1`, [cur.id]);
  },
  async capture(x, key) {
    const s = bySlug(await schemeRows(x), key);
    return s ? { name: s.name, pack: s.pack, scale_id: s.scale_id, programme_id: s.programme_id, config: s.config, active: s.active } : null;
  },
  async restore(x, key, state) {
    const cur = bySlug(await schemeRows(x), key);
    if (!state) {
      if (cur) await exec(x, `update erp.assessment_schemes set deleted_at = now() where id = $1`, [cur.id]);
      return;
    }
    const vals = [state.name, state.pack, state.scale_id, state.programme_id, json(state.config), state.active];
    if (cur) await exec(x, `update erp.assessment_schemes set name = $2, pack = $3, scale_id = $4, programme_id = $5, config = $6, active = $7 where id = $1`, [cur.id, ...vals]);
    else await exec(x, `insert into erp.assessment_schemes (org_id, academic_year_id, name, pack, scale_id, programme_id, config, active) values ($1, $2, $3, $4, $5, $6, $7, $8)`, [x.actor.orgId, await currentYear(x), ...vals]);
  },
};

// ---------------------------------------------------------------- roles matrix and modules
const splitCell = (key: string) => {
  const i = key.lastIndexOf('__');
  return { role: key.slice(0, i), cap: key.slice(i + 2) };
};
async function erpRole(x: ApplyCtx, key: string): Promise<{ id: string; name: string } | null> {
  return maybe(await erp(x), `select id, name from core.roles where org_id = $1 and product_key = 'erp' and key = $2`, [x.actor.orgId, key]);
}
const permRows = (x: ApplyCtx, roleId: string) => rows(x, `select module_key, action, scope from core.role_permissions where role_id = $1 order by module_key, action`, [roleId]);

export const erpRolePermissionServer: ServerBlock = {
  key: 'erp.role_permission',
  async read(x, key) {
    const { role, cap } = splitCell(key);
    const r = await erpRole(x, role);
    return r ? { role_key: role, capability: cap, level: erpLevelOf(cap, (await permRows(x, r.id)) as { module_key: string; action: string }[]) } : null;
  },
  async list(x) {
    const roles = await rows(x, `select r.id, r.key, r.name from core.roles r where r.org_id = $1 and r.product_key = 'erp' and r.key not in ('group_admin', 'portal') order by r.name`, [x.actor.orgId]);
    const out: { key: string; name: string }[] = [];
    for (const r of roles) {
      const perms = (await permRows(x, r.id)) as { module_key: string; action: string }[];
      for (const cap of Object.keys(ERP_CAP_MODULES)) {
        const level = erpLevelOf(cap, perms);
        if (level !== '-') out.push({ key: `${r.key}__${cap}`, name: `${r.name}: ${cap} = ${level}` });
      }
    }
    return out;
  },
  async write(x, key, s) {
    const { role, cap } = splitCell(key);
    if (['group_admin', 'portal'].includes(role) || cap === 'admin') throw new ValidationError('permission_is_manual', { role, cap });
    const r = await erpRole(x, role);
    if (!r) throw new ValidationError('unknown_role', { role });
    const mods = ERP_CAP_MODULES[cap] ?? [cap];
    await exec(x, `delete from core.role_permissions where role_id = $1 and module_key = any($2)`, [r.id, mods]);
    for (const m of mods) for (const p of erpLevelRows(String(s.level))) await exec(x, `insert into core.role_permissions (org_id, role_id, module_key, action, scope) values ($1, $2, $3, $4, $5)`, [x.actor.orgId, r.id, m, p.action, p.scope]);
  },
  async remove(x, key) {
    await this.write(x, key, { level: '-' });
  },
  /** The exact rows of the capability's modules (a level is lossy: hand-edited rows come back as they were). */
  async capture(x, key) {
    const { role, cap } = splitCell(key);
    const r = await erpRole(x, role);
    if (!r) return null;
    const mods = ERP_CAP_MODULES[cap] ?? [cap];
    return { rows: (await permRows(x, r.id)).filter((p) => mods.includes(p.module_key)) };
  },
  async restore(x, key, state) {
    const { role, cap } = splitCell(key);
    const r = await erpRole(x, role);
    if (!r) return;
    const mods = ERP_CAP_MODULES[cap] ?? [cap];
    await exec(x, `delete from core.role_permissions where role_id = $1 and module_key = any($2)`, [r.id, mods]);
    for (const p of ((state?.rows as Row[]) ?? [])) await exec(x, `insert into core.role_permissions (org_id, role_id, module_key, action, scope) values ($1, $2, $3, $4, $5)`, [x.actor.orgId, r.id, p.module_key, p.action, p.scope]);
  },
};

const flagFind = async (x: ApplyCtx, key: string) => {
  const i = key.lastIndexOf('__');
  const module = key.slice(0, i);
  const code = key.slice(i + 2);
  const branch = code === 'ALL' ? null : branchOf(x, code);
  const r = (await rows(x, `select id, enabled from erp.module_flags where org_id = $1 and module_key = $2 and branch_id is not distinct from $3 and deleted_at is null`, [x.actor.orgId, module, branch]))[0] ?? null;
  return { module, code, branch, r };
};
export const erpModuleFlagServer: ServerBlock = {
  key: 'erp.module_flag',
  async read(x, key) {
    const f = await flagFind(x, key);
    return f.r ? { module_key: f.module, branch_code: f.code === 'ALL' ? null : f.code, enabled: f.r.enabled } : null;
  },
  async list(x) {
    return (await rows(x, `select f.module_key, b.code from erp.module_flags f left join core.branches b on b.id = f.branch_id where f.org_id = $1 and f.deleted_at is null`, [x.actor.orgId])).map((r) => ({ key: `${r.module_key}__${r.code ?? 'ALL'}`, name: `${r.module_key} @ ${r.code ?? 'all branches'}` }));
  },
  async write(x, key, s) {
    const f = await flagFind(x, key);
    if (f.r) await exec(x, `update erp.module_flags set enabled = $2 where id = $1`, [f.r.id, s.enabled]);
    else await exec(x, `insert into erp.module_flags (org_id, branch_id, module_key, enabled) values ($1, $2, $3, $4)`, [x.actor.orgId, f.branch, f.module, s.enabled]);
  },
  async remove(x, key) {
    const f = await flagFind(x, key);
    if (f.r) await exec(x, `delete from erp.module_flags where id = $1`, [f.r.id]);
  },
};

export const ERP_SERVER_BLOCKS: ServerBlock[] = [
  erpFeeHeadServer,
  erpFeePlanServer,
  erpLateFeeServer,
  erpConcessionTypeServer,
  erpApprovalRuleServer,
  erpAutomationServer,
  erpTemplateServer,
  erpLeaveTypeServer,
  erpDocTemplateServer,
  erpCampusServer,
  erpGradingScaleServer,
  erpAssessmentSchemeServer,
  erpRolePermissionServer,
  erpModuleFlagServer,
];
