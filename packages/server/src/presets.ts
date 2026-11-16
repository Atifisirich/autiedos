/**
 * Applies AutoEd presets to an organisation / branch (setup wizard, seed, "Reset to preset").
 * Reset restores preset rows by key (undeleting them) and soft-deletes school-added rows of that area.
 */
import {
  PRESET_ROLES,
  PRESET_POSITIONS,
  PRESET_TASK_CATEGORIES,
  PRESET_LEAVE_TYPES,
  PRESET_CHECKLISTS,
  PRESET_TICKET_CATEGORIES,
  PRESET_RUBRIC,
  PRESET_EVENT_TEMPLATES,
  PRESET_DUTY_TYPES,
  PRESET_COMPLIANCE,
  PRESET_EXAM_TYPES,
  PRESET_APPROVAL_TYPES,
  NOTIFICATION_EVENTS,
  PRESET_DEPARTMENTS,
  DEFAULT_TEMPLATE_SECTIONS,
  MODULE_KEYS,
  addDays,
  type PresetKey,
} from '@autoed/shared';
import { insert, maybe, q, type Tx } from './db';

export const CONFIG_AREAS = [
  'roles',
  'task_categories',
  'escalation',
  'leave_types',
  'checklists',
  'ticket_categories',
  'rubric',
  'event_templates',
  'duty_types',
  'compliance',
  'exam_types',
  'approval_types',
  'notification_rules',
  'lesson_template',
  'plan_rules',
  'attendance_rules',
  'module_flags',
  'departments',
] as const;
export type ConfigArea = (typeof CONFIG_AREAS)[number];

const boardOf = (k: PresetKey): 'cbse' | 'cambridge' => (k === 'cambridge' ? 'cambridge' : 'cbse');

async function roleIds(c: Tx, orgId: string): Promise<Record<string, string>> {
  const rows = await q<{ key: string; id: string }>(c, 'select key, id from public.roles where org_id = $1 and deleted_at is null', [orgId]);
  return Object.fromEntries(rows.map((r) => [r.key, r.id]));
}

export async function applyRoles(c: Tx, orgId: string, opts: { reset?: boolean } = {}): Promise<Record<string, string>> {
  for (const r of PRESET_ROLES) {
    const role = await insert<{ id: string }>(
      c,
      'roles',
      { org_id: orgId, key: r.key, name: r.name, is_preset: true, description: `${r.name_i18n.hi} / ${r.name_i18n.te}` },
      { onConflict: '(org_id, key) do update set name = excluded.name, is_preset = true, deleted_at = null' },
    );
    if (opts.reset) await c.query('delete from public.role_permissions where role_id = $1', [role.id]);
    for (const p of r.permissions) {
      await c.query(
        `insert into public.role_permissions (org_id, role_id, module, action, scope) values ($1,$2,$3,$4,$5)
         on conflict (role_id, module, action) do ${opts.reset ? 'update set scope = excluded.scope, deleted_at = null' : 'nothing'}`,
        [orgId, role.id, p.module, p.action, p.scope],
      );
    }
  }
  const ids = await roleIds(c, orgId);
  for (const p of PRESET_POSITIONS) {
    await c.query(
      `insert into public.positions (org_id, key, name, rank, default_role_id) values ($1,$2,$3,$4,$5)
       on conflict (org_id, key) do update set name = excluded.name, rank = excluded.rank, default_role_id = excluded.default_role_id, deleted_at = null`,
      [orgId, p.key, p.name, p.rank, ids[p.role]],
    );
  }
  if (opts.reset) {
    await c.query(`update public.roles set deleted_at = now() where org_id = $1 and not is_preset and deleted_at is null`, [orgId]);
  }
  return ids;
}

export async function applyDepartments(c: Tx, orgId: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const name of PRESET_DEPARTMENTS) {
    const existing = await maybe<{ id: string }>(c, 'select id from public.departments where org_id = $1 and name = $2 and branch_id is null', [orgId, name]);
    out[name] = existing?.id ?? (await insert<{ id: string }>(c, 'departments', { org_id: orgId, name })).id;
  }
  return out;
}

