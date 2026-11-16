/**
 * Checklists (PRD 5.2) and administrative modules (PRD 7): helpdesk, circulars, calendar,
 * meetings, events, duty roster, incidents, compliance.
 */
import { createHmac } from 'node:crypto';
import {
  itemPassed,
  followUps,
  missingRequired,
  rotateDuties,
  complianceStatus,
  complianceReminderDue,
  readinessPct,
  addDays,
  eachDate,
  isoWeekday,
  isWorkingDay,
  fromLocal,
  toLocal,
  type ChecklistItemDef,
  type ItemValue,
  type RosterStaff,
} from '@autoed/shared';
import { ForbiddenError, NotFoundError, ValidationError, insert, maybe, one, q, update, type Tx } from '../db';
import { branchInfo, need, needModule, rank, run, staffWithRole, workCalendar, localToday, now, type Ctx } from '../core';
import { notify } from '../notify';
import { systemTask } from './tasks';
import { submitApproval, registerApprovalHook } from './approvals';
import { currentVersionId } from './timetable';

// ================================================================ checklists
export async function checklistTemplates(ctx: Ctx) {
  needModule(ctx, 'checklists');
  return run(ctx, async (c) => {
    const tpls = await q<{ id: string }>(c, `select t.*, r.name as owner_role_name, s.full_name as owner_staff_name, rm.name as room_name from public.checklist_templates t left join public.roles r on r.id = t.owner_role_id left join public.staff s on s.id = t.owner_staff_id left join public.rooms rm on rm.id = t.room_id where (t.branch_id = $1 or t.branch_id is null) and t.org_id = $2 and t.deleted_at is null order by t.name`, [ctx.branchId, ctx.orgId]);
    const items = await q<{ template_id: string }>(c, `select * from public.checklist_items where template_id = any($1) and deleted_at is null order by seq`, [tpls.map((t) => t.id)]);
    return tpls.map((t) => ({ ...t, items: items.filter((i) => i.template_id === t.id) }));
  });
}

export async function saveChecklistTemplate(ctx: Ctx, id: string | null, input: { name: string; schedule: Record<string, unknown>; owner_role_id?: string | null; owner_staff_id?: string | null; room_id?: string | null; location_text?: string | null; items: { label: string; label_i18n: Record<string, string>; item_type: string; min_value?: number | null; max_value?: number | null; required: boolean; on_fail?: unknown }[] }) {
  need(ctx, 'checklists', 'configure');
  return run(ctx, async (c) => {
    const row = { org_id: ctx.orgId, branch_id: ctx.branchId, name: input.name, schedule: input.schedule, owner_role_id: input.owner_role_id ?? null, owner_staff_id: input.owner_staff_id ?? null, room_id: input.room_id ?? null, location_text: input.location_text ?? null };
    const t = id ? await update<{ id: string }>(c, 'checklist_templates', id, row) : await insert<{ id: string }>(c, 'checklist_templates', row);
    await c.query(`update public.checklist_items set deleted_at = now() where template_id = $1 and deleted_at is null`, [t.id]);
    let seq = 1;
    for (const it of input.items) await insert(c, 'checklist_items', { org_id: ctx.orgId, branch_id: ctx.branchId, template_id: t.id, seq: seq++, ...it, on_fail: it.on_fail ?? null });
    return { id: t.id };
  });
}

export async function myChecklistRuns(ctx: Ctx, date?: string) {
  needModule(ctx, 'checklists');
  return run(ctx, async (c) => {
    const d = date ?? localToday(ctx);
    return q(c, `select r.id, r.status, r.due_at, r.run_date, t.name, t.name_i18n, rm.name as room_name, t.location_text from public.checklist_runs r join public.checklist_templates t on t.id = r.template_id left join public.rooms rm on rm.id = t.room_id where r.owner_id = $1 and r.run_date between $2::date - 1 and $2 and r.deleted_at is null order by r.due_at`, [ctx.staffId, d]);
  });
}

export async function getRun(ctx: Ctx, runId: string) {
  needModule(ctx, 'checklists');
  return run(ctx, async (c) => {
    const r = await maybe<{ id: string; template_id: string }>(c, `select r.*, t.name, t.name_i18n from public.checklist_runs r join public.checklist_templates t on t.id = r.template_id where r.id = $1`, [runId]);
    if (!r) throw new NotFoundError();
    const items = await q(c, `select * from public.checklist_items where template_id = $1 and deleted_at is null order by seq`, [r.template_id]);
    const responses = await q(c, `select * from public.checklist_responses where run_id = $1`, [runId]);
    return { ...r, items, responses };
  });
}

/** Completes a run (offline-capable); "No" / out-of-range answers auto-create tickets or tasks. */
export async function submitRun(ctx: Ctx, runId: string, input: { answers: { item_id: string; value: ItemValue; photo_path?: string | null; note?: string | null }[]; complete: boolean; client_id?: string }) {
  needModule(ctx, 'checklists');
  return run(ctx, async (c, sys) => {
    const r = await maybe<{ id: string; org_id: string; branch_id: string; template_id: string; owner_id: string; status: string; name: string }>(c, `select r.*, t.name from public.checklist_runs r join public.checklist_templates t on t.id = r.template_id where r.id = $1 for update of r`, [runId]);
    if (!r) throw new NotFoundError();
    if (r.owner_id !== ctx.staffId && rank(ctx, 'checklists', 'edit') < 2) throw new ForbiddenError();
    if (r.status === 'completed') return { status: 'completed', follow_ups: [], duplicate: true };
    const items = await q<{ id: string; item_type: ChecklistItemDef['itemType']; min_value: number | null; max_value: number | null; required: boolean; on_fail: { action: 'ticket'; ticket_category_key: string } | { action: 'task'; role_key: string } | null; label: string }>(c, `select id, item_type, min_value, max_value, required, on_fail, label from public.checklist_items where template_id = $1 and deleted_at is null`, [r.template_id]);
    const defs: ChecklistItemDef[] = items.map((i) => ({ id: i.id, itemType: i.item_type, minValue: i.min_value, maxValue: i.max_value, required: i.required, onFail: i.on_fail ? (i.on_fail.action === 'ticket' ? { action: 'ticket', ticketCategoryKey: i.on_fail.ticket_category_key } : { action: 'task', roleKey: i.on_fail.role_key }) : null }));
    const answers: Record<string, ItemValue> = Object.fromEntries(input.answers.map((a) => [a.item_id, answerValue(a)]));
    if (input.complete) {
      const missing = missingRequired(defs, answers);
      if (missing.length) throw new ValidationError('required_items_missing', { items: missing });
    }
    const responseIds = new Map<string, string>();
    for (const a of input.answers) {
      const def = defs.find((d) => d.id === a.item_id);
      if (!def) continue;
      const passed = itemPassed(def, answers[a.item_id] ?? null);
      const row = await insert<{ id: string }>(c, 'checklist_responses', { org_id: r.org_id, branch_id: r.branch_id, run_id: runId, item_id: a.item_id, value: a.value, passed, photo_path: a.photo_path ?? null, note: a.note ?? null }, { onConflict: '(run_id, item_id) do update set value = excluded.value, passed = excluded.passed, photo_path = excluded.photo_path, note = excluded.note' });
      responseIds.set(a.item_id, row.id);
    }
    const created: { item_id: string; type: string; id: string | null }[] = [];
    if (input.complete) {
      await update(c, 'checklist_runs', runId, { status: 'completed', completed_at: ctx.now.toISOString() });
      for (const f of followUps(defs, answers)) {
        const item = items.find((i) => i.id === f.itemId)!;
        const id = await sys(async () => {
          if (f.action === 'ticket') return autoTicket(c, { orgId: r.org_id, branchId: r.branch_id, categoryKey: f.target, title: `${r.name}: ${item.label}`, raisedBy: ctx.staffId, responseId: responseIds.get(f.itemId) ?? null });
          const owner = (await staffWithRole(c, r.org_id, f.target, r.branch_id))[0];
          if (!owner) return null;
          return systemTask(c, { orgId: r.org_id, branchId: r.branch_id, ownerId: owner, title: `${r.name}: ${item.label}`, systemKey: `chk:${runId}:${f.itemId}`, priority: 'high', linkedType: 'checklist_run', linkedId: runId, categoryKey: 'maintenance' });
        });
        if (id) await sys(() => c.query(`update public.checklist_responses set follow_up_type = $2, follow_up_id = $3 where id = $1`, [responseIds.get(f.itemId), f.action, id]));
        created.push({ item_id: f.itemId, type: f.action, id });
      }
    } else await update(c, 'checklist_runs', runId, { status: 'in_progress' });
    return { status: input.complete ? 'completed' : 'in_progress', follow_ups: created };
  });
}

