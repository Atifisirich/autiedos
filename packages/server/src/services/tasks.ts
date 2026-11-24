/**
 * Task management (PRD 5.1).
 */
import {
  canAssign,
  transition,
  dueEscalation,
  recurrenceDates,
  isOverdue,
  countsAsComplete,
  DEFAULT_ESCALATION,
  fromLocal,
  toLocal,
  addDays,
  isoWeekday,
  isWorkingDay,
  type ActorRole,
  type AssignRule,
  type OrgGraph,
  type TaskCreateInput,
  type TaskActionInput,
  type TaskStatus,
  type EscalationRule,
} from '@autoed/shared';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError, insert, maybe, one, q, update, type Tx } from '../db';
import { need, needModule, rank, run, workCalendar, localToday, now, type Ctx } from '../core';
import { notify } from '../notify';

export interface TaskRow {
  id: string;
  org_id: string;
  branch_id: string;
  parent_task_id: string | null;
  is_group_parent: boolean;
  group_mode: 'each' | 'any' | null;
  title: string;
  description: string | null;
  category_id: string | null;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  status: TaskStatus;
  source: string;
  owner_id: string | null;
  assigner_id: string | null;
  department_id: string | null;
  wing_id: string | null;
  start_at: string | null;
  due_at: string | null;
  estimated_minutes: number | null;
  time_spent_minutes: number | null;
  proof_required: 'none' | 'note' | 'photo' | 'file';
  verification_required: boolean;
  unplanned: boolean;
  completed_at: string | null;
  verified_at: string | null;
  last_escalation_level: number;
  linked_type: string | null;
  linked_id: string | null;
  carried_forward_count: number;
  system_key: string | null;
  updated_at: string;
}

// ---------------------------------------------------------------- org graph
export async function loadGraph(c: Tx, orgId: string): Promise<{ graph: OrgGraph; rules: AssignRule[] }> {
  const staff = await q<{ id: string; reports_to: string | null }>(c, `select id, reports_to from core.staff where org_id = $1 and deleted_at is null`, [orgId]);
  const sec = await q<{ staff_id: string; manager_id: string }>(c, `select staff_id, manager_id from os.reporting_lines where org_id = $1 and deleted_at is null`, [orgId]);
  const roles = await q<{ staff_id: string; role_id: string }>(c, `select staff_id, role_id from os.staff_roles where org_id = $1 and deleted_at is null`, [orgId]);
  const rules = await q<{ from_role_id: string; to_role_id: string; rule: 'assign' | 'request' | 'none' }>(c, `select from_role_id, to_role_id, rule from os.assignment_rules where org_id = $1 and deleted_at is null`, [orgId]);
  const graph: OrgGraph = { reportsTo: {}, secondary: {}, roles: {} };
  for (const s of staff) graph.reportsTo[s.id] = s.reports_to;
  for (const l of sec) (graph.secondary![l.staff_id] ??= []).push(l.manager_id);
  for (const r of roles) (graph.roles[r.staff_id] ??= []).push(r.role_id);
  return { graph, rules: rules.map((r) => ({ fromRoleId: r.from_role_id, toRoleId: r.to_role_id, rule: r.rule })) };
}

async function actorRoles(c: Tx, ctx: Ctx, t: TaskRow): Promise<ActorRole[]> {
  const roles: ActorRole[] = [];
  if (t.owner_id === ctx.staffId) roles.push('owner');
  if (t.assigner_id === ctx.staffId) roles.push('assigner');
  if (t.assigner_id && t.assigner_id !== ctx.staffId) {
    const subs = await one<{ ids: string[] }>(c, `select os.subordinates_of($1) as ids`, [ctx.staffId]);
    if (subs.ids.includes(t.assigner_id)) roles.push('above_assigner');
  }
  // Branch-wide task authority (e.g. principal) counts as "above".
  if (!roles.includes('above_assigner') && rank(ctx, 'tasks', 'assign') >= 5 && t.branch_id && ctx.branchIds.includes(t.branch_id) && t.assigner_id !== ctx.staffId) roles.push('above_assigner');
  return roles;
}

async function event(c: Tx, t: { id: string; org_id: string; branch_id: string }, actor: string | null, ev: string, from: string | null, to: string | null, data: Record<string, unknown> = {}) {
  await insert(c, 'os.task_events', { org_id: t.org_id, branch_id: t.branch_id, task_id: t.id, actor_id: actor, event: ev, from_status: from, to_status: to, data });
}

async function staffMeta(c: Tx, ids: string[]) {
  return q<{ id: string; full_name: string; department_id: string | null; wing_id: string | null; branch_id: string | null }>(c, `select id, full_name, department_id, wing_id, branch_id from core.staff where id = any($1) and deleted_at is null`, [ids]);
}

/** Resolve "assign to a role, a wing or a department" into people in the branch. */
async function resolveTargets(c: Tx, ctx: Ctx, input: TaskCreateInput): Promise<string[]> {
  const ids = new Set(input.assignee_ids);
  if (input.target_role_id) (await q<{ id: string }>(c, `select s.id from core.staff s join os.staff_roles sr on sr.staff_id = s.id and sr.deleted_at is null where sr.role_id = $1 and s.branch_id = $2 and s.status = 'active' and s.deleted_at is null`, [input.target_role_id, ctx.branchId])).forEach((r) => ids.add(r.id));
  if (input.target_wing_id) (await q<{ id: string }>(c, `select id from core.staff where wing_id = $1 and status = 'active' and deleted_at is null`, [input.target_wing_id])).forEach((r) => ids.add(r.id));
  if (input.target_department_id) (await q<{ id: string }>(c, `select id from core.staff where department_id = $1 and branch_id = $2 and status = 'active' and deleted_at is null`, [input.target_department_id, ctx.branchId])).forEach((r) => ids.add(r.id));
  return [...ids];
}

