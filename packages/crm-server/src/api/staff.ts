/**
 * The working screens of the CRM (PRD 7): My day, leads, family 360, inbox, tasks, visits, applications, campaigns,
 * walk-in. Ported from autoedcrm app/(app) and app/actions/{leads,record,ops}.ts.
 *
 * How a request is authorised (ADR crm-port 9): the person's CRM role decides what they may DO (lib/perm helpers);
 * the row policies decide which records they can SEE (reads run as the person with asMe); a write first loads the
 * record as the person (so a colleague's private record is refused) and then runs as the org's automation user with
 * the person named as actor. Edits to the family record itself run as the person, so the database enforces masking
 * and scope on every statement.
 */
import { type Db, ForbiddenError, NotFoundError, type Row } from '../db';
import type { Ctx } from '../auth';
import {
  addTask, audit, captureEnquiry, changeStage, completeTask, duplicatePreview, emit, getEnquiry, logActivity, mapGender, needsNextAction, normMobile, notify, receiveMessage, renderTemplate, scoreBreakdown,
  sendMessage, splitName, stageByName, TASK_TYPES, MESSAGE_COST, type Actor,
} from '../core';
import { APPLICATION_SECTIONS, ageIssue, checklist, confirmAdmission, saveApplication, seatUse, settlePayment, startApplication } from '../admissions';
import { mergeVars } from '../workflows';
import { CHIPS, countLeads, findEnquiry, leadIds, listLeads, pipeline, stageCounts, type SP } from '../leads';
import {
  canCreateLeads, canEditApplications, canEditLeads, canMessage, canRunCampaigns, canTakePayment, canVerifyDocs, canVerifyPayment, canWorkTasks, has, isFullAdmin, leadScope, lvl, mask, seesSensitive,
} from '../perm';
import { publicUrl } from '../util';
import { asMe, asOrg, bool, fail, need, num, on, str, who, type ApiRequest } from './router';
import { asSystem, asUser } from '../db';

const IST = 'Asia/Kolkata';
/** datetime-local value entered in India time. */
export const parseLocal = (s: string): Date => {
  const d = new Date(s.length === 16 ? s + ':00+05:30' : s);
  if (isNaN(d.getTime())) fail('Pick a valid date and time.');
  return d;
};
const inr = (n: unknown) => '₹' + new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(Number(n ?? 0));
const fmtSlot = (d: Date) => new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: IST }).format(d);

/** Loads the enquiry as the person (row policies), then runs fn as the org automation user naming the person as actor. */
async function onEnquiry<T>(req: ApiRequest, enquiryId: string, allowed: (c: Ctx) => boolean, fn: (db: Db, actor: NonNullable<Actor>, ctx: Ctx, e: Row) => Promise<T>): Promise<T> {
  const { s, ctx, actor } = await who(req);
  if (!allowed(ctx)) throw new ForbiddenError('Your role does not allow this action.');
  await asUser(s.userId, ctx.orgId, (db) => findEnquiry(db, enquiryId));
  return asSystem(ctx.orgId, async (db) => fn(db, actor, ctx, (await getEnquiry(db, enquiryId))!));
}
const perms = (f: (p: Ctx['perms']) => boolean) => (c: Ctx) => f(c.perms);

// ---------------------------------------------------------------- shared lookups
const staffPick = (db: Db, levels = ['F', 'T', 'O']) =>
  db.q(`select id, name from crm.staff_v where org_id = $1 and active and role_key <> 'system' and permissions->>'leads' in (select jsonb_array_elements_text($2::jsonb)) order by name`, [db.requireOrg(), levels]);
const approvedTemplates = (db: Db, channel?: string) =>
  db.q(
    `select id, name, channel, category, body from core.message_templates where org_id = $1 and product_key = 'crm' and status = 'approved' and deleted_at is null and ($2::text is null or channel = $2) order by channel, name`,
    [db.requireOrg(), channel ?? null],
  );
async function customFields(db: Db, ctx: Ctx): Promise<Row[]> {
  const rows = await db.q(
    `select f.id, f.key, f.label, f.field_type as type, f.options, f.required, f.active, f.seq, coalesce(s.sensitive, false) as sensitive from core.custom_fields f
       left join crm.field_settings s on s.org_id = f.org_id and s.entity = 'enquiry' and s.key = f.key
      where f.org_id = $1 and f.product_key = 'crm' and f.entity = 'enquiry' and f.active and f.deleted_at is null order by f.seq`,
    [db.requireOrg()],
  );
  return rows.map((f) => ({ ...f, options: f.options ?? [], hidden: f.sensitive && !seesSensitive(ctx.perms) }));
}
const caps = (ctx: Ctx) => ({
  bulk: has(ctx.perms, 'bulk'), reassign: ['F', 'T'].includes(lvl(ctx.perms, 'reassign')), edit: canEditLeads(ctx.perms), message: canMessage(ctx.perms), create: canCreateLeads(ctx.perms),
  export: ['F', 'T', 'Part'].includes(lvl(ctx.perms, 'bulk')), tasks: canWorkTasks(ctx.perms), application: canEditApplications(ctx.perms), verifyDocs: canVerifyDocs(ctx.perms), pay: canTakePayment(ctx.perms),
  verifyPay: canVerifyPayment(ctx.perms), campaigns: canRunCampaigns(ctx.perms), sensitive: seesSensitive(ctx.perms), merge: ['F', 'T', 'Merge only'].includes(lvl(ctx.perms, 'delete')),
  decide: ['F', 'T', 'Decide'].includes(lvl(ctx.perms, 'applications')), fullAdmin: isFullAdmin(ctx.perms), reports: has(ctx.perms, 'reports'),
});

// ---------------------------------------------------------------- My day
on('GET', '/home', ({ req }) =>
  asMe(req, async (db, ctx) => {
    const org = db.requireOrg();
    const me = ctx.user.id;
    const isHead = ['F', 'T'].includes(lvl(ctx.perms, 'reassign'));
    const ps: any[] = [];
    const scope = (await import('../auth')).scopeSql(ctx, ps);
    const y = ps.push(ctx.yearId);
    const J = 'join crm.prospects st on st.org_id = e.org_id and st.id = e.prospect_id join crm.stages s on s.org_id = e.org_id and s.id = e.stage_id';
    const [tasks, visits, fresh, replies, mine, team, pl] = await Promise.all([
      db.q(
        `select k.id, k.title, k.type, k.priority, k.due_at, k.enquiry_id, e.household_id, st.full_name as student, s.exempt_next_action,
           (select count(*)::int from crm.follow_ups o where o.enquiry_id = k.enquiry_id and o.status = 'open') as open_count
         from crm.follow_ups k join crm.enquiries e on e.org_id = k.org_id and e.id = k.enquiry_id ${J}
        where k.org_id = $1 and k.owner_id = $2 and k.status = 'open' and k.due_at < now() + interval '36 hours' order by k.due_at limit 60`,
        [org, me],
      ),
      db.q(
        `select v.id, v.slot_at, v.checked_in_at, v.household_id, v.enquiry_id, st.full_name as student, u.full_name as host
           from crm.visits v join crm.enquiries e on e.org_id = v.org_id and e.id = v.enquiry_id join crm.prospects st on st.org_id = e.org_id and st.id = e.prospect_id
           left join core.staff u on u.org_id = v.org_id and u.user_id = v.host_id
          where ${scope} and v.status = 'scheduled' and (v.slot_at at time zone '${IST}')::date = (now() at time zone '${IST}')::date order by v.slot_at`,
        ps.slice(0, y - 1),
      ),
      db.q(
        `select e.id, e.household_id, e.created_at, e.grade, st.full_name as student, u.full_name as owner
           from crm.enquiries e ${J} join crm.phases p on p.org_id = s.org_id and p.id = s.phase_id left join core.staff u on u.org_id = e.org_id and u.user_id = e.owner_id
          where ${scope} and e.academic_year_id = $${y} and p.key = 'enquiry' and e.first_response_at is null order by e.created_at limit 12`,
        ps,
      ),
      db.q(
        `select m.household_id, max(m.created_at) as at, (array_agg(m.body order by m.created_at desc))[1] as body, min(st.full_name) as student
           from crm.messages m join crm.enquiries e on e.org_id = m.org_id and e.household_id = m.household_id join crm.prospects st on st.org_id = e.org_id and st.id = e.prospect_id
          where ${scope} and m.direction = 'in' and not m.read group by m.household_id order by at desc limit 8`,
        ps.slice(0, y - 1),
      ),
      db.one(
        `select count(*) filter (where e.owner_id = $2 and not s.is_closed and not s.is_won)::int as open, count(*) filter (where e.owner_id = $2 and s.is_won)::int as won,
                count(*) filter (where e.owner_id = $2 and e.created_at > now() - interval '7 days')::int as week
           from crm.enquiries e join crm.stages s on s.org_id = e.org_id and s.id = e.stage_id where e.org_id = $1 and e.academic_year_id = $3`,
        [org, me, ctx.yearId],
      ),
      isHead
        ? db.q(
            `select u.id, u.name, u.on_leave,
               count(e.id) filter (where not s.is_closed and not s.is_won)::int as open, count(e.id) filter (where s.is_won)::int as won,
               count(e.id) filter (where e.first_response_at is null and p.key = 'enquiry')::int as untouched,
               (select count(*)::int from crm.follow_ups k where k.org_id = u.org_id and k.owner_id = u.id and k.status = 'open' and k.due_at < now()) as overdue
             from crm.staff_v u left join crm.enquiries e on e.org_id = u.org_id and e.owner_id = u.id and e.academic_year_id = $2
             left join crm.stages s on s.org_id = e.org_id and s.id = e.stage_id left join crm.phases p on p.org_id = s.org_id and p.id = s.phase_id
            where u.org_id = $1 and u.active and u.permissions->>'leads' = 'O' ${ctx.branchIds.length ? "and (u.branch_ids = '[]'::jsonb or u.branch_ids ?| array(select jsonb_array_elements_text($3::jsonb)))" : ''}
            group by u.org_id, u.id, u.name, u.on_leave order by u.name`,
          ctx.branchIds.length ? [org, ctx.yearId, ctx.branchIds] : [org, ctx.yearId],
        )
        : Promise.resolve([]),
      pipeline(db),
    ]);
    const stageOpts = pl.stages.map((x) => ({ id: x.id, name: x.name, phase_name: x.phase_name, is_closed: x.is_closed, exempt_next_action: x.exempt_next_action }));
    return {
      tasks, visits, fresh, replies, mine, team, stages: stageOpts, taskTypes: TASK_TYPES,
      sla: Number(ctx.settings.first_response_mins ?? 30), reasons: ctx.settings.closure_reasons ?? [], can: caps(ctx), isHead,
    };
  }),
);

