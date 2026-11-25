/**
 * CRM blocks, applied through the CRM server's own data layer: every statement runs in the designer's crm_server
 * transaction (x.tx('crm')) with the signed-in person's claims, wrapped in the CRM's Db (packages/crm-server/src/db.ts),
 * so the CRM row policies (crm.scope_of / app.can 'admin' 'configure' ...), the platform audit trigger and the CRM's
 * own audit trail (crm.audit_event, as the admin console writes it) apply exactly as for Admin -> Pipeline, Routing,
 * Templates, Forms, Workflows and Roles. Never asSystem, never the owner.
 *
 *   crm.stage             crm.stages (+ phase)            crm.lead_source       crm.sources
 *   crm.assignment_rule   crm.assignment_rules (+ crm.counsellor_settings capacity of the role's people)
 *   crm.follow_up_sla     crm.settings.settings.first_response_mins
 *   crm.workflow          crm.workflows (+ stop_rules)    crm.message_template  core.message_templates (product crm)
 *   crm.enquiry_form      crm.forms                       crm.messaging_limits  crm.settings quiet_hours / max_auto_per_day
 *   crm.scoring           crm.settings scoring / hot_at / warm_at
 *   crm.role              core.roles + crm.roles          crm.role_permission   crm.roles.permissions (one cell)
 */
import crypto from 'node:crypto';
import { slugKey } from '@autoed/shared';
import { Db, type Row } from '@autoed/crm-server/db';
import { audit, DEFAULT_SCORING } from '@autoed/crm-server/core';
import { ValidationError } from '../../../db';
import { clean, num, type ApplyCtx, type ServerBlock, type Settings } from '../types';

async function crm(x: ApplyCtx): Promise<Db> {
  return new Db(await x.tx('crm'), x.actor.orgId, x.actor.userId);
}
/** The CRM's own audit trail entry, like the admin console's (who is the signed-in person; the database adds the session). */
const log = (db: Db, x: ApplyCtx, entity: string, summary: string, before?: unknown, after?: unknown) =>
  audit(db, { id: x.actor.userId, name: x.actor.kind === 'relationship_manager' ? 'AutoEd (AI designer, support session)' : 'AI designer' }, 'config', entity, null, `AI designer: ${summary}`, before, after);
const settingsOf = async (db: Db): Promise<Row> => ((await db.one('select settings from crm.settings where org_id = $1', [db.requireOrg()]))?.settings ?? {}) as Row;
/** A write the row policies refused changes no row: that is an error here, never a silent "published" no-op. */
const refused = () => Object.assign(new Error('forbidden'), { status: 403 });
async function setSettings(db: Db, patch: Row) {
  const r = await db.client.query('update crm.settings set settings = settings || $2::jsonb where org_id = $1', [db.requireOrg(), JSON.stringify(patch)]);
  if (!r.rowCount) throw refused();
}
/** Update by id through the CRM's Db; refused (403) when the row policies let nothing change. */
async function mustUpdate(db: Db, table: string, id: string, data: Row) {
  if (!(await db.update(table, id, data))) throw refused();
}
async function mustRun(db: Db, sql: string, params: unknown[]) {
  const r = await db.client.query(sql, params.map((v) => (v !== null && typeof v === 'object' && !Array.isArray(v) ? JSON.stringify(v) : v)));
  if (!r.rowCount) throw refused();
}
const bySlug = <T extends Row>(rows: T[], key: string, field = 'name') => rows.find((r) => slugKey(String(r[field])) === key) ?? null;
const branchId = (x: ApplyCtx, code: string | null | undefined) => {
  if (!code) return null;
  const b = x.actor.branches.find((br) => br.code === code);
  if (!b) throw new ValidationError('unknown_branch', { branch: code });
  return b.id;
};
const branchCode = (x: ApplyCtx, id: string | null | undefined) => (id ? (x.actor.branches.find((b) => b.id === id)?.code ?? null) : null);

// ---------------------------------------------------------------- pipeline stages
const PRODUCT_STAGES = new Set(['new', 'new_data', 'admission_confirmed']);
const stageRows = async (db: Db) => db.q('select s.*, p.key as phase from crm.stages s join crm.phases p on p.org_id = s.org_id and p.id = s.phase_id where s.org_id = $1 order by s.active desc, s.seq', [db.requireOrg()]);