// ---------------------------------------------------------------- create
export async function createTask(ctx: Ctx, input: TaskCreateInput): Promise<{ id: string; children: string[]; requested: string[]; recurrence_id?: string }> {
  need(ctx, 'tasks', 'create');
  return run(ctx, async (c, sys) => {
    if (input.client_id) {
      const existing = await maybe<{ id: string }>(c, `select id from os.tasks where system_key = $1 and org_id = $2`, [`client:${input.client_id}`, ctx.orgId]);
      if (existing) return { id: existing.id, children: [], requested: [] };
    }
    let assignees = input.source === 'assigned' ? await resolveTargets(c, ctx, input) : [ctx.staffId];
    if (!assignees.length) assignees = [ctx.staffId];
    const cat = input.category_id ? await maybe<{ default_proof: 'none' | 'note' | 'photo' | 'file'; default_verification: boolean }>(c, `select default_proof, default_verification from os.task_categories where id = $1`, [input.category_id]) : null;
    const proof = input.proof_required ?? cat?.default_proof ?? 'none';
    const verify = input.verification_required ?? cat?.default_verification ?? false;

    const { graph, rules } = await loadGraph(c, ctx.orgId);
    const decisions = assignees.map((a) => ({ a, d: canAssign(ctx.staffId, a, graph, rules) }));
    const refused = decisions.filter((x) => x.d.mode === 'none');
    if (refused.length) throw new ForbiddenError('assignment_not_allowed');
    if (assignees.length > 1 && decisions.some((x) => x.d.mode === 'request')) throw new ValidationError('group_assignment_requires_assign_rights');

    const meta = new Map((await staffMeta(c, assignees)).map((m) => [m.id, m]));
    const base = {
      org_id: ctx.orgId,
      branch_id: ctx.branchId,
      title: input.title,
      description: input.description ?? null,
      category_id: input.category_id ?? null,
      priority: input.priority,
      assigner_id: ctx.staffId,
      start_at: input.start_at ?? null,
      due_at: input.due_at ?? null,
      estimated_minutes: input.estimated_minutes ?? null,
      proof_required: proof,
      verification_required: verify,
      linked_type: input.linked_type ?? null,
      linked_id: input.linked_id ?? null,
      voice_note_path: input.voice_note_path ?? null,
      custom: input.custom,
    };

    if (input.recurrence) {
      const rec = await insert<{ id: string }>(c, 'os.task_recurrences', {
        org_id: ctx.orgId,
        branch_id: ctx.branchId,
        template: { title: input.title, description: input.description ?? null, category_id: input.category_id ?? null, priority: input.priority, proof_required: proof, verification_required: verify, estimated_minutes: input.estimated_minutes ?? null },
        target: { staff_ids: assignees, group_mode: input.group_mode },
        frequency: input.recurrence.frequency,
        interval_n: input.recurrence.interval_n,
        weekdays: input.recurrence.weekdays,
        month_day: input.recurrence.month_day ?? null,
        custom_dates: input.recurrence.custom_dates,
        due_time: input.recurrence.due_time,
        starts_on: input.recurrence.starts_on,
        ends_on: input.recurrence.ends_on ?? null,
        assigner_id: ctx.staffId,
      });
      await sys(() => generateRecurrences(c, localToday(ctx), rec.id));
      return { id: rec.id, children: [], requested: [], recurrence_id: rec.id };
    }

    const requested: string[] = [];
    const created: string[] = [];
    let parentId: string | null = null;
    if (assignees.length > 1) {
      const parent = await insert<TaskRow>(c, 'os.tasks', { ...base, source: 'assigned', is_group_parent: true, group_mode: input.group_mode, owner_id: null, status: 'todo' });
      parentId = parent.id;
      await event(c, parent, ctx.staffId, 'created', null, 'todo', { group: assignees.length });
    }
    for (const { a, d } of decisions) {
      const m = meta.get(a);
      const isRequest = d.mode === 'request';
      const status: TaskStatus = isRequest ? 'requested' : 'todo';
      const t = await insert<TaskRow>(c, 'os.tasks', {
        ...base,
        parent_task_id: parentId,
        source: input.source === 'self' ? 'self' : isRequest ? 'request' : 'assigned',
        owner_id: a,
        department_id: m?.department_id ?? null,
        wing_id: m?.wing_id ?? null,
        status,
        system_key: input.client_id && !parentId ? `client:${input.client_id}` : null,
      });
      created.push(t.id);
      if (isRequest) requested.push(t.id);
      await event(c, t, ctx.staffId, 'created', null, status);
      for (const title of input.subtasks) {
        const sub = await insert<TaskRow>(c, 'os.tasks', { ...base, title, parent_task_id: t.id, owner_id: a, source: 'assigned', status, department_id: m?.department_id ?? null, wing_id: m?.wing_id ?? null, proof_required: 'none', verification_required: false });
        await event(c, sub, ctx.staffId, 'created', null, status, { subtask_of: t.id });
      }
      for (const cid of input.collaborator_ids) await insert(c, 'os.task_assignees', { org_id: ctx.orgId, branch_id: ctx.branchId, task_id: t.id, staff_id: cid, kind: 'collaborator' }, { onConflict: '(task_id, staff_id, kind) do nothing' });
      for (const wid of input.watcher_ids) await insert(c, 'os.task_assignees', { org_id: ctx.orgId, branch_id: ctx.branchId, task_id: t.id, staff_id: wid, kind: 'watcher' }, { onConflict: '(task_id, staff_id, kind) do nothing' });
      if (a !== ctx.staffId) {
        await sys(() =>
          notify(c, {
            orgId: ctx.orgId,
            branchId: ctx.branchId,
            staffIds: [a],
            event: isRequest ? 'task.requested' : input.priority === 'urgent' ? 'task.assigned_urgent' : 'task.assigned',
            titleKey: isRequest ? 'notif.task.requested' : 'notif.task.assigned',
            vars: { title: input.title, from: ctx.staff.full_name },
            link: `/os/tasks/${t.id}`,
            data: { task_id: t.id },
            priority: input.priority === 'urgent' ? 'urgent' : 'normal',
          }),
        );
      }
    }
    return { id: parentId ?? created[0]!, children: parentId ? created : [], requested };
  });
}

/** "Quick add" in two taps: an unplanned piece of work already done. */
export async function quickAdd(ctx: Ctx, input: { title: string; time_spent_minutes?: number | null; voice_note_path?: string | null; client_id?: string }) {
  need(ctx, 'tasks', 'create');
  return run(ctx, async (c) => {
    if (input.client_id) {
      const ex = await maybe<{ id: string }>(c, `select id from os.tasks where system_key = $1 and org_id = $2`, [`client:${input.client_id}`, ctx.orgId]);
      if (ex) return { id: ex.id };
    }
    const cat = await maybe<{ id: string }>(c, `select id from os.task_categories where org_id = $1 and key = 'personal' and deleted_at is null`, [ctx.orgId]);
    const t = await insert<TaskRow>(c, 'os.tasks', {
      org_id: ctx.orgId,
      branch_id: ctx.branchId,
      title: input.title,
      category_id: cat?.id ?? null,
      source: 'sudden',
      unplanned: true,
      owner_id: ctx.staffId,
      assigner_id: ctx.staffId,
      department_id: ctx.staff.department_id,
      wing_id: ctx.staff.wing_id,
      status: 'done',
      completed_at: ctx.now.toISOString(),
      time_spent_minutes: input.time_spent_minutes ?? null,
      voice_note_path: input.voice_note_path ?? null,
      system_key: input.client_id ? `client:${input.client_id}` : null,
    });
    await event(c, t, ctx.staffId, 'created', null, 'done', { quick_add: true });
    return { id: t.id };
  });
}

// ---------------------------------------------------------------- read
const LIST_SELECT = `
  select t.id, t.title, t.status, t.priority, t.source, t.due_at, t.start_at, t.owner_id, t.assigner_id, t.category_id, t.parent_task_id,
         t.is_group_parent, t.group_mode, t.verification_required, t.proof_required, t.unplanned, t.completed_at, t.linked_type, t.linked_id,
         t.time_spent_minutes, t.estimated_minutes, t.updated_at,
         o.full_name as owner_name, a.full_name as assigner_name, tc.name as category_name, tc.name_i18n as category_i18n, tc.color as category_color,
         (t.due_at is not null and t.due_at < now() and t.status in ('todo','in_progress','blocked','reopened')) as overdue,
         (select count(*)::int from os.tasks ch where ch.parent_task_id = t.id and ch.deleted_at is null) as child_count,
         (select count(*)::int from os.tasks ch where ch.parent_task_id = t.id and ch.deleted_at is null and ch.status in ('done','verified')) as child_done
  from os.tasks t
  left join core.staff o on o.id = t.owner_id
  left join core.staff a on a.id = t.assigner_id
  left join os.task_categories tc on tc.id = t.category_id`;