/** Photo items count as answered when a photo was attached. */
function answerValue(a: { value: ItemValue; photo_path?: string | null }): ItemValue {
  return a.photo_path && (a.value === null || a.value === '') ? a.photo_path : a.value;
}

/** Creates runs for templates scheduled today; missed runs escalate to the owner's manager. */
export async function checklistSweep(c: Tx, branchId: string, at: Date = now()): Promise<{ created: number; missed: number }> {
  const b = await branchInfo(c, branchId);
  const cal = await workCalendar(c, branchId);
  const local = toLocal(at, b.timezone);
  let created = 0;
  if (isWorkingDay(local.date, cal)) {
    const tpls = await q<{ id: string; owner_role_id: string | null; owner_staff_id: string | null; schedule: { frequency: string; time: string; weekdays?: number[]; month_day?: number } }>(c, `select id, owner_role_id, owner_staff_id, schedule from public.checklist_templates where (branch_id = $1 or (branch_id is null and org_id = $2)) and active and deleted_at is null`, [branchId, b.org_id]);
    for (const t of tpls) {
      const s = t.schedule;
      const due =
        s.frequency === 'daily' ||
        (s.frequency === 'weekly' && (s.weekdays?.length ? s.weekdays : [1]).includes(isoWeekday(local.date))) ||
        (s.frequency === 'monthly' && Number(local.date.slice(8)) === (s.month_day ?? 1));
      if (!due) continue;
      let owner = t.owner_staff_id;
      if (!owner && t.owner_role_id) owner = (await maybe<{ id: string }>(c, `select s.id from public.staff s join public.staff_roles sr on sr.staff_id = s.id where sr.role_id = $1 and s.branch_id = $2 and s.status = 'active' order by s.created_at limit 1`, [t.owner_role_id, branchId]))?.id ?? null;
      if (!owner) continue;
      const r = await q(c, `insert into public.checklist_runs (org_id, branch_id, template_id, owner_id, run_date, due_at) values ($1,$2,$3,$4,$5,$6) on conflict (template_id, run_date) do nothing returning id`, [b.org_id, branchId, t.id, owner, local.date, fromLocal(local.date, s.time ?? '09:00', b.timezone).toISOString()]);
      created += r.length;
    }
  }
  // Missed: not completed 2 hours after due.
  const missed = await q<{ id: string; owner_id: string; name: string; reports_to: string | null }>(
    c,
    `update public.checklist_runs r set status = 'missed', escalated_at = now() from public.checklist_templates t, public.staff s
     where t.id = r.template_id and s.id = r.owner_id and r.branch_id = $1 and r.status in ('pending','in_progress') and r.due_at < $2::timestamptz - interval '2 hours'
     returning r.id, r.owner_id, t.name, s.reports_to`,
    [branchId, at.toISOString()],
  );
  for (const m of missed) await notify(c, { orgId: b.org_id, branchId, staffIds: [m.reports_to, m.owner_id], event: 'checklist.missed', titleKey: 'notif.checklist.missed', vars: { name: m.name }, link: '/os/checklists', dedupeKey: `chkmiss:${m.id}` });
  return { created, missed: missed.length };
}

export async function checklistReports(ctx: Ctx, from: string, to: string) {
  need(ctx, 'checklists', 'view', 2);
  return run(ctx, async (c) => ({
    completion: await q(c, `select t.name, count(r.id)::int as runs, count(r.id) filter (where r.status = 'completed')::int as completed, count(r.id) filter (where r.status = 'missed')::int as missed from public.checklist_templates t left join public.checklist_runs r on r.template_id = t.id and r.run_date between $2 and $3 where t.branch_id = $1 and t.deleted_at is null group by t.name order by missed desc, t.name`, [ctx.branchId, from, to]),
    failures: await q(c, `select t.name as checklist, i.label, count(*)::int as failures from public.checklist_responses cr join public.checklist_items i on i.id = cr.item_id join public.checklist_templates t on t.id = i.template_id join public.checklist_runs r on r.id = cr.run_id where r.branch_id = $1 and r.run_date between $2 and $3 and not cr.passed group by 1, 2 order by failures desc limit 50`, [ctx.branchId, from, to]),
    photos: await q(c, `select cr.photo_path, i.label, r.run_date, t.name from public.checklist_responses cr join public.checklist_items i on i.id = cr.item_id join public.checklist_runs r on r.id = cr.run_id join public.checklist_templates t on t.id = r.template_id where r.branch_id = $1 and r.run_date between $2 and $3 and cr.photo_path is not null order by r.run_date desc limit 100`, [ctx.branchId, from, to]),
  }));
}

// ================================================================ helpdesk (7.1)
async function ticketOwner(c: Tx, orgId: string, branchId: string, categoryId: string): Promise<string | null> {
  const cat = await one<{ owner_staff_id: string | null; key: string; owner_role_id: string | null }>(c, `select owner_staff_id, key, owner_role_id from public.ticket_categories where id = $1`, [categoryId]);
  if (cat.owner_staff_id) return cat.owner_staff_id;
  if (cat.owner_role_id) {
    const s = await maybe<{ id: string }>(c, `select s.id from public.staff s join public.staff_roles sr on sr.staff_id = s.id where sr.role_id = $1 and s.branch_id = $2 and s.status = 'active' order by s.created_at limit 1`, [cat.owner_role_id, branchId]);
    if (s) return s.id;
  }
  return (await staffWithRole(c, orgId, 'admin_officer', branchId))[0] ?? null;
}

async function slaDue(c: Tx, categoryId: string, priority: string): Promise<string> {
  const cat = await one<{ sla_hours: Record<string, number> }>(c, `select sla_hours from public.ticket_categories where id = $1`, [categoryId]);
  return new Date(now().getTime() + (cat.sla_hours?.[priority] ?? 48) * 3600000).toISOString();
}

export async function autoTicket(c: Tx, input: { orgId: string; branchId: string; categoryKey: string; title: string; raisedBy: string; responseId: string | null }): Promise<string | null> {
  const cat = await maybe<{ id: string }>(c, `select id from public.ticket_categories where org_id = $1 and key = $2 and deleted_at is null`, [input.orgId, input.categoryKey]);
  if (!cat) return null;
  const owner = await ticketOwner(c, input.orgId, input.branchId, cat.id);
  const t = await insert<{ id: string }>(c, 'tickets', { org_id: input.orgId, branch_id: input.branchId, category_id: cat.id, title: input.title, priority: 'high', status: owner ? 'assigned' : 'open', raised_by: input.raisedBy, owner_id: owner, source: 'checklist', checklist_response_id: input.responseId, due_at: await slaDue(c, cat.id, 'high') });
  await insert(c, 'ticket_events', { org_id: input.orgId, branch_id: input.branchId, ticket_id: t.id, actor_id: null, event: 'created', to_status: owner ? 'assigned' : 'open', note: 'checklist' });
  if (owner) await notify(c, { orgId: input.orgId, branchId: input.branchId, staffIds: [owner], event: 'ticket.update', titleKey: 'notif.ticket.assigned', vars: { title: input.title }, link: `/os/helpdesk/${t.id}`, priority: 'urgent' });
  return t.id;
}

