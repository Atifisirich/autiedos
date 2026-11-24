/**
 * General approvals (PRD 5.6): request types built by the school, approval chains with
 * conditional, parallel or sequential steps, time limits and auto-escalation. Leave,
 * regularisation, attendance edits and swaps use the same engine through system types.
 */
import { resolveChain, applyApproval, type ResolvedStage, type StepDef } from '@autoed/shared';
import { ForbiddenError, NotFoundError, ValidationError, insert, maybe, one, q, update, type Tx } from '../db';
import { need, needModule, run, localToday, now, type Ctx } from '../core';
import { notify } from '../notify';
import { systemTask } from './tasks';

interface Stage extends ResolvedStage {
  anyOf: boolean;
}

export interface ApprovalRequestRow {
  id: string;
  org_id: string;
  branch_id: string;
  approval_type_id: string;
  applicant_id: string;
  title: string;
  data: Record<string, unknown> & { __chain?: Stage[]; __approved_by?: string[] };
  status: 'pending' | 'approved' | 'rejected' | 'returned' | 'cancelled';
  current_seq: number;
  pending_approver_ids: string[];
  linked_type: string | null;
  linked_id: string | null;
}

export type ApprovalHook = (c: Tx, req: ApprovalRequestRow, decision: 'approved' | 'rejected' | 'returned' | 'cancelled', actorId: string | null) => Promise<void>;
const hooks = new Map<string, ApprovalHook>();
export function registerApprovalHook(typeKey: string, fn: ApprovalHook) {
  hooks.set(typeKey, fn);
}

/** core.approval_requests names the applicant applicant_staff_id; the OS code reads it as applicant_id. */
function norm<T extends ApprovalRequestRow>(r: T): T {
  return { ...r, applicant_id: (r as unknown as { applicant_staff_id: string }).applicant_staff_id ?? r.applicant_id };
}

async function buildChain(c: Tx, orgId: string, branchId: string, typeId: string, applicantId: string, data: Record<string, unknown>, day: string): Promise<{ flowId: string | null; stages: Stage[] }> {
  // core.approval_flows / steps name OS roles by key (R8: core never references product role ids)
  const roleKeys = (await q<{ key: string }>(c, `select r.key from os.staff_roles sr join os.roles r on r.id = sr.role_id where sr.staff_id = $1 and sr.deleted_at is null`, [applicantId])).map((r) => r.key);
  const flow =
    (await maybe<{ id: string }>(c, `select id from core.approval_flows where approval_type_id = $1 and applicant_role_key = any($2) and deleted_at is null order by created_at limit 1`, [typeId, roleKeys])) ??
    (await maybe<{ id: string }>(c, `select id from core.approval_flows where approval_type_id = $1 and applicant_role_key is null and deleted_at is null order by created_at limit 1`, [typeId]));
  if (!flow) return { flowId: null, stages: [] };
  const steps = await q<{ seq: number; approver_kind: StepDef['approverKind']; approver_role_id: string | null; approver_staff_id: string | null; condition: StepDef['condition']; time_limit_hours: number }>(
    c,
    `select seq, approver_kind, approver_role_key as approver_role_id, approver_staff_id, condition, coalesce(time_limit_hours, 48) as time_limit_hours from core.approval_steps where flow_id = $1 and deleted_at is null order by seq`,
    [flow.id],
  );
  const reportsTo = Object.fromEntries((await q<{ id: string; reports_to: string | null }>(c, `select id, reports_to from core.staff where org_id = $1`, [orgId])).map((s) => [s.id, s.reports_to]));
  const roleHolders: Record<string, string[]> = {};
  for (const s of steps) {
    if (s.approver_role_id && !roleHolders[s.approver_role_id]) {
      roleHolders[s.approver_role_id] = (
        await q<{ id: string }>(
          c,
          `select s.id from core.staff s join os.staff_roles sr on sr.staff_id = s.id and sr.deleted_at is null join os.roles r on r.id = sr.role_id
           where r.key = $1 and r.org_id = $3 and s.status = 'active' and s.deleted_at is null and (s.branch_id = $2 or s.branch_id is null and not exists (
             select 1 from core.staff s2 join os.staff_roles sr2 on sr2.staff_id = s2.id join os.roles r2 on r2.id = sr2.role_id where r2.key = $1 and r2.org_id = $3 and s2.branch_id = $2 and s2.status = 'active'))`,
          [s.approver_role_id, branchId, orgId],
        )
      ).map((r) => r.id);
    }
  }
  const dels = await q<{ staff_id: string; delegate_id: string }>(c, `select staff_id, delegate_id from core.delegations where org_id = $1 and $2::date between starts_on and ends_on and deleted_at is null`, [orgId, day]);
  const resolved = resolveChain(
    steps.map((s) => ({ seq: s.seq, approverKind: s.approver_kind, approverRoleId: s.approver_role_id, approverStaffId: s.approver_staff_id, condition: s.condition, timeLimitHours: s.time_limit_hours })),
    { applicantId, data, reportsTo, roleHolders, delegates: Object.fromEntries(dels.map((d) => [d.staff_id, d.delegate_id])) },
  );
  const kindBySeq = new Map<number, string[]>();
  for (const s of steps) kindBySeq.set(s.seq, [...(kindBySeq.get(s.seq) ?? []), s.approver_kind]);
  return { flowId: flow.id, stages: resolved.map((r) => ({ ...r, anyOf: (kindBySeq.get(r.seq) ?? []).every((k) => k === 'role') })) };
}

