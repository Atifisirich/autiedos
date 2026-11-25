/**
 * Task blocks: os.task_category (os.task_categories), os.recurring_task (os.task_recurrences, target = a role in the
 * active branch, identified by template.designer_key), os.escalation_rule (os.escalation_rules, by name, org level)
 * and os.assignment_rule (os.assignment_rules, as setup.setAssignmentRule writes them).
 */
import { insert, maybe, q } from '../../../db';
import { localToday, now } from '../../../core';
import { clean, hm, num, osRoleId, osRoleKey, type ApplyCtx, type ServerBlock } from '../types';

// ---------------------------------------------------------------- task categories
const category = (x: ApplyCtx, key: string) =>
  maybe<{ id: string; key: string; name: string; color: string; default_proof: string; default_verification: boolean; escalation_rule_id: string | null }>(
    x.c,
    `select id, key, name, color, default_proof, default_verification, escalation_rule_id from os.task_categories where org_id = $1 and key = $2 and deleted_at is null`,
    [x.actor.orgId, key],
  );

export const taskCategoryServer: ServerBlock = {
  key: 'os.task_category',
  async read(x, key) {
    const r = await category(x, key);
    if (!r) return null;
    const rule = r.escalation_rule_id ? await maybe<{ name: string }>(x.c, `select name from os.escalation_rules where id = $1 and deleted_at is null`, [r.escalation_rule_id]) : null;
    return clean({ key: r.key, name: r.name, color: r.color, default_proof: r.default_proof, default_verification: r.default_verification, escalation_rule: rule?.name ?? null });
  },
  list: (x) => q(x.c, `select key, name from os.task_categories where org_id = $1 and deleted_at is null order by name`, [x.actor.orgId]),
  async write(x, key, s) {
    const rule = s.escalation_rule ? await maybe<{ id: string }>(x.c, `select id from os.escalation_rules where org_id = $1 and name = $2 and deleted_at is null order by branch_id nulls first limit 1`, [x.actor.orgId, s.escalation_rule]) : null;
    await x.c.query(
      `insert into os.task_categories (org_id, key, name, color, default_proof, default_verification, escalation_rule_id) values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (org_id, key) do update set name = excluded.name, color = excluded.color, default_proof = excluded.default_proof, default_verification = excluded.default_verification, escalation_rule_id = excluded.escalation_rule_id, deleted_at = null`,
      [x.actor.orgId, key, s.name, s.color, s.default_proof, s.default_verification, rule?.id ?? null],
    );
  },
  async remove(x, key) {
    await x.c.query(`update os.task_categories set deleted_at = now() where org_id = $1 and key = $2 and deleted_at is null`, [x.actor.orgId, key]);
  },
};

// ---------------------------------------------------------------- recurring tasks
const recurrence = (x: ApplyCtx, key: string) =>
  maybe<{ id: string; template: Record<string, unknown>; target: { role_id?: string }; frequency: string; weekdays: number[]; month_day: number | null; due_time: string; starts_on: string; active: boolean }>(
    x.c,
    `select id, template, target, frequency, weekdays, month_day, due_time::text, starts_on::text, active from os.task_recurrences
      where org_id = $1 and branch_id = $2 and template->>'designer_key' = $3 and deleted_at is null order by created_at desc limit 1`,
    [x.actor.orgId, x.actor.branchId, key],
  );

export const recurringTaskServer: ServerBlock = {
  key: 'os.recurring_task',
  async read(x, key) {
    const r = await recurrence(x, key);
    if (!r || !r.active) return null;
    return clean({
      key,
      title: String(r.template.title ?? ''),
      description: (r.template.description as string | null) ?? null,
      role_key: (await osRoleKey(x.c, r.target.role_id ?? null)) ?? '',
      frequency: r.frequency,
      weekdays: r.weekdays ?? [],
      month_day: r.month_day,
      due_time: hm(r.due_time) ?? '17:00',
      priority: String(r.template.priority ?? 'normal'),
      starts_on: r.starts_on,
    });
  },
  list: (x) => q(x.c, `select template->>'designer_key' as key, template->>'title' as name from os.task_recurrences where org_id = $1 and branch_id = $2 and template ? 'designer_key' and active and deleted_at is null order by 2`, [x.actor.orgId, x.actor.branchId]),
  async write(x, key, s) {
    const roleId = await osRoleId(x, String(s.role_key));
    const template = { designer_key: key, title: s.title, description: s.description ?? null, priority: s.priority ?? 'normal', category_id: null, proof_required: null, verification_required: null };
    const startsOn = (s.starts_on as string | null | undefined) ?? localToday({ now: now() });
    const ex = await recurrence(x, key);
    const vals = [JSON.stringify(template), JSON.stringify({ role_id: roleId }), s.frequency, s.weekdays ?? [], s.month_day ?? null, s.due_time, startsOn];
    if (ex) {
      await x.c.query(`update os.task_recurrences set template = $2, target = $3, frequency = $4, weekdays = $5, month_day = $6, due_time = $7, starts_on = $8, active = true where id = $1`, [ex.id, ...vals]);
    } else {
      await insert(x.c, 'os.task_recurrences', { org_id: x.actor.orgId, branch_id: x.actor.branchId, template, target: { role_id: roleId }, frequency: s.frequency, weekdays: s.weekdays ?? [], month_day: s.month_day ?? null, due_time: s.due_time, starts_on: startsOn, assigner_id: x.actor.staffId });
    }
  },
  async remove(x, key) {
    const r = await recurrence(x, key);
    if (r) await x.c.query(`update os.task_recurrences set active = false, deleted_at = now() where id = $1`, [r.id]);
  },
};