/** Raise a ticket in three taps: category, location, photo or voice note. */
export async function raiseTicket(ctx: Ctx, input: { category_id: string; room_id?: string | null; location_text?: string | null; title?: string; description?: string | null; priority: string; photo_path?: string | null; voice_path?: string | null; source: 'manual' | 'qr' }) {
  needModule(ctx, 'helpdesk');
  return run(ctx, async (c, sys) => {
    const cat = await one<{ name: string; name_i18n: Record<string, string> }>(c, `select name, name_i18n from public.ticket_categories where id = $1`, [input.category_id]);
    const room = input.room_id ? await maybe<{ name: string }>(c, `select name from public.rooms where id = $1`, [input.room_id]) : null;
    const owner = await sys(() => ticketOwner(c, ctx.orgId, ctx.branchId, input.category_id));
    const title = input.title || `${cat.name_i18n?.[ctx.lang] || cat.name}${room ? ` · ${room.name}` : input.location_text ? ` · ${input.location_text}` : ''}`;
    const t = await insert<{ id: string }>(c, 'tickets', { org_id: ctx.orgId, branch_id: ctx.branchId, category_id: input.category_id, room_id: input.room_id ?? null, location_text: input.location_text ?? null, title, description: input.description ?? null, priority: input.priority, status: owner ? 'assigned' : 'open', raised_by: ctx.staffId, owner_id: owner, photo_path: input.photo_path ?? null, voice_path: input.voice_path ?? null, source: input.source, due_at: await sys(() => slaDue(c, input.category_id, input.priority)) });
    await insert(c, 'ticket_events', { org_id: ctx.orgId, branch_id: ctx.branchId, ticket_id: t.id, actor_id: ctx.staffId, event: 'created', to_status: owner ? 'assigned' : 'open' });
    if (owner) await sys(() => notify(c, { orgId: ctx.orgId, branchId: ctx.branchId, staffIds: [owner], event: 'ticket.update', titleKey: 'notif.ticket.assigned', vars: { title }, link: `/os/helpdesk/${t.id}`, priority: input.priority === 'urgent' ? 'urgent' : 'normal' }));
    return { id: t.id, owner_id: owner };
  });
}

export async function ticketAction(ctx: Ctx, id: string, input: { action: 'assign' | 'start' | 'wait' | 'resolve' | 'close' | 'reopen' | 'update_costs'; owner_id?: string; note?: string; vendor?: string; cost?: number; parts?: string }) {
  needModule(ctx, 'helpdesk');
  return run(ctx, async (c, sys) => {
    const t = await maybe<{ id: string; org_id: string; branch_id: string; status: string; owner_id: string | null; raised_by: string; title: string; category_id: string; cost: number | null; approval_request_id: string | null }>(c, `select * from public.tickets where id = $1 for update`, [id]);
    if (!t) throw new NotFoundError();
    const isOwner = t.owner_id === ctx.staffId;
    const isRaiser = t.raised_by === ctx.staffId;
    const manager = rank(ctx, 'helpdesk', 'assign') >= 2 || rank(ctx, 'helpdesk', 'edit') >= 5;
    const next: Record<string, string> = { assign: 'assigned', start: 'in_progress', wait: 'waiting', resolve: 'resolved', close: 'closed', reopen: 'reopened', update_costs: t.status };
    const allowed: Record<string, boolean> = { assign: manager, start: isOwner, wait: isOwner, resolve: isOwner || manager, close: isRaiser, reopen: isRaiser && ['resolved', 'closed'].includes(t.status), update_costs: isOwner || manager };
    if (!allowed[input.action]) throw new ForbiddenError();
    const patch: Record<string, unknown> = { status: next[input.action] };
    if (input.action === 'assign') {
      if (!input.owner_id) throw new ValidationError('owner_required');
      patch.owner_id = input.owner_id;
    }
    if (input.action === 'resolve') patch.resolved_at = ctx.now.toISOString();
    if (input.action === 'close') patch.closed_at = ctx.now.toISOString();
    if (input.action === 'update_costs') Object.assign(patch, { vendor: input.vendor ?? null, cost: input.cost ?? null, parts: input.parts ?? null });
    await sys(() => update(c, 'tickets', id, patch));
    await sys(() => insert(c, 'ticket_events', { org_id: t.org_id, branch_id: t.branch_id, ticket_id: id, actor_id: ctx.staffId, event: input.action, from_status: t.status, to_status: patch.status as string, note: input.note ?? null }));
    // A cost above the category limit starts a purchase approval.
    if (input.action === 'update_costs' && input.cost != null && !t.approval_request_id) {
      const cat = await one<{ cost_approval_limit: number }>(c, `select cost_approval_limit from public.ticket_categories where id = $1`, [t.category_id]);
      if (input.cost > Number(cat.cost_approval_limit)) {
        const req = await sys(() => submitApproval(c, { orgId: t.org_id, branchId: t.branch_id, applicantId: ctx.staffId, typeKey: 'ticket_cost', title: `${t.title} · ₹${input.cost}`, data: { amount: input.cost, ticket_id: id, vendor: input.vendor ?? '' }, linkedType: 'ticket', linkedId: id, actorName: ctx.staff.full_name }));
        await sys(() => c.query(`update public.tickets set approval_request_id = $2, status = 'waiting' where id = $1`, [id, req.id]));
      }
    }
    const notifyIds = input.action === 'assign' ? [input.owner_id] : input.action === 'resolve' ? [t.raised_by] : input.action === 'reopen' ? [t.owner_id] : [];
    if (notifyIds.length) await sys(() => notify(c, { orgId: t.org_id, branchId: t.branch_id, staffIds: notifyIds, event: 'ticket.update', titleKey: `notif.ticket.${input.action}`, vars: { title: t.title }, link: `/os/helpdesk/${id}` }));
    return { status: patch.status };
  });
}

registerApprovalHook('ticket_cost', async (c, req, decision) => {
  const tid = (req.data as { ticket_id: string }).ticket_id;
  await c.query(`update public.tickets set status = $2 where id = $1 and status = 'waiting'`, [tid, decision === 'approved' ? 'in_progress' : 'waiting']);
  await insert(c, 'ticket_events', { org_id: req.org_id, branch_id: req.branch_id, ticket_id: tid, actor_id: null, event: `cost_${decision}`, note: req.title });
});

export async function listTickets(ctx: Ctx, view: 'mine' | 'assigned' | 'all', status?: string) {
  needModule(ctx, 'helpdesk');
  return run(ctx, async (c) =>
    q(
      c,
      `select t.id, t.title, t.status, t.priority, t.due_at, t.created_at, t.cost, tc.name as category, tc.name_i18n, r.name as room_name, o.full_name as owner_name, rb.full_name as raised_by_name,
         (t.due_at < now() and t.status not in ('resolved','closed')) as breached
       from public.tickets t join public.ticket_categories tc on tc.id = t.category_id left join public.rooms r on r.id = t.room_id left join public.staff o on o.id = t.owner_id left join public.staff rb on rb.id = t.raised_by
       where t.deleted_at is null and ${view === 'mine' ? 't.raised_by = $1' : view === 'assigned' ? 't.owner_id = $1' : 't.branch_id = $2'} and ($3::text is null or t.status = $3)
       order by (t.status in ('resolved','closed')), t.due_at nulls last limit 300`,
      [ctx.staffId, ctx.branchId, status ?? null],
    ),
  );
}

export async function getTicket(ctx: Ctx, id: string) {
  return run(ctx, async (c) => {
    const t = await maybe(c, `select t.*, tc.name as category, r.name as room_name, o.full_name as owner_name, rb.full_name as raised_by_name from public.tickets t join public.ticket_categories tc on tc.id = t.category_id left join public.rooms r on r.id = t.room_id left join public.staff o on o.id = t.owner_id left join public.staff rb on rb.id = t.raised_by where t.id = $1`, [id]);
    if (!t) throw new NotFoundError();
    const events = await q(c, `select e.*, s.full_name as actor_name from public.ticket_events e left join public.staff s on s.id = e.actor_id where e.ticket_id = $1 order by e.created_at`, [id]);
    return { ...t, events };
  });
}

/** QR per room opens the ticket form with the location filled in. */
export async function roomByQr(ctx: Ctx, token: string) {
  return run(ctx, async (c) => {
    const r = await maybe(c, `select id, name, branch_id from public.rooms where qr_token = $1 and org_id = $2`, [token, ctx.orgId]);
    if (!r) throw new NotFoundError();
    return r;
  });
}