// ---------------------------------------------------------------- leads list
const PAGE = 50;
const queryOf = (q: Record<string, string>): SP => Object.fromEntries(Object.entries(q).filter(([k]) => !['yearId', 'branchId', 'page', 'size'].includes(k)));

on('GET', '/leads', ({ req }) =>
  asMe(req, async (db, ctx) => {
    need(has(ctx.perms, 'leads'), 'Your role cannot open leads.');
    const sp = queryOf(req.query);
    const view = sp.view ?? 'table';
    const page = Math.max(1, num(req.query.page, 1));
    const size = view === 'kanban' ? 400 : Math.min(200, num(req.query.size, PAGE));
    const pl = await pipeline(db);
    const [rows, total, counts, users, templates, views, channels, fields] = await Promise.all([
      listLeads(db, ctx, sp, size, (page - 1) * size),
      countLeads(db, ctx, sp),
      stageCounts(db, ctx, sp),
      staffPick(db),
      approvedTemplates(db),
      db.q('select id, name, shared, query, user_id from crm.saved_views where org_id = $1 and (user_id = $2 or shared) order by name', [db.requireOrg(), ctx.user.id]),
      db.q('select distinct channel from crm.sources where org_id = $1 order by 1', [db.requireOrg()]),
      customFields(db, ctx),
    ]);
    const now = Date.now();
    const data = rows.map((r) => ({
      id: r.id, household_id: r.household_id, student: r.student, guardian: r.guardian, mobile: r.mobile, grade: r.grade, branch: r.branch, stage: r.stage, stage_id: r.stage_id, color: r.color, phase: r.phase,
      owner: r.owner, score: r.score, temperature: r.temperature, source: r.source, created_at: r.created_at, next_due: r.next_due, next_title: r.next_title,
      overdue: !!r.next_due && new Date(r.next_due).getTime() < now, reenquired: r.reenquired, family: r.family_size, untouched: !r.first_response_at, tags: r.tags, application_no: r.application_no,
      custom: Object.fromEntries(fields.map((f) => [f.key, f.hidden ? (r.custom?.[f.key] ? mask('x') : '') : String(r.custom?.[f.key] ?? '')])),
    }));
    return {
      data, total, page, size, pipeline: pl, counts, users, templates, views, channels, fields: fields.map(({ hidden, ...f }) => ({ ...f, hidden })), chips: CHIPS,
      reasons: ctx.settings.closure_reasons ?? [], grades: ctx.settings.grades ?? [], can: caps(ctx), allYears: sp.year === 'all',
    };
  }),
);

/** Ids matching a filter (select-all across pages, campaigns, exports). */
on('GET', '/leads/ids', ({ req }) =>
  asMe(req, async (db, ctx) => {
    need(has(ctx.perms, 'leads'), 'Your role cannot open leads.');
    return { ids: await leadIds(db, ctx, queryOf(req.query)) };
  }),
);

on('GET', '/dedupe', ({ req }) =>
  asOrg(req, async (db, ctx) => {
    need(canCreateLeads(ctx.perms));
    return { match: await duplicatePreview(db, { mobile: req.query.mobile, email: req.query.email }) };
  }),
);

// quick add (CAP-01) and walk-in (CAP-02)
on('POST', '/leads', async ({ req, b }) => {
  const { ctx, actor } = await who(req);
  need(canCreateLeads(ctx.perms), 'Your role cannot add enquiries.');
  const branchId = str(b.branchId);
  if (!ctx.branches.some((x) => x.id === branchId)) fail('Choose one of your branches.');
  // Capture sees the whole org (duplicate and sibling detection, sticky owner) so it runs as the automation user; the person's
  // own permission was checked above and they are recorded as the actor.
  const res = await asSystem(ctx.orgId, (db) =>
    captureEnquiry(
      db,
      {
        studentName: str(b.studentName), guardianName: str(b.guardianName), mobile: str(b.mobile), branchId, yearId: ctx.yearId, grade: str(b.grade) || undefined, board: str(b.board) || undefined,
        custom: Object.fromEntries(Object.entries((b.custom ?? {}) as Record<string, unknown>).filter(([k, v]) => /^[a-z][a-z0-9_]*$/.test(k) && str(v)).map(([k, v]) => [k, str(v)])),
        sourceId: str(b.sourceId) || undefined, heardAbout: str(b.heardAbout) || undefined, note: str(b.note) || undefined, dob: str(b.dob) || undefined, email: str(b.email) || undefined,
        consent: { source: bool(b.consent) ? 'Verbal consent recorded by ' + ctx.user.name : 'Not recorded' },
        preferOwnerId: leadScope(ctx.perms) === 'own' ? ctx.user.id : undefined,
      },
      actor,
    ),
  );
  if (!res.ok) return { status: 422, json: res };
  // Someone who only sees their own records cannot open a family that belongs to a colleague.
  const canOpen = leadScope(ctx.perms) !== 'own' || res.ownerId === ctx.user.id;
  return { ...res, canOpen };
});

on('POST', '/walkin', async ({ req, b }) => {
  const { ctx, actor } = await who(req);
  need(canCreateLeads(ctx.perms), 'Your role cannot add walk-ins.');
  if (!ctx.branches.some((x) => x.id === str(b.branchId))) fail('Choose one of your branches.');
  return asSystem(ctx.orgId, async (db) => {
    const src = await db.one("select id from crm.sources where org_id = $1 and channel = 'Walk-in' and active limit 1", [ctx.orgId]);
    const res = await captureEnquiry(
      db,
      { studentName: str(b.studentName), guardianName: str(b.guardianName), mobile: str(b.mobile), branchId: str(b.branchId), yearId: ctx.yearId, grade: str(b.grade), sourceId: src?.id, channel: 'Walk-in', source: 'Front desk walk-in', consent: { source: bool(b.consent) ? 'Verbal consent at front desk' : 'Not recorded' } },
      actor,
    );
    if (!res.ok) return { status: 422, json: res };
    await addTask(db, { enquiryId: res.enquiryId, type: 'visit', title: 'Walk-in waiting at the front desk', dueAt: new Date(), priority: 'high' });
    await notify(db, res.ownerId, 'due', 'Walk-in at the front desk: ' + str(b.studentName), `/crm/households/${res.householdId}?e=${res.enquiryId}`);
    const n = await db.one(`select count(*)::int n from crm.source_touches where org_id = $1 and channel = 'Walk-in' and (created_at at time zone '${IST}')::date = (now() at time zone '${IST}')::date`, [ctx.orgId]);
    return { ...res, token: 'W-' + String(n!.n).padStart(2, '0'), message: res.status === 're_enquiry' ? 'Existing family. Walk-in added to their record.' : res.status === 'sibling_added' ? 'Existing family. New child added to their household.' : 'New enquiry saved.' };
  });
});

on('GET', '/walkin', ({ req }) =>
  asMe(req, async (db, ctx) => {
    need(canCreateLeads(ctx.perms), 'Your role cannot add walk-ins.');
    return { grades: ctx.settings.grades ?? [], branches: ctx.branches.map((x) => ({ id: x.id, name: x.name })), branchId: ctx.branchId ?? ctx.branches[0]?.id ?? null };
  }),
);

// ---------------------------------------------------------------- stage moves, bulk, saved views
on('POST', '/leads/:id/stage', ({ req, p, b }) =>
  onEnquiry(req, p.id!, perms(canEditLeads), async (db, actor) => {
    if (!str(b.stageId)) fail('Choose a stage.');
    return changeStage(db, p.id!, str(b.stageId), actor, { closure_reason: str(b.closure_reason) || undefined, expected_decision: str(b.expected_decision) || undefined, note: str(b.note) || undefined });
  }),
);