export async function listTasks(ctx: Ctx, opts: { view: 'mine' | 'assigned' | 'team' | 'all'; status?: string; from?: string; to?: string; owner_id?: string; q?: string; limit?: number; offset?: number }) {
  needModule(ctx, 'tasks');
  return run(ctx, async (c) => {
    const where: string[] = ['t.deleted_at is null', 't.org_id = $1'];
    const params: unknown[] = [ctx.orgId];
    const p = (v: unknown) => (params.push(v), `$${params.length}`);
    if (opts.view === 'mine') where.push(`(t.owner_id = ${p(ctx.staffId)} or exists (select 1 from os.task_assignees ta where ta.task_id = t.id and ta.staff_id = ${p(ctx.staffId)} and ta.kind = 'collaborator')) and not t.is_group_parent`);
    if (opts.view === 'assigned') where.push(`t.assigner_id = ${p(ctx.staffId)} and t.owner_id is distinct from ${p(ctx.staffId)} and t.parent_task_id is null`);
    if (opts.view === 'team') where.push(`t.owner_id = any(os.subordinates_of(${p(ctx.staffId)})) and not t.is_group_parent`);
    if (opts.view === 'all') where.push(`t.branch_id = ${p(ctx.branchId)}`);
    if (opts.status === 'open') where.push(`t.status in ('todo','in_progress','blocked','reopened','requested')`);
    else if (opts.status === 'overdue') where.push(`t.due_at < now() and t.status in ('todo','in_progress','blocked','reopened')`);
    else if (opts.status === 'awaiting_verification') where.push(`t.status = 'done' and t.verification_required`);
    else if (opts.status) where.push(`t.status = ${p(opts.status)}`);
    if (opts.owner_id) where.push(`t.owner_id = ${p(opts.owner_id)}`);
    if (opts.from) where.push(`coalesce(t.due_at, t.start_at, t.created_at) >= ${p(opts.from)}::date`);
    if (opts.to) where.push(`coalesce(t.due_at, t.start_at, t.created_at) < (${p(opts.to)}::date + 1)`);
    if (opts.q) where.push(`t.title ilike ${p(`%${opts.q}%`)}`);
    const limit = Math.min(opts.limit ?? 200, 500);
    return q(c, `${LIST_SELECT} where ${where.join(' and ')} order by (t.status in ('done','verified','cancelled','not_done','declined')), t.due_at nulls last, t.created_at desc limit ${limit} offset ${Math.max(0, opts.offset ?? 0)}`, params);
  });
}

export async function getTask(ctx: Ctx, id: string) {
  needModule(ctx, 'tasks');
  return run(ctx, async (c) => {
    const rows = await q<TaskRow & Record<string, unknown>>(c, `${LIST_SELECT} where t.id = $1 and t.deleted_at is null`, [id]);
    const task = rows[0];
    if (!task) throw new NotFoundError();
    const full = await one<TaskRow & Record<string, unknown>>(c, `select * from os.tasks where id = $1`, [id]);
    const events = await q(c, `select e.*, s.full_name as actor_name from os.task_events e left join core.staff s on s.id = e.actor_id where e.task_id = $1 order by e.created_at`, [id]);
    const comments = await q(c, `select cm.*, s.full_name as author_name from os.task_comments cm left join core.staff s on s.id = cm.author_id where cm.task_id = $1 and cm.deleted_at is null order by cm.created_at`, [id]);
    const attachments = await q(c, `select * from os.task_attachments where task_id = $1 and deleted_at is null order by created_at`, [id]);
    const children = await q(c, `${LIST_SELECT} where t.parent_task_id = $1 and t.deleted_at is null order by t.created_at`, [id]);
    const people = await q(c, `select ta.kind, ta.staff_id, s.full_name from os.task_assignees ta join core.staff s on s.id = ta.staff_id where ta.task_id = $1 and ta.deleted_at is null`, [id]);
    const custom = await q(c, `select t.custom -> f.key as value, f.key, coalesce(f.label_i18n, to_jsonb(f.label)) as label, f.field_type from os.tasks t join core.custom_fields f on f.org_id = t.org_id and f.entity = 'task' and f.deleted_at is null where t.id = $1 and t.custom ? f.key`, [id]);
    const roles = await actorRoles(c, ctx, full);
    return { ...task, ...full, owner_name: task.owner_name, assigner_name: task.assigner_name, category_name: task.category_name, overdue: task.overdue, events, comments, attachments, children, people, custom, my_roles: roles };
  });
}