export async function helpdeskReports(ctx: Ctx, from: string, to: string) {
  need(ctx, 'helpdesk', 'view', 5);
  return run(ctx, async (c) => ({
    by_category: await q(c, `select tc.name, count(*)::int as tickets, round(avg(extract(epoch from (coalesce(t.resolved_at, now()) - t.created_at)) / 3600)::numeric, 1) as avg_hours, count(*) filter (where t.due_at < coalesce(t.resolved_at, now()))::int as breaches, coalesce(sum(t.cost), 0) as cost from public.tickets t join public.ticket_categories tc on tc.id = t.category_id where t.branch_id = $1 and t.created_at::date between $2 and $3 group by tc.name order by tickets desc`, [ctx.branchId, from, to]),
    by_location: await q(c, `select coalesce(r.name, t.location_text, '—') as location, count(*)::int as tickets from public.tickets t left join public.rooms r on r.id = t.room_id where t.branch_id = $1 and t.created_at::date between $2 and $3 group by 1 order by tickets desc limit 30`, [ctx.branchId, from, to]),
    repeats: await q(c, `select coalesce(r.name, t.asset_tag, t.location_text) as place, tc.name as category, count(*)::int as times from public.tickets t join public.ticket_categories tc on tc.id = t.category_id left join public.rooms r on r.id = t.room_id where t.branch_id = $1 and t.created_at::date between $2 and $3 group by 1, 2 having count(*) > 1 order by times desc`, [ctx.branchId, from, to]),
  }));
}

// ================================================================ circulars (7.2)
async function circularRecipients(c: Tx, orgId: string, target: { branch_ids: string[]; wing_ids: string[]; department_ids: string[]; role_ids: string[]; staff_ids: string[] }, defaultBranch: string | null): Promise<string[]> {
  const rows = await q<{ id: string }>(
    c,
    `select distinct s.id from public.staff s where s.org_id = $1 and s.status = 'active' and s.deleted_at is null and (
       s.id = any($6)
       or ((cardinality($2::uuid[]) = 0 or s.branch_id = any($2) or ($7::uuid is not null and cardinality($2::uuid[]) = 0 and s.branch_id = $7))
         and (cardinality($3::uuid[]) = 0 or s.wing_id = any($3))
         and (cardinality($4::uuid[]) = 0 or s.department_id = any($4))
         and (cardinality($5::uuid[]) = 0 or exists (select 1 from public.staff_roles sr where sr.staff_id = s.id and sr.role_id = any($5)))
         and (cardinality($2::uuid[]) + cardinality($3::uuid[]) + cardinality($4::uuid[]) + cardinality($5::uuid[]) > 0 or (cardinality($6::uuid[]) = 0 and s.branch_id = $7))))`,
    [orgId, target.branch_ids, target.wing_ids, target.department_ids, target.role_ids, target.staff_ids, defaultBranch],
  );
  return rows.map((r) => r.id);
}

export async function createCircular(ctx: Ctx, input: { title: string; body: string; attachments: { path: string; name: string }[]; target: { branch_ids: string[]; wing_ids: string[]; department_ids: string[]; role_ids: string[]; staff_ids: string[] }; response_mode: string; reply_form?: unknown; important: boolean; tags: string[]; scheduled_at?: string | null; reminder_after_hours: number }) {
  need(ctx, 'circulars', 'create');
  if (input.target.branch_ids.some((b) => !ctx.branchIds.includes(b))) throw new ForbiddenError('branch_not_allowed');
  return run(ctx, async (c, sys) => {
    const scheduled = input.scheduled_at && new Date(input.scheduled_at) > ctx.now;
    const circ = await insert<{ id: string }>(c, 'circulars', { org_id: ctx.orgId, branch_id: input.target.branch_ids.length === 1 ? input.target.branch_ids[0] : ctx.branchId, author_id: ctx.staffId, title: input.title, body: input.body, attachments: input.attachments, target: input.target, response_mode: input.response_mode, reply_form: input.reply_form ?? null, important: input.important, tags: input.tags, scheduled_at: input.scheduled_at ?? null, reminder_after_hours: input.reminder_after_hours, status: scheduled ? 'scheduled' : 'draft' });
    if (!scheduled) await sys(() => sendCircular(c, circ.id));
    return { id: circ.id, status: scheduled ? 'scheduled' : 'sent' };
  });
}

export async function sendCircular(c: Tx, id: string): Promise<number> {
  const circ = await one<{ id: string; org_id: string; branch_id: string; title: string; target: Parameters<typeof circularRecipients>[2]; important: boolean; status: string }>(c, `select * from public.circulars where id = $1`, [id]);
  if (circ.status === 'sent') return 0;
  const ids = await circularRecipients(c, circ.org_id, circ.target, circ.branch_id);
  for (const s of ids) await c.query(`insert into public.circular_receipts (org_id, branch_id, circular_id, staff_id) values ($1,$2,$3,$4) on conflict do nothing`, [circ.org_id, circ.branch_id, id, s]);
  await c.query(`update public.circulars set status = 'sent', sent_at = now() where id = $1`, [id]);
  // Important circulars also go by WhatsApp with a link.
  await notify(c, { orgId: circ.org_id, branchId: circ.branch_id, staffIds: ids, event: circ.important ? 'circular.important' : 'circular.new', titleKey: 'notif.circular.new', vars: { title: circ.title }, link: `/os/circulars/${id}` });
  return ids.length;
}

export async function respondCircular(ctx: Ctx, id: string, input: { action: 'read' | 'acknowledge' | 'reply'; reply?: { choice: string; comment?: string } }) {
  return run(ctx, async (c) => {
    const r = await maybe<{ id: string; read_at: string | null }>(c, `select id, read_at from public.circular_receipts where circular_id = $1 and staff_id = $2`, [id, ctx.staffId]);
    if (!r) throw new NotFoundError();
    const patch: Record<string, unknown> = { read_at: r.read_at ?? ctx.now.toISOString() };
    if (input.action === 'acknowledge') patch.acknowledged_at = ctx.now.toISOString();
    if (input.action === 'reply') {
      if (!input.reply) throw new ValidationError('reply_required');
      patch.reply = input.reply;
      patch.acknowledged_at = ctx.now.toISOString();
    }
    await update(c, 'circular_receipts', r.id, patch);
    return { ok: true };
  });
}

export async function listCirculars(ctx: Ctx, opts: { q?: string; tag?: string; from?: string; to?: string }) {
  needModule(ctx, 'circulars');
  return run(ctx, async (c) =>
    q(
      c,
      `select ci.id, ci.title, ci.important, ci.tags, ci.sent_at, ci.status, ci.response_mode, ci.author_id, s.full_name as author_name, r.read_at, r.acknowledged_at,
         (select count(*)::int from public.circular_receipts x where x.circular_id = ci.id) as recipients,
         (select count(*)::int from public.circular_receipts x where x.circular_id = ci.id and x.read_at is not null) as read_count
       from public.circulars ci left join public.staff s on s.id = ci.author_id left join public.circular_receipts r on r.circular_id = ci.id and r.staff_id = $1
       where ci.deleted_at is null and ($2::text is null or ci.title ilike '%' || $2 || '%' or ci.body ilike '%' || $2 || '%') and ($3::text is null or $3 = any(ci.tags))
         and ($4::date is null or ci.created_at::date >= $4) and ($5::date is null or ci.created_at::date <= $5)
       order by coalesce(ci.sent_at, ci.created_at) desc limit 200`,
      [ctx.staffId, opts.q ?? null, opts.tag ?? null, opts.from ?? null, opts.to ?? null],
    ),
  );
}