on('POST', '/leads/bulk', async ({ req, b }) => {
  const { s, ctx, actor } = await who(req);
  need(has(ctx.perms, 'bulk'), 'Your role cannot run bulk actions.');
  const action = str(b.action);
  // Either explicit ids, or "everything matching the current filter". Visibility is the person's: asUser resolves the ids.
  const picked = (Array.isArray(b.ids) ? b.ids : str(b.ids).split(',')).map(String).filter(Boolean);
  if (!b.all && !picked.length) fail('No records selected.');
  const sp: SP = b.all ? (Object.fromEntries(new URLSearchParams(str(b.query))) as SP) : { ids: picked.join(','), year: 'all' };
  const ids = await asUser(s.userId, ctx.orgId, (db) => leadIds(db, ctx, sp));
  if (!ids.length) fail('No records selected.');
  return asSystem(ctx.orgId, async (db) => {
    let done = 0, skipped = 0;
    let message = '';
    if (action === 'stage') {
      need(canEditLeads(ctx.perms), 'Your role cannot change stages.');
      for (const id of ids) {
        if ((await changeStage(db, id, str(b.stageId), actor, { closure_reason: str(b.closure_reason) || undefined })).ok) done++;
        else skipped++;
      }
      message = `Stage changed for ${done} record${done === 1 ? '' : 's'}` + (skipped ? `; ${skipped} skipped because the stage needs information they do not have.` : '.');
    } else if (action === 'reassign') {
      need(['F', 'T'].includes(lvl(ctx.perms, 'reassign')), 'Your role cannot reassign leads.');
      const to = await db.one("select id, name from crm.staff_v where org_id = $1 and id = $2 and active and role_key <> 'system'", [ctx.orgId, str(b.ownerId)]);
      if (!to) fail('Choose who to assign to.');
      const reason = str(b.reason) || 'Bulk reassignment';
      for (const id of ids) {
        const e = await getEnquiry(db, id);
        if (!e || e.owner_id === to!.id) { skipped++; continue; }
        await db.q('update crm.enquiries set owner_id = $2, updated_at = now() where id = $1', [id, to!.id]);
        await db.q("update crm.follow_ups set owner_id = $2 where enquiry_id = $1 and status = 'open'", [id, to!.id]);
        await logActivity(db, { householdId: e.household_id, enquiryId: id, type: 'system', actorId: actor.id, content: `Reassigned from ${e.owner_name} to ${to!.name}. Reason: ${reason}` });
        done++;
      }
      if (done) await notify(db, to!.id, 'assigned', `${done} enquir${done === 1 ? 'y' : 'ies'} reassigned to you by ${actor.name}`, '/crm/leads?chip=my');
      message = `Reassigned ${done} record${done === 1 ? '' : 's'} to ${to!.name}.`;
    } else if (action === 'task') {
      need(canWorkTasks(ctx.perms), 'Your role cannot add tasks.');
      const due = parseLocal(str(b.dueAt));
      for (const id of ids) { await addTask(db, { enquiryId: id, title: str(b.title) || 'Follow-up', dueAt: due }); done++; }
      message = `Task added to ${done} record${done === 1 ? '' : 's'}.`;
    } else if (action === 'tag') {
      const tag = str(b.tag).toLowerCase();
      if (!tag) fail('Type a tag first.');
      await db.q('update crm.enquiries set tags = tags || to_jsonb($2::text) where org_id = $1 and id::text in (select jsonb_array_elements_text($3::jsonb)) and not tags @> to_jsonb($2::text)', [ctx.orgId, tag, ids]);
      done = ids.length;
      message = `Tag "${tag}" added to ${ids.length} record${ids.length === 1 ? '' : 's'}.`;
    } else if (action === 'message') {
      need(canMessage(ctx.perms), 'Your role cannot send messages.');
      const tpl = await db.one("select * from core.message_templates where org_id = $1 and product_key = 'crm' and id = $2 and status = 'approved' and deleted_at is null", [ctx.orgId, str(b.templateId)]);
      if (!tpl) fail('Choose an approved template.');
      for (const id of ids) {
        const e = await getEnquiry(db, id);
        if (!e) continue;
        const vars = await mergeVars(db, e);
        const r = await sendMessage(db, { householdId: e.household_id, enquiryId: id, channel: tpl!.channel, body: renderTemplate(tpl!.body, vars), actorId: actor.id, template: tpl, vars });
        if (r.status !== 'failed') done++;
        else skipped++;
      }
      message = `"${tpl!.name}" sent to ${done} famil${done === 1 ? 'y' : 'ies'}` + (skipped ? `; ${skipped} not delivered (see each timeline for why).` : '.');
    } else fail('Choose an action.');
    await audit(db, actor, 'bulk', 'enquiry', null, `Bulk ${action} on ${ids.length} enquiries`);
    return { ok: true, done, skipped, message };
  });
});

on('POST', '/views', ({ req, b }) =>
  asMe(req, async (db, ctx) => {
    need(has(ctx.perms, 'leads'));
    if (!str(b.name)) fail('Give the view a name.');
    const v = await db.insert('crm.saved_views', { user_id: ctx.user.id, name: str(b.name), shared: bool(b.shared) && has(ctx.perms, 'bulk'), query: str(b.query) });
    return { ok: true, id: v.id };
  }),
);
on('POST', '/views/:id/delete', ({ req, p }) =>
  asMe(req, async (db, ctx) => {
    await db.q('delete from crm.saved_views where org_id = $1 and id = $2 and user_id = $3', [ctx.orgId, p.id, ctx.user.id]);
    return { ok: true };
  }),
);

// ---------------------------------------------------------------- family 360
on('GET', '/households/:id', ({ req, p }) =>
  asMe(req, async (db, ctx) => {
    need(has(ctx.perms, 'leads'));
    const org = db.requireOrg();
    const sens = seesSensitive(ctx.perms);
    const enquiries = await db.q(
      `select e.id, e.household_id, e.prospect_id, e.branch_id, e.academic_year_id, e.board, e.grade, e.stage_id, e.owner_id, e.score, e.temperature, e.expected_decision::text, e.closure_reason, e.custom_full as custom, e.tags,
              e.application_no, e.public_token, e.reenquired, e.first_response_at, e.created_at, e.stage_entered_at,
              st.full_name as student, st.first_name, st.dob::text as dob, st.gender, st.current_school, st.current_grade, st.special_needs,
              s.name as stage, s.color, s.is_closed, s.is_won, s.exempt_next_action, p.key as phase_key, u.full_name as owner, b.name as branch, y.name as year
         from crm.enquiries_full e join crm.prospects st on st.org_id = e.org_id and st.id = e.prospect_id join crm.stages s on s.org_id = e.org_id and s.id = e.stage_id join crm.phases p on p.org_id = s.org_id and p.id = s.phase_id
         left join core.staff u on u.org_id = e.org_id and u.user_id = e.owner_id join core.branches b on b.org_id = e.org_id and b.id = e.branch_id join core.academic_years y on y.org_id = e.org_id and y.id = e.academic_year_id
        where e.household_id = $1 and e.org_id = $2 ${ctx.branchId ? '' : ''} order by y.seq desc, e.created_at`,
      [p.id, org],
    );
    if (!enquiries.length) throw new NotFoundError('This family is not available to you.');
    const e = enquiries.find((x) => x.id === req.query.e) ?? enquiries[0]!;
    const typeFilter = req.query.t;
    const [hh, guardians, acts, tasks, visits, touches, app, docs, payments, fields, pl, templates, users, score] = await Promise.all([
      db.one('select * from crm.households where org_id = $1 and id = $2', [org, p.id]),
      db.q('select * from crm.guardians where org_id = $1 and household_id = $2 order by is_primary desc, created_at', [org, p.id]),
      db.q(
        `select a.id, a.type, a.outcome, a.content, a.meta, a.created_at, a.enquiry_id, u.full_name as actor from crm.activities a left join core.staff u on u.org_id = a.org_id and u.user_id = a.actor_id
          where a.org_id = $1 and a.household_id = $2 ${typeFilter ? 'and a.type = $3' : ''} order by a.created_at desc limit 150`,
        typeFilter ? [org, p.id, typeFilter] : [org, p.id],
      ),
      db.q('select k.*, u.full_name as owner from crm.follow_ups k left join core.staff u on u.org_id = k.org_id and u.user_id = k.owner_id where k.org_id = $1 and k.enquiry_id = $2 order by (k.status = \'open\') desc, k.due_at desc limit 20', [org, e.id]),
      db.q('select v.*, u.full_name as host from crm.visits v left join core.staff u on u.org_id = v.org_id and u.user_id = v.host_id where v.org_id = $1 and v.enquiry_id = $2 order by v.slot_at desc', [org, e.id]),
      db.q('select * from crm.source_touches where org_id = $1 and enquiry_id = $2 order by created_at', [org, e.id]),
      db.one('select * from crm.applications where org_id = $1 and enquiry_id = $2', [org, e.id]),
      db.q('select * from crm.enquiry_documents where org_id = $1 and enquiry_id = $2 order by type', [org, e.id]),
      db.q('select id, purpose, amount, mode, status, receipt_no, reference, token, created_at from crm.payments where org_id = $1 and enquiry_id = $2 order by created_at desc', [org, e.id]),
      customFields(db, ctx),
      pipeline(db),
      approvedTemplates(db),
      staffPick(db),
      scoreBreakdown(db, e.id),
    ]);
    const consents = await Promise.all(guardians.slice(0, 1).map((g) => db.one('select crm.guardian_consents($1) as c', [g.id])));
    const consent = (consents[0]?.c ?? {}) as Record<string, boolean>;
    const maskedEnquiries: Row[] = enquiries.map((x) => ({ ...x, dob: sens ? x.dob : x.dob ? mask('x') : null, special_needs: sens ? x.special_needs : x.special_needs ? mask('x') : null, custom: x.custom ?? {}, public_token: x.public_token }));
    const me = maskedEnquiries.find((x) => x.id === e.id)!;
    return {
      household: hh, guardians: guardians.map((g) => ({ ...g, mobile: g.phone, alt_mobile: g.alt_phone })), enquiries: maskedEnquiries, current: me, activities: acts, tasks, visits, touches, application: app, documents: docs, payments,
      fields, stages: pl.stages.map((x) => ({ id: x.id, name: x.name, phase_name: x.phase_name, is_closed: x.is_closed, exempt_next_action: x.exempt_next_action, required_fields: x.required_fields })), templates, users, score,
      consent: { whatsapp: consent.whatsapp !== false && consent.whatsapp !== undefined ? true : consent.whatsapp === undefined ? null : false, sms: consent.sms ?? null, email: consent.email ?? null, call: consent.call ?? null },
      settings: { grades: ctx.settings.grades ?? [], boards: ctx.settings.boards ?? [], reasons: ctx.settings.closure_reasons ?? [], fees: ctx.settings.fees ?? { registration: 1500, admission: 25000 } },
      branches: ctx.branches.map((x) => ({ id: x.id, name: x.name })), taskTypes: TASK_TYPES, can: caps(ctx), sections: APPLICATION_SECTIONS.length, publicApplyUrl: publicUrl('apply', e.public_token),
    };
  }),
);