// ---------------------------------------------------------------- actions
export async function taskAction(ctx: Ctx, id: string, input: TaskActionInput): Promise<{ status: string; conflict?: 'server_wins' }> {
  needModule(ctx, 'tasks');
  return run(ctx, async (c, sys) => {
    const t = await maybe<TaskRow>(c, `select * from os.tasks where id = $1 and deleted_at is null for update`, [id]);
    if (!t) throw new NotFoundError();
    const roles = await actorRoles(c, ctx, t);
    if (!roles.length) throw new ForbiddenError();

    // Offline conflict rule (PRD 9.2): a record already closed on the server wins.
    if (input.client_at && ['verified', 'cancelled', 'not_done', 'declined'].includes(t.status) && ['complete', 'start', 'block', 'not_done', 'carry_forward'].includes(input.action)) {
      await event(c, t, ctx.staffId, 'offline_conflict', t.status, t.status, { action: input.action, client_at: input.client_at });
      return { status: t.status, conflict: 'server_wins' as const };
    }

    if (input.action === 'request_extension') {
      if (!roles.includes('owner')) throw new ForbiddenError();
      if (!input.due_at) throw new ValidationError('due_at_required');
      await insert(c, 'os.task_comments', { org_id: t.org_id, branch_id: t.branch_id, task_id: t.id, author_id: ctx.staffId, kind: 'extension_request', body: `${input.note ?? ''}`.trim() || ctx.t('task.extensionRequested'), mentions: [] });
      await event(c, t, ctx.staffId, 'extension_requested', t.status, t.status, { proposed_due_at: input.due_at });
      await sys(() => notify(c, { orgId: t.org_id, branchId: t.branch_id, staffIds: [t.assigner_id], event: 'task.status', titleKey: 'notif.task.extension', vars: { title: t.title, who: ctx.staff.full_name }, link: `/os/tasks/${t.id}` }));
      return { status: t.status };
    }

    if (input.action === 'change_due') {
      if (!roles.some((r) => r === 'assigner' || r === 'above_assigner')) throw new ForbiddenError('only_assigner_or_above');
      if (!input.due_at) throw new ValidationError('due_at_required');
      await update(c, 'os.tasks', t.id, { due_at: input.due_at, last_escalation_level: 0 });
      await event(c, t, ctx.staffId, 'due_changed', t.status, t.status, { from: t.due_at, to: input.due_at });
      await sys(() => notify(c, { orgId: t.org_id, branchId: t.branch_id, staffIds: [t.owner_id], event: 'task.status', titleKey: 'notif.task.dueChanged', vars: { title: t.title }, link: `/os/tasks/${t.id}` }));
      return { status: t.status };
    }

    if (input.action === 'delegate') {
      if (!roles.includes('owner')) throw new ForbiddenError();
      if (!input.delegate_to) throw new ValidationError('delegate_to_required');
      if (['done', 'verified', 'cancelled', 'not_done', 'declined'].includes(t.status)) throw new ConflictError('task_closed');
      const { graph, rules } = await loadGraph(c, ctx.orgId);
      const d = canAssign(ctx.staffId, input.delegate_to, graph, rules);
      if (d.mode !== 'assign') throw new ForbiddenError('delegation_not_allowed');
      const m = (await staffMeta(c, [input.delegate_to]))[0];
      if (!m) throw new NotFoundError();
      // The update moves the task out of the current owner's reach; do it with system rights after the check.
      await sys(async () => {
        await update(c, 'os.tasks', t.id, { owner_id: input.delegate_to, department_id: m.department_id, wing_id: m.wing_id, last_escalation_level: 0 });
        await event(c, t, ctx.staffId, 'delegated', t.status, t.status, { from: ctx.staffId, to: input.delegate_to, note: input.note ?? null });
        await insert(c, 'os.task_assignees', { org_id: t.org_id, branch_id: t.branch_id, task_id: t.id, staff_id: ctx.staffId, kind: 'watcher' }, { onConflict: '(task_id, staff_id, kind) do nothing' });
        await notify(c, { orgId: t.org_id, branchId: t.branch_id, staffIds: [input.delegate_to, t.assigner_id], event: 'task.assigned', titleKey: 'notif.task.delegated', vars: { title: t.title, from: ctx.staff.full_name }, link: `/os/tasks/${t.id}` });
      });
      return { status: t.status };
    }

    const res = transition({ status: t.status, proofRequired: t.proof_required, verificationRequired: t.verification_required }, input.action as Parameters<typeof transition>[1], roles, { reason: input.reason, note: input.note, proofPath: input.proof_path });
    if (!res.ok) throw res.error === 'not_allowed_for_role' ? new ForbiddenError(res.error) : new ValidationError(res.error);
    const patch: Record<string, unknown> = { status: res.status };
    if (input.action === 'complete') {
      patch.completed_at = (input.client_at ?? ctx.now.toISOString());
      patch.completion_note = input.note ?? null;
      if (input.proof_path) patch.proof_path = input.proof_path;
      if (input.time_spent_minutes != null) patch.time_spent_minutes = input.time_spent_minutes;
      if (input.proof_path) await insert(c, 'os.task_attachments', { org_id: t.org_id, branch_id: t.branch_id, task_id: t.id, kind: 'proof', storage_path: input.proof_path });
    }
    if (input.action === 'block') patch.blocked_reason = input.reason;
    if (input.action === 'not_done') {
      patch.not_done_reason = input.reason;
      patch.not_done_note = input.note ?? null;
    }
    if (input.action === 'verify') {
      patch.verified_at = ctx.now.toISOString();
      patch.verified_by = ctx.staffId;
    }
    if (input.action === 'reopen') {
      patch.completed_at = null;
      patch.verified_at = null;
      patch.last_escalation_level = 0;
      await insert(c, 'os.task_comments', { org_id: t.org_id, branch_id: t.branch_id, task_id: t.id, author_id: ctx.staffId, kind: 'comment', body: input.note!, mentions: [] });
    }
    if (input.action === 'carry_forward') {
      const cal = await workCalendar(c, t.branch_id);
      let next = addDays(localToday(ctx, cal.timeZone), 1);
      for (let i = 0; i < 14 && !isWorkingDay(next, cal); i++) next = addDays(next, 1);
      const time = t.due_at ? toLocal(new Date(t.due_at), cal.timeZone).minutes : 17 * 60;
      patch.due_at = fromLocal(next, time, cal.timeZone).toISOString();
      patch.carried_forward_count = t.carried_forward_count + 1;
      patch.last_escalation_level = 0;
    }
    await update(c, 'os.tasks', t.id, patch);
    await event(c, t, ctx.staffId, input.action, t.status, res.status, { reason: input.reason ?? null, note: input.note ?? null, client_at: input.client_at ?? null });

    await sys(async () => {
      if (input.action === 'complete' && t.verification_required) {
        await notify(c, { orgId: t.org_id, branchId: t.branch_id, staffIds: [t.assigner_id], event: 'task.status', titleKey: 'notif.task.awaitingVerification', vars: { title: t.title, who: ctx.staff.full_name }, link: `/os/tasks/${t.id}` });
      } else if (['complete', 'block', 'not_done', 'decline', 'accept'].includes(input.action) && t.assigner_id !== ctx.staffId) {
        await notify(c, { orgId: t.org_id, branchId: t.branch_id, staffIds: [t.assigner_id], event: 'task.status', titleKey: `notif.task.${input.action}`, vars: { title: t.title, who: ctx.staff.full_name }, link: `/os/tasks/${t.id}` });
      }
      if (['verify', 'reopen', 'cancel'].includes(input.action) && t.owner_id && t.owner_id !== ctx.staffId) {
        await notify(c, { orgId: t.org_id, branchId: t.branch_id, staffIds: [t.owner_id], event: 'task.status', titleKey: `notif.task.${input.action}`, vars: { title: t.title, who: ctx.staff.full_name }, link: `/os/tasks/${t.id}` });
      }
      if (t.parent_task_id) await rollupParent(c, t.parent_task_id, t.id, res.status, ctx.staffId);
    });
    return { status: res.status };
  });
}

/** Group tasks: "each" completes when all children complete; "any" when one does (others cancelled). */
async function rollupParent(c: Tx, parentId: string, childId: string, childStatus: TaskStatus, actor: string) {
  const parent = await maybe<TaskRow>(c, `select * from os.tasks where id = $1`, [parentId]);
  if (!parent || !parent.is_group_parent) return;
  const kids = await q<TaskRow>(c, `select * from os.tasks where parent_task_id = $1 and deleted_at is null`, [parentId]);
  const complete = (k: TaskRow) => countsAsComplete({ status: k.status, verificationRequired: k.verification_required });
  if (parent.group_mode === 'any' && (childStatus === 'done' || childStatus === 'verified') && complete({ ...kids.find((k) => k.id === childId)!, status: childStatus })) {
    for (const k of kids) {
      if (k.id !== childId && ['todo', 'in_progress', 'blocked', 'reopened', 'requested'].includes(k.status)) {
        await update(c, 'os.tasks', k.id, { status: 'cancelled' });
        await event(c, k, actor, 'completed_by_other', k.status, 'cancelled', { by_task: childId });
      }
    }
    if (parent.status !== 'done') {
      await update(c, 'os.tasks', parent.id, { status: 'done', completed_at: new Date().toISOString() });
      await event(c, parent, actor, 'group_complete', parent.status, 'done');
    }
    return;
  }
  if (parent.group_mode === 'each') {
    const active = kids.filter((k) => k.status !== 'cancelled');
    if (active.length && active.every(complete) && parent.status !== 'done') {
      await update(c, 'os.tasks', parent.id, { status: 'done', completed_at: new Date().toISOString() });
      await event(c, parent, actor, 'group_complete', parent.status, 'done');
    } else if (!active.every(complete) && parent.status === 'done') {
      await update(c, 'os.tasks', parent.id, { status: 'in_progress', completed_at: null });
      await event(c, parent, actor, 'group_reopened', 'done', 'in_progress');
    }
  }
}