/** Creates a request (called inside the caller's transaction, with system rights). */
export async function submitApproval(
  c: Tx,
  input: { orgId: string; branchId: string; applicantId: string; typeKey: string; title: string; data: Record<string, unknown>; linkedType?: string; linkedId?: string; actorName: string },
): Promise<ApprovalRequestRow> {
  const type = await maybe<{ id: string; key: string; form_schema: { key: string; required: boolean; type: string }[] }>(c, `select id, key, form_schema from core.approval_types where org_id = $1 and key = $2 and active and deleted_at is null`, [input.orgId, input.typeKey]);
  if (!type) throw new NotFoundError('approval_type_not_found');
  for (const f of type.form_schema ?? []) {
    if (f.required && (input.data[f.key] === undefined || input.data[f.key] === '' || input.data[f.key] === null)) throw new ValidationError('missing_field', { field: f.key });
    if (f.type === 'number' && input.data[f.key] !== undefined && Number.isNaN(Number(input.data[f.key]))) throw new ValidationError('bad_number', { field: f.key });
  }
  const day = new Date().toISOString().slice(0, 10);
  const { flowId, stages } = await buildChain(c, input.orgId, input.branchId, type.id, input.applicantId, input.data, day);
  const first = stages[0];
  const req = await insert<ApprovalRequestRow>(c, 'core.approval_requests', {
    org_id: input.orgId,
    branch_id: input.branchId,
    approval_type_id: type.id,
    flow_id: flowId,
    product_key: 'os',
    applicant_staff_id: input.applicantId,
    applicant_user_id: (await maybe<{ user_id: string | null }>(c, `select user_id from core.staff where id = $1`, [input.applicantId]))?.user_id ?? null,
    amount: typeof input.data.amount === 'number' ? input.data.amount : Number.isFinite(Number(input.data.amount)) && input.data.amount !== undefined && input.data.amount !== '' ? Number(input.data.amount) : null,
    title: input.title,
    data: { ...input.data, __chain: stages, __approved_by: [] },
    status: first ? 'pending' : 'approved',
    current_seq: 1,
    pending_approver_ids: first?.approverIds ?? [],
    step_due_at: first ? new Date(now().getTime() + first.timeLimitHours * 3600000).toISOString() : null,
    linked_type: input.linkedType ?? null,
    linked_id: input.linkedId ?? null,
    decided_at: first ? null : now().toISOString(),
  }).then(norm);
  await insert(c, 'core.approval_actions', { org_id: input.orgId, request_id: req.id, step_seq: 0, actor_staff_id: input.applicantId, action: 'submit' });
  if (first) {
    await notify(c, { orgId: input.orgId, branchId: input.branchId, staffIds: first.approverIds, event: 'approval.pending', titleKey: 'notif.approval.pending', vars: { title: input.title, who: input.actorName }, link: `/os/approvals/${req.id}` });
  } else {
    await finalize(c, req, 'approved', null);
  }
  return req;
}