// ---------------------------------------------------------------- record actions
on('POST', '/leads/:id/note', ({ req, p, b }) =>
  onEnquiry(req, p.id!, perms((x) => has(x, 'leads')), async (db, actor, _c, e) => {
    const text = str(b.note);
    if (!text) fail('Write the note first.');
    await logActivity(db, { householdId: e.household_id, enquiryId: e.id, type: 'note', actorId: actor.id, content: text });
    // @mentions loop in a colleague (L360-07).
    for (const m of text.matchAll(/@([a-z]+)/gi)) {
      const u = await db.one("select id from crm.staff_v where org_id = $1 and lower(split_part(name, ' ', 1)) = lower($2) and active and role_key <> 'system'", [db.requireOrg(), m[1]]);
      if (u) await notify(db, u.id, 'mention', `${actor.name} mentioned you: ${text.slice(0, 70)}`, `/crm/households/${e.household_id}?e=${e.id}`);
    }
    return { ok: true };
  }),
);

const CALL_TEXT: Record<string, string> = { connected: 'Spoke to the parent.', not_answered: 'Call not answered.', busy: 'Line was busy.', wrong_number: 'Wrong number.', switched_off: 'Phone switched off or unreachable.' };
on('POST', '/leads/:id/call', ({ req, p, b }) =>
  onEnquiry(req, p.id!, perms(canEditLeads), async (db, actor, _c, e) => {
    const outcome = CALL_TEXT[str(b.outcome)] ? str(b.outcome) : 'connected';
    await logActivity(db, { householdId: e.household_id, enquiryId: e.id, type: 'call', actorId: actor.id, outcome, content: [CALL_TEXT[outcome], str(b.notes)].filter(Boolean).join(' ') });
    // Sensible default moves out of "New" so the board reflects reality without an extra click.
    if (e.stage_name === 'New') {
      const st = await stageByName(db, outcome === 'connected' ? 'Connected' : 'Contact attempted');
      if (st) await changeStage(db, e.id, st.id, actor);
    }
    if (outcome !== 'connected') await emit(db, 'call_not_answered', e.id);
    if (str(b.nextDue)) await addTask(db, { enquiryId: e.id, title: str(b.nextTitle) || 'Follow-up call', dueAt: parseLocal(str(b.nextDue)) });
    return { ok: true, message: 'Call logged.' };
  }),
);

on('POST', '/leads/:id/task', ({ req, p, b }) =>
  onEnquiry(req, p.id!, perms((x) => has(x, 'tasks')), async (db, _a, _c, e) => {
    const t = await addTask(db, { enquiryId: e.id, type: TASK_TYPES[str(b.type)] ? str(b.type) : 'call_back', title: str(b.title) || 'Follow-up', dueAt: parseLocal(str(b.dueAt)), priority: str(b.priority) || 'normal', ownerId: str(b.ownerId) || undefined });
    return { ok: true, id: t.id, message: 'Task added.' };
  }),
);

on('POST', '/leads/:id/message', ({ req, p, b }) =>
  onEnquiry(req, p.id!, perms(canMessage), async (db, actor, ctx, e) => {
    let body = str(b.body);
    let channel = ['whatsapp', 'sms', 'email'].includes(str(b.channel)) ? str(b.channel) : 'whatsapp';
    let tpl: Row | null = null;
    let vars: Record<string, string> = {};
    if (str(b.templateId)) {
      tpl = await db.one("select * from core.message_templates where org_id = $1 and product_key = 'crm' and id = $2 and status = 'approved' and deleted_at is null", [ctx.orgId, str(b.templateId)]);
      if (!tpl) fail('That template is not approved yet.');
      vars = await mergeVars(db, e);
      body = renderTemplate(tpl!.body, vars);
      channel = tpl!.channel;
    }
    if (!body) fail('Write a message or pick a template.');
    // WhatsApp rule: free text is only allowed within 24 hours of the parent's last message.
    if (channel === 'whatsapp' && !str(b.templateId) && !bool(b.note)) {
      const last = await db.one("select max(created_at) as at from crm.messages where org_id = $1 and household_id = $2 and channel = 'whatsapp' and direction = 'in'", [ctx.orgId, e.household_id]);
      if (!last?.at || Date.now() - new Date(last.at).getTime() > 24 * 3600e3) fail("WhatsApp allows free text only within 24 hours of the parent's last message. Pick an approved template instead.");
    }
    if (bool(b.note)) {
      await db.insert('crm.messages', { household_id: e.household_id, enquiry_id: e.id, channel, direction: 'out', body, status: 'sent', is_note: true, sender_id: actor.id, read: true });
      return { ok: true, status: 'note', message: 'Internal note saved.' };
    }
    const r = await sendMessage(db, { householdId: e.household_id, enquiryId: e.id, channel, body, actorId: actor.id, template: tpl, vars });
    await db.q("update crm.messages set read = true where org_id = $1 and household_id = $2 and direction = 'in'", [ctx.orgId, e.household_id]);
    return { ok: r.status !== 'failed', status: r.status, reason: r.reason, message: r.status === 'failed' ? 'Not delivered: ' + r.reason : `Sent on ${channel === 'whatsapp' ? 'WhatsApp' : channel === 'sms' ? 'SMS' : 'email'}.` };
  }),
);

on('POST', '/leads/:id/visit', ({ req, p, b }) =>
  onEnquiry(req, p.id!, perms((x) => has(x, 'tasks')), async (db, actor, ctx, e) => {
    const slot = parseLocal(str(b.slotAt));
    if (slot.getTime() < Date.now() - 3600e3) fail('Pick a visit time in the future.');
    const branch = await db.one('select coalesce(bs.visit_capacity, 3) as cap from core.branches b left join crm.branch_settings bs on bs.org_id = b.org_id and bs.branch_id = b.id where b.org_id = $1 and b.id = $2', [ctx.orgId, e.branch_id]);
    const taken = await db.one("select count(*)::int n from crm.visits where org_id = $1 and branch_id = $2 and status = 'scheduled' and date_trunc('hour', slot_at) = date_trunc('hour', $3::timestamptz) and enquiry_id <> $4", [ctx.orgId, e.branch_id, slot, e.id]);
    if (taken!.n >= branch!.cap) fail(`That hour is full (${branch!.cap} visits). Pick another slot.`);
    const host = str(b.hostId) || e.owner_id;
    await db.q("update crm.visits set status = 'cancelled' where org_id = $1 and enquiry_id = $2 and status = 'scheduled'", [ctx.orgId, e.id]);
    await db.insert('crm.visits', { enquiry_id: e.id, household_id: e.household_id, branch_id: e.branch_id, type: ['campus_tour', 'counselling', 'interaction', 'assessment'].includes(str(b.type)) ? str(b.type) : 'campus_tour', slot_at: slot, host_id: host });
    await logActivity(db, { householdId: e.household_id, enquiryId: e.id, type: 'visit', outcome: 'booked', actorId: actor.id, content: `Campus visit booked for ${fmtSlot(slot)}.` });
    const st = await stageByName(db, 'Visit scheduled');
    if (st && (['prospect', 'enquiry'].includes(e.phase_key) || e.stage_name === 'No-show')) await changeStage(db, e.id, st.id, actor);
    await db.q("update crm.follow_ups set status = 'cancelled' where org_id = $1 and enquiry_id = $2 and status = 'open' and type = 'visit'", [ctx.orgId, e.id]);
    await addTask(db, { enquiryId: e.id, type: 'visit', title: 'Host the campus visit', dueAt: slot, ownerId: host });
    await emit(db, 'visit_scheduled', e.id);
    return { ok: true, message: 'Visit booked. The parent gets a confirmation.' };
  }),
);

on('POST', '/visits/:id', async ({ req, p, b }) => {
  const { s, ctx, actor } = await who(req);
  need(canWorkTasks(ctx.perms), 'Your role cannot update visits.');
  const v = await asUser(s.userId, ctx.orgId, (db) => db.one('select * from crm.visits where org_id = $1 and id = $2', [ctx.orgId, p.id]));
  if (!v) throw new NotFoundError('Visit not found.');
  return asSystem(ctx.orgId, async (db) => {
    const what = str(b.what);
    const e = (await getEnquiry(db, v.enquiry_id))!;
    const move = async (name: string) => { const st = await stageByName(db, name); if (st && e.phase_key === 'visit') await changeStage(db, e.id, st.id, actor); };
    const cancelTasks = () => db.q("update crm.follow_ups set status = 'cancelled' where org_id = $1 and enquiry_id = $2 and status = 'open' and type = 'visit'", [ctx.orgId, e.id]);
    let message = '';
    if (what === 'check_in') {
      await db.update('crm.visits', v.id, { checked_in_at: new Date() });
      await logActivity(db, { householdId: v.household_id, enquiryId: v.enquiry_id, type: 'visit', outcome: 'checked_in', actorId: actor.id, content: 'Family checked in at the front desk.' });
      if (v.host_id) await notify(db, v.host_id, 'due', `${e.student_name}'s family has arrived for their visit`, `/crm/households/${v.household_id}?e=${v.enquiry_id}`);
      message = 'Checked in. The host has been notified.';
    } else if (what === 'done') {
      if (!str(b.outcome)) fail('Add the visit outcome first.');
      await db.update('crm.visits', v.id, { status: 'done', outcome: str(b.outcome), checked_in_at: v.checked_in_at ?? new Date() });
      await logActivity(db, { householdId: v.household_id, enquiryId: v.enquiry_id, type: 'visit', outcome: 'done', actorId: actor.id, content: 'Visit completed. Outcome: ' + str(b.outcome) });
      await db.q("update crm.follow_ups set status = 'done', completed_at = now() where org_id = $1 and enquiry_id = $2 and status = 'open' and type = 'visit'", [ctx.orgId, e.id]);
      await move('Visit done');
      if (await needsNextAction(db, e.id)) await addTask(db, { enquiryId: e.id, title: 'Post-visit follow-up', dueAt: new Date(Date.now() + 24 * 3600e3) });
      await emit(db, 'visit_done', e.id);
      message = 'Visit marked done. A follow-up task was added for tomorrow.';
    } else if (what === 'no_show') {
      await db.update('crm.visits', v.id, { status: 'no_show' });
      await logActivity(db, { householdId: v.household_id, enquiryId: v.enquiry_id, type: 'visit', outcome: 'no_show', actorId: actor.id, content: 'Family did not arrive for the visit.' });
      await cancelTasks();
      await move('No-show');
      await emit(db, 'visit_no_show', e.id);
      if (await needsNextAction(db, e.id)) await addTask(db, { enquiryId: e.id, type: 'visit', title: 'Rebook the campus visit', dueAt: new Date(Date.now() + 24 * 3600e3) });
      message = 'Marked no-show. A rebooking task was created.';
    } else if (what === 'cancel') {
      await db.update('crm.visits', v.id, { status: 'cancelled' });
      await cancelTasks();
      await logActivity(db, { householdId: v.household_id, enquiryId: v.enquiry_id, type: 'visit', outcome: 'cancelled', actorId: actor.id, content: 'Visit cancelled.' });
      if (await needsNextAction(db, e.id)) await addTask(db, { enquiryId: e.id, title: 'Call to rebook the visit', dueAt: new Date(Date.now() + 4 * 3600e3) });
      message = 'Visit cancelled.';
    } else fail('Unknown visit action.');
    return { ok: true, message };
  });
});