export const crmStageServer: ServerBlock = {
  key: 'crm.stage',
  async read(x, key) {
    const s = bySlug((await stageRows(await crm(x))).filter((r) => r.active), key);
    if (!s) return null;
    return clean({ name: s.name, phase: s.phase, color: s.color, probability: s.probability, sla_hours: s.sla_hours ?? undefined, required_fields: s.required_fields ?? [], exempt_next_action: s.exempt_next_action });
  },
  async list(x) {
    return (await stageRows(await crm(x))).filter((r) => r.active).map((r) => ({ key: slugKey(r.name), name: r.name, system: PRODUCT_STAGES.has(slugKey(r.name)) }));
  },
  async check(x, s) {
    const cur = bySlug(await stageRows(await crm(x)), slugKey(String(s.name)));
    return cur && cur.phase !== s.phase ? [`stage_phase_fixed: ${cur.name} is in ${cur.phase}`] : [];
  },
  async write(x, key, s) {
    const db = await crm(x);
    const cur = bySlug(await stageRows(db), key);
    const data = { name: s.name, color: s.color ?? 'slate', probability: s.probability ?? 0, sla_hours: s.sla_hours ?? null, required_fields: s.required_fields ?? [], exempt_next_action: !!s.exempt_next_action, active: true };
    if (cur) {
      if (cur.phase !== s.phase) throw new ValidationError('stage_phase_fixed', { stage: cur.name });
      await mustUpdate(db, 'crm.stages', cur.id, data);
      await log(db, x, 'stage', `Edited stage "${s.name}"`, { name: cur.name, sla_hours: cur.sla_hours, required_fields: cur.required_fields }, data);
      return;
    }
    const ph = await db.one('select * from crm.phases where org_id = $1 and key = $2', [db.requireOrg(), s.phase]);
    if (!ph) throw new ValidationError('unknown_phase', { phase: s.phase });
    const n = await db.one('select coalesce(max(seq), 0) + 1 as n from crm.stages where org_id = $1 and phase_id = $2', [db.requireOrg(), ph.id]);
    await db.insert('crm.stages', { phase_id: ph.id, seq: n!.n, ...data, is_closed: ph.key === 'closed', is_won: ph.key === 'enrolled', exempt_next_action: data.exempt_next_action || ['closed', 'enrolled', 'prospect'].includes(ph.key) });
    await log(db, x, 'stage', `Added stage "${s.name}" to ${ph.name}`);
  },
  async remove(x, key) {
    const db = await crm(x);
    const cur = bySlug((await stageRows(db)).filter((r) => r.active), key);
    if (!cur) return;
    if (PRODUCT_STAGES.has(key)) throw new ValidationError('stage_used_by_product', { stage: cur.name });
    const n = await db.one('select count(*)::int as n from crm.enquiries where org_id = $1 and stage_id = $2', [db.requireOrg(), cur.id]);
    if (n!.n > 0) throw new ValidationError('stage_has_records', { stage: cur.name, records: n!.n });
    await mustUpdate(db, 'crm.stages', cur.id, { active: false });
    await log(db, x, 'stage', `Retired stage "${cur.name}"`);
  },
};

// ---------------------------------------------------------------- lead sources
const sourceRows = async (db: Db) => db.q('select * from crm.sources where org_id = $1 order by active desc, created_at', [db.requireOrg()]);
export const crmSourceServer: ServerBlock = {
  key: 'crm.lead_source',
  async read(x, key) {
    const s = bySlug((await sourceRows(await crm(x))).filter((r) => r.active), key);
    return s ? { channel: s.channel, name: s.name, cost: num(s.cost) ?? 0, active: true } : null;
  },
  async list(x) {
    return (await sourceRows(await crm(x))).filter((r) => r.active).map((r) => ({ key: slugKey(r.name), name: `${r.channel}: ${r.name}` }));
  },
  async write(x, key, s) {
    const db = await crm(x);
    const cur = bySlug(await sourceRows(db), key);
    const data = { channel: s.channel, name: s.name, cost: s.cost ?? 0, active: s.active !== false };
    if (cur) await mustUpdate(db, 'crm.sources', cur.id, data);
    else await db.insert('crm.sources', data);
    await log(db, x, 'source', `Saved source "${s.name}"`);
  },
  async remove(x, key) {
    const db = await crm(x);
    const cur = bySlug((await sourceRows(db)).filter((r) => r.active), key);
    if (cur) await mustUpdate(db, 'crm.sources', cur.id, { active: false });
  },
};