async function finalize(c: Tx, req: ApprovalRequestRow, decision: 'approved' | 'rejected' | 'returned' | 'cancelled', actorId: string | null) {
  const type = await one<{ key: string; task_template: { title: string; role_key?: string; days_after: number }[] | null }>(c, `select key, task_template from core.approval_types where id = $1`, [req.approval_type_id]);
  const hook = hooks.get(type.key);
  if (hook) await hook(c, req, decision, actorId);
  if (decision === 'approved' && type.task_template?.length) {
    // An approved request can create tasks from a template (e.g. approved field trip -> trip checklist).
    for (const [i, tt] of type.task_template.entries()) {
      await systemTask(c, { orgId: req.org_id, branchId: req.branch_id, ownerId: req.applicant_id, title: tt.title, systemKey: `appr:${req.id}:${i}`, dueAt: new Date(now().getTime() + (tt.days_after ?? 0) * 86400000).toISOString(), linkedType: 'approval', linkedId: req.id, categoryKey: 'admin' });
    }
  }
  if (decision !== 'cancelled') {
    await notify(c, { orgId: req.org_id, branchId: req.branch_id, staffIds: [req.applicant_id], event: type.key === 'leave' ? 'leave.decision' : 'approval.decision', titleKey: `notif.approval.${decision}`, vars: { title: req.title }, link: `/os/approvals/${req.id}` });
  }
}