on('GET', '/visits', ({ req }) =>
  asMe(req, async (db, ctx) => {
    need(has(ctx.perms, 'tasks'));
    const ps: any[] = [];
    const scope = (await import('../auth')).scopeSql(ctx, ps);
    const rows = await db.q(
      `select v.id, v.enquiry_id, v.household_id, v.slot_at, v.status, v.checked_in_at, v.outcome, v.type, st.full_name as student, e.grade, u.full_name as host, b.name as branch, coalesce(bs.visit_capacity, 3) as visit_capacity, g.name as guardian, g.mobile
         from crm.visits v join crm.enquiries e on e.org_id = v.org_id and e.id = v.enquiry_id join crm.prospects st on st.org_id = e.org_id and st.id = e.prospect_id join core.branches b on b.org_id = v.org_id and b.id = v.branch_id
         left join crm.branch_settings bs on bs.org_id = b.org_id and bs.branch_id = b.id left join core.staff u on u.org_id = v.org_id and u.user_id = v.host_id
         left join lateral (select name, phone as mobile from crm.guardians g where g.household_id = v.household_id order by is_primary desc limit 1) g on true
        where ${scope} and v.slot_at > now() - interval '7 days' and v.slot_at < now() + interval '14 days' and v.status <> 'cancelled' order by v.slot_at`,
      ps,
    );
    return { visits: rows, can: caps(ctx) };
  }),
);

// details (DM-04): the person edits the record, so the database applies masking and scope to every statement
const EDITABLE: Record<string, [string, string][]> = {
  guardians: [['g_name', 'name'], ['g_relation', 'relation'], ['g_email', 'email'], ['g_alt_mobile', 'alt_phone'], ['g_occupation', 'occupation'], ['g_language', 'language']],
  households: [['h_address', 'address'], ['h_locality', 'locality'], ['h_pincode', 'pincode'], ['h_heard_about', 'heard_about']],
  prospects: [['s_gender', 'gender'], ['s_current_school', 'current_school'], ['s_current_grade', 'current_grade']],
  enquiries: [['e_grade', 'grade'], ['e_board', 'board'], ['e_expected_decision', 'expected_decision']],
};
const SENSITIVE_STUDENT: [string, string][] = [['s_dob', 'dob'], ['s_special_needs', 'special_needs']];

on('POST', '/leads/:id/details', async ({ req, p, b }) => {
  const { s, ctx, actor } = await who(req);
  need(canEditLeads(ctx.perms), 'Your role cannot edit records.');
  return asUser(s.userId, ctx.orgId, async (db) => {
    const e = await findEnquiry(db, p.id!);
    const g = await db.one('select * from crm.guardians where org_id = $1 and household_id = $2 order by is_primary desc, created_at limit 1', [ctx.orgId, e.household_id]);
    const targets: Record<string, Row | null> = {
      guardians: g, households: await db.one('select * from crm.households where id = $1', [e.household_id]),
      prospects: await db.one('select *, dob::text as dob from crm.prospects where id = $1', [e.prospect_id]), enquiries: { ...e, expected_decision: e.expected_decision ? String(e.expected_decision).slice(0, 10) : null },
    };
    const changes: string[] = [];
    const before: Record<string, unknown> = {}, after: Record<string, unknown> = {};
    const has_ = (k: string) => Object.prototype.hasOwnProperty.call(b, k);
    for (const [table, fields] of Object.entries(EDITABLE)) {
      const all = table === 'prospects' && seesSensitive(ctx.perms) ? [...fields, ...SENSITIVE_STUDENT] : fields;
      const patch: Row = {};
      for (const [form, col] of all) {
        if (!has_(form)) continue;
        let v: unknown = str(b[form]) || null;
        if (col === 'gender') v = mapGender(v as string);
        if (col === 'relation' && v) v = String(v).toLowerCase();
        const old = targets[table]?.[col] ?? null;
        if (String(old ?? '') !== String(v ?? '')) { patch[col] = v; before[col] = old; after[col] = v; changes.push(col.replace(/_/g, ' ')); }
      }
      if (Object.keys(patch).length && targets[table]) await db.update(table === 'households' || table === 'guardians' || table === 'prospects' || table === 'enquiries' ? `crm.${table}` : table, targets[table]!.id, patch);
    }
    if (has_('s_name') && str(b.s_name) && str(b.s_name) !== e.student_name) {
      const cur = (await db.one('select full_name from crm.prospects where id = $1', [e.prospect_id]))!.full_name;
      if (cur !== str(b.s_name)) {
        const n = splitName(str(b.s_name));
        await db.update('crm.prospects', e.prospect_id, { first_name: n.first, last_name: n.last });
        before.student = cur; after.student = str(b.s_name); changes.push('student name');
      }
    }
    if (has_('h_sibling_in_school')) await db.q('update crm.households set sibling_in_school = $2 where id = $1', [e.household_id, b.h_sibling_in_school === 'yes' || b.h_sibling_in_school === true]);
    // custom fields: placeholders of sensitive values stay as they are; the trigger decides who may change a sensitive value
    const fields = await customFields(db, ctx);
    const custom = { ...(e.custom ?? {}) };
    for (const f of fields) {
      const k = 'cf_' + f.key;
      if (!has_(k) || (f.sensitive && !seesSensitive(ctx.perms))) continue;
      const v = str(b[k]);
      // the person may see this value (checked above), so the real one is compared; the log and audit never carry a sensitive value
      const real = String((e.custom_full ?? e.custom ?? {})[f.key] ?? '');
      if (real === v) continue;
      if (f.sensitive && !v) continue;
      before[f.key] = f.sensitive ? mask('x') : custom[f.key] ?? null; after[f.key] = f.sensitive ? mask('x') : v; custom[f.key] = v; changes.push(f.label);
    }
    if (changes.some((c) => fields.some((f) => f.label === c))) await db.q('update crm.enquiries set custom = $2, updated_at = now() where id = $1', [e.id, custom]);
    if (changes.length) {
      await logActivity(db, { householdId: e.household_id, enquiryId: e.id, type: 'field_change', actorId: ctx.user.id, content: 'Updated ' + changes.join(', ') + '.' });
      await audit(db, actor, 'edit', 'enquiry', e.id, 'Edited ' + changes.join(', '), before, after);
    }
    return { ok: true, changed: changes.length, message: changes.length ? 'Details saved.' : 'Nothing changed.' };
  });
});

// DM-02: one action from the household page
on('POST', '/households/:id/sibling', async ({ req, p, b }) => {
  const { s, ctx, actor } = await who(req);
  need(canEditLeads(ctx.perms), 'Your role cannot add children.');
  const hh = await asUser(s.userId, ctx.orgId, (db) => db.one('select id from crm.households where org_id = $1 and id = $2', [ctx.orgId, p.id]));
  if (!hh) throw new NotFoundError('Household not found.');
  if (!ctx.branches.some((x) => x.id === str(b.branchId))) fail('Choose one of your branches.');
  return asSystem(ctx.orgId, async (db) => {
    const g = await db.one('select * from crm.guardians where org_id = $1 and household_id = $2 order by is_primary desc, created_at limit 1', [ctx.orgId, p.id]);
    if (!g) fail('Household not found.', 404);
    const res = await captureEnquiry(db, { studentName: str(b.studentName), guardianName: g!.name, mobile: g!.phone, branchId: str(b.branchId), yearId: ctx.yearId, grade: str(b.grade), dob: str(b.dob) || undefined, source: 'Sibling added by staff', channel: 'Referral' }, actor);
    if (!res.ok) return { status: 422, json: res };
    return { ...res, message: res.status === 're_enquiry' ? 'That child already has an enquiry for this year; it was flagged as a re-enquiry.' : 'Sibling added to this household.' };
  });
});

