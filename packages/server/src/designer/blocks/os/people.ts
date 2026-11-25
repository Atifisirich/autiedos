/**
 * Leave, attendance, modules, roles and fields:
 *   os.leave_type       core.leave_types (org level, by key)
 *   os.attendance_rule  core.attendance_rules (staff, active branch, one per position or all staff)
 *   os.module_flag      os.module_flags (one branch, as Setup -> Modules writes them)
 *   os.role             os.roles (+ copy of another role's permissions on creation)
 *   os.role_permission  os.role_permissions (one matrix cell, as Setup -> Roles writes it)
 *   os.custom_field     core.custom_fields (product 'os', org level)
 */
import { ForbiddenError, ValidationError, maybe, one, q } from '../../../db';
import { clean, num, osRoleId, type ApplyCtx, type ServerBlock } from '../types';

const LEAVE_COLS = ['name', 'unit', 'yearly_quota', 'accrual', 'carry_forward', 'carry_forward_max', 'half_day_allowed', 'notice_days', 'doc_required_after_days', 'sandwich_rule', 'paid'] as const;

export const leaveTypeServer: ServerBlock = {
  key: 'os.leave_type',
  async read(x, key) {
    const r = await maybe<Record<string, unknown>>(x.c, `select key, ${LEAVE_COLS.join(', ')} from core.leave_types where org_id = $1 and key = $2 and applies_to = 'staff' and active and deleted_at is null`, [x.actor.orgId, key]);
    if (!r) return null;
    return clean({ ...r, yearly_quota: num(r.yearly_quota), carry_forward_max: num(r.carry_forward_max) });
  },
  list: (x) => q(x.c, `select key, name from core.leave_types where org_id = $1 and applies_to = 'staff' and active and deleted_at is null order by name`, [x.actor.orgId]),
  async write(x, key, s) {
    const vals = LEAVE_COLS.map((k) => s[k] ?? null);
    await x.c.query(
      `insert into core.leave_types (org_id, key, applies_to, active, ${LEAVE_COLS.join(', ')}) values ($1, $2, 'staff', true, ${LEAVE_COLS.map((_, i) => `$${i + 3}`).join(', ')})
       on conflict (org_id, key) do update set active = true, deleted_at = null, ${LEAVE_COLS.map((k) => `${k} = excluded.${k}`).join(', ')}`,
      [x.actor.orgId, key, ...vals],
    );
  },
  async remove(x, key) {
    await x.c.query(`update core.leave_types set deleted_at = now() where org_id = $1 and key = $2 and deleted_at is null`, [x.actor.orgId, key]);
  },
};

// ---------------------------------------------------------------- staff attendance rules (active branch)
async function positionId(x: ApplyCtx, key: string | null): Promise<string | null> {
  if (!key) return null;
  const p = await maybe<{ id: string }>(x.c, `select id from core.positions where org_id = $1 and key = $2 and deleted_at is null`, [x.actor.orgId, key]);
  if (!p) throw new ValidationError('unknown_position', { position: key });
  return p.id;
}
const attRule = async (x: ApplyCtx, key: string) => {
  const pos = key === 'all_staff' ? null : await positionId(x, key);
  return maybe<{ id: string; grace_minutes: number; half_day_after_minutes: number; edit_window_hours: number | null }>(
    x.c,
    `select id, grace_minutes, half_day_after_minutes, edit_window_hours from core.attendance_rules where org_id = $1 and branch_id = $2 and applies_to = 'staff' and position_id is not distinct from $3 and deleted_at is null order by created_at limit 1`,
    [x.actor.orgId, x.actor.branchId, pos],
  );
};