export async function approvalAction(ctx: Ctx, id: string, input: { action: 'approve' | 'reject' | 'return' | 'forward' | 'resubmit' | 'cancel'; comment?: string | null; forward_to?: string; data?: Record<string, unknown> }) {
  needModule(ctx, 'approvals');
  return run(ctx, async (c, sys) => {
    const req = await maybe<ApprovalRequestRow>(c, `select *, applicant_staff_id as applicant_id from core.approval_requests where id = $1 and deleted_at is null for update`, [id]);
    if (!req) throw new NotFoundError();
    const stages = (req.data.__chain ?? []) as Stage[];
    const approvedBy = (req.data.__approved_by ?? []) as string[];

    if (input.action === 'cancel' || input.action === 'resubmit') {
      if (req.applicant_id !== ctx.staffId) throw new ForbiddenError();
      if (input.action === 'cancel') {
        if (!['pending', 'returned', 'approved'].includes(req.status)) throw new ValidationError('cannot_cancel');
        await sys(async () => {
          await update(c, 'core.approval_requests', id, { status: 'cancelled', pending_approver_ids: [], decided_at: ctx.now.toISOString() });
          await insert(c, 'core.approval_actions', { org_id: req.org_id, request_id: id, step_seq: req.current_seq, actor_staff_id: ctx.staffId, actor_user_id: ctx.userId, action: 'cancel', comment: input.comment ?? null });
          await finalize(c, { ...req, status: 'cancelled' }, 'cancelled', ctx.staffId);
        });
        return { status: 'cancelled' };
      }
      if (req.status !== 'returned') throw new ValidationError('not_returned');
      const data = { ...req.data, ...(input.data ?? {}) };
      const first = stages[0];
      await sys(async () => {
        await update(c, 'core.approval_requests', id, { status: first ? 'pending' : 'approved', data: { ...data, __approved_by: [] }, current_seq: 1, pending_approver_ids: first?.approverIds ?? [], step_due_at: first ? new Date(ctx.now.getTime() + first.timeLimitHours * 3600000).toISOString() : null });
        await insert(c, 'core.approval_actions', { org_id: req.org_id, request_id: id, step_seq: 0, actor_staff_id: ctx.staffId, actor_user_id: ctx.userId, action: 'resubmit', comment: input.comment ?? null });
        if (first) await notify(c, { orgId: req.org_id, branchId: req.branch_id, staffIds: first.approverIds, event: 'approval.pending', titleKey: 'notif.approval.pending', vars: { title: req.title, who: ctx.staff.full_name }, link: `/os/approvals/${id}` });
      });
      return { status: 'pending' };
    }

    if (req.status !== 'pending') throw new ValidationError('not_pending');
    if (!req.pending_approver_ids.includes(ctx.staffId)) throw new ForbiddenError('not_an_approver');
    if (input.action === 'forward' && !input.forward_to) throw new ValidationError('forward_to_required');
    const stageIndex = req.current_seq - 1;
    const stage = stages[stageIndex];
    const res = applyApproval({ status: 'pending', stageIndex, approvedBy }, stages, ctx.staffId, input.action, { anyOf: stage?.anyOf ?? true, forwardTo: input.forward_to });
    if (res.error) throw new ForbiddenError(res.error);
    const nextStages = res.stages as Stage[];
    if (input.action === 'forward') nextStages[stageIndex + 1] = { ...nextStages[stageIndex + 1]!, anyOf: true };
    const nextStage = nextStages[res.state.stageIndex];
    const patch: Record<string, unknown> = {
      status: res.state.status,
      current_seq: res.state.stageIndex + 1,
      pending_approver_ids: res.state.status === 'pending' ? (res.state.approvedBy.length ? stage!.approverIds.filter((a) => !res.state.approvedBy.includes(a)) : nextStage?.approverIds ?? []) : [],
      data: { ...req.data, __chain: nextStages, __approved_by: res.state.approvedBy },
      step_due_at: res.state.status === 'pending' && nextStage ? new Date(ctx.now.getTime() + nextStage.timeLimitHours * 3600000).toISOString() : null,
      decided_at: res.state.status === 'pending' ? null : ctx.now.toISOString(),
    };
    await sys(async () => {
      const updated = norm(await update<ApprovalRequestRow>(c, 'core.approval_requests', id, patch));
      await insert(c, 'core.approval_actions', { org_id: req.org_id, request_id: id, step_seq: req.current_seq, actor_staff_id: ctx.staffId, actor_user_id: ctx.userId, action: input.action, comment: input.comment ?? null, forwarded_to: input.forward_to ?? null });
      if (res.state.status === 'pending' && res.state.stageIndex !== stageIndex) {
        await notify(c, { orgId: req.org_id, branchId: req.branch_id, staffIds: nextStage?.approverIds ?? [], event: 'approval.pending', titleKey: 'notif.approval.pending', vars: { title: req.title, who: ctx.staff.full_name }, link: `/os/approvals/${id}` });
      } else if (res.state.status !== 'pending') {
        await finalize(c, updated, res.state.status as 'approved' | 'rejected' | 'returned', ctx.staffId);
      }
    });
    return { status: res.state.status };
  });
}

export async function createRequest(ctx: Ctx, input: { approval_type_key: string; title: string; data: Record<string, unknown> }) {
  need(ctx, 'approvals', 'create');
  return run(ctx, async (c, sys) => {
    const t = await maybe<{ is_system: boolean }>(c, `select is_system from core.approval_types where org_id = $1 and key = $2 and deleted_at is null`, [ctx.orgId, input.approval_type_key]);
    if (!t) throw new NotFoundError();
    if (t.is_system) throw new ValidationError('system_type');
    const req = await sys(() => submitApproval(c, { orgId: ctx.orgId, branchId: ctx.branchId, applicantId: ctx.staffId, typeKey: input.approval_type_key, title: input.title, data: input.data, actorName: ctx.staff.full_name }));
    return { id: req.id, status: req.status };
  });
}