// ---------------------------------------------------------------- routing rules (+ capacity of the role's people)
const ruleRows = async (db: Db) => db.q('select * from crm.assignment_rules where org_id = $1 order by seq, created_at', [db.requireOrg()]);
const capacities = async (db: Db): Promise<Record<string, number>> =>
  Object.fromEntries((await db.q('select user_id, daily_capacity from crm.counsellor_settings where org_id = $1 order by user_id', [db.requireOrg()])).map((r) => [r.user_id, Number(r.daily_capacity)]));

function ruleSettings(x: ApplyCtx, r: Row): Settings {
  const c = (r.conditions ?? {}) as Row;
  return clean({ name: r.name, seq: r.seq, method: r.method, role_key: c.role_key ?? undefined, branch_code: branchCode(x, c.branch_id) ?? undefined, channel: c.channel ?? undefined, grades: c.grades ?? [], daily_capacity: c.daily_capacity ?? undefined });
}

export const crmAssignmentRuleServer: ServerBlock = {
  key: 'crm.assignment_rule',
  async read(x, key) {
    const r = bySlug(await ruleRows(await crm(x)), key);
    return r ? ruleSettings(x, r) : null;
  },
  async list(x) {
    return (await ruleRows(await crm(x))).map((r) => ({ key: slugKey(r.name), name: r.name }));
  },
  async write(x, key, s) {
    const db = await crm(x);
    const branch = branchId(x, s.branch_code as string | null);
    const people = await db.q(
      `select id from crm.staff_v where org_id = $1 and active and role_key = $2 and ($3::uuid is null or branch_ids = '[]'::jsonb or branch_ids @> to_jsonb($3::text)) order by name`,
      [db.requireOrg(), s.role_key, branch],
    );
    if (!people.length) throw new ValidationError('no_one_holds_role', { role: s.role_key });
    const data = {
      name: s.name,
      seq: s.seq ?? 1,
      method: s.method === 'least_load' ? 'least_load' : 'round_robin',
      user_ids: people.map((p) => p.id),
      conditions: clean({ branch_id: branch ?? undefined, channel: s.channel ?? undefined, grades: s.grades ?? [], role_key: s.role_key, daily_capacity: s.daily_capacity ?? undefined }),
      active: true,
    };
    const cur = bySlug(await ruleRows(db), key);
    if (cur) await mustUpdate(db, 'crm.assignment_rules', cur.id, data);
    else await db.insert('crm.assignment_rules', data);
    if (s.daily_capacity != null) {
      for (const p of people) {
        await db.q('insert into crm.counsellor_settings (org_id, user_id, daily_capacity) values ($1, $2, $3) on conflict (org_id, user_id) do update set daily_capacity = excluded.daily_capacity', [db.requireOrg(), p.id, s.daily_capacity]);
      }
    }
    await log(db, x, 'assignment_rule', `Assignment rule saved: ${s.name} (${s.role_key})`);
  },
  async remove(x, key) {
    const db = await crm(x);
    const cur = bySlug(await ruleRows(db), key);
    if (cur) await mustRun(db, 'delete from crm.assignment_rules where org_id = $1 and id = $2', [db.requireOrg(), cur.id]);
  },
  /** The rule as stored (user ids included) and every person's daily capacity: undo puts both back exactly. */
  async capture(x, key) {
    const db = await crm(x);
    const r = bySlug(await ruleRows(db), key);
    return { rule: r ? { name: r.name, seq: r.seq, method: r.method, user_ids: r.user_ids, conditions: r.conditions, active: r.active } : null, capacities: await capacities(db) };
  },
  async restore(x, key, state) {
    const db = await crm(x);
    const st = (state ?? { rule: null, capacities: null }) as { rule: Row | null; capacities: Record<string, number> | null };
    const cur = bySlug(await ruleRows(db), key);
    if (!st.rule) {
      if (cur) await mustRun(db, 'delete from crm.assignment_rules where org_id = $1 and id = $2', [db.requireOrg(), cur.id]);
    } else if (cur) await mustUpdate(db, 'crm.assignment_rules', cur.id, st.rule);
    else await db.insert('crm.assignment_rules', st.rule);
    if (st.capacities) {
      const now = await capacities(db);
      for (const [u, n] of Object.entries(now)) {
        if (!(u in st.capacities)) await db.q('delete from crm.counsellor_settings where org_id = $1 and user_id = $2', [db.requireOrg(), u]);
        else if (st.capacities[u] !== n) await db.q('update crm.counsellor_settings set daily_capacity = $3 where org_id = $1 and user_id = $2', [db.requireOrg(), u, st.capacities[u]]);
      }
    }
  },
};