export const attendanceRuleServer: ServerBlock = {
  key: 'os.attendance_rule',
  async read(x, key) {
    const r = await attRule(x, key);
    return r ? clean({ position_key: key === 'all_staff' ? null : key, grace_minutes: r.grace_minutes, half_day_after_minutes: r.half_day_after_minutes, edit_window_hours: r.edit_window_hours }) : null;
  },
  list: (x) =>
    q(x.c, `select coalesce(p.key, 'all_staff') as key, coalesce(p.name, 'All staff') as name from core.attendance_rules a left join core.positions p on p.id = a.position_id where a.org_id = $1 and a.branch_id = $2 and a.applies_to = 'staff' and a.deleted_at is null`, [x.actor.orgId, x.actor.branchId]),
  async write(x, key, s) {
    const ex = await attRule(x, key);
    if (ex) await x.c.query(`update core.attendance_rules set grace_minutes = $2, half_day_after_minutes = $3, edit_window_hours = $4 where id = $1`, [ex.id, s.grace_minutes, s.half_day_after_minutes, s.edit_window_hours ?? null]);
    else await x.c.query(`insert into core.attendance_rules (org_id, branch_id, applies_to, position_id, grace_minutes, half_day_after_minutes, edit_window_hours) values ($1, $2, 'staff', $3, $4, $5, $6)`, [x.actor.orgId, x.actor.branchId, await positionId(x, (s.position_key as string | null) ?? null), s.grace_minutes, s.half_day_after_minutes, s.edit_window_hours ?? null]);
  },
  async remove(x, key) {
    const ex = await attRule(x, key);
    if (ex) await x.c.query(`update core.attendance_rules set deleted_at = now() where id = $1`, [ex.id]);
  },
};

// ---------------------------------------------------------------- module flags
function branchOf(x: ApplyCtx, code: string): string {
  const b = x.actor.branches.find((br) => br.code === code);
  if (!b) throw new ForbiddenError('unknown_branch');
  return b.id;
}
function splitFlag(key: string) {
  const i = key.lastIndexOf('__');
  return { module: key.slice(0, i), code: key.slice(i + 2) };
}

export const moduleFlagServer: ServerBlock = {
  key: 'os.module_flag',
  async read(x, key) {
    const { module, code } = splitFlag(key);
    const b = x.actor.branches.find((br) => br.code === code);
    if (!b) return null;
    const r = await maybe<{ enabled: boolean }>(x.c, `select enabled from os.module_flags where branch_id = $1 and module_key = $2 and deleted_at is null`, [b.id, module]);
    return r ? { module_key: module, branch_code: code, enabled: r.enabled } : null;
  },
  list: (x) =>
    q(x.c, `select f.module_key || '__' || b.code as key, f.module_key || ' (' || b.code || ')' as name from os.module_flags f join core.branches b on b.id = f.branch_id where f.org_id = $1 and f.deleted_at is null and not f.enabled`, [x.actor.orgId]),
  async write(x, _key, s) {
    await x.c.query(`insert into os.module_flags (org_id, branch_id, module_key, enabled) values ($1, $2, $3, $4) on conflict (branch_id, module_key) do update set enabled = excluded.enabled, deleted_at = null`, [x.actor.orgId, branchOf(x, String(s.branch_code)), s.module_key, s.enabled]);
  },
  async remove(x, key) {
    const { module, code } = splitFlag(key);
    await x.c.query(`delete from os.module_flags where branch_id = $1 and module_key = $2`, [branchOf(x, code), module]);
  },
};

// ---------------------------------------------------------------- roles and permissions
export const roleServer: ServerBlock = {
  key: 'os.role',
  async read(x, key) {
    const r = await maybe<{ key: string; name: string; description: string | null }>(x.c, `select key, name, description from os.roles where org_id = $1 and key = $2 and deleted_at is null`, [x.actor.orgId, key]);
    return r ? clean({ key: r.key, name: r.name, description: r.description }) : null;
  },
  list: async (x) => (await q<{ key: string; name: string; is_preset: boolean }>(x.c, `select key, name, is_preset from os.roles where org_id = $1 and deleted_at is null order by name`, [x.actor.orgId])).map((r) => ({ key: r.key, name: r.name, system: r.is_preset })),
  async write(x, key, s) {
    const existed = await maybe<{ id: string; deleted_at: string | null }>(x.c, `select id, deleted_at from os.roles where org_id = $1 and key = $2`, [x.actor.orgId, key]);
    const role = await one<{ id: string }>(
      x.c,
      `insert into os.roles (org_id, key, name, description, is_preset) values ($1, $2, $3, $4, false)
       on conflict (org_id, key) do update set name = excluded.name, description = excluded.description, deleted_at = null returning id`,
      [x.actor.orgId, key, s.name, s.description ?? null],
    );
    if (!existed && s.copy_from_role_key) {
      const from = await osRoleId(x, String(s.copy_from_role_key));
      await x.c.query(`insert into os.role_permissions (org_id, role_id, module, action, scope) select org_id, $2, module, action, scope from os.role_permissions where role_id = $1 and deleted_at is null and module <> 'setup' on conflict (role_id, module, action) do nothing`, [from, role.id]);
    }
  },
  async remove(x, key) {
    const r = await maybe<{ id: string; is_preset: boolean }>(x.c, `select id, is_preset from os.roles where org_id = $1 and key = $2 and deleted_at is null`, [x.actor.orgId, key]);
    if (!r) return;
    if (r.is_preset) throw new ValidationError('system_item', { key });
    const held = await one<{ n: number }>(x.c, `select count(*)::int as n from os.staff_roles where role_id = $1 and deleted_at is null`, [r.id]);
    if (held.n) throw new ValidationError('role_in_use', { key, staff: held.n });
    await x.c.query(`update os.roles set deleted_at = now() where id = $1`, [r.id]);
  },
};

