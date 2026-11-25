/**
 * os.approval_type -> core.approval_types + one default flow (core.approval_flows, applicant_role_key null) + its
 * core.approval_steps, exactly as the approval type builder saves them (services/approvals.ts saveApprovalType):
 * upsert the type by (org, key), retire the previous default flow, insert the new flow and steps.
 */
import { ValidationError, insert, maybe, one, q } from '../../../db';
import { clean, osRoleId, type ApplyCtx, type ServerBlock, type Settings } from '../types';

interface RawStep {
  seq: number;
  approver_kind: 'role' | 'manager_of_applicant' | 'staff';
  approver_role_key: string | null;
  approver_staff_id: string | null;
  condition: unknown;
  parallel_group: number | null;
  time_limit_hours: number | null;
}
interface RawType {
  name: string;
  form_schema: unknown;
  task_template: unknown;
  active: boolean;
  steps: RawStep[];
}

async function typeRow(x: ApplyCtx, key: string) {
  return maybe<{ id: string; key: string; name: string; form_schema: unknown; task_template: unknown; is_system: boolean; active: boolean }>(
    x.c,
    `select id, key, name, form_schema, task_template, is_system, active from core.approval_types where org_id = $1 and key = $2 and deleted_at is null`,
    [x.actor.orgId, key],
  );
}

async function defaultFlowSteps(x: ApplyCtx, typeId: string): Promise<RawStep[]> {
  const flow = await maybe<{ id: string }>(x.c, `select id from core.approval_flows where approval_type_id = $1 and applicant_role_key is null and deleted_at is null order by created_at desc limit 1`, [typeId]);
  if (!flow) return [];
  return q<RawStep>(
    x.c,
    `select seq, approver_kind, approver_role_key, approver_staff_id, condition, parallel_group, time_limit_hours from core.approval_steps where flow_id = $1 and deleted_at is null order by seq, created_at`,
    [flow.id],
  );
}

async function capture(x: ApplyCtx, key: string): Promise<Settings | null> {
  const t = await typeRow(x, key);
  if (!t) return null;
  const raw: RawType = { name: t.name, form_schema: t.form_schema, task_template: t.task_template, active: t.active, steps: await defaultFlowSteps(x, t.id) };
  return raw as unknown as Settings;
}

async function writeRaw(x: ApplyCtx, key: string, raw: RawType): Promise<void> {
  const { orgId } = x.actor;
  const t = await one<{ id: string }>(
    x.c,
    `insert into core.approval_types (org_id, product_key, key, name, form_schema, task_template, active) values ($1, 'os', $2, $3, $4, $5, $6)
     on conflict (org_id, key) do update set name = excluded.name, form_schema = excluded.form_schema, task_template = excluded.task_template, active = excluded.active, deleted_at = null
     returning id`,
    [orgId, key, raw.name, JSON.stringify(raw.form_schema ?? []), raw.task_template == null ? null : JSON.stringify(raw.task_template), raw.active],
  );
  await x.c.query(`update core.approval_flows set deleted_at = now() where approval_type_id = $1 and applicant_role_key is null and deleted_at is null`, [t.id]);
  const flow = await insert<{ id: string }>(x.c, 'core.approval_flows', { org_id: orgId, approval_type_id: t.id, name: `${raw.name} – flow` });
  for (const s of raw.steps) {
    await insert(x.c, 'core.approval_steps', {
      org_id: orgId,
      flow_id: flow.id,
      seq: s.seq,
      approver_kind: s.approver_kind,
      approver_role_key: s.approver_role_key,
      approver_staff_id: s.approver_staff_id,
      condition: s.condition ?? null,
      parallel_group: s.parallel_group,
      time_limit_hours: s.time_limit_hours,
    });
  }
}

export const approvalTypeServer: ServerBlock = {
  key: 'os.approval_type',
  async read(x, key) {
    const t = await typeRow(x, key);
    if (!t || !t.active) return null;
    const steps = await defaultFlowSteps(x, t.id);
    return {
      key: t.key,
      name: t.name,
      fields: Array.isArray(t.form_schema) ? t.form_schema : [],
      steps: steps.map((s) =>
        clean({
          seq: s.seq,
          approver: s.approver_kind === 'role' ? 'role' : 'manager_of_applicant',
          role_key: s.approver_kind === 'role' ? s.approver_role_key : null,
          condition: s.condition ?? null,
          time_limit_hours: s.time_limit_hours ?? 48,
        }),
      ),
      tasks: Array.isArray(t.task_template) ? t.task_template : [],
    };
  },
  async list(x) {
    return (await q<{ key: string; name: string; is_system: boolean }>(x.c, `select key, name, is_system from core.approval_types where org_id = $1 and deleted_at is null and active order by name`, [x.actor.orgId])).map((r) => ({ key: r.key, name: r.name, system: r.is_system }));
  },
  async write(x, key, s) {
    const steps = s.steps as { seq: number; approver: 'role' | 'manager_of_applicant'; role_key?: string | null; condition?: unknown; time_limit_hours: number }[];
    for (const st of steps) if (st.approver === 'role') await osRoleId(x, String(st.role_key));
    await writeRaw(x, key, {
      name: String(s.name),
      form_schema: s.fields ?? [],
      task_template: s.tasks ?? [],
      active: true,
      steps: steps.map((st) => ({ seq: st.seq, approver_kind: st.approver, approver_role_key: st.approver === 'role' ? (st.role_key ?? null) : null, approver_staff_id: null, condition: st.condition ?? null, parallel_group: null, time_limit_hours: st.time_limit_hours })),
    });
  },
  async remove(x, key) {
    const t = await typeRow(x, key);
    if (!t) return;
    if (t.is_system) throw new ValidationError('system_item', { key });
    await x.c.query(`update core.approval_flows set deleted_at = now() where approval_type_id = $1 and deleted_at is null`, [t.id]);
    await x.c.query(`update core.approval_types set deleted_at = now() where id = $1`, [t.id]);
  },
  capture,
  async restore(x, key, state) {
    if (state === null) {
      const t = await typeRow(x, key);
      if (t) {
        await x.c.query(`update core.approval_flows set deleted_at = now() where approval_type_id = $1 and deleted_at is null`, [t.id]);
        await x.c.query(`update core.approval_types set deleted_at = now() where id = $1`, [t.id]);
      }
      return;
    }
    await writeRaw(x, key, state as unknown as RawType);
  },
};