on('POST', '/leads/:id/reassign', ({ req, p, b }) =>
  onEnquiry(req, p.id!, perms((x) => ['F', 'T'].includes(lvl(x, 'reassign'))), async (db, actor, ctx, e) => {
    const to = await db.one("select id, name from crm.staff_v where org_id = $1 and id = $2 and active and role_key <> 'system'", [ctx.orgId, str(b.ownerId)]);
    if (!to) fail('Choose who to assign to.');
    if (to!.id === e.owner_id) return { ok: true, message: 'Already owned by them.' };
    await db.q('update crm.enquiries set owner_id = $2, updated_at = now() where id = $1', [e.id, to!.id]);
    await db.q("update crm.follow_ups set owner_id = $2 where enquiry_id = $1 and status = 'open'", [e.id, to!.id]);
    await logActivity(db, { householdId: e.household_id, enquiryId: e.id, type: 'system', actorId: actor.id, content: `Reassigned from ${e.owner_name} to ${to!.name}. Reason: ${str(b.reason) || 'not given'}` });
    await notify(db, to!.id, 'assigned', `${e.student_name} reassigned to you by ${actor.name}`, `/crm/households/${e.household_id}?e=${e.id}`);
    return { ok: true, message: `Reassigned to ${to!.name}.` };
  }),
);

// ---------------------------------------------------------------- tasks
on('GET', '/tasks', ({ req }) =>
  asMe(req, async (db, ctx) => {
    need(has(ctx.perms, 'tasks'));
    const tab = str(req.query.tab) || 'today';
    const teamAllowed = ['F', 'T'].includes(lvl(ctx.perms, 'tasks'));
    const team = teamAllowed && req.query.who === 'team';
    const calendar = req.query.view === 'calendar';
    const ps: any[] = [ctx.orgId];
    let where = 'k.org_id = $1';
    if (!team) { ps.push(ctx.user.id); where += ` and k.owner_id = $${ps.length}`; }
    else if (ctx.branchIds.length) { ps.push(ctx.branchIds); where += ` and e.branch_id in (select jsonb_array_elements_text($${ps.length}::jsonb)::uuid)`; }
    const today = `(k.due_at at time zone '${IST}')::date = (now() at time zone '${IST}')::date`;
    const cond = calendar ? "k.status = 'open' and k.due_at > now() - interval '35 days' and k.due_at < now() + interval '45 days'"
      : ({ today: `k.status = 'open' and ${today}`, overdue: "k.status = 'open' and k.due_at < now()", upcoming: `k.status = 'open' and k.due_at > now() and not ${today}`, done: "k.status = 'done' and k.completed_at > now() - interval '14 days'" } as Record<string, string>)[tab] ?? `k.status = 'open' and ${today}`;
    const rows = await db.q(
      `select k.id, k.title, k.type, k.priority, k.status, k.due_at, k.outcome, k.completed_at, k.enquiry_id, e.household_id, st.full_name as student, u.full_name as owner, s.exempt_next_action,
         (select count(*)::int from crm.follow_ups o where o.enquiry_id = k.enquiry_id and o.status = 'open') as open_count
       from crm.follow_ups k join crm.enquiries e on e.org_id = k.org_id and e.id = k.enquiry_id join crm.prospects st on st.org_id = e.org_id and st.id = e.prospect_id
       left join core.staff u on u.org_id = k.org_id and u.user_id = k.owner_id join crm.stages s on s.org_id = e.org_id and s.id = e.stage_id
      where ${where} and ${cond} order by ${tab === 'done' ? 'k.completed_at desc' : 'k.due_at'} limit 300`,
      ps,
    );
    const pl = await pipeline(db);
    return {
      tasks: rows, team, teamAllowed, calendar, tab, taskTypes: TASK_TYPES, reasons: ctx.settings.closure_reasons ?? [],
      stages: pl.stages.map((x) => ({ id: x.id, name: x.name, phase_name: x.phase_name, is_closed: x.is_closed, exempt_next_action: x.exempt_next_action })), can: caps(ctx),
    };
  }),
);

/**
 * Completes a task. If that leaves an open enquiry with nothing planned, the same submit must carry the next task or a
 * stage move; otherwise nothing is saved (TSK-03).
 */
on('POST', '/tasks/:id/complete', async ({ req, p, b }) => {
  const { s, ctx, actor } = await who(req);
  need(canWorkTasks(ctx.perms), 'Your role cannot complete tasks.');
  const seen = await asUser(s.userId, ctx.orgId, (db) => db.one('select id from crm.follow_ups where org_id = $1 and id = $2', [ctx.orgId, p.id]));
  if (!seen) throw new NotFoundError('Task not found.');
  return asSystem(ctx.orgId, async (db) => {
    const t = await db.one("select * from crm.follow_ups where org_id = $1 and id = $2 and status = 'open'", [ctx.orgId, p.id]);
    if (!t) return { status: 422, json: { ok: false, error: 'This task is already closed.' } };
    const next = str(b.next) || 'none';
    if (t.enquiry_id) {
      const e = (await getEnquiry(db, t.enquiry_id))!;
      const others = await db.one("select count(*)::int n from crm.follow_ups where org_id = $1 and enquiry_id = $2 and status = 'open' and id <> $3", [ctx.orgId, t.enquiry_id, t.id]);
      const mustPlan = !e.is_closed && !e.is_won && !e.exempt_next_action && others!.n === 0;
      if (next === 'task') {
        if (!str(b.nextDue)) return { status: 422, json: { ok: false, error: 'Pick a date and time for the next action.' } };
        await addTask(db, { enquiryId: e.id, type: TASK_TYPES[str(b.nextType)] ? str(b.nextType) : 'call_back', title: str(b.nextTitle) || 'Follow-up', dueAt: parseLocal(str(b.nextDue)) });
      } else if (next === 'stage') {
        if (!str(b.stageId)) return { status: 422, json: { ok: false, error: 'Choose the stage to move to.' } };
        const target = await db.one('select exempt_next_action from crm.stages where org_id = $1 and id = $2', [ctx.orgId, str(b.stageId)]);
        if (mustPlan && !target?.exempt_next_action) return { status: 422, json: { ok: false, error: 'That stage still needs a next action. Schedule a task, or close the enquiry with a reason.' } };
        const res = await changeStage(db, e.id, str(b.stageId), actor, { closure_reason: str(b.closure_reason) || undefined });
        if (!res.ok) return { status: 422, json: { ok: false, error: res.missing ? 'Choose a closure reason to close this enquiry.' : res.error } };
      } else if (mustPlan) return { status: 422, json: { ok: false, error: 'This enquiry would be left with no next action. Schedule the next task, or close it with a reason.' } };
    }
    await completeTask(db, t.id, actor, str(b.outcome));
    return { ok: true, message: 'Task completed.' };
  });
});

on('POST', '/tasks/:id/reschedule', async ({ req, p, b }) => {
  const { s, ctx } = await who(req);
  need(canWorkTasks(ctx.perms), 'Your role cannot change tasks.');
  const due = new Date(str(b.due));
  if (isNaN(due.getTime())) fail('Pick a valid date.');
  return asUser(s.userId, ctx.orgId, async (db) => {
    const r = await db.update('crm.follow_ups', p.id!, { due_at: due });
    if (!r) throw new NotFoundError('Task not found.');
    return { ok: true };
  });
});

// ---------------------------------------------------------------- inbox (WA-02)
on('GET', '/inbox', ({ req }) =>
  asMe(req, async (db, ctx) => {
    need(has(ctx.perms, 'leads') && has(ctx.perms, 'templates'));
    const ps: any[] = [];
    const scope = (await import('../auth')).scopeSql(ctx, ps);
    const f = str(req.query.f) || 'open';
    const convs = await db.q(
      `select hh.id, hh.inbox_status, g.name as guardian, g.mobile, min(st.full_name) as student, min(u.full_name) as owner,
         max(m.created_at) as last_at, max(m.created_at) filter (where m.direction = 'in') as last_in,
         (array_agg(m.body order by m.created_at desc))[1] as last_body, (array_agg(m.direction order by m.created_at desc) filter (where not m.is_note))[1] as last_dir,
         count(distinct m.id) filter (where m.direction = 'in' and not m.read)::int as unread
       from crm.messages m join crm.households hh on hh.org_id = m.org_id and hh.id = m.household_id join crm.enquiries e on e.org_id = hh.org_id and e.household_id = hh.id
       join crm.prospects st on st.org_id = e.org_id and st.id = e.prospect_id left join core.staff u on u.org_id = e.org_id and u.user_id = e.owner_id
       left join lateral (select name, phone as mobile from crm.guardians g where g.household_id = hh.id order by is_primary desc limit 1) g on true
      where ${scope} and m.channel = 'whatsapp' group by hh.id, g.name, g.mobile order by last_at desc limit 200`,
      ps,
    );
    const list = convs.filter((c) => (f === 'all' ? true : f === 'unread' ? c.unread > 0 : f === 'unanswered' ? c.last_dir === 'in' : f === 'waiting' ? c.inbox_status === 'open' && c.last_dir === 'out' : f === 'open' ? c.inbox_status === 'open' && c.last_dir !== 'out' : c.inbox_status === f));
    const cur = convs.find((c) => c.id === req.query.h) ?? list[0] ?? null;
    const msgs = cur ? await db.q("select m.id, m.body, m.direction, m.status, m.is_note, m.fail_reason, m.created_at, u.full_name as sender from crm.messages m left join core.staff u on u.org_id = m.org_id and u.user_id = m.sender_id where m.org_id = $1 and m.household_id = $2 and m.channel = 'whatsapp' order by m.created_at", [ctx.orgId, cur.id]) : [];
    const enq = cur ? await db.q('select e.id, st.full_name as student, e.grade, s.name as stage, s.color, e.score, e.temperature from crm.enquiries e join crm.prospects st on st.org_id = e.org_id and st.id = e.prospect_id join crm.stages s on s.org_id = e.org_id and s.id = e.stage_id where e.org_id = $1 and e.household_id = $2', [ctx.orgId, cur.id]) : [];
    const templates = await approvedTemplates(db, 'whatsapp');
    return {
      list, current: cur, messages: msgs, enquiries: enq, templates, sla: Number(ctx.settings.first_response_mins ?? 30), f,
      windowOpen: !!cur?.last_in && Date.now() - new Date(cur.last_in).getTime() < 24 * 3600e3, can: caps(ctx), demo: process.env.DEMO_PAYMENTS === '1' || process.env.NODE_ENV !== 'production',
    };
  }),
);
on('POST', '/inbox/:household/status', ({ req, p, b }) =>
  asMe(req, async (db, ctx) => {
    need(has(ctx.perms, 'leads'));
    const status = str(b.status) === 'closed' ? 'closed' : 'open';
    await db.q('update crm.households set inbox_status = $3 where org_id = $1 and id = $2', [ctx.orgId, p.household, status]);
    await db.q("update crm.messages set read = true where org_id = $1 and household_id = $2 and direction = 'in'", [ctx.orgId, p.household]);
    return { ok: true };
  }),
);
/** Stands in for the provider webhook so the inbox, opt-out and stop-on-reply rules can be tried without a live number. */
on('POST', '/inbox/:household/simulate', async ({ req, p, b }) => {
  const { s, ctx } = await who(req);
  need(has(ctx.perms, 'leads'));
  if (process.env.NODE_ENV === 'production' && process.env.DEMO_PAYMENTS !== '1') fail('Simulated replies are only available in demo mode.', 403);
  const ok = await asUser(s.userId, ctx.orgId, (db) => db.one('select id from crm.households where org_id = $1 and id = $2', [ctx.orgId, p.household]));
  if (!ok) throw new NotFoundError();
  await asSystem(ctx.orgId, (db) => receiveMessage(db, p.household!, 'whatsapp', str(b.body) || 'Thank you, please call me after 5 pm.'));
  return { ok: true, message: 'Simulated parent reply received.' };
});