// ---------------------------------------------------------------- settings singletons (SLA, quiet hours, scoring)
function settingsBlock(key: string, instance: string, name: string, read: (s: Row) => Settings, patch: (s: Settings, cur: Row) => Row): ServerBlock {
  return {
    key,
    async read(x) {
      return read(await settingsOf(await crm(x)));
    },
    async list() {
      return [{ key: instance, name, system: true }];
    },
    async write(x, _k, s) {
      const db = await crm(x);
      const cur = await settingsOf(db);
      const p = patch(s, cur);
      await setSettings(db, p);
      await log(db, x, key.replace('crm.', ''), `Changed ${name.toLowerCase()}`, Object.fromEntries(Object.keys(p).map((k) => [k, cur[k] ?? null])), p);
    },
    async remove() {
      throw new ValidationError('setting_cannot_be_removed', { block: key });
    },
  };
}

export const crmSlaServer = settingsBlock(
  'crm.follow_up_sla',
  'first_response',
  'First response time',
  (s) => ({ first_response_hours: Math.round((Number(s.first_response_mins ?? 30) / 60) * 100) / 100 }),
  (s) => ({ first_response_mins: Math.max(1, Math.round(Number(s.first_response_hours) * 60)) }),
);
export const crmMessagingLimitsServer = settingsBlock(
  'crm.messaging_limits',
  'messaging',
  'Quiet hours and message cap',
  (s) => ({ quiet_from: Number(s.quiet_hours?.from ?? 21), quiet_to: Number(s.quiet_hours?.to ?? 8), max_auto_per_day: Number(s.max_auto_per_day ?? 4) }),
  (s) => ({ quiet_hours: { from: s.quiet_from, to: s.quiet_to }, max_auto_per_day: s.max_auto_per_day }),
);
export const crmScoringServer = settingsBlock(
  'crm.scoring',
  'scoring',
  'Lead scoring rules',
  (s) => ({ weights: { ...DEFAULT_SCORING, ...(s.scoring ?? {}) }, hot_at: Number(s.hot_at ?? 60), warm_at: Number(s.warm_at ?? 30) }),
  (s, cur) => ({ scoring: { ...DEFAULT_SCORING, ...(cur.scoring ?? {}), ...Object.fromEntries(Object.entries((s.weights ?? {}) as Row).filter(([, v]) => v != null)) }, hot_at: s.hot_at, warm_at: s.warm_at }),
);

// ---------------------------------------------------------------- workflows
const wfRows = async (db: Db) => db.q('select * from crm.workflows where org_id = $1 order by created_at', [db.requireOrg()]);
const wfKey = (w: Row) => (w.recipe_key ? String(w.recipe_key) : slugKey(w.name));
const wfFind = (rows: Row[], key: string) => rows.find((w) => wfKey(w) === key) ?? null;