export async function addComment(ctx: Ctx, taskId: string, input: { body: string; kind: 'comment' | 'question'; mentions: string[] }) {
  needModule(ctx, 'tasks');
  return run(ctx, async (c, sys) => {
    const t = await maybe<TaskRow>(c, `select * from os.tasks where id = $1`, [taskId]);
    if (!t) throw new NotFoundError();
    const cm = await insert<{ id: string }>(c, 'os.task_comments', { org_id: t.org_id, branch_id: t.branch_id, task_id: t.id, author_id: ctx.staffId, body: input.body, kind: input.kind, mentions: input.mentions });
    await event(c, t, ctx.staffId, input.kind === 'question' ? 'question' : 'comment', t.status, t.status, { comment_id: cm.id });
    const watchers = (await q<{ staff_id: string }>(c, `select staff_id from os.task_assignees where task_id = $1 and deleted_at is null`, [t.id])).map((w) => w.staff_id);
    const recipients = [...new Set([t.owner_id, t.assigner_id, ...watchers, ...input.mentions])].filter((x) => x && x !== ctx.staffId);
    await sys(() => notify(c, { orgId: t.org_id, branchId: t.branch_id, staffIds: recipients, event: 'task.comment', titleKey: input.mentions.length ? 'notif.task.mention' : 'notif.task.comment', vars: { title: t.title, who: ctx.staff.full_name }, link: `/os/tasks/${t.id}` }));
    return { id: cm.id };
  });
}

/** Convert a comment into a subtask (PRD 5.1 Actions). */
export async function commentToSubtask(ctx: Ctx, commentId: string) {
  return run(ctx, async (c) => {
    const cm = await maybe<{ id: string; task_id: string; body: string; converted_task_id: string | null }>(c, `select * from os.task_comments where id = $1`, [commentId]);
    if (!cm) throw new NotFoundError();
    if (cm.converted_task_id) return { id: cm.converted_task_id };
    const t = await one<TaskRow>(c, `select * from os.tasks where id = $1`, [cm.task_id]);
    const roles = await actorRoles(c, ctx, t);
    if (!roles.length) throw new ForbiddenError();
    const sub = await insert<TaskRow>(c, 'os.tasks', { org_id: t.org_id, branch_id: t.branch_id, parent_task_id: t.id, title: cm.body.slice(0, 300), owner_id: t.owner_id, assigner_id: ctx.staffId, department_id: t.department_id, wing_id: t.wing_id, status: 'todo', due_at: t.due_at, source: 'assigned' });
    await update(c, 'os.task_comments', cm.id, { converted_task_id: sub.id });
    await event(c, sub, ctx.staffId, 'created', null, 'todo', { from_comment: cm.id });
    return { id: sub.id };
  });
}

export async function attachToTask(ctx: Ctx, taskId: string, input: { storage_path: string; mime?: string; size_bytes?: number; kind?: 'attachment' | 'voice' }) {
  return run(ctx, async (c) => {
    const t = await maybe<TaskRow>(c, `select * from os.tasks where id = $1`, [taskId]);
    if (!t) throw new NotFoundError();
    if (!input.storage_path.startsWith(`${ctx.orgId}/`)) throw new ForbiddenError('bad_path');
    const a = await insert<{ id: string }>(c, 'os.task_attachments', { org_id: t.org_id, branch_id: t.branch_id, task_id: t.id, kind: input.kind ?? 'attachment', storage_path: input.storage_path, mime: input.mime ?? null, size_bytes: input.size_bytes ?? null });
    await event(c, t, ctx.staffId, 'attachment', t.status, t.status, { attachment_id: a.id });
    return { id: a.id };
  });
}

/** Bulk assign / reschedule / reassign (PRD 5.1 Rules). */
export async function bulkTasks(ctx: Ctx, input: { task_ids: string[]; op: 'reassign' | 'reschedule' | 'cancel'; to_staff_id?: string; due_at?: string }) {
  need(ctx, 'tasks', 'assign');
  return run(ctx, async (c, sys) => {
    let changed = 0;
    const { graph, rules } = await loadGraph(c, ctx.orgId);
    for (const id of input.task_ids) {
      const t = await maybe<TaskRow>(c, `select * from os.tasks where id = $1 and deleted_at is null`, [id]);
      if (!t) continue;
      const roles = await actorRoles(c, ctx, t);
      if (!roles.some((r) => r === 'assigner' || r === 'above_assigner')) continue;
      if (input.op === 'reschedule' && input.due_at) {
        await update(c, 'os.tasks', id, { due_at: input.due_at, last_escalation_level: 0 });
        await event(c, t, ctx.staffId, 'due_changed', t.status, t.status, { bulk: true, to: input.due_at });
      } else if (input.op === 'cancel' && !['verified', 'cancelled', 'not_done'].includes(t.status)) {
        await update(c, 'os.tasks', id, { status: 'cancelled' });
        await event(c, t, ctx.staffId, 'cancel', t.status, 'cancelled', { bulk: true });
      } else if (input.op === 'reassign' && input.to_staff_id) {
        if (canAssign(ctx.staffId, input.to_staff_id, graph, rules).mode !== 'assign') throw new ForbiddenError('assignment_not_allowed');
        const m = (await staffMeta(c, [input.to_staff_id]))[0];
        await sys(() => update(c, 'os.tasks', id, { owner_id: input.to_staff_id, department_id: m?.department_id ?? null, wing_id: m?.wing_id ?? null }));
        await event(c, t, ctx.staffId, 'reassigned', t.status, t.status, { from: t.owner_id, to: input.to_staff_id, bulk: true });
      } else continue;
      changed++;
    }
    if (input.op === 'reassign' && input.to_staff_id && changed) await sys(() => notify(c, { orgId: ctx.orgId, branchId: ctx.branchId, staffIds: [input.to_staff_id], event: 'task.assigned', titleKey: 'notif.task.bulkAssigned', vars: { count: changed }, link: '/os/tasks' }));
    return { changed };
  });
}

/** When a staff member leaves: move every open task to someone else. */
export async function reassignLeaver(ctx: Ctx, input: { from_staff_id: string; to_staff_id: string }) {
  need(ctx, 'tasks', 'assign', 5);
  return run(ctx, async (c, sys) => {
    const m = (await staffMeta(c, [input.to_staff_id]))[0];
    if (!m) throw new NotFoundError();
    const rows = await sys(() =>
      q<{ id: string; org_id: string; branch_id: string; status: string }>(
        c,
        `update os.tasks set owner_id = $2, department_id = $3, wing_id = $4 where owner_id = $1 and org_id = $5 and status in ('todo','in_progress','blocked','reopened','requested') and deleted_at is null returning id, org_id, branch_id, status`,
        [input.from_staff_id, input.to_staff_id, m.department_id, m.wing_id, ctx.orgId],
      ),
    );
    for (const r of rows) await event(c, r, ctx.staffId, 'reassigned', r.status, r.status, { from: input.from_staff_id, to: input.to_staff_id, reason: 'staff_left' });
    if (rows.length) await sys(() => notify(c, { orgId: ctx.orgId, branchId: ctx.branchId, staffIds: [input.to_staff_id], event: 'task.assigned', titleKey: 'notif.task.bulkAssigned', vars: { count: rows.length }, link: '/os/tasks' }));
    return { moved: rows.length };
  });
}