// ---------------------------------------------------------------- applications, documents, payments, admission
on('GET', '/applications', ({ req }) =>
  asMe(req, async (db, ctx) => {
    need(has(ctx.perms, 'applications'));
    const ps: any[] = [];
    const scope = (await import('../auth')).scopeSql(ctx, ps);
    ps.push(ctx.yearId);
    const rows = await db.q(
      `select a.id, a.status, a.progress, a.submitted_at, a.updated_at, e.id as enquiry_id, e.household_id, e.application_no, e.grade, st.full_name as student, s.name as stage, s.color, s.is_won, u.full_name as owner, b.name as branch,
         (select count(*)::int from crm.enquiry_documents d where d.enquiry_id = e.id) as docs,
         (select count(*)::int from crm.enquiry_documents d where d.enquiry_id = e.id and d.status = 'verified') as docs_ok,
         (select count(*)::int from crm.enquiry_documents d where d.enquiry_id = e.id and d.status = 'uploaded') as docs_review,
         (select coalesce(sum(p.amount), 0) from crm.payments p where p.enquiry_id = e.id and p.status = 'paid') as paid,
         (select count(*)::int from crm.payments p where p.enquiry_id = e.id and p.status in ('pending', 'failed')) as pay_open
       from crm.applications a join crm.enquiries e on e.org_id = a.org_id and e.id = a.enquiry_id join crm.prospects st on st.org_id = e.org_id and st.id = e.prospect_id join crm.stages s on s.org_id = e.org_id and s.id = e.stage_id
       left join core.staff u on u.org_id = e.org_id and u.user_id = e.owner_id join core.branches b on b.org_id = e.org_id and b.id = e.branch_id
      where ${scope} and e.academic_year_id = $${ps.length} order by a.updated_at desc limit 300`,
      ps,
    );
    const queue = canVerifyPayment(ctx.perms)
      ? await db.q(`select p.id, p.purpose, p.amount, p.mode, p.reference, p.enquiry_id, st.full_name as student, e.household_id from crm.payments p join crm.enquiries e on e.org_id = p.org_id and e.id = p.enquiry_id join crm.prospects st on st.org_id = e.org_id and st.id = e.prospect_id where ${scope} and p.status = 'pending' and p.mode <> 'link' order by p.created_at`, ps.slice(0, -1))
      : [];
    return { rows, queue, can: caps(ctx) };
  }),
);

on('GET', '/applications/:enquiryId', ({ req, p }) =>
  asMe(req, async (db, ctx) => {
    need(has(ctx.perms, 'applications'));
    const org = ctx.orgId;
    const e = await db.one(
      `select e.*, st.full_name as student, s.name as stage, s.color, s.is_won, s.is_closed, b.name as branch, y.name as year
         from crm.enquiries e join crm.prospects st on st.org_id = e.org_id and st.id = e.prospect_id join crm.stages s on s.org_id = e.org_id and s.id = e.stage_id join core.branches b on b.org_id = e.org_id and b.id = e.branch_id join core.academic_years y on y.org_id = e.org_id and y.id = e.academic_year_id
        where e.org_id = $1 and e.id = $2`,
      [org, p.enquiryId],
    );
    if (!e) throw new NotFoundError('Application not found.');
    const [app, docs, payments, list, issue, seats] = await Promise.all([
      db.one('select * from crm.applications where org_id = $1 and enquiry_id = $2', [org, e.id]),
      db.q('select * from crm.enquiry_documents where org_id = $1 and enquiry_id = $2 order by type', [org, e.id]),
      db.q('select id, purpose, amount, mode, status, receipt_no, reference, token, created_at from crm.payments where org_id = $1 and enquiry_id = $2 order by created_at', [org, e.id]),
      checklist(db, e.id), ageIssue(db, { ...e, prospect_id: e.prospect_id }), seatUse(db, e.branch_id, e.academic_year_id, e.grade),
    ]);
    const k = caps(ctx);
    return {
      enquiry: { id: e.id, household_id: e.household_id, student: e.student, application_no: e.application_no, grade: e.grade, branch: e.branch, year: e.year, stage: e.stage, color: e.color, is_won: e.is_won, is_closed: e.is_closed, public_token: e.public_token },
      application: app, documents: docs, payments: payments.map((x) => ({ ...x, link: x.mode === 'link' && x.status !== 'paid' ? publicUrl('pay', x.token) : null })), checklist: list, ageIssue: issue, seats,
      sections: APPLICATION_SECTIONS, fees: ctx.settings.fees ?? { registration: 1500, admission: 25000 }, can: k, applyUrl: publicUrl('apply', e.public_token),
    };
  }),
);

on('POST', '/leads/:id/application/start', ({ req, p }) =>
  onEnquiry(req, p.id!, perms(canEditApplications), async (db, actor) => {
    await startApplication(db, p.id!, actor);
    return { ok: true, message: 'Application started. Fill it with the parent or send them the link.' };
  }),
);

on('POST', '/leads/:id/application', ({ req, p, b }) =>
  onEnquiry(req, p.id!, perms(canEditApplications), async (db, actor, ctx) => {
    await startApplication(db, p.id!, actor);
    const allowed = new Set(APPLICATION_SECTIONS.flatMap((x) => x.fields).map((f) => f.key));
    const answers = Object.fromEntries(Object.entries((b.answers ?? {}) as Record<string, unknown>).filter(([k]) => allowed.has(k)).map(([k, v]) => [k, str(v)]));
    const res = await saveApplication(db, p.id!, answers, { submit: bool(b.submit), declaration: bool(b.declaration), overrideAge: bool(b.overrideAge) && ['F', 'T', 'Decide'].includes(lvl(ctx.perms, 'applications')) }, actor);
    return res.ok ? { ok: true, message: bool(b.submit) ? 'Application submitted.' : 'Progress saved.' } : { status: 422, json: res };
  }),
);

on('POST', '/leads/:id/admission', ({ req, p, b }) =>
  onEnquiry(req, p.id!, perms((x) => ['F', 'T', 'Decide'].includes(lvl(x, 'applications'))), async (db, actor, ctx) => {
    const res = await confirmAdmission(db, p.id!, actor, isFullAdmin(ctx.perms) && bool(b?.allowOverCapacity));
    return res.ok ? { ...res, message: 'Admission confirmed. The welcome workflow has started.' } : { status: 422, json: res };
  }),
);

on('POST', '/documents/:id', async ({ req, p, b }) => {
  const { s, ctx, actor } = await who(req);
  need(has(ctx.perms, 'applications'));
  const d = await asUser(s.userId, ctx.orgId, (db) => db.one('select * from crm.enquiry_documents where org_id = $1 and id = $2', [ctx.orgId, p.id]));
  if (!d) throw new NotFoundError('Document not found.');
  await asUser(s.userId, ctx.orgId, (db) => findEnquiry(db, d.enquiry_id));
  return asSystem(ctx.orgId, async (db) => {
    const e = (await getEnquiry(db, d.enquiry_id))!;
    const what = str(b.what);
    if (what === 'upload') {
      need(canEditApplications(ctx.perms), 'Your role cannot add documents.');
      if (!str(b.fileName)) fail('Choose a file first.');
      await db.update('crm.enquiry_documents', d.id, { status: 'uploaded', file_name: str(b.fileName).slice(0, 200), reject_reason: null });
      await logActivity(db, { householdId: e.household_id, enquiryId: e.id, type: 'document', actorId: actor.id, content: `${d.type} received (${str(b.fileName).slice(0, 200)}).` });
    } else if (what === 'verify' || what === 'reject') {
      need(canVerifyDocs(ctx.perms), 'Your role cannot verify documents.');
      if (what === 'reject' && !str(b.reason)) fail('Say why the document is rejected so the parent knows what to fix.');
      await db.update('crm.enquiry_documents', d.id, { status: what === 'verify' ? 'verified' : 'rejected', reject_reason: what === 'reject' ? str(b.reason) : null, verifier_id: actor.id });
      await logActivity(db, { householdId: e.household_id, enquiryId: e.id, type: 'document', actorId: actor.id, content: what === 'verify' ? `${d.type} verified.` : `${d.type} rejected: ${str(b.reason)}` });
      if (what === 'reject') await addTask(db, { enquiryId: e.id, type: 'document_chase', title: `Ask the parent to resend: ${d.type}`, dueAt: new Date(Date.now() + 24 * 3600e3) });
      const left = await db.one("select count(*)::int n from crm.enquiry_documents where org_id = $1 and enquiry_id = $2 and status <> 'verified'", [ctx.orgId, e.id]);
      const st = await stageByName(db, left!.n === 0 ? 'Documents verified' : 'Documents pending');
      if (st && ['Fee paid', 'Documents pending'].includes(e.stage_name)) await changeStage(db, e.id, st.id, actor);
    } else fail('Unknown document action.');
    return { ok: true };
  });
});