/** Applies one area. Org-level areas ignore branchId. */
export async function applyArea(c: Tx, area: ConfigArea, orgId: string, branchId: string | null, preset: PresetKey, opts: { reset?: boolean } = {}): Promise<void> {
  const reset = !!opts.reset;
  const roles = await roleIds(c, orgId);
  const softDeleteOthers = async (table: string, keys: string[], scope: 'org' | 'branch' = 'org') => {
    if (!reset) return;
    const where = scope === 'branch' ? 'org_id = $1 and branch_id = $3' : 'org_id = $1';
    const params: unknown[] = [orgId, keys];
    if (scope === 'branch') params.push(branchId);
    await c.query(`update public.${table} set deleted_at = now() where ${where} and deleted_at is null and not (key = any($2))`, params);
  };

  switch (area) {
    case 'roles':
      await applyRoles(c, orgId, { reset });
      return;
    case 'departments':
      await applyDepartments(c, orgId);
      return;
    case 'escalation': {
      const ex = await maybe<{ id: string }>(c, `select id from public.escalation_rules where org_id = $1 and name = 'Default' and branch_id is null`, [orgId]);
      if (ex) {
        if (reset) await c.query(`update public.escalation_rules set remind_before_minutes = 120, notify_owner_at_due = true, notify_assigner_after_working_minutes = 240, notify_manager_after_working_days = 1, urgent_factor = 0.5, deleted_at = null where id = $1`, [ex.id]);
      } else await insert(c, 'escalation_rules', { org_id: orgId, name: 'Default' });
      return;
    }
    case 'task_categories': {
      const esc = await maybe<{ id: string }>(c, `select id from public.escalation_rules where org_id = $1 and name = 'Default' and deleted_at is null`, [orgId]);
      for (const t of PRESET_TASK_CATEGORIES) {
        await c.query(
          `insert into public.task_categories (org_id, key, name, name_i18n, color, default_proof, default_verification, escalation_rule_id)
           values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (org_id, key) do ${reset ? 'update set name = excluded.name, name_i18n = excluded.name_i18n, color = excluded.color, default_proof = excluded.default_proof, default_verification = excluded.default_verification, deleted_at = null' : 'nothing'}`,
          [orgId, t.key, t.name, JSON.stringify(t.name_i18n), t.color, t.proof, t.verify, esc?.id ?? null],
        );
      }
      await softDeleteOthers('task_categories', PRESET_TASK_CATEGORIES.map((t) => t.key));
      return;
    }
    case 'leave_types': {
      for (const l of PRESET_LEAVE_TYPES) {
        await c.query(
          `insert into public.leave_types (org_id, key, name, name_i18n, unit, yearly_quota, accrual, carry_forward, carry_forward_max, half_day_allowed, notice_days, doc_required_after_days, sandwich_rule, paid)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
           on conflict (org_id, key) do ${reset ? 'update set name = excluded.name, name_i18n = excluded.name_i18n, unit = excluded.unit, yearly_quota = excluded.yearly_quota, accrual = excluded.accrual, carry_forward = excluded.carry_forward, carry_forward_max = excluded.carry_forward_max, half_day_allowed = excluded.half_day_allowed, notice_days = excluded.notice_days, doc_required_after_days = excluded.doc_required_after_days, sandwich_rule = excluded.sandwich_rule, paid = excluded.paid, deleted_at = null' : 'nothing'}`,
          [orgId, l.key, l.name, JSON.stringify(l.name_i18n), l.unit, l.yearly_quota, l.accrual, l.carry_forward, l.carry_forward_max, l.half_day_allowed, l.notice_days, l.doc_required_after_days, l.sandwich_rule, l.paid],
        );
      }
      await softDeleteOthers('leave_types', PRESET_LEAVE_TYPES.map((l) => l.key));
      return;
    }
    case 'ticket_categories': {
      for (const t of PRESET_TICKET_CATEGORIES) {
        await c.query(
          `insert into public.ticket_categories (org_id, key, name, name_i18n, owner_role_id) values ($1,$2,$3,$4,$5)
           on conflict (org_id, key) do ${reset ? 'update set name = excluded.name, name_i18n = excluded.name_i18n, owner_role_id = excluded.owner_role_id, deleted_at = null' : 'nothing'}`,
          [orgId, t.key, t.name, JSON.stringify(t.name_i18n), roles[t.ownerRole] ?? null],
        );
      }
      await softDeleteOthers('ticket_categories', PRESET_TICKET_CATEGORIES.map((t) => t.key));
      return;
    }
    case 'checklists': {
      if (!branchId) throw new Error('checklists preset needs a branch');
      if (reset) await c.query(`update public.checklist_templates set deleted_at = now() where org_id = $1 and branch_id = $2 and deleted_at is null`, [orgId, branchId]);
      for (const t of PRESET_CHECKLISTS) {
        const existing = await maybe<{ id: string }>(c, `select id from public.checklist_templates where branch_id = $1 and key = $2 and deleted_at is null`, [branchId, t.key]);
        if (existing) continue;
        const tpl = await insert<{ id: string }>(c, 'checklist_templates', {
          org_id: orgId,
          branch_id: branchId,
          key: t.key,
          name: t.name,
          name_i18n: t.name_i18n,
          schedule: { frequency: t.frequency, time: t.time, weekdays: [], month_day: 1 },
          owner_role_id: roles[t.ownerRole] ?? null,
        });
        let seq = 1;
        for (const it of t.items) {
          await insert(c, 'checklist_items', {
            org_id: orgId,
            branch_id: branchId,
            template_id: tpl.id,
            seq: seq++,
            label: it.label,
            label_i18n: it.label_i18n,
            item_type: it.type,
            min_value: it.min ?? null,
            max_value: it.max ?? null,
            required: it.type !== 'photo',
            on_fail: it.onFail ?? null,
          });
        }
      }
      return;
    }
    case 'rubric': {
      const ex = await maybe<{ id: string }>(c, `select id from public.observation_rubrics where org_id = $1 and is_preset and deleted_at is null`, [orgId]);
      if (ex && reset) await c.query(`update public.observation_rubrics set name = $2, domains = $3, scale = $4 where id = $1`, [ex.id, PRESET_RUBRIC.name, JSON.stringify(PRESET_RUBRIC.domains), JSON.stringify(PRESET_RUBRIC.scale)]);
      if (!ex) await insert(c, 'observation_rubrics', { org_id: orgId, name: PRESET_RUBRIC.name, domains: PRESET_RUBRIC.domains, scale: PRESET_RUBRIC.scale, is_preset: true });
      return;
    }
    case 'event_templates': {
      for (const e of PRESET_EVENT_TEMPLATES) {
        await c.query(
          `insert into public.event_templates (org_id, key, name, name_i18n, task_pack, committees, budget_lines) values ($1,$2,$3,$4,$5,$6,$7)
           on conflict (org_id, key) do ${reset ? 'update set name = excluded.name, name_i18n = excluded.name_i18n, task_pack = excluded.task_pack, committees = excluded.committees, budget_lines = excluded.budget_lines, deleted_at = null' : 'nothing'}`,
          [orgId, e.key, e.name, JSON.stringify(e.name_i18n), JSON.stringify(e.tasks), JSON.stringify(e.committees), JSON.stringify(e.budget)],
        );
      }
      await softDeleteOthers('event_templates', PRESET_EVENT_TEMPLATES.map((e) => e.key));
      return;
    }
    case 'duty_types': {
      for (const d of PRESET_DUTY_TYPES) {
        await c.query(
          `insert into public.duty_types (org_id, key, name, name_i18n, starts_at, ends_at, staff_needed, overlaps_period_seq) values ($1,$2,$3,$4,$5,$6,$7,$8)
           on conflict (org_id, key) do ${reset ? 'update set name = excluded.name, name_i18n = excluded.name_i18n, starts_at = excluded.starts_at, ends_at = excluded.ends_at, staff_needed = excluded.staff_needed, deleted_at = null' : 'nothing'}`,
          [orgId, d.key, d.name, JSON.stringify(d.name_i18n), d.starts_at, d.ends_at, d.staff, d.overlapsPeriod ?? null],
        );
      }
      await softDeleteOthers('duty_types', PRESET_DUTY_TYPES.map((d) => d.key));
      return;
    }
    case 'compliance': {
      if (!branchId) throw new Error('compliance preset needs a branch');
      const today = new Date().toISOString().slice(0, 10);
      for (const it of PRESET_COMPLIANCE[boardOf(preset)]) {
        const key = it.name.toLowerCase().replace(/[^a-z0-9]+/g, '_');
        const ex = await maybe(c, `select id from public.compliance_items where branch_id = $1 and preset_key = $2 and deleted_at is null`, [branchId, key]);
        if (ex) continue;
        await insert(c, 'compliance_items', { org_id: orgId, branch_id: branchId, name: it.name, category: it.category, preset_key: key, status: 'missing', verify_note: 'verify_against_board_rules', notes: `Typical renewal: every ${it.months} months`, expires_on: null, issued_on: null });
        void today;
      }
      return;
    }
    case 'exam_types': {
      const list = preset === 'dual' ? [...PRESET_EXAM_TYPES.cbse, ...PRESET_EXAM_TYPES.cambridge.filter((x) => !PRESET_EXAM_TYPES.cbse.some((y) => y.key === x.key))] : PRESET_EXAM_TYPES[boardOf(preset)];
      for (const e of list) {
        await c.query(
          `insert into public.exam_types (org_id, key, name, name_i18n) values ($1,$2,$3,$4) on conflict (org_id, key) do ${reset ? 'update set name = excluded.name, name_i18n = excluded.name_i18n, deleted_at = null' : 'nothing'}`,
          [orgId, e.key, e.name, JSON.stringify(e.name_i18n)],
        );
      }
      await softDeleteOthers('exam_types', list.map((e) => e.key));
      return;
    }
    case 'approval_types': {
      for (const a of PRESET_APPROVAL_TYPES) {
        const type = await insert<{ id: string }>(
          c,
          'approval_types',
          { org_id: orgId, key: a.key, name: a.name, name_i18n: a.name_i18n, form_schema: a.form, task_template: a.taskTemplate ?? null, is_system: a.system },
          { onConflict: `(org_id, key) do update set name = excluded.name${reset ? ', form_schema = excluded.form_schema, task_template = excluded.task_template' : ''}, deleted_at = null` },
        );
        const hasFlow = await maybe(c, `select id from public.approval_flows where approval_type_id = $1 and deleted_at is null`, [type.id]);
        if (hasFlow && !reset) continue;
        if (hasFlow) await c.query(`update public.approval_flows set deleted_at = now() where approval_type_id = $1`, [type.id]);
        const flow = await insert<{ id: string }>(c, 'approval_flows', { org_id: orgId, approval_type_id: type.id, name: `${a.name} – default` });
        for (const s of a.steps) {
          await insert(c, 'approval_steps', {
            org_id: orgId,
            flow_id: flow.id,
            seq: s.seq,
            approver_kind: s.kind,
            approver_role_id: s.role ? roles[s.role] ?? null : null,
            condition: s.condition ?? null,
            time_limit_hours: 48,
          });
        }
      }
      if (reset) await c.query(`update public.approval_types set deleted_at = now() where org_id = $1 and not (key = any($2)) and deleted_at is null`, [orgId, PRESET_APPROVAL_TYPES.map((a) => a.key)]);
      return;
    }
    case 'notification_rules': {
      for (const n of NOTIFICATION_EVENTS) {
        await c.query(
          `insert into public.notification_rules (org_id, event_key, channels, recipients, optional, urgent, whatsapp_template) values ($1,$2,$3,$4,$5,$6,$7)
           on conflict (org_id, event_key) do ${reset ? 'update set channels = excluded.channels, recipients = excluded.recipients, optional = excluded.optional, urgent = excluded.urgent, whatsapp_template = excluded.whatsapp_template, enabled = true, deleted_at = null' : 'nothing'}`,
          [orgId, n.key, n.channels, ['target'], n.optional, n.urgent, n.whatsappTemplate ?? null],
        );
      }
      return;
    }
    case 'lesson_template': {
      const ex = await maybe<{ id: string }>(c, `select id from public.lesson_plan_templates where org_id = $1 and is_default and deleted_at is null`, [orgId]);
      if (ex && reset) await c.query(`update public.lesson_plan_templates set sections = $2, default_teaching_model = '5E' where id = $1`, [ex.id, JSON.stringify(DEFAULT_TEMPLATE_SECTIONS)]);
      if (!ex) await insert(c, 'lesson_plan_templates', { org_id: orgId, name: 'School lesson plan', sections: DEFAULT_TEMPLATE_SECTIONS, header: { show_logo: true }, default_teaching_model: '5E', is_default: true });
      return;
    }
    case 'plan_rules': {
      const ex = await maybe(c, `select id from public.plan_submission_rules where org_id = $1 and deleted_at is null`, [orgId]);
      if (ex && !reset) return;
      if (ex) await c.query(`update public.plan_submission_rules set deleted_at = now() where org_id = $1`, [orgId]);
      await insert(c, 'plan_submission_rules', { org_id: orgId, level: 'weekly', name: 'Weekly plans due Friday 4 pm', due_weekday: 5, due_time: '16:00', days_before: 0, review_steps: ['hod', 'academic_coordinator'] });
      await insert(c, 'plan_submission_rules', { org_id: orgId, level: 'daily', name: 'Daily plans due the day before, 4 pm', due_time: '16:00', days_before: 1, review_steps: ['hod'] });
      return;
    }
    case 'attendance_rules': {
      if (!branchId) throw new Error('attendance preset needs a branch');
      await c.query(
        `insert into public.attendance_rules (org_id, branch_id) values ($1,$2) on conflict (branch_id, position_id) do nothing`,
        [orgId, branchId],
      );
      if (reset) await c.query(`update public.attendance_rules set shift_start = '08:00', shift_end = '15:30', grace_minutes = 10, half_day_after_minutes = 120, early_exit_minutes = 30, checkin_cutoff = '08:30', student_cutoff = '09:30', student_edit_window_minutes = 120, student_threshold_pct = 75 where branch_id = $1`, [branchId]);
      return;
    }
    case 'module_flags': {
      if (!branchId) throw new Error('module flags need a branch');
      for (const m of MODULE_KEYS) {
        await c.query(`insert into public.module_flags (org_id, branch_id, module_key, enabled) values ($1,$2,$3,true) on conflict (branch_id, module_key) do ${reset ? 'update set enabled = true' : 'nothing'}`, [orgId, branchId, m]);
      }
      return;
    }
  }
}

/** Everything a new branch needs on day one. */
export async function applyPreset(c: Tx, orgId: string, branchId: string, preset: PresetKey): Promise<void> {
  for (const area of CONFIG_AREAS) await applyArea(c, area, orgId, branchId, preset);
}

/** Copies global curriculum boards to nothing — global rows are read directly; kept for symmetry. */
export function termDates(yearStart: string): { t1: [string, string]; t2: [string, string] } {
  const t1End = addDays(yearStart, 182);
  return { t1: [yearStart, t1End], t2: [addDays(t1End, 1), addDays(yearStart, 364)] };
}