// ---------------------------------------------------------------- views
export async function teamView(ctx: Ctx) {
  needModule(ctx, 'tasks');
  return run(ctx, async (c) =>
    q(
      c,
      `with team as (select unnest(os.subordinates_of($1)) as id)
       select s.id, s.full_name, p.name as position,
         count(t.id) filter (where t.status in ('todo','in_progress','blocked','reopened')) as open,
         count(t.id) filter (where t.status in ('todo','in_progress','blocked','reopened') and t.due_at < now()) as overdue,
         count(t.id) filter (where t.completed_at >= now() - interval '30 days' and t.due_at is not null and t.status in ('done','verified')) as completed_30,
         count(t.id) filter (where t.completed_at >= now() - interval '30 days' and t.due_at is not null and t.status in ('done','verified') and t.completed_at <= t.due_at) as on_time_30,
         coalesce(sum(t.time_spent_minutes) filter (where t.unplanned and t.created_at >= now() - interval '30 days'), 0) as unplanned_minutes,
         count(t.id) filter (where t.unplanned and t.created_at >= now() - interval '30 days') as unplanned_30,
         count(t.id) filter (where t.created_at >= now() - interval '30 days') as total_30
       from team join core.staff s on s.id = team.id
       left join core.positions p on p.id = s.position_id
       left join os.tasks t on t.owner_id = s.id and t.deleted_at is null and not t.is_group_parent
       where s.deleted_at is null and s.status = 'active'
       group by s.id, s.full_name, p.name order by overdue desc, open desc, s.full_name`,
      [ctx.staffId],
    ),
  );
}

/**
 * My Day (PRD 5.1 Views): one timeline merging today's periods, duties, tasks, checklists,
 * meetings and substitutions, with free periods shown as slots.
 */
export async function myDay(ctx: Ctx, date?: string) {
  return run(ctx, async (c) => {
    const cal = await workCalendar(c, ctx.branchId);
    const day = date ?? localToday(ctx, cal.timeZone);
    const weekday = isoWeekday(day);
    const items: { kind: string; start: string | null; end: string | null; title: string; ref?: string; status?: string; meta?: Record<string, unknown> }[] = [];

    // periods from the published timetable (bell schedule of my sections' wing, else branch default)
    const version = await maybe<{ id: string }>(c, `select id from core.timetable_versions where branch_id = $1 and status = 'published' and (effective_from is null or effective_from <= $2) and deleted_at is null order by effective_from desc nulls last limit 1`, [ctx.branchId, day]);
    const periods = await q<{ teaching_index: number; label: string; starts_at: string; ends_at: string; wing_id: string | null }>(
      c,
      `select p.teaching_index, p.label, p.starts_at::text, p.ends_at::text, bs.wing_id from core.periods p join core.bell_schedules bs on bs.id = p.bell_schedule_id
       where bs.branch_id = $1 and bs.active and $2 = any(bs.days) and p.kind = 'period' and p.deleted_at is null order by p.seq`,
      [ctx.branchId, weekday],
    );
    const bell = new Map<number, { start: string; end: string; label: string }>();
    for (const p of periods) if (!bell.has(p.teaching_index)) bell.set(p.teaching_index, { start: p.starts_at.slice(0, 5), end: p.ends_at.slice(0, 5), label: p.label });
    const holiday = !isWorkingDay(day, cal);
    const onLeave = !!(await maybe(c, `select 1 from core.leave_requests where staff_id = $1 and status = 'approved' and $2::date between start_date and end_date and deleted_at is null`, [ctx.staffId, day]));
    if (version && !holiday && !onLeave && ctx.modules.timetable !== false) {
      const mine = await q<{ period_seq: number; section_name: string; subject_name: string | null; room_name: string | null; section_id: string; subject_id: string | null }>(
        c,
        `select e.period_seq, cl.name || ' ' || se.name as section_name, sb.name as subject_name, r.name as room_name, e.section_id, e.subject_id
         from core.timetable_entries e join core.sections se on se.id = e.section_id join core.programmes cl on cl.id = se.programme_id
         left join core.subjects sb on sb.id = e.subject_id left join core.rooms r on r.id = e.room_id
         where e.version_id = $1 and e.day = $2 and e.staff_id = $3 and e.deleted_at is null order by e.period_seq`,
        [version.id, weekday, ctx.staffId],
      );
      const taught = new Set(mine.map((m) => m.period_seq));
      for (const m of mine) {
        const b = bell.get(m.period_seq);
        const logged = await maybe(c, `select 1 from os.class_logs where section_id = $1 and date = $2 and period_seq = $3`, [m.section_id, day, m.period_seq]);
        items.push({ kind: 'period', start: b?.start ?? null, end: b?.end ?? null, title: `${m.subject_name ?? ''} · ${m.section_name}`, meta: { period_seq: m.period_seq, room: m.room_name, section_id: m.section_id, subject_id: m.subject_id, logged: !!logged } });
      }
      if (ctx.staff.is_teaching) {
        for (const [seq, b] of bell) if (!taught.has(seq)) items.push({ kind: 'free', start: b.start, end: b.end, title: b.label, meta: { period_seq: seq } });
      }
    }
    const subs = await q<{ id: string; period_seq: number; section_name: string; subject_name: string | null; status: string; cover_plan_id: string | null }>(
      c,
      `select su.id, su.period_seq, cl.name || ' ' || se.name as section_name, sb.name as subject_name, su.status, su.cover_plan_id from os.substitutions su
       join core.sections se on se.id = su.section_id join core.programmes cl on cl.id = se.programme_id left join core.subjects sb on sb.id = su.subject_id
       where su.substitute_staff_id = $1 and su.date = $2 and su.status = 'assigned' and su.deleted_at is null`,
      [ctx.staffId, day],
    );
    for (const s of subs) {
      const b = bell.get(s.period_seq);
      const idx = items.findIndex((i) => i.kind === 'free' && i.meta?.period_seq === s.period_seq);
      if (idx >= 0) items.splice(idx, 1);
      items.push({ kind: 'substitution', start: b?.start ?? null, end: b?.end ?? null, title: `${s.subject_name ?? ''} · ${s.section_name}`, ref: s.id, meta: { period_seq: s.period_seq, cover_plan_id: s.cover_plan_id } });
    }
    const duties = await q<{ id: string; name: string; name_i18n: Record<string, string>; starts_at: string; ends_at: string; status: string }>(
      c,
      `select da.id, dt.name, dt.name_i18n, dt.starts_at::text, dt.ends_at::text, da.status from os.duty_assignments da join os.duty_types dt on dt.id = da.duty_type_id
       where da.staff_id = $1 and da.date = $2 and da.deleted_at is null`,
      [ctx.staffId, day],
    );
    for (const d of duties) items.push({ kind: 'duty', start: d.starts_at.slice(0, 5), end: d.ends_at.slice(0, 5), title: d.name_i18n?.[ctx.lang] || d.name, ref: d.id, status: d.status });
    const meetings = await q<{ id: string; title: string; starts_at: string; ends_at: string }>(
      c,
      `select id, title, starts_at, ends_at from os.meetings where ($1 = any(attendee_ids) or organizer_id = $1) and status = 'scheduled' and deleted_at is null`,
      [ctx.staffId],
    );
    for (const m of meetings) {
      const s = toLocal(new Date(m.starts_at), cal.timeZone);
      if (s.date !== day) continue;
      const e = toLocal(new Date(m.ends_at), cal.timeZone);
      items.push({ kind: 'meeting', start: hm(s.minutes), end: hm(e.minutes), title: m.title, ref: m.id });
    }
    const checklists = await q<{ id: string; name: string; name_i18n: Record<string, string>; due_at: string; status: string }>(
      c,
      `select r.id, t.name, t.name_i18n, r.due_at, r.status from os.checklist_runs r join os.checklist_templates t on t.id = r.template_id where r.owner_id = $1 and r.run_date = $2 and r.deleted_at is null`,
      [ctx.staffId, day],
    );
    for (const k of checklists) items.push({ kind: 'checklist', start: hm(toLocal(new Date(k.due_at), cal.timeZone).minutes), end: null, title: k.name_i18n?.[ctx.lang] || k.name, ref: k.id, status: k.status });
    const dayEnd = fromLocal(addDays(day, 1), 0, cal.timeZone).toISOString();
    const tasks = await q<{ id: string; title: string; due_at: string | null; start_at: string | null; status: string; priority: string; overdue: boolean }>(
      c,
      `select id, title, due_at, start_at, status, priority, (due_at < now() and status in ('todo','in_progress','blocked','reopened')) as overdue from os.tasks
       where owner_id = $1 and deleted_at is null and not is_group_parent and (
         (status in ('todo','in_progress','blocked','reopened','requested') and (due_at < $2 or start_at < $2 or due_at is null))
         or (status in ('done','verified') and completed_at >= $3))
       order by due_at nulls last limit 100`,
      [ctx.staffId, dayEnd, fromLocal(day, 0, cal.timeZone).toISOString()],
    );
    for (const t of tasks) {
      const anchor = t.start_at ?? t.due_at;
      const loc = anchor ? toLocal(new Date(anchor), cal.timeZone) : null;
      items.push({ kind: 'task', start: loc && loc.date === day ? hm(loc.minutes) : null, end: null, title: t.title, ref: t.id, status: t.status, meta: { priority: t.priority, overdue: t.overdue, due_at: t.due_at } });
    }
    items.sort((a, b) => (a.start ?? '99:99').localeCompare(b.start ?? '99:99'));
    const att = await maybe<{ check_in_at: string | null; check_out_at: string | null; status: string }>(c, `select check_in_at, check_out_at, status from core.staff_attendance where staff_id = $1 and date = $2`, [ctx.staffId, day]);
    const approvals = await one<{ n: number }>(c, `select count(*)::int as n from core.approval_requests where $1 = any(pending_approver_ids) and status = 'pending' and deleted_at is null`, [ctx.staffId]);
    const unread = await one<{ n: number }>(c, `select count(*)::int as n from core.notifications where staff_id = $1 and read_at is null and deliver_after <= now()`, [ctx.staffId]);
    return { date: day, holiday, on_leave: onLeave, items, attendance: att, pending_approvals: approvals.n, unread: unread.n, simplified: !!ctx.staff.ui_prefs?.simplified_home };
  });
}