export async function listApprovals(ctx: Ctx, view: 'pending_me' | 'mine' | 'all' | 'decided_by_me') {
  needModule(ctx, 'approvals');
  return run(ctx, async (c) => {
    const where =
      view === 'pending_me' ? `$1 = any(r.pending_approver_ids) and r.status = 'pending'` : view === 'mine' ? `r.applicant_staff_id = $1` : view === 'decided_by_me' ? `exists (select 1 from core.approval_actions a where a.request_id = r.id and a.actor_staff_id = $1 and a.action in ('approve','reject','return','forward'))` : `r.branch_id = $2`;
    return q(
      c,
      `select r.id, r.title, r.status, r.created_at, r.step_due_at, r.current_seq, r.linked_type, r.linked_id, t.key as type_key, t.name as type_name, t.name_i18n, s.full_name as applicant_name,
         extract(epoch from (coalesce(r.decided_at, now()) - r.created_at)) / 3600 as age_hours
       from core.approval_requests r join core.approval_types t on t.id = r.approval_type_id join core.staff s on s.id = r.applicant_staff_id
       where r.deleted_at is null and ${where} order by r.created_at desc limit 200`,
      view === 'all' ? [ctx.staffId, ctx.branchId] : [ctx.staffId],
    );
  });
}

export async function getApproval(ctx: Ctx, id: string) {
  return run(ctx, async (c) => {
    const r = await maybe<ApprovalRequestRow & Record<string, unknown>>(
      c,
      `select r.*, r.applicant_staff_id as applicant_id, t.key as type_key, t.name as type_name, t.form_schema, s.full_name as applicant_name from core.approval_requests r join core.approval_types t on t.id = r.approval_type_id join core.staff s on s.id = r.applicant_staff_id where r.id = $1`,
      [id],
    );
    if (!r) throw new NotFoundError();
    const actions = await q(c, `select a.*, a.actor_staff_id as actor_id, s.full_name as actor_name, f.full_name as forwarded_name from core.approval_actions a left join core.staff s on s.id = a.actor_staff_id left join core.staff f on f.id = a.forwarded_to where a.request_id = $1 order by a.created_at`, [id]);
    const names = await q<{ id: string; full_name: string }>(c, `select id, full_name from core.staff where id = any($1)`, [((r.data.__chain ?? []) as Stage[]).flatMap((s) => s.approverIds)]);
    const { __chain, __approved_by, ...data } = r.data;
    return { ...r, data, chain: ((__chain ?? []) as Stage[]).map((s) => ({ ...s, approvers: s.approverIds.map((a) => names.find((n) => n.id === a)?.full_name ?? a) })), approved_by: __approved_by ?? [], actions, can_act: r.status === 'pending' && r.pending_approver_ids.includes(ctx.staffId), is_applicant: r.applicant_id === ctx.staffId };
  });
}