export const crmWorkflowServer: ServerBlock = {
  key: 'crm.workflow',
  async read(x, key) {
    const w = wfFind(await wfRows(await crm(x)), key);
    if (!w) return null;
    return clean({
      key,
      name: w.name,
      description: w.description ?? undefined,
      trigger: w.trigger,
      conditions: w.conditions ?? [],
      steps: w.steps ?? [],
      status: w.status,
      stop_on_reply: w.stop_rules?.on_reply !== false,
      stop_on_stage_change: w.stop_rules?.on_stage_change !== false,
    });
  },
  async list(x) {
    return (await wfRows(await crm(x))).map((w) => ({ key: wfKey(w), name: `${w.name} (${w.status})` }));
  },
  async check(x, s, _op, plan) {
    const db = await crm(x);
    const stages = new Set((await db.q('select name from crm.stages where org_id = $1 and active', [db.requireOrg()])).map((r) => String(r.name)));
    for (const o of plan) if (o.block === 'crm.stage') stages.add(String(o.settings.name));
    return ((s.steps as Row[]) ?? []).filter((st) => st.type === 'stage' && !stages.has(String(st.stage))).map((st) => `unknown_stage: ${st.stage}`);
  },
  async write(x, key, s) {
    const db = await crm(x);
    const cur = wfFind(await wfRows(db), key);
    const data = {
      name: s.name,
      description: s.description ?? null,
      trigger: s.trigger,
      conditions: s.conditions ?? [],
      steps: s.steps,
      status: s.status ?? 'published',
      stop_rules: { on_reply: s.stop_on_reply !== false, on_stage_change: s.stop_on_stage_change !== false },
    };
    if (cur) {
      await mustUpdate(db, 'crm.workflows', cur.id, { ...data, version: Number(cur.version) + 1 });
      await log(db, x, 'workflow', `Edited workflow "${s.name}" (version ${Number(cur.version) + 1})`, { steps: cur.steps, status: cur.status }, { steps: data.steps, status: data.status });
    } else {
      await db.insert('crm.workflows', { recipe_key: key, ...data });
      await log(db, x, 'workflow', `Added workflow "${s.name}" (${data.status})`);
    }
  },
  async remove(x, key) {
    const db = await crm(x);
    const cur = wfFind(await wfRows(db), key);
    if (!cur) return;
    await mustRun(db, 'delete from crm.workflows where org_id = $1 and id = $2', [db.requireOrg(), cur.id]);
    await log(db, x, 'workflow', `Removed workflow "${cur.name}"`);
  },
  /** Exact row state (version included) so undo restores what was there, without bumping the version again. */
  async capture(x, key) {
    const w = wfFind(await wfRows(await crm(x)), key);
    return w ? { name: w.name, description: w.description, recipe_key: w.recipe_key, trigger: w.trigger, conditions: w.conditions, steps: w.steps, status: w.status, version: w.version, stop_rules: w.stop_rules } : null;
  },
  async restore(x, key, state) {
    const db = await crm(x);
    const cur = wfFind(await wfRows(db), key);
    if (!state) {
      if (cur) await mustRun(db, 'delete from crm.workflows where org_id = $1 and id = $2', [db.requireOrg(), cur.id]);
      return;
    }
    if (cur) await mustUpdate(db, 'crm.workflows', cur.id, state);
    else await db.insert('crm.workflows', state);
  },
};

// ---------------------------------------------------------------- message templates (core.message_templates, product crm)
const tplRows = async (db: Db, product: string) =>
  db.q(`select * from core.message_templates where org_id = $1 and product_key = $2 and deleted_at is null order by created_at`, [db.requireOrg(), product]);
const tplFind = (rows: Row[], key: string) => rows.find((r) => `${slugKey(r.name)}__${r.channel}` === key) ?? null;

export const crmTemplateServer: ServerBlock = {
  key: 'crm.message_template',
  async read(x, key) {
    const t = tplFind(await tplRows(await crm(x), 'crm'), key);
    return t ? { name: t.name, channel: t.channel, category: t.category ?? 'utility', language: t.language ?? 'en', body: t.body } : null;
  },
  async list(x) {
    return (await tplRows(await crm(x), 'crm')).map((t) => ({ key: `${slugKey(t.name)}__${t.channel}`, name: `${t.name} (${t.channel}, ${t.status})` }));
  },
  async write(x, key, s) {
    const db = await crm(x);
    const cur = tplFind(await tplRows(db, 'crm'), key);
    const data = { name: s.name, channel: s.channel, category: s.category ?? 'utility', language: s.language ?? 'en', body: s.body };
    // as the admin screen: a new WhatsApp template waits for provider approval; an edit keeps its status
    if (cur) await mustUpdate(db, 'core.message_templates', cur.id, data);
    else await db.insert('core.message_templates', { product_key: 'crm', ...data, status: s.channel === 'whatsapp' ? 'submitted' : 'approved' });
    await log(db, x, 'template', `Saved template "${s.name}" (${s.channel})`);
  },
  async remove(x, key) {
    const db = await crm(x);
    const cur = tplFind(await tplRows(db, 'crm'), key);
    if (cur) await mustRun(db, 'update core.message_templates set deleted_at = now() where org_id = $1 and id = $2', [db.requireOrg(), cur.id]);
  },
  async capture(x, key) {
    const t = tplFind(await tplRows(await crm(x), 'crm'), key);
    return t ? { name: t.name, channel: t.channel, category: t.category, language: t.language, body: t.body, status: t.status } : null;
  },
  async restore(x, key, state) {
    const db = await crm(x);
    const cur = tplFind(await tplRows(db, 'crm'), key);
    if (!state) {
      if (cur) await mustRun(db, 'update core.message_templates set deleted_at = now() where org_id = $1 and id = $2', [db.requireOrg(), cur.id]);
    } else if (cur) await mustUpdate(db, 'core.message_templates', cur.id, state);
    else await db.insert('core.message_templates', { product_key: 'crm', ...state });
  },
};

