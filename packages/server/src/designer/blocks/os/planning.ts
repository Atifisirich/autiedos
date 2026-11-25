/**
 * Calendar and planning blocks (org level, as the presets and the generic settings screens write them):
 *   os.event_template      os.event_templates (by key; task_pack in the preset format)
 *   os.duty_type           os.duty_types (by key)
 *   os.plan_review_chain   os.plan_submission_rules (by name)
 */
import { maybe, q } from '../../../db';
import { clean, hm, osRoleId, type ServerBlock } from '../types';

export const eventTemplateServer: ServerBlock = {
  key: 'os.event_template',
  async read(x, key) {
    const r = await maybe<{ key: string; name: string; task_pack: unknown[]; committees: string[]; checklist: string[]; budget_lines: unknown[] }>(
      x.c,
      `select key, name, task_pack, committees, checklist, budget_lines from os.event_templates where org_id = $1 and key = $2 and deleted_at is null`,
      [x.actor.orgId, key],
    );
    return r ? { key: r.key, name: r.name, tasks: r.task_pack ?? [], committees: r.committees ?? [], checklist: r.checklist ?? [], budget_lines: r.budget_lines ?? [] } : null;
  },
  list: (x) => q(x.c, `select key, name from os.event_templates where org_id = $1 and deleted_at is null order by name`, [x.actor.orgId]),
  async write(x, key, s) {
    for (const t of (s.tasks as { role_key: string }[]) ?? []) await osRoleId(x, t.role_key);
    await x.c.query(
      `insert into os.event_templates (org_id, key, name, task_pack, committees, checklist, budget_lines) values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (org_id, key) do update set name = excluded.name, task_pack = excluded.task_pack, committees = excluded.committees, checklist = excluded.checklist, budget_lines = excluded.budget_lines, deleted_at = null`,
      [x.actor.orgId, key, s.name, JSON.stringify(s.tasks ?? []), JSON.stringify(s.committees ?? []), JSON.stringify(s.checklist ?? []), JSON.stringify(s.budget_lines ?? [])],
    );
  },
  async remove(x, key) {
    await x.c.query(`update os.event_templates set deleted_at = now() where org_id = $1 and key = $2 and deleted_at is null`, [x.actor.orgId, key]);
  },
};

export const dutyTypeServer: ServerBlock = {
  key: 'os.duty_type',
  async read(x, key) {
    const r = await maybe<{ key: string; name: string; location: string | null; starts_at: string; ends_at: string; staff_needed: number; days: number[] }>(
      x.c,
      `select key, name, location, starts_at::text, ends_at::text, staff_needed, days from os.duty_types where org_id = $1 and key = $2 and deleted_at is null`,
      [x.actor.orgId, key],
    );
    return r ? clean({ key: r.key, name: r.name, location: r.location, starts_at: hm(r.starts_at), ends_at: hm(r.ends_at), staff_needed: r.staff_needed, days: r.days }) : null;
  },
  list: (x) => q(x.c, `select key, name from os.duty_types where org_id = $1 and deleted_at is null order by name`, [x.actor.orgId]),
  async write(x, key, s) {
    await x.c.query(
      `insert into os.duty_types (org_id, key, name, location, starts_at, ends_at, staff_needed, days) values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (org_id, key) do update set name = excluded.name, location = excluded.location, starts_at = excluded.starts_at, ends_at = excluded.ends_at, staff_needed = excluded.staff_needed, days = excluded.days, deleted_at = null`,
      [x.actor.orgId, key, s.name, s.location ?? null, s.starts_at, s.ends_at, s.staff_needed, s.days],
    );
  },
  async remove(x, key) {
    await x.c.query(`update os.duty_types set deleted_at = now() where org_id = $1 and key = $2 and deleted_at is null`, [x.actor.orgId, key]);
  },
};

const planRule = (x: Parameters<ServerBlock['read']>[0], name: string) =>
  maybe<{ id: string; name: string; level: string; due_weekday: number | null; due_time: string; days_before: number; review_steps: string[]; active: boolean }>(
    x.c,
    `select id, name, level, due_weekday, due_time::text, days_before, review_steps, active from os.plan_submission_rules where org_id = $1 and name = $2 and branch_id is null and deleted_at is null order by created_at limit 1`,
    [x.actor.orgId, name],
  );

export const planReviewServer: ServerBlock = {
  key: 'os.plan_review_chain',
  async read(x, key) {
    const r = await planRule(x, key);
    return r ? clean({ name: r.name, level: r.level, due_weekday: r.due_weekday, due_time: hm(r.due_time), days_before: r.days_before, review_steps: r.review_steps ?? [], active: r.active }) : null;
  },
  list: (x) => q(x.c, `select name as key, name from os.plan_submission_rules where org_id = $1 and deleted_at is null order by name`, [x.actor.orgId]),
  async write(x, key, s) {
    for (const r of s.review_steps as string[]) await osRoleId(x, r);
    const ex = await planRule(x, key);
    const vals = [s.level, s.due_weekday ?? null, s.due_time, s.days_before, JSON.stringify(s.review_steps), s.active ?? true];
    if (ex) await x.c.query(`update os.plan_submission_rules set level = $2, due_weekday = $3, due_time = $4, days_before = $5, review_steps = $6, active = $7 where id = $1`, [ex.id, ...vals]);
    else await x.c.query(`insert into os.plan_submission_rules (org_id, name, level, due_weekday, due_time, days_before, review_steps, active) values ($1, $2, $3, $4, $5, $6, $7, $8)`, [x.actor.orgId, key, ...vals]);
  },
  async remove(x, key) {
    const ex = await planRule(x, key);
    if (ex) await x.c.query(`update os.plan_submission_rules set deleted_at = now() where id = $1`, [ex.id]);
  },
};