// ---------------------------------------------------------------- escalation rules (org level, by name)
const escalation = (x: ApplyCtx, name: string) =>
  maybe<{ id: string; name: string; remind_before_minutes: number; notify_owner_at_due: boolean; notify_assigner_after_working_minutes: number; notify_manager_after_working_days: number; urgent_factor: number }>(
    x.c,
    `select * from os.escalation_rules where org_id = $1 and name = $2 and branch_id is null and deleted_at is null order by created_at limit 1`,
    [x.actor.orgId, name],
  );

export const escalationRuleServer: ServerBlock = {
  key: 'os.escalation_rule',
  async read(x, key) {
    const r = await escalation(x, key);
    if (!r) return null;
    return { name: r.name, remind_before_minutes: r.remind_before_minutes, notify_owner_at_due: r.notify_owner_at_due, notify_assigner_after_working_minutes: r.notify_assigner_after_working_minutes, notify_manager_after_working_days: r.notify_manager_after_working_days, urgent_factor: num(r.urgent_factor) };
  },
  list: (x) => q(x.c, `select name as key, name from os.escalation_rules where org_id = $1 and deleted_at is null order by name`, [x.actor.orgId]),
  async write(x, key, s) {
    const ex = await escalation(x, key);
    const vals = [s.remind_before_minutes, s.notify_owner_at_due, s.notify_assigner_after_working_minutes, s.notify_manager_after_working_days, s.urgent_factor];
    if (ex) await x.c.query(`update os.escalation_rules set remind_before_minutes = $2, notify_owner_at_due = $3, notify_assigner_after_working_minutes = $4, notify_manager_after_working_days = $5, urgent_factor = $6 where id = $1`, [ex.id, ...vals]);
    else await x.c.query(`insert into os.escalation_rules (org_id, name, remind_before_minutes, notify_owner_at_due, notify_assigner_after_working_minutes, notify_manager_after_working_days, urgent_factor) values ($1, $2, $3, $4, $5, $6, $7)`, [x.actor.orgId, key, ...vals]);
  },
  async remove(x, key) {
    await x.c.query(`update os.escalation_rules set deleted_at = now() where org_id = $1 and name = $2 and branch_id is null and deleted_at is null`, [x.actor.orgId, key]);
  },
};

// ---------------------------------------------------------------- assignment rules
async function pair(x: ApplyCtx, key: string): Promise<{ from: string; to: string } | null> {
  const [from, to] = key.split('__');
  return from && to ? { from, to } : null;
}

export const assignmentRuleServer: ServerBlock = {
  key: 'os.assignment_rule',
  async read(x, key) {
    const p = await pair(x, key);
    if (!p) return null;
    const r = await maybe<{ rule: string }>(
      x.c,
      `select ar.rule from os.assignment_rules ar join os.roles f on f.id = ar.from_role_id join os.roles t on t.id = ar.to_role_id
        where ar.org_id = $1 and f.key = $2 and t.key = $3 and ar.deleted_at is null`,
      [x.actor.orgId, p.from, p.to],
    );
    return r ? { from_role_key: p.from, to_role_key: p.to, rule: r.rule } : null;
  },
  list: (x) =>
    q(x.c, `select f.key || '__' || t.key as key, f.name || ' -> ' || t.name as name from os.assignment_rules ar join os.roles f on f.id = ar.from_role_id join os.roles t on t.id = ar.to_role_id where ar.org_id = $1 and ar.deleted_at is null`, [x.actor.orgId]),
  async write(x, _key, s) {
    const from = await osRoleId(x, String(s.from_role_key));
    const to = await osRoleId(x, String(s.to_role_key));
    await x.c.query(`insert into os.assignment_rules (org_id, from_role_id, to_role_id, rule) values ($1, $2, $3, $4) on conflict (org_id, from_role_id, to_role_id) do update set rule = excluded.rule, deleted_at = null`, [x.actor.orgId, from, to, s.rule]);
  },
  async remove(x, key) {
    const p = await pair(x, key);
    if (!p) return;
    await x.c.query(`delete from os.assignment_rules where org_id = $1 and from_role_id = (select id from os.roles where org_id = $1 and key = $2) and to_role_id = (select id from os.roles where org_id = $1 and key = $3)`, [x.actor.orgId, p.from, p.to]);
  },
};