// ---------------------------------------------------------------- enquiry forms
const BASE_FIELDS = ['student_name', 'guardian_name', 'mobile'];
const formRows = async (db: Db) => db.q('select f.*, s.name as source_name from crm.forms f left join crm.sources s on s.org_id = f.org_id and s.id = f.source_id where f.org_id = $1 order by f.created_at', [db.requireOrg()]);
export const crmFormServer: ServerBlock = {
  key: 'crm.enquiry_form',
  async read(x, key) {
    const f = bySlug((await formRows(await crm(x))).filter((r) => r.active), key);
    if (!f) return null;
    return clean({ name: f.name, branch_code: branchCode(x, f.branch_id) ?? undefined, source: f.source_name ?? undefined, fields: ((f.fields ?? []) as string[]).filter((k) => !BASE_FIELDS.includes(k)), thank_you: f.thank_you ?? undefined });
  },
  async list(x) {
    return (await formRows(await crm(x))).filter((r) => r.active).map((f) => ({ key: slugKey(f.name), name: f.name }));
  },
  async check(x, s, _op, plan) {
    if (!s.source) return [];
    const known = [...(await sourceRows(await crm(x))), ...plan.filter((o) => o.block === 'crm.lead_source').map((o) => ({ name: o.settings.name }))];
    return bySlug(known as Row[], slugKey(String(s.source))) ? [] : [`unknown_source: ${s.source}`];
  },
  async write(x, key, s) {
    const db = await crm(x);
    let sourceId: string | null = null;
    if (s.source) {
      const src = bySlug(await sourceRows(db), slugKey(String(s.source)));
      if (!src) throw new ValidationError('unknown_source', { source: s.source });
      sourceId = src.id;
    }
    const data = { name: s.name, branch_id: branchId(x, s.branch_code as string | null), source_id: sourceId, fields: [...BASE_FIELDS, ...((s.fields as string[]) ?? [])], thank_you: s.thank_you ?? 'Thank you. Our admissions team will call you shortly.', active: true };
    const cur = bySlug(await formRows(db), key);
    if (cur) await mustUpdate(db, 'crm.forms', cur.id, data);
    else {
      const org = await db.one('select slug, name from core.organizations where id = $1', [db.requireOrg()]);
      const slug = `${slugKey(String(org?.slug ?? org?.name ?? 'school')).replace(/_/g, '-')}-${key.replace(/_/g, '-')}-${crypto.randomBytes(2).toString('hex')}`;
      await db.insert('crm.forms', { slug, ...data });
    }
    await log(db, x, 'form', `Saved form "${s.name}"`);
  },
  async remove(x, key) {
    const db = await crm(x);
    const cur = bySlug((await formRows(db)).filter((r) => r.active), key);
    if (cur) await mustUpdate(db, 'crm.forms', cur.id, { active: false });
  },
};