export async function getCircular(ctx: Ctx, id: string) {
  return run(ctx, async (c) => {
    const ci = await maybe<{ author_id: string }>(c, `select ci.*, s.full_name as author_name from public.circulars ci left join public.staff s on s.id = ci.author_id where ci.id = $1`, [id]);
    if (!ci) throw new NotFoundError();
    const mine = await maybe(c, `select * from public.circular_receipts where circular_id = $1 and staff_id = $2`, [id, ctx.staffId]);
    const canSeeReceipts = ci.author_id === ctx.staffId || rank(ctx, 'circulars', 'view') >= 3;
    const receipts = canSeeReceipts ? await q(c, `select r.staff_id, s.full_name, r.read_at, r.acknowledged_at, r.reply from public.circular_receipts r join public.staff s on s.id = r.staff_id where r.circular_id = $1 order by r.read_at nulls first, s.full_name`, [id]) : [];
    return { ...ci, mine, receipts };
  });
}

/** Sends scheduled circulars and reminds non-readers after the set time. */
export async function circularSweep(c: Tx, at: Date = now()): Promise<number> {
  const due = await q<{ id: string }>(c, `select id from public.circulars where status = 'scheduled' and scheduled_at <= $1 and deleted_at is null`, [at.toISOString()]);
  for (const d of due) await sendCircular(c, d.id);
  const pending = await q<{ id: string; circular_id: string; staff_id: string; org_id: string; branch_id: string; title: string }>(
    c,
    `select r.id, r.circular_id, r.staff_id, r.org_id, r.branch_id, ci.title from public.circular_receipts r join public.circulars ci on ci.id = r.circular_id
     where ci.status = 'sent' and r.reminded_at is null and ((ci.response_mode = 'read' and r.read_at is null) or (ci.response_mode <> 'read' and r.acknowledged_at is null))
       and ci.sent_at + (ci.reminder_after_hours || ' hours')::interval < $1`,
    [at.toISOString()],
  );
  for (const p of pending) {
    await notify(c, { orgId: p.org_id, branchId: p.branch_id, staffIds: [p.staff_id], event: 'circular.new', titleKey: 'notif.circular.reminder', vars: { title: p.title }, link: `/os/circulars/${p.circular_id}` });
    await c.query(`update public.circular_receipts set reminded_at = now() where id = $1`, [p.id]);
  }
  return due.length + pending.length;
}

// ================================================================ calendar (7.3)
export async function calendarEvents(ctx: Ctx, from: string, to: string, layers?: string[]) {
  needModule(ctx, 'calendar');
  return run(ctx, async (c) => q(c, `select * from public.calendar_events where org_id = $1 and (branch_id is null or branch_id = $2) and ends_on >= $3 and starts_on <= $4 and deleted_at is null and ($5::text[] is null or layer = any($5)) order by starts_on`, [ctx.orgId, ctx.branchId, from, to, layers?.length ? layers : null]));
}

export async function saveCalendarEvent(ctx: Ctx, id: string | null, input: { layer: string; title: string; starts_on: string; ends_on: string; starts_at?: string | null; ends_at?: string | null; group_level: boolean }) {
  need(ctx, 'calendar', 'create', input.group_level ? 6 : 5);
  if (input.ends_on < input.starts_on) throw new ValidationError('end_before_start');
  return run(ctx, async (c) => {
    const row = { org_id: ctx.orgId, branch_id: input.group_level ? null : ctx.branchId, layer: input.layer, title: input.title, starts_on: input.starts_on, ends_on: input.ends_on, starts_at: input.starts_at ?? null, ends_at: input.ends_at ?? null, is_working_day: input.layer !== 'holiday' };
    return id ? update(c, 'calendar_events', id, row) : insert(c, 'calendar_events', row);
  });
}

/** Subscription link for phone calendars: signed per staff member, read-only. */
export function calendarToken(staffId: string): string {
  const sig = createHmac('sha256', process.env.AUTH_JWT_SECRET ?? 'dev-secret').update(`ics:${staffId}`).digest('hex').slice(0, 32);
  return `${staffId}.${sig}`;
}

export async function icsFeed(token: string): Promise<string> {
  const [staffId, sig] = token.split('.');
  if (!staffId || calendarToken(staffId) !== token || !sig) throw new ForbiddenError();
  const { asService } = await import('../db');
  return asService(async (c) => {
    const s = await one<{ org_id: string; branch_id: string | null }>(c, `select org_id, branch_id from public.staff where id = $1`, [staffId]);
    const ev = await q<{ id: string; title: string; starts_on: string; ends_on: string; layer: string }>(c, `select id, title, starts_on::text, ends_on::text, layer from public.calendar_events where org_id = $1 and (branch_id is null or branch_id = $2) and deleted_at is null and ends_on >= current_date - 30`, [s.org_id, s.branch_id]);
    const d = (x: string) => x.replace(/-/g, '');
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//AutoEd OS//Calendar//EN', 'CALSCALE:GREGORIAN'];
    for (const e of ev) lines.push('BEGIN:VEVENT', `UID:${e.id}@autoed-os`, `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`, `DTSTART;VALUE=DATE:${d(e.starts_on)}`, `DTEND;VALUE=DATE:${d(addDays(e.ends_on, 1))}`, `SUMMARY:${e.title.replace(/[,;]/g, ' ')}`, `CATEGORIES:${e.layer}`, 'END:VEVENT');
    lines.push('END:VCALENDAR');
    return lines.join('\r\n');
  });
}

// ================================================================ meetings (7.4)
export async function createMeeting(ctx: Ctx, input: { title: string; agenda?: string; starts_at: string; ends_at: string; room_id?: string | null; attendee_ids: string[]; recurrence?: { frequency: 'weekly' | 'monthly'; count: number } | null }) {
  need(ctx, 'meetings', 'create');
  return run(ctx, async (c, sys) => {
    const series = input.recurrence ? crypto.randomUUID() : null;
    const n = input.recurrence?.count ?? 1;
    const ids: string[] = [];
    let prev: string | null = null;
    for (let i = 0; i < n; i++) {
      const shift = (d: string) => {
        const x = new Date(d);
        if (input.recurrence?.frequency === 'monthly') x.setMonth(x.getMonth() + i);
        else x.setDate(x.getDate() + 7 * i);
        return x.toISOString();
      };
      const m: { id: string } = await insert<{ id: string }>(c, 'meetings', { org_id: ctx.orgId, branch_id: ctx.branchId, series_id: series, previous_meeting_id: prev, title: input.title, agenda: input.agenda ?? null, starts_at: shift(input.starts_at), ends_at: shift(input.ends_at), room_id: input.room_id ?? null, organizer_id: ctx.staffId, attendee_ids: input.attendee_ids, recurrence: input.recurrence ?? null });
      ids.push(m.id);
      prev = m.id;
    }
    await sys(() => notify(c, { orgId: ctx.orgId, branchId: ctx.branchId, staffIds: input.attendee_ids, event: 'meeting.scheduled', titleKey: 'notif.meeting.scheduled', vars: { title: input.title }, link: `/os/meetings/${ids[0]}` }));
    return { ids };
  });
}

/** The next meeting in the series opens with the status of the previous action items. */
export async function getMeeting(ctx: Ctx, id: string) {
  needModule(ctx, 'meetings');
  return run(ctx, async (c) => {
    const m = await maybe<{ previous_meeting_id: string | null; attendee_ids: string[] }>(c, `select m.*, r.name as room_name, o.full_name as organizer_name from public.meetings m left join public.rooms r on r.id = m.room_id left join public.staff o on o.id = m.organizer_id where m.id = $1`, [id]);
    if (!m) throw new NotFoundError();
    const actions = await q(c, `select a.*, s.full_name as owner_name, t.status as task_status from public.meeting_actions a left join public.staff s on s.id = a.owner_id left join public.tasks t on t.id = a.task_id where a.meeting_id = $1 order by a.created_at`, [id]);
    const previousActions = m.previous_meeting_id ? await q(c, `select a.*, s.full_name as owner_name, t.status as task_status from public.meeting_actions a left join public.staff s on s.id = a.owner_id left join public.tasks t on t.id = a.task_id where a.meeting_id = $1 order by a.created_at`, [m.previous_meeting_id]) : [];
    const attendees = await q(c, `select id, full_name from public.staff where id = any($1) order by full_name`, [m.attendee_ids]);
    return { ...m, actions, previous_actions: previousActions, attendees };
  });
}