/** Auto-escalation: a step past its time limit escalates to each pending approver's manager. */
export async function approvalEscalationSweep(c: Tx, at: Date = now()): Promise<number> {
  const rows = await q<ApprovalRequestRow & { step_due_at: string }>(c, `select *, applicant_staff_id as applicant_id from core.approval_requests where status = 'pending' and step_due_at < $1 and deleted_at is null`, [at.toISOString()]);
  let n = 0;
  for (const r of rows) {
    const managers = (await q<{ reports_to: string | null }>(c, `select reports_to from core.staff where id = any($1)`, [r.pending_approver_ids])).map((m) => m.reports_to).filter((m): m is string => !!m && m !== r.applicant_id);
    const add = managers.filter((m) => !r.pending_approver_ids.includes(m));
    const stages = (r.data.__chain ?? []) as Stage[];
    const idx = r.current_seq - 1;
    if (stages[idx]) stages[idx] = { ...stages[idx]!, approverIds: [...new Set([...stages[idx]!.approverIds, ...add])], anyOf: true };
    await c.query(`update core.approval_requests set pending_approver_ids = $2, step_due_at = $3, data = $4 where id = $1`, [r.id, [...new Set([...r.pending_approver_ids, ...add])], new Date(at.getTime() + 24 * 3600000).toISOString(), JSON.stringify({ ...r.data, __chain: stages })]);
    await insert(c, 'core.approval_actions', { org_id: r.org_id, request_id: r.id, step_seq: r.current_seq, actor_staff_id: null, action: 'escalate', comment: 'time_limit_exceeded' });
    await notify(c, { orgId: r.org_id, branchId: r.branch_id, staffIds: [...r.pending_approver_ids, ...add], event: 'task.escalation', titleKey: 'notif.approval.escalated', vars: { title: r.title }, link: `/os/approvals/${r.id}`, dedupeKey: `apesc:${r.id}:${at.toISOString().slice(0, 13)}` });
    n++;
  }
  return n;
}

export async function approvalTypes(ctx: Ctx) {
  return run(ctx, async (c) => {
    const types = await q<{ id: string }>(c, `select id, key, name, name_i18n, form_schema, task_template, is_system, active from core.approval_types where org_id = $1 and deleted_at is null order by is_system, name`, [ctx.orgId]);
    const steps = await q(c, `select f.approval_type_id, s.* , r.id as approver_role_id, r.name as role_name, st.full_name as staff_name from core.approval_flows f join core.approval_steps s on s.flow_id = f.id left join os.roles r on r.org_id = s.org_id and r.key = s.approver_role_key and r.deleted_at is null left join core.staff st on st.id = s.approver_staff_id where f.org_id = $1 and f.deleted_at is null and s.deleted_at is null order by s.seq`, [ctx.orgId]);
    return types.map((t) => ({ ...t, steps: steps.filter((s) => (s as { approval_type_id: string }).approval_type_id === t.id) }));
  });
}

/** Form builder save: type + single default flow. */
export async function saveApprovalType(ctx: Ctx, input: { key: string; name: string; form_schema: unknown[]; task_template?: unknown[] | null; steps: { seq: number; approver_kind: string; approver_role_id?: string | null; approver_staff_id?: string | null; condition?: unknown; time_limit_hours: number }[] }) {
  need(ctx, 'approvals', 'configure');
  return run(ctx, async (c) => {
    const type = await insert<{ id: string; is_system: boolean }>(c, 'core.approval_types', { org_id: ctx.orgId, product_key: 'os', key: input.key, name: input.name, form_schema: input.form_schema, task_template: input.task_template ?? null }, { onConflict: '(org_id, key) do update set name = excluded.name, form_schema = excluded.form_schema, task_template = excluded.task_template, deleted_at = null' });
    await c.query(`update core.approval_flows set deleted_at = now() where approval_type_id = $1 and deleted_at is null`, [type.id]);
    const flow = await insert<{ id: string }>(c, 'core.approval_flows', { org_id: ctx.orgId, approval_type_id: type.id, name: `${input.name} – flow` });
    for (const s of input.steps) await insert(c, 'core.approval_steps', { org_id: ctx.orgId, flow_id: flow.id, seq: s.seq, approver_kind: s.approver_kind, approver_role_key: s.approver_role_id ? (await one<{ key: string }>(c, `select key from os.roles where id = $1`, [s.approver_role_id])).key : null, approver_staff_id: s.approver_staff_id ?? null, condition: s.condition ?? null, time_limit_hours: s.time_limit_hours });
    return { id: type.id };
  });
}

export { localToday };