on('POST', '/leads/:id/payment', ({ req, p, b }) =>
  onEnquiry(req, p.id!, perms(canTakePayment), async (db, actor, ctx, e) => {
    const amount = Number(str(b.amount));
    if (!(amount > 0)) fail('Enter the amount.');
    const mode = ['link', 'cash', 'cheque', 'bank_transfer', 'upi'].includes(str(b.mode)) ? str(b.mode) : 'link';
    const pay = await db.insert('crm.payments', { enquiry_id: e.id, purpose: str(b.purpose) || 'Registration fee', amount, mode, reference: str(b.reference) || null, status: 'pending' });
    if (mode === 'link') {
      const link = publicUrl('pay', pay.token);
      const payTpl = await db.one("select * from core.message_templates where org_id = $1 and product_key = 'crm' and channel = 'whatsapp' and name = 'Payment link' and status = 'approved' and deleted_at is null", [ctx.orgId]);
      const vars = { ...(await mergeVars(db, e)), purpose: pay.purpose, amount: inr(amount), pay_link: link };
      const r = await sendMessage(db, { householdId: e.household_id, enquiryId: e.id, channel: 'whatsapp', body: payTpl ? renderTemplate(payTpl.body, vars) : `Payment link for ${pay.purpose} (${inr(amount)}): ${link}`, actorId: actor.id, template: payTpl, vars });
      return { ok: true, id: pay.id, link, message: r.status !== 'failed' ? 'Payment link sent on WhatsApp.' : 'Link created but not delivered: ' + r.reason };
    }
    if (canVerifyPayment(ctx.perms)) {
      await settlePayment(db, pay.id, true, actor);
      return { ok: true, id: pay.id, message: 'Payment recorded and receipt issued.' };
    }
    await logActivity(db, { householdId: e.household_id, enquiryId: e.id, type: 'payment', outcome: 'collected', actorId: actor.id, content: `${pay.purpose} of ${inr(amount)} collected by ${mode.replace('_', ' ')}. Waiting for accounts to verify.` });
    return { ok: true, id: pay.id, message: 'Recorded. Accounts will verify and issue the receipt.' };
  }),
);

/** Accounts verify an offline payment (issue the receipt) or mark it not received. */
on('POST', '/payments/:id/settle', async ({ req, p, b }) => {
  const { s, ctx, actor } = await who(req);
  need(canVerifyPayment(ctx.perms), 'Only accounts or an admin can verify payments.');
  const pay = await asUser(s.userId, ctx.orgId, (db) => db.one('select id from crm.payments where org_id = $1 and id = $2', [ctx.orgId, p.id]));
  if (!pay) throw new NotFoundError('Payment not found.');
  const success = b.success !== false && str(b.what) !== 'fail';
  const row = await asSystem(ctx.orgId, (db) => settlePayment(db, p.id!, success, actor, str(b.reference) || undefined));
  return { ok: true, payment: row, message: success ? 'Payment verified and receipt issued.' : 'Payment marked as failed.' };
});

// ---------------------------------------------------------------- campaigns (CMP-01, CMP-02)
on('GET', '/campaigns', ({ req }) =>
  asMe(req, async (db, ctx) => {
    need(has(ctx.perms, 'campaigns'));
    const org = ctx.orgId;
    const [rows, templates, views, wallet] = await Promise.all([
      db.q('select c.*, t.name as template, t.category, u.full_name as creator from crm.campaigns c left join core.message_templates t on t.id = c.template_id left join core.staff u on u.org_id = c.org_id and u.user_id = c.created_by where c.org_id = $1 order by c.created_at desc', [org]),
      db.q("select id, name, channel, category from core.message_templates where org_id = $1 and product_key = 'crm' and status = 'approved' and deleted_at is null order by channel, name", [org]),
      db.q('select name, query from crm.saved_views where org_id = $1 and (shared or user_id = $2)', [org, ctx.user.id]),
      db.one('select wallet_balance from crm.settings where org_id = $1', [org]),
    ]);
    // Live results for campaigns sent from this system: what the same families did after the send.
    for (const c of rows) {
      if (c.status === 'draft') { c.count = await countLeads(db, ctx, Object.fromEntries(new URLSearchParams(c.audience?.query ?? '')) as SP); c.estimate = c.count * (MESSAGE_COST[c.channel] ?? 0); continue; }
      if (c.stats.read !== undefined) continue;
      const live = await db.one(
        `with hh as (select distinct household_id from crm.messages where org_id = $1 and campaign_id = $2 and status = 'delivered')
         select (select count(distinct m.household_id)::int from crm.messages m join hh on hh.household_id = m.household_id where m.org_id = $1 and m.direction = 'in' and m.created_at > $3) as replied,
                (select count(distinct v.household_id)::int from crm.visits v join hh on hh.household_id = v.household_id where v.org_id = $1 and v.created_at > $3) as visits,
                (select count(distinct e.household_id)::int from crm.applications a join crm.enquiries e on e.org_id = a.org_id and e.id = a.enquiry_id join hh on hh.household_id = e.household_id where a.org_id = $1 and a.created_at > $3) as applications,
                (select count(distinct e.household_id)::int from crm.enquiries e join crm.stages s on s.org_id = e.org_id and s.id = e.stage_id join hh on hh.household_id = e.household_id where e.org_id = $1 and s.is_won and e.stage_entered_at > $3) as admissions`,
        [org, c.id, c.sent_at],
      );
      c.stats = { ...c.stats, ...live };
    }
    return { campaigns: rows, templates, views, wallet: Number(wallet?.wallet_balance ?? 0), can: caps(ctx), costs: MESSAGE_COST };
  }),
);
on('POST', '/campaigns', ({ req, b }) =>
  asMe(req, async (db, ctx, actor) => {
    need(canRunCampaigns(ctx.perms), 'Your role cannot create campaigns.');
    const tpl = await db.one("select * from core.message_templates where org_id = $1 and product_key = 'crm' and id = $2 and status = 'approved' and deleted_at is null", [ctx.orgId, str(b.templateId)]);
    if (!tpl) fail('Choose an approved template.');
    const c = await db.insert('crm.campaigns', { name: str(b.name) || tpl!.name, channel: tpl!.channel, template_id: tpl!.id, audience: { query: str(b.audience) }, created_by: actor.id });
    return { ok: true, id: c.id, message: 'Draft campaign created. Review the audience and cost, then send.' };
  }),
);
on('POST', '/campaigns/:id/send', async ({ req, p }) => {
  const { s, ctx, actor } = await who(req);
  need(canRunCampaigns(ctx.perms), 'Your role cannot send campaigns.');
  const c = await asUser(s.userId, ctx.orgId, (db) => db.one("select c.*, t.body, t.category from crm.campaigns c join core.message_templates t on t.id = c.template_id where c.org_id = $1 and c.id = $2 and c.status = 'draft'", [ctx.orgId, p.id]));
  if (!c) throw new NotFoundError('Draft campaign not found.');
  const ids = await asUser(s.userId, ctx.orgId, (db) => leadIds(db, ctx, Object.fromEntries(new URLSearchParams(c.audience?.query ?? '')) as SP));
  return asSystem(ctx.orgId, async (db) => {
    const tplRow = await db.one('select * from core.message_templates where id = $1', [c.template_id]);
    // One message per family, even when several children match (MSG-05 frequency rule).
    const seen = new Set<string>();
    let sent = 0, delivered = 0, skipped = 0;
    for (const id of ids) {
      const e = await getEnquiry(db, id);
      if (!e || seen.has(e.household_id)) continue;
      seen.add(e.household_id);
      // CMPL-05: promotional messages never go to families who have already enrolled or closed.
      if (c.category === 'marketing' && (e.is_won || e.is_closed)) { skipped++; continue; }
      const vars = await mergeVars(db, e);
      const r = await sendMessage(db, { householdId: e.household_id, enquiryId: id, channel: c.channel, body: renderTemplate(c.body, vars), actorId: actor.id, campaignId: c.id, template: tplRow, vars });
      sent++;
      if (r.status !== 'failed') delivered++;
    }
    await db.update('crm.campaigns', c.id, { status: 'sent', sent_at: new Date(), cost: delivered * (MESSAGE_COST[c.channel] ?? 0), stats: { targeted: seen.size, sent, delivered, skipped } });
    await audit(db, actor, 'campaign', 'campaign', c.id, `Sent campaign "${c.name}" to ${sent} families`);
    return { ok: true, sent, delivered, skipped, message: `Campaign sent to ${sent} famil${sent === 1 ? 'y' : 'ies'}: ${delivered} delivered, ${sent - delivered} not delivered${skipped ? `, ${skipped} excluded (enrolled or closed)` : ''}.` };
  });
});
on('POST', '/campaigns/:id/delete', ({ req, p }) =>
  asMe(req, async (db, ctx) => {
    need(canRunCampaigns(ctx.perms), 'Your role cannot delete campaigns.');
    await db.q("delete from crm.campaigns where org_id = $1 and id = $2 and status = 'draft'", [ctx.orgId, p.id]);
    return { ok: true };
  }),
);

// kept for the mobile app: the original lookup of who a lead would go to
export { PAGE };
void normMobile;
void seatUse;
import './session';