const hm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** Plan my week: drop a task onto a day or a free period. */
export async function scheduleTask(ctx: Ctx, taskId: string, startAt: string | null) {
  return run(ctx, async (c) => {
    const t = await maybe<TaskRow>(c, `select * from os.tasks where id = $1`, [taskId]);
    if (!t || t.owner_id !== ctx.staffId) throw new ForbiddenError();
    await update(c, 'os.tasks', t.id, { start_at: startAt });
    await event(c, t, ctx.staffId, 'scheduled', t.status, t.status, { start_at: startAt });
    return { ok: true };
  });
}

/** Day close (PRD 5.1): each open task due today is marked done, not done with reason, or carried forward. */
export async function dayClose(ctx: Ctx, items: { task_id: string; outcome: 'done' | 'not_done' | 'carry_forward'; reason?: 'no_time' | 'not_possible' | 'not_needed' | 'other'; note?: string }[]) {
  const results: { task_id: string; ok: boolean; error?: string }[] = [];
  for (const it of items) {
    try {
      const action = it.outcome === 'done' ? 'complete' : it.outcome === 'not_done' ? 'not_done' : 'carry_forward';
      await taskAction(ctx, it.task_id, { action, reason: it.reason ?? null, note: it.note ?? null });
      results.push({ task_id: it.task_id, ok: true });
    } catch (e) {
      results.push({ task_id: it.task_id, ok: false, error: (e as Error).message });
    }
  }
  return { results };
}

export async function dayCloseList(ctx: Ctx) {
  return run(ctx, async (c) => {
    const cal = await workCalendar(c, ctx.branchId);
    const day = localToday(ctx, cal.timeZone);
    return q(c, `select id, title, due_at, status, proof_required from os.tasks where owner_id = $1 and status in ('todo','in_progress','blocked','reopened') and due_at < $2 and deleted_at is null and not is_group_parent order by due_at`, [ctx.staffId, fromLocal(addDays(day, 1), 0, cal.timeZone).toISOString()]);
  });
}

// ---------------------------------------------------------------- system sweeps (jobs)
/** Creates a system task once (idempotent by system key). */
export async function systemTask(c: Tx, input: { orgId: string; branchId: string; ownerId: string; title: string; systemKey: string; dueAt?: string | null; categoryKey?: string; linkedType?: string; linkedId?: string; priority?: 'normal' | 'high' | 'urgent'; assignerId?: string | null; description?: string }): Promise<string | null> {
  const owner = await maybe<{ department_id: string | null; wing_id: string | null }>(c, `select department_id, wing_id from core.staff where id = $1`, [input.ownerId]);
  const cat = await maybe<{ id: string }>(c, `select id from os.task_categories where org_id = $1 and key = $2 and deleted_at is null`, [input.orgId, input.categoryKey ?? 'system']);
  const rows = await q<{ id: string; org_id: string; branch_id: string }>(
    c,
    `insert into os.tasks (org_id, branch_id, title, description, category_id, priority, status, source, owner_id, assigner_id, department_id, wing_id, due_at, linked_type, linked_id, system_key)
     values ($1,$2,$3,$4,$5,$6,'todo','system',$7,$8,$9,$10,$11,$12,$13,$14) on conflict (org_id, system_key) where system_key is not null do nothing returning id, org_id, branch_id`,
    [input.orgId, input.branchId, input.title, input.description ?? null, cat?.id ?? null, input.priority ?? 'normal', input.ownerId, input.assignerId ?? null, owner?.department_id ?? null, owner?.wing_id ?? null, input.dueAt ?? null, input.linkedType ?? null, input.linkedId ?? null, input.systemKey],
  );
  const t = rows[0];
  if (!t) return null;
  await event(c, t, null, 'created', null, 'todo', { system: true });
  return t.id;
}