/** Minutes typed or dictated during the meeting; each action item becomes a linked task. */
export async function saveMinutes(ctx: Ctx, id: string, input: { minutes: string; attendance: Record<string, boolean>; actions: { description: string; owner_id: string; due_on: string }[]; close: boolean }) {
  needModule(ctx, 'meetings');
  return run(ctx, async (c, sys) => {
    const m = await maybe<{ id: string; organizer_id: string; branch_id: string; org_id: string; title: string }>(c, `select * from public.meetings where id = $1`, [id]);
    if (!m) throw new NotFoundError();
    if (m.organizer_id !== ctx.staffId && rank(ctx, 'meetings', 'edit') < 5) throw new ForbiddenError();
    await update(c, 'meetings', id, { minutes: input.minutes, attendance: input.attendance, status: input.close ? 'held' : 'scheduled' });
    const cal = await workCalendar(c, m.branch_id);
    for (const a of input.actions) {
      const taskId = await sys(() => systemTask(c, { orgId: m.org_id, branchId: m.branch_id, ownerId: a.owner_id, assignerId: ctx.staffId, title: a.description, systemKey: `mtg:${id}:${a.owner_id}:${a.description.slice(0, 40)}`, dueAt: fromLocal(a.due_on, '17:00', cal.timeZone).toISOString(), linkedType: 'meeting', linkedId: id, categoryKey: 'admin' }));
      await insert(c, 'meeting_actions', { org_id: m.org_id, branch_id: m.branch_id, meeting_id: id, description: a.description, owner_id: a.owner_id, due_on: a.due_on, task_id: taskId });
      if (taskId) await sys(() => notify(c, { orgId: m.org_id, branchId: m.branch_id, staffIds: [a.owner_id], event: 'task.assigned', titleKey: 'notif.task.assigned', vars: { title: a.description, from: ctx.staff.full_name }, link: `/os/tasks/${taskId}` }));
    }
    return { ok: true };
  });
}

export async function listMeetings(ctx: Ctx) {
  needModule(ctx, 'meetings');
  return run(ctx, async (c) => q(c, `select m.id, m.title, m.starts_at, m.ends_at, m.status, m.series_id, r.name as room_name, cardinality(m.attendee_ids) as attendees from public.meetings m left join public.rooms r on r.id = m.room_id where m.branch_id = $1 and m.deleted_at is null and ($2 = any(m.attendee_ids) or m.organizer_id = $2 or $3) order by m.starts_at desc limit 200`, [ctx.branchId, ctx.staffId, rank(ctx, 'meetings', 'view') >= 5]));
}

// ================================================================ events (7.5)
export async function createEvent(ctx: Ctx, input: { template_id?: string | null; name: string; event_date: string; owner_id?: string | null; budget: { line: string; amount: number }[] }) {
  need(ctx, 'events', 'create');
  return run(ctx, async (c, sys) => {
    const tpl = input.template_id ? await maybe<{ task_pack: { title: string; role_key: string; days_before: number; priority: string }[]; committees: string[]; budget_lines: { line: string; amount: number }[] }>(c, `select task_pack, committees, budget_lines from public.event_templates where id = $1`, [input.template_id]) : null;
    const budget = (input.budget.length ? input.budget : tpl?.budget_lines ?? []).map((b) => ({ ...b, approved: false }));
    const ev = await insert<{ id: string }>(c, 'events', { org_id: ctx.orgId, branch_id: ctx.branchId, template_id: input.template_id ?? null, name: input.name, event_date: input.event_date, owner_id: input.owner_id ?? ctx.staffId, committees: (tpl?.committees ?? []).map((n) => ({ name: n, members: [] })), budget });
    await insert(c, 'calendar_events', { org_id: ctx.orgId, branch_id: ctx.branchId, layer: 'event', title: input.name, starts_on: input.event_date, ends_on: input.event_date, linked_type: 'event', linked_id: ev.id });
    // Creating an event from a template creates all tasks with owners by role and dates counted back.
    const cal = await workCalendar(c, ctx.branchId);
    let tasks = 0;
    await sys(async () => {
      for (const [i, tp] of (tpl?.task_pack ?? []).entries()) {
        const owner = (await staffWithRole(c, ctx.orgId, tp.role_key, ctx.branchId))[0] ?? input.owner_id ?? ctx.staffId;
        let due = addDays(input.event_date, -tp.days_before);
        while (!isWorkingDay(due, cal) && due > localToday(ctx)) due = addDays(due, -1);
        const id = await systemTask(c, { orgId: ctx.orgId, branchId: ctx.branchId, ownerId: owner, assignerId: ctx.staffId, title: `${input.name}: ${tp.title}`, systemKey: `evt:${ev.id}:${i}`, dueAt: fromLocal(due, '16:00', cal.timeZone).toISOString(), linkedType: 'event', linkedId: ev.id, categoryKey: 'event', priority: tp.priority === 'high' ? 'high' : 'normal' });
        if (id) tasks++;
      }
      const total = budget.reduce((s, b) => s + b.amount, 0);
      if (total > 0) {
        const req = await submitApproval(c, { orgId: ctx.orgId, branchId: ctx.branchId, applicantId: ctx.staffId, typeKey: 'event_budget', title: `${input.name} budget · ₹${total}`, data: { amount: total, event_id: ev.id }, linkedType: 'event', linkedId: ev.id, actorName: ctx.staff.full_name });
        await c.query(`update public.events set budget_approval_request_id = $2 where id = $1`, [ev.id, req.id]);
      }
    });
    return { id: ev.id, tasks };
  });
}

registerApprovalHook('event_budget', async (c, req, decision) => {
  if (decision !== 'approved') return;
  const id = (req.data as { event_id: string }).event_id;
  const ev = await one<{ budget: { line: string; amount: number; approved: boolean }[] }>(c, `select budget from public.events where id = $1`, [id]);
  await c.query(`update public.events set budget = $2 where id = $1`, [id, JSON.stringify(ev.budget.map((b) => ({ ...b, approved: true })))]);
});

/** Event dashboard: readiness = share of the event's tasks completed. */
export async function eventDetail(ctx: Ctx, id: string) {
  needModule(ctx, 'events');
  return run(ctx, async (c) => {
    const ev = await maybe(c, `select e.*, o.full_name as owner_name, t.name as template_name from public.events e left join public.staff o on o.id = e.owner_id left join public.event_templates t on t.id = e.template_id where e.id = $1`, [id]);
    if (!ev) throw new NotFoundError();
    const tasks = await q<{ status: string }>(c, `select t.id, t.title, t.status, t.due_at, s.full_name as owner_name from public.tasks t left join public.staff s on s.id = t.owner_id where t.linked_type = 'event' and t.linked_id = $1 and t.deleted_at is null order by t.due_at`, [id]);
    const active = tasks.filter((t) => t.status !== 'cancelled');
    const readiness = active.length ? Math.round((active.filter((t) => ['done', 'verified'].includes(t.status)).length / active.length) * 100) : 0;
    return { ...ev, tasks, readiness };
  });
}

export async function listEvents(ctx: Ctx) {
  needModule(ctx, 'events');
  return run(ctx, async (c) => q(c, `select e.id, e.name, e.event_date, e.status, (select count(*) filter (where t.status in ('done','verified'))::float / nullif(count(*) filter (where t.status <> 'cancelled'), 0) from public.tasks t where t.linked_type = 'event' and t.linked_id = e.id) as readiness from public.events e where e.branch_id = $1 and e.deleted_at is null order by e.event_date desc`, [ctx.branchId]));
}

/** After the event: a short review form, saved for next year. */
export async function reviewEvent(ctx: Ctx, id: string, review: { went_well: string; improve: string; attendance?: number }) {
  need(ctx, 'events', 'edit');
  return run(ctx, async (c) => update(c, 'events', id, { review: { ...review, by: ctx.staff.full_name, at: ctx.now.toISOString() }, status: 'reviewed' }));
}