function splitPerm(key: string) {
  const [role, module, action] = key.split('__');
  return { role: role ?? '', module: module ?? '', action: action ?? '' };
}

export const rolePermissionServer: ServerBlock = {
  key: 'os.role_permission',
  async read(x, key) {
    const p = splitPerm(key);
    const r = await maybe<{ scope: string }>(
      x.c,
      `select rp.scope from os.role_permissions rp join os.roles r on r.id = rp.role_id where r.org_id = $1 and r.key = $2 and rp.module = $3 and rp.action = $4 and rp.deleted_at is null and r.deleted_at is null`,
      [x.actor.orgId, p.role, p.module, p.action],
    );
    return r ? { role_key: p.role, module: p.module, action: p.action, scope: r.scope } : null;
  },
  // the matrix is large; the AI sees roles (os.role) and asks for single cells
  list: async () => [],
  async write(x, _key, s) {
    if (s.module === 'setup') throw new ForbiddenError('setup_permissions_are_manual');
    const role = await osRoleId(x, String(s.role_key));
    await x.c.query(`insert into os.role_permissions (org_id, role_id, module, action, scope) values ($1, $2, $3, $4, $5) on conflict (role_id, module, action) do update set scope = excluded.scope, deleted_at = null`, [x.actor.orgId, role, s.module, s.action, s.scope]);
  },
  async remove(x, key) {
    const p = splitPerm(key);
    if (p.module === 'setup') throw new ForbiddenError('setup_permissions_are_manual');
    await x.c.query(`delete from os.role_permissions where role_id = (select id from os.roles where org_id = $1 and key = $2 and deleted_at is null) and module = $3 and action = $4`, [x.actor.orgId, p.role, p.module, p.action]);
  },
};

// ---------------------------------------------------------------- custom fields
function splitField(key: string) {
  const i = key.indexOf('__');
  return { entity: key.slice(0, i), field: key.slice(i + 2) };
}

export const customFieldServer: ServerBlock = {
  key: 'os.custom_field',
  async read(x, key) {
    const { entity, field } = splitField(key);
    const r = await maybe<{ entity: string; key: string; label: string; field_type: string; options: string[]; required: boolean; active: boolean }>(
      x.c,
      `select entity, key, label, field_type, options, required, active from core.custom_fields where org_id = $1 and branch_id is null and entity = $2 and key = $3 and deleted_at is null`,
      [x.actor.orgId, entity, field],
    );
    return r && r.active ? { entity: r.entity, key: r.key, label: r.label, field_type: r.field_type, options: Array.isArray(r.options) ? r.options : [], required: r.required } : null;
  },
  list: (x) => q(x.c, `select entity || '__' || key as key, label as name from core.custom_fields where org_id = $1 and branch_id is null and product_key = 'os' and active and deleted_at is null order by entity, seq`, [x.actor.orgId]),
  async write(x, _key, s) {
    await x.c.query(
      `insert into core.custom_fields (org_id, branch_id, product_key, entity, key, label, field_type, options, required, active) values ($1, null, 'os', $2, $3, $4, $5, $6, $7, true)
       on conflict (org_id, branch_id, entity, key) do update set label = excluded.label, field_type = excluded.field_type, options = excluded.options, required = excluded.required, active = true, deleted_at = null`,
      [x.actor.orgId, s.entity, s.key, s.label, s.field_type, JSON.stringify(s.options ?? []), s.required ?? false],
    );
  },
  async remove(x, key) {
    const { entity, field } = splitField(key);
    await x.c.query(`update core.custom_fields set deleted_at = now() where org_id = $1 and branch_id is null and entity = $2 and key = $3 and deleted_at is null`, [x.actor.orgId, entity, field]);
  },
};