/** Escalation sweep: reminder, due, assigner, assigner's manager (configurable per category). */
export async function escalationSweep(c: Tx, at: Date = now()): Promise<number> {
  const tasks = await q<TaskRow & { esc: EscalationRule | null; assigner_manager: string | null }>(
    c,
    `select t.*, case when er.id is null then null else json_build_object('remindBeforeMinutes', er.remind_before_minutes, 'notifyOwnerAtDue', er.notify_owner_at_due,
        'notifyAssignerAfterWorkingMinutes', er.notify_assigner_after_working_minutes, 'notifyManagerAfterWorkingDays', er.notify_manager_after_working_days, 'urgentFactor', er.urgent_factor) end as esc,
        am.reports_to as assigner_manager
     from os.tasks t left join os.task_categories tc on tc.id = t.category_id left join os.escalation_rules er on er.id = tc.escalation_rule_id
     left join core.staff am on am.id = t.assigner_id
     where t.status in ('todo','in_progress','blocked','reopened') and t.due_at is not null and t.deleted_at is null and not t.is_group_parent
       and t.due_at < $1::timestamptz + interval '1 day' and t.last_escalation_level < 4
       and exists (select 1 from os.module_flags mf where mf.branch_id = t.branch_id and mf.module_key = 'tasks' and mf.enabled)`,
    [at.toISOString()],
  );
  let fired = 0;
  const cals = new Map<string, Awaited<ReturnType<typeof workCalendar>>>();
  for (const t of tasks) {
    if (!cals.has(t.branch_id)) cals.set(t.branch_id, await workCalendar(c, t.branch_id));
    const cal = cals.get(t.branch_id)!;
    const rule = t.esc ? { ...DEFAULT_ESCALATION, ...t.esc, urgentFactor: Number(t.esc.urgentFactor) } : DEFAULT_ESCALATION;
    const step = dueEscalation({ dueAt: new Date(t.due_at!), priority: t.priority, status: t.status, lastEscalationLevel: t.last_escalation_level }, rule, cal, at);
    if (!step) continue;
    const target = step.notify === 'owner' ? t.owner_id : step.notify === 'assigner' ? t.assigner_id : t.assigner_manager ? await delegateOf(c, t.assigner_manager, toLocal(at, cal.timeZone).date) : null;
    await c.query(`update os.tasks set last_escalation_level = $2 where id = $1`, [t.id, step.level]);
    await event(c, t, null, 'escalated', t.status, t.status, { level: step.level, kind: step.kind, notified: target });
    if (target && !(step.notify !== 'owner' && target === t.owner_id && step.level > 2)) {
      await notify(c, {
        orgId: t.org_id,
        branchId: t.branch_id,
        staffIds: [target],
        event: step.level <= 2 ? 'task.reminder' : 'task.escalation',
        titleKey: `notif.task.esc.${step.kind}`,
        vars: { title: t.title },
        link: `/os/tasks/${t.id}`,
        priority: t.priority === 'urgent' ? 'urgent' : 'normal',
        dedupeKey: `esc:${t.id}:${step.level}`,
      });
    }
    fired++;
  }
  return fired;
}

async function delegateOf(c: Tx, staffId: string, date: string) {
  const d = await maybe<{ delegate_id: string }>(c, `select delegate_id from core.delegations where staff_id = $1 and $2::date between starts_on and ends_on and deleted_at is null limit 1`, [staffId, date]);
  return d?.delegate_id ?? staffId;
}

/** Creates today's (and missed recent) occurrences of recurring tasks; skips holidays. */
export async function generateRecurrences(c: Tx, day: string, onlyId?: string): Promise<number> {
  const recs = await q<{ id: string; org_id: string; branch_id: string; template: Record<string, unknown>; target: { staff_ids?: string[]; role_id?: string; group_mode?: string }; frequency: 'daily' | 'weekly' | 'monthly' | 'term' | 'custom'; interval_n: number; weekdays: number[]; month_day: number | null; custom_dates: string[]; due_time: string; starts_on: string; ends_on: string | null; skip_holidays: boolean; assigner_id: string | null }>(
    c,
    `select id, org_id, branch_id, template, target, frequency, interval_n, weekdays, month_day, custom_dates::text[] as custom_dates, due_time::text, starts_on::text, ends_on::text, skip_holidays, assigner_id
     from os.task_recurrences where active and deleted_at is null and ($1::uuid is null or id = $1)`,
    [onlyId ?? null],
  );
  let created = 0;
  for (const r of recs) {
    const cal = await workCalendar(c, r.branch_id);
    const terms = r.frequency === 'term' ? (await q<{ starts_on: string }>(c, `select t.starts_on::text from core.terms t join core.academic_years y on y.id = t.academic_year_id where (y.branch_id = $1 or y.branch_id is null) and y.org_id = $2 and t.starts_on is not null and t.deleted_at is null`, [r.branch_id, r.org_id])).map((t) => t.starts_on) : [];
    const dates = recurrenceDates({ frequency: r.frequency, intervalN: r.interval_n, weekdays: r.weekdays, monthDay: r.month_day, customDates: r.custom_dates ?? [], startsOn: r.starts_on, endsOn: r.ends_on, skipHolidays: r.skip_holidays, termStarts: terms }, day, day, cal);
    for (const d of dates) {
      let owners = r.target.staff_ids ?? [];
      if (r.target.role_id) owners = (await q<{ id: string }>(c, `select s.id from core.staff s join os.staff_roles sr on sr.staff_id = s.id where sr.role_id = $1 and s.branch_id = $2 and s.status = 'active'`, [r.target.role_id, r.branch_id])).map((x) => x.id);
      for (const o of owners) {
        const id = await systemTask(c, { orgId: r.org_id, branchId: r.branch_id, ownerId: o, title: String(r.template.title), description: (r.template.description as string) ?? undefined, systemKey: `rec:${r.id}:${o}:${d}`, dueAt: fromLocal(d, r.due_time.slice(0, 5), cal.timeZone).toISOString(), priority: (r.template.priority as 'normal') ?? 'normal', assignerId: r.assigner_id });
        if (id) {
          await c.query(`update os.tasks set source = 'recurring', recurrence_id = $2, category_id = coalesce($3::uuid, category_id), proof_required = coalesce($4, proof_required), verification_required = coalesce($5, verification_required) where id = $1`, [id, r.id, r.template.category_id ?? null, r.template.proof_required ?? null, r.template.verification_required ?? null]);
          created++;
        }
      }
    }
    await c.query(`update os.task_recurrences set last_generated_on = greatest(coalesce(last_generated_on, $2::date), $2::date) where id = $1`, [r.id, day]);
  }
  return created;
}

/** Day close sweep: next morning, unanswered open tasks due yesterday become "Not done – no response". */
export async function noResponseSweep(c: Tx, branchId: string, yesterday: string, tz: string): Promise<number> {
  const end = fromLocal(addDays(yesterday, 1), 0, tz).toISOString();
  const start = fromLocal(yesterday, 0, tz).toISOString();
  const rows = await q<{ id: string; org_id: string; branch_id: string; status: string }>(
    c,
    `update os.tasks set status = 'not_done', not_done_reason = 'no_response' where branch_id = $1 and status in ('todo','in_progress','blocked','reopened')
       and due_at >= $2 and due_at < $3 and deleted_at is null and not is_group_parent and source <> 'system' returning id, org_id, branch_id, status`,
    [branchId, start, end],
  );
  for (const r of rows) await event(c, r, null, 'not_done', 'open', 'not_done', { reason: 'no_response', system: true });
  return rows.length;
}

/** At the branch's day-close time, ask each person with open tasks due today to close the day. */
export async function dayCloseReminder(c: Tx, branchId: string, day: string, tz: string): Promise<number> {
  const end = fromLocal(addDays(day, 1), 0, tz).toISOString();
  const people = await q<{ owner_id: string; org_id: string; n: number }>(
    c,
    `select owner_id, org_id, count(*)::int as n from os.tasks where branch_id = $1 and status in ('todo','in_progress','blocked','reopened') and due_at < $2 and deleted_at is null and owner_id is not null and not is_group_parent group by 1, 2`,
    [branchId, end],
  );
  for (const p of people) await notify(c, { orgId: p.org_id, branchId, staffIds: [p.owner_id], event: 'task.day_close', titleKey: 'notif.task.dayClose', vars: { count: p.n }, link: '/os/tasks/day-close', dedupeKey: `dayclose:${day}` });
  return people.length;
}

export function overdueFlag(t: { due_at: string | null; status: string }) {
  return isOverdue({ dueAt: t.due_at ? new Date(t.due_at) : null, status: t.status }, now());
}