// ================================================================ duty roster (7.6)
/** Automatic rotation that respects the timetable and spreads duties fairly. */
export async function generateDuties(ctx: Ctx, from: string, to: string) {
  need(ctx, 'duty_roster', 'assign');
  return run(ctx, async (c) => {
    const cal = await workCalendar(c, ctx.branchId, from, to);
    const types = await q<{ id: string; key: string; staff_needed: number; days: number[]; overlaps_period_seq: number | null }>(c, `select id, key, staff_needed, days, overlaps_period_seq from public.duty_types where org_id = $1 and deleted_at is null and staff_needed > 0`, [ctx.orgId]);
    const staff = await q<{ id: string; full_name: string; load: number }>(c, `select s.id, s.full_name, (select count(*)::int from public.duty_assignments d where d.staff_id = s.id and d.date >= $2::date - 30) as load from public.staff s where s.branch_id = $1 and s.status = 'active' and s.deleted_at is null and s.is_teaching`, [ctx.branchId, from]);
    const vid = await currentVersionId(c, ctx.branchId, from);
    const busyRows = vid ? await q<{ staff_id: string; day: number; period_seq: number }>(c, `select staff_id, day, period_seq from public.timetable_entries where version_id = $1 and staff_id is not null`, [vid]) : [];
    const leave = await q<{ staff_id: string; start_date: string; end_date: string }>(c, `select staff_id, start_date::text, end_date::text from public.leave_requests where branch_id = $1 and status = 'approved' and end_date >= $2 and start_date <= $3`, [ctx.branchId, from, to]);
    const dates = eachDate(from, to).filter((d) => isWorkingDay(d, cal));
    const roster: RosterStaff[] = staff.map((s) => {
      const busy = new Set<string>();
      for (const d of dates) {
        for (const b of busyRows.filter((x) => x.staff_id === s.id && x.day === isoWeekday(d))) busy.add(`${d}|${b.period_seq}`);
        if (leave.some((l) => l.staff_id === s.id && d >= l.start_date && d <= l.end_date)) busy.add(d);
      }
      return { id: s.id, name: s.full_name, busy, load: s.load };
    });
    const existing = new Set((await q<{ k: string }>(c, `select duty_type_id || '|' || date::text as k from public.duty_assignments where branch_id = $1 and date between $2 and $3 and manual`, [ctx.branchId, from, to])).map((r) => r.k));
    await c.query(`delete from public.duty_assignments where branch_id = $1 and date between $2 and $3 and not manual and status = 'assigned'`, [ctx.branchId, from, to]);
    const slots = types.flatMap((t) => dates.filter((d) => t.days.includes(isoWeekday(d)) && !existing.has(`${t.id}|${d}`)).map((d) => ({ key: `${t.id}|${d}`, dutyTypeId: t.id, date: d, busyKey: t.overlaps_period_seq ? `${d}|${t.overlaps_period_seq}` : `${d}|none`, needed: t.staff_needed })));
    const res = rotateDuties(slots, roster, 2);
    for (const a of res.assignments) {
      const [typeId, date] = a.slotKey.split('|');
      await c.query(`insert into public.duty_assignments (org_id, branch_id, duty_type_id, staff_id, date) values ($1,$2,$3,$4,$5) on conflict do nothing`, [ctx.orgId, ctx.branchId, typeId, a.staffId, date]);
    }
    return { assigned: res.assignments.length, unfilled: res.unfilled };
  });
}

export async function roster(ctx: Ctx, from: string, to: string) {
  needModule(ctx, 'duty_roster');
  return run(ctx, async (c) => q(c, `select da.id, da.date, da.status, da.manual, da.staff_id, s.full_name, dt.name, dt.name_i18n, dt.starts_at, dt.ends_at, dt.id as duty_type_id from public.duty_assignments da join public.staff s on s.id = da.staff_id join public.duty_types dt on dt.id = da.duty_type_id where da.branch_id = $1 and da.date between $2 and $3 and da.deleted_at is null order by da.date, dt.starts_at`, [ctx.branchId, from, to]));
}

export async function overrideDuty(ctx: Ctx, id: string, staffId: string) {
  need(ctx, 'duty_roster', 'edit');
  return run(ctx, async (c) => update(c, 'duty_assignments', id, { staff_id: staffId, manual: true }));
}

export async function requestDutySwap(ctx: Ctx, assignmentId: string, swapWithId: string) {
  needModule(ctx, 'duty_roster');
  return run(ctx, async (c, sys) => {
    const d = await maybe<{ staff_id: string; branch_id: string; date: string }>(c, `select staff_id, branch_id, date::text from public.duty_assignments where id = $1`, [assignmentId]);
    if (!d || d.staff_id !== ctx.staffId) throw new ForbiddenError();
    const req = await sys(() => submitApproval(c, { orgId: ctx.orgId, branchId: d.branch_id, applicantId: ctx.staffId, typeKey: 'duty_swap', title: `${ctx.t('duty.swap')} · ${d.date}`, data: { assignment_id: assignmentId, swap_with: swapWithId }, linkedType: 'duty_assignment', linkedId: assignmentId, actorName: ctx.staff.full_name }));
    await sys(() => c.query(`update public.duty_assignments set swap_with_id = $2, swap_approval_request_id = $3 where id = $1`, [assignmentId, swapWithId, req.id]));
    return { approval_id: req.id };
  });
}

registerApprovalHook('duty_swap', async (c, req, decision) => {
  const d = req.data as { assignment_id: string; swap_with: string };
  if (decision === 'approved') await c.query(`update public.duty_assignments set staff_id = $2, status = 'assigned', manual = true where id = $1`, [d.assignment_id, d.swap_with]);
});

/** Duty reminders before start; missed duties are recorded at day end. */
export async function dutySweep(c: Tx, branchId: string, at: Date = now()): Promise<number> {
  const b = await branchInfo(c, branchId);
  const local = toLocal(at, b.timezone);
  const soon = await q<{ id: string; staff_id: string; name: string; starts_at: string }>(
    c,
    `select da.id, da.staff_id, dt.name, dt.starts_at::text from public.duty_assignments da join public.duty_types dt on dt.id = da.duty_type_id where da.branch_id = $1 and da.date = $2 and da.status = 'assigned' and da.reminded_at is null`,
    [branchId, local.date],
  );
  let n = 0;
  for (const d of soon) {
    const [h, m] = d.starts_at.split(':').map(Number);
    const start = h! * 60 + m!;
    if (start - local.minutes <= 30 && start - local.minutes >= -5) {
      await notify(c, { orgId: b.org_id, branchId, staffIds: [d.staff_id], event: 'duty.reminder', titleKey: 'notif.duty.reminder', vars: { name: d.name, time: d.starts_at.slice(0, 5) }, link: '/os', priority: 'urgent' });
      await c.query(`update public.duty_assignments set reminded_at = now() where id = $1`, [d.id]);
      n++;
    }
  }
  return n;
}

export async function markDuty(ctx: Ctx, id: string, status: 'done' | 'missed') {
  return run(ctx, async (c, sys) => {
    const d = await maybe<{ staff_id: string }>(c, `select staff_id from public.duty_assignments where id = $1`, [id]);
    if (!d) throw new NotFoundError();
    if (status === 'done' && d.staff_id !== ctx.staffId) throw new ForbiddenError();
    if (status === 'missed') need(ctx, 'duty_roster', 'edit');
    return sys(() => update(c, 'duty_assignments', id, { status }));
  });
}