// ---------------------------------------------------------------- roles and the permission matrix
const roleRow = async (db: Db, key: string) => db.one('select * from crm.roles where org_id = $1 and key = $2', [db.requireOrg(), key]);
export const crmRoleServer: ServerBlock = {
  key: 'crm.role',
  async read(x, key) {
    const r = await roleRow(await crm(x), key);
    return r && key !== 'system' ? { key: r.key, name: r.name } : null;
  },
  async list(x) {
    const db = await crm(x);
    return (await db.q("select key, name, is_system from crm.roles where org_id = $1 and key <> 'system' order by name", [db.requireOrg()])).map((r) => ({ key: r.key, name: r.name, system: !!r.is_system }));
  },
  async write(x, key, s) {
    const db = await crm(x);
    const cur = await roleRow(db, key);
    if (cur) {
      await mustRun(db, 'update crm.roles set name = $3 where org_id = $1 and key = $2', [db.requireOrg(), key, s.name]);
      return;
    }
    const from = await roleRow(db, String(s.copy_from_role_key));
    if (!from) throw new ValidationError('unknown_role', { role: s.copy_from_role_key });
    await db.q('insert into core.roles (org_id, product_key, key, name) values ($1, $2, $3, $4) on conflict (org_id, product_key, key) do nothing', [db.requireOrg(), 'crm', key, s.name]);
    // never above the copied role, and never the full admin level (as the roles screen's clone for a non-group admin)
    const perms = { ...(from.permissions as Row) };
    if (perms.admin === 'F') perms.admin = '-';
    await db.insert('crm.roles', { key, name: s.name, permissions: perms });
    await log(db, x, 'role', `Created role "${s.name}" from "${from.name}"`);
  },
  async remove(x, key) {
    const db = await crm(x);
    const cur = await roleRow(db, key);
    if (!cur) return;
    if (cur.is_system) throw new ValidationError('system_role', { role: key });
    const held = await db.one("select count(*)::int as n from core.user_product_access where org_id = $1 and product_key = 'crm' and role_key = $2 and revoked_at is null", [db.requireOrg(), key]);
    if (held!.n > 0) throw new ValidationError('role_in_use', { role: key, people: held!.n });
    await db.q('delete from crm.roles where org_id = $1 and key = $2', [db.requireOrg(), key]);
    await db.q("delete from core.roles where org_id = $1 and product_key = 'crm' and key = $2", [db.requireOrg(), key]);
  },
  async capture(x, key) {
    const r = await roleRow(await crm(x), key);
    return r ? { key: r.key, name: r.name, permissions: r.permissions } : null;
  },
  async restore(x, key, state) {
    const db = await crm(x);
    if (!state) return this.remove(x, key);
    if (await roleRow(db, key)) await mustRun(db, 'update crm.roles set name = $3, permissions = $4 where org_id = $1 and key = $2', [db.requireOrg(), key, state.name, JSON.stringify(state.permissions)]);
    else {
      await db.q('insert into core.roles (org_id, product_key, key, name) values ($1, $2, $3, $4) on conflict (org_id, product_key, key) do nothing', [db.requireOrg(), 'crm', key, state.name]);
      await db.insert('crm.roles', { key, name: state.name, permissions: state.permissions });
    }
  },
};

const splitCell = (key: string) => {
  const i = key.lastIndexOf('__');
  return { role: key.slice(0, i), cap: key.slice(i + 2) };
};
export const crmRolePermissionServer: ServerBlock = {
  key: 'crm.role_permission',
  async read(x, key) {
    const { role, cap } = splitCell(key);
    const r = await roleRow(await crm(x), role);
    return r ? { role_key: role, capability: cap, level: (r.permissions as Row)?.[cap] ?? '-' } : null;
  },
  async list(x) {
    const db = await crm(x);
    const roles = await db.q("select key, name, permissions from crm.roles where org_id = $1 and key not in ('system', 'group_admin') order by name", [db.requireOrg()]);
    return roles.flatMap((r) => Object.entries((r.permissions ?? {}) as Row).map(([cap, level]) => ({ key: `${r.key}__${cap}`, name: `${r.name}: ${cap} = ${level}` })));
  },
  async write(x, key, s) {
    const db = await crm(x);
    const { role, cap } = splitCell(key);
    const r = await roleRow(db, role);
    if (!r) throw new ValidationError('unknown_role', { role });
    if (role === 'group_admin' || role === 'system' || cap === 'admin') throw new ValidationError('permission_is_manual', { role, cap });
    const perms = { ...(r.permissions as Row), [cap]: s.level };
    await mustRun(db, 'update crm.roles set permissions = $3 where org_id = $1 and key = $2', [db.requireOrg(), role, JSON.stringify(perms)]);
    await audit(db, { id: x.actor.userId, name: 'AI designer' }, 'permission', 'role', r.id, `AI designer: changed ${cap} of role "${r.name}" to ${s.level}`, r.permissions, perms);
  },
  async remove(x, key) {
    await this.write(x, key, { level: '-' });
  },
};

export const CRM_SERVER_BLOCKS: ServerBlock[] = [
  crmStageServer,
  crmSourceServer,
  crmAssignmentRuleServer,
  crmSlaServer,
  crmWorkflowServer,
  crmTemplateServer,
  crmFormServer,
  crmMessagingLimitsServer,
  crmScoringServer,
  crmRoleServer,
  crmRolePermissionServer,
];