// ================================================================ incidents (7.7)
export async function logIncident(ctx: Ctx, input: { type: string; student_ids: string[]; staff_ids: string[]; room_id?: string | null; location_text?: string | null; occurred_at: string; description: string; action_taken?: string | null; severity: string; confidential: boolean; owner_id?: string | null; follow_ups: { title: string; owner_id: string; due_on: string }[] }) {
  need(ctx, 'incidents', 'create');
  return run(ctx, async (c, sys) => {
    const { follow_ups, ...rest } = input;
    const owner = input.owner_id ?? ctx.staffId;
    const inc = await sys(() => insert<{ id: string }>(c, 'incidents', { org_id: ctx.orgId, branch_id: ctx.branchId, ...rest, owner_id: owner, reported_by: ctx.staffId, status: follow_ups.length ? 'follow_up' : 'open' }));
    const cal = await workCalendar(c, ctx.branchId);
    await sys(async () => {
      for (const [i, f] of follow_ups.entries()) await systemTask(c, { orgId: ctx.orgId, branchId: ctx.branchId, ownerId: f.owner_id, assignerId: ctx.staffId, title: f.title, systemKey: `inc:${inc.id}:${i}`, dueAt: fromLocal(f.due_on, '17:00', cal.timeZone).toISOString(), linkedType: 'incident', linkedId: inc.id, categoryKey: 'parent' });
      // Serious types notify the principal immediately.
      if (['high', 'critical'].includes(input.severity) || input.type === 'injury') {
        const principals = await staffWithRole(c, ctx.orgId, 'principal', ctx.branchId);
        await notify(c, { orgId: ctx.orgId, branchId: ctx.branchId, staffIds: principals, event: input.severity === 'critical' ? 'incident.critical' : 'task.escalation', titleKey: 'notif.incident.serious', vars: { type: input.type, severity: input.severity }, link: `/os/incidents/${inc.id}`, priority: 'urgent' });
      }
    });
    return { id: inc.id };
  });
}

export async function listIncidents(ctx: Ctx) {
  needModule(ctx, 'incidents');
  return run(ctx, async (c) => q(c, `select i.id, i.type, i.severity, i.status, i.confidential, i.occurred_at, i.location_text, r.name as room_name, o.full_name as owner_name, cardinality(i.student_ids) as students from public.incidents i left join public.rooms r on r.id = i.room_id left join public.staff o on o.id = i.owner_id where i.deleted_at is null order by i.occurred_at desc limit 300`));
}

export async function getIncident(ctx: Ctx, id: string) {
  return run(ctx, async (c) => {
    const i = await maybe<{ student_ids: string[] }>(c, `select i.*, o.full_name as owner_name, rb.full_name as reported_by_name from public.incidents i left join public.staff o on o.id = i.owner_id left join public.staff rb on rb.id = i.reported_by where i.id = $1`, [id]);
    if (!i) throw new NotFoundError();
    const students = await q(c, `select st.id, st.full_name, cl.name || ' ' || se.name as section from public.students st left join public.sections se on se.id = st.section_id left join public.classes cl on cl.id = se.class_id where st.id = any($1)`, [i.student_ids]);
    const tasks = await q(c, `select t.id, t.title, t.status, t.due_at, s.full_name as owner_name from public.tasks t left join public.staff s on s.id = t.owner_id where t.linked_type = 'incident' and t.linked_id = $1`, [id]);
    return { ...i, students, tasks };
  });
}

export async function incidentReports(ctx: Ctx, from: string, to: string) {
  need(ctx, 'incidents', 'view', 5);
  return run(ctx, async (c) => ({
    by_type: await q(c, `select type, count(*)::int as n from public.incidents where branch_id = $1 and occurred_at::date between $2 and $3 group by type order by n desc`, [ctx.branchId, from, to]),
    by_hour: await q(c, `select extract(hour from occurred_at at time zone 'Asia/Kolkata')::int as hour, count(*)::int as n from public.incidents where branch_id = $1 and occurred_at::date between $2 and $3 group by 1 order by 1`, [ctx.branchId, from, to]),
    by_location: await q(c, `select coalesce(r.name, i.location_text, '—') as location, count(*)::int as n from public.incidents i left join public.rooms r on r.id = i.room_id where i.branch_id = $1 and i.occurred_at::date between $2 and $3 group by 1 order by n desc`, [ctx.branchId, from, to]),
    by_class: await q(c, `select cl.name as class, count(distinct i.id)::int as n from public.incidents i cross join unnest(i.student_ids) sid join public.students st on st.id = sid join public.classes cl on cl.id = st.class_id where i.branch_id = $1 and i.occurred_at::date between $2 and $3 group by 1 order by n desc`, [ctx.branchId, from, to]),
    repeat_students: await q(c, `select st.full_name, count(*)::int as n from public.incidents i cross join unnest(i.student_ids) sid join public.students st on st.id = sid where i.branch_id = $1 and i.occurred_at::date between $2 and $3 group by st.full_name having count(*) > 1 order by n desc`, [ctx.branchId, from, to]),
    open_follow_ups: await q(c, `select t.id, t.title, t.due_at, s.full_name from public.tasks t left join public.staff s on s.id = t.owner_id where t.linked_type = 'incident' and t.branch_id = $1 and t.status in ('todo','in_progress','blocked','reopened')`, [ctx.branchId]),
  }));
}

export async function closeIncident(ctx: Ctx, id: string) {
  need(ctx, 'incidents', 'edit');
  return run(ctx, async (c) => update(c, 'incidents', id, { status: 'closed' }));
}

// ================================================================ compliance (7.8)
export async function complianceList(ctx: Ctx, branchId?: string) {
  needModule(ctx, 'compliance');
  return run(ctx, async (c) => {
    const b = branchId && ctx.branchIds.includes(branchId) ? branchId : ctx.branchId;
    const items = await q<{ status: string; expires_on: string | null }>(c, `select ci.*, s.full_name as owner_name from public.compliance_items ci left join public.staff s on s.id = ci.owner_id where ci.branch_id = $1 and ci.deleted_at is null order by ci.expires_on nulls first`, [b]);
    const today = localToday(ctx);
    const enriched = items.map((i) => ({ ...i, ...complianceStatus(i.expires_on, today) }));
    return { readiness: readinessPct(enriched), items: enriched };
  });
}

export async function saveComplianceItem(ctx: Ctx, id: string | null, input: { name: string; category: string; owner_id?: string | null; issued_on?: string | null; expires_on?: string | null; notes?: string; documents: { path: string; name: string }[] }) {
  need(ctx, 'compliance', id ? 'edit' : 'create');
  return run(ctx, async (c) => {
    const st = complianceStatus(input.expires_on ?? null, localToday(ctx));
    const row = { org_id: ctx.orgId, branch_id: ctx.branchId, ...input, status: st.status, reminders_sent: id && input.expires_on ? undefined : [] };
    if (id) {
      const prev = await one<{ expires_on: string | null }>(c, `select expires_on::text from public.compliance_items where id = $1`, [id]);
      if (prev.expires_on !== (input.expires_on ?? null)) Object.assign(row, { reminders_sent: [], escalated_at: null });
      return update(c, 'compliance_items', id, row);
    }
    return insert(c, 'compliance_items', row);
  });
}

/** Reminders at 60, 30 and 7 days; an overdue item escalates to the principal. */
export async function complianceSweep(c: Tx, today: string): Promise<number> {
  const items = await q<{ id: string; org_id: string; branch_id: string; name: string; owner_id: string | null; expires_on: string | null; reminders_sent: number[]; escalated_at: string | null }>(c, `select id, org_id, branch_id, name, owner_id, expires_on::text, reminders_sent, escalated_at from public.compliance_items where deleted_at is null`);
  let n = 0;
  for (const it of items) {
    const st = complianceStatus(it.expires_on, today);
    await c.query(`update public.compliance_items set status = $2 where id = $1 and status <> $2`, [it.id, st.status]);
    const due = complianceReminderDue(st.daysLeft, it.reminders_sent ?? []);
    if (due != null && it.owner_id) {
      await notify(c, { orgId: it.org_id, branchId: it.branch_id, staffIds: [it.owner_id], event: 'compliance.reminder', titleKey: 'notif.compliance.reminder', vars: { name: it.name, days: st.daysLeft ?? 0 }, link: '/os/compliance', dedupeKey: `comp:${it.id}:${due}` });
      await c.query(`update public.compliance_items set reminders_sent = array_append(reminders_sent, $2) where id = $1`, [it.id, due]);
      n++;
    }
    if (st.status === 'overdue' && !it.escalated_at) {
      const principals = await staffWithRole(c, it.org_id, 'principal', it.branch_id);
      await notify(c, { orgId: it.org_id, branchId: it.branch_id, staffIds: principals, event: 'task.escalation', titleKey: 'notif.compliance.overdue', vars: { name: it.name }, link: '/os/compliance', priority: 'urgent' });
      await c.query(`update public.compliance_items set escalated_at = now() where id = $1`, [it.id]);
      n++;
    }
  }
  return n;
}
