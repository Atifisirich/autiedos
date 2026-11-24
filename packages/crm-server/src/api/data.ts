/**
 * Reports with drill-down, CSV export (audited), global search, duplicate finder and household merge, CSV import with a
 * review queue and undo, and the data-subject tools (access export, erasure). Ported from autoedcrm
 * app/(app)/reports, app/api/{export,search,dedupe,dsr,import-failed} and app/actions/admin.ts (data section).
 */
import { asSystem, asUser, ForbiddenError, NotFoundError, type Db, type Row } from '../db';
import { scopeSql, type Ctx } from '../auth';
import { audit, captureEnquiry, changeStage, findHousehold, logActivity, normMobile, sameStudent, stageByName, validMobile } from '../core';
import { listLeads, type SP } from '../leads';
import { adminSections, has, isFullAdmin, leadScope, lvl, mask, seesSensitive } from '../perm';
import { mapStage } from '../migration';
import { parseCsv } from '../util';
import { bool, fail, need, num, on, str, who, type ApiRequest } from './router';

const IST = 'Asia/Kolkata';

// ---------------------------------------------------------------- reports (REP-01..03)
/** The year, branch and every number on the dashboards: one query per block, all inside the person's row policies. */
async function reportData(db: Db, ctx: Ctx, by: string) {
  const ps: any[] = [];
  const scope = scopeSql(ctx, ps) + ` and e.academic_year_id = $${ps.push(ctx.yearId)}`;
  const J = 'from crm.enquiries e join crm.stages s on s.org_id = e.org_id and s.id = e.stage_id join crm.phases p on p.org_id = s.org_id and p.id = s.phase_id';
  const lead = "p.key <> 'prospect'";
  const level = lvl(ctx.perms, 'reports');
  const org = ctx.orgId;
  const visited = "exists (select 1 from crm.visits v where v.enquiry_id = e.id and v.status = 'done')";
  const applied = "exists (select 1 from crm.applications a where a.enquiry_id = e.id and a.status = 'submitted')";
  const [k, phases, seats, branches, sources, team, reasons, ageing, fr, tasks, fields] = await Promise.all([
    db.one(
      `select count(*) filter (where ${lead})::int as enquiries,
         count(*) filter (where ${lead} and exists (select 1 from crm.activities a where a.enquiry_id = e.id and ((a.type = 'call' and a.outcome = 'connected') or a.meta->>'direction' = 'in')))::int as contacted,
         count(*) filter (where ${visited})::int as visited, count(*) filter (where ${visited} and ${applied})::int as visited_applied, count(*) filter (where ${applied})::int as applied,
         count(*) filter (where s.is_won)::int as admitted, count(*) filter (where not s.is_closed and not s.is_won and ${lead})::int as open,
         coalesce(sum(s.probability) filter (where not s.is_closed and not s.is_won), 0)::float / 100 as weighted, count(*) filter (where e.reenquired)::int as reenquired
       ${J} where ${scope}`,
      ps,
    ),
    db.q(`select p.key, p.name, p.seq, count(e.id)::int n ${J} where ${scope} group by p.key, p.name, p.seq order by p.seq`, ps),
    db.q(
      `select pr.name as grade, pr.seq as grade_order, sum(i.capacity)::int as capacity,
         (select count(*)::int ${J} where ${scope} and e.grade = pr.name and s.is_won) as confirmed,
         (select count(*)::int ${J} where ${scope} and e.grade = pr.name and p.key in ('application','evaluation','offer')) as pipeline
       from core.programmes pr join crm.intakes i on i.org_id = pr.org_id and i.programme_id = pr.id and i.academic_year_id = $${ps.length}
       where pr.org_id = $1 and pr.deleted_at is null ${ctx.branchId ? `and pr.branch_id = '${ctx.branchId}'` : ''} group by pr.name, pr.seq order by pr.seq`,
      [...ps],
    ),
    db.q(`select b.id, b.name, count(*) filter (where ${lead})::int as enquiries, count(*) filter (where ${visited})::int as visited, count(*) filter (where s.is_won)::int as admitted ${J} join core.branches b on b.org_id = e.org_id and b.id = e.branch_id where ${scope} group by b.id, b.name order by b.name`, ps),
    db.q(
      `select t.channel, count(*)::int as leads, count(*) filter (where ${visited})::int as visits, count(*) filter (where s.is_won)::int as admissions,
         (select coalesce(sum(cost), 0)::float from crm.sources so where so.org_id = e.org_id and so.channel = t.channel) as cost
       ${J} join lateral (select channel from crm.source_touches t where t.enquiry_id = e.id order by t.created_at limit 1) t on true where ${scope} group by t.channel, e.org_id order by leads desc`,
      ps,
    ),
    db.q(
      `select u.user_id as id, u.full_name as name, count(*) filter (where not s.is_closed and not s.is_won)::int as open, count(*) filter (where s.is_won)::int as admitted, count(*)::int as total,
         (select count(*)::int from crm.activities a where a.actor_id = u.user_id and a.type = 'call' and a.created_at > now() - interval '7 days') as calls,
         (select count(*)::int from crm.activities a where a.actor_id = u.user_id and a.type = 'call' and a.outcome = 'connected' and a.created_at > now() - interval '7 days') as connected,
         (select count(*)::int from crm.visits v where v.host_id = u.user_id and v.status = 'done' and v.slot_at > now() - interval '30 days') as visits,
         (select count(*)::int from crm.follow_ups k where k.owner_id = u.user_id and k.status = 'open' and k.due_at < now()) as overdue
       ${J} join core.staff u on u.org_id = e.org_id and u.user_id = e.owner_id where ${scope} group by u.user_id, u.full_name order by admitted desc, total desc`,
      ps,
    ),
    db.q(`select coalesce(e.closure_reason, 'Not recorded') as reason, count(*)::int n ${J} where ${scope} and s.is_closed group by 1 order by n desc`, ps),
    db.q(
      `select case when now() - e.created_at < interval '1 hour' then '1' when now() - e.created_at < interval '1 day' then '2' when now() - e.created_at < interval '3 days' then '3' else '4' end as bucket, count(*)::int n
       ${J} where ${scope} and p.key = 'enquiry' and e.first_response_at is null group by 1 order by 1`,
      ps,
    ),
    db.one(`select percentile_cont(0.5) within group (order by extract(epoch from (e.first_response_at - e.created_at)) / 60)::float as median ${J} where ${scope} and e.first_response_at is not null and e.created_at > now() - interval '60 days'`, ps),
    db.one(
      `select count(*) filter (where k.status = 'done' and k.completed_at <= k.due_at + interval '1 day')::int as ontime, count(*) filter (where k.status = 'done' or k.due_at < now())::int as due
       from crm.follow_ups k join crm.enquiries e on e.org_id = k.org_id and e.id = k.enquiry_id where ${scope} and k.status <> 'cancelled'`,
      ps,
    ),
    db.q(
      `select f.key, f.label from core.custom_fields f left join crm.field_settings fs on fs.org_id = f.org_id and fs.entity = 'enquiry' and fs.key = f.key
        where f.org_id = $1 and f.product_key = 'crm' and f.entity = 'enquiry' and f.active and f.deleted_at is null and f.field_type = 'select' and not coalesce(fs.sensitive, false) order by f.seq`,
      [org],
    ),
  ]);
  const byField = fields.find((f) => f.key === by) ?? fields[0];
  const byRows = byField
    ? await db.q(`select coalesce(nullif(e.custom->>$${ps.length + 1}, ''), 'Not filled') as v, count(*) filter (where ${lead})::int as enquiries, count(*) filter (where ${visited})::int as visited, count(*) filter (where s.is_won)::int as admitted ${J} where ${scope} group by 1 order by 2 desc`, [...ps, byField.key])
    : [];
  const K = k!;
  const BUCKET: Record<string, string> = { '1': 'Under 1 hour', '2': '1 to 24 hours', '3': '1 to 3 days', '4': 'Over 3 days' };
  return {
    kpis: { ...K, forecast: Math.round(K.admitted + K.weighted), capacity: seats.reduce((a, r) => a + (r.capacity ?? 0), 0), median_first_response: fr?.median ?? null, followup_ontime: tasks!.ontime, followup_due: tasks!.due },
    phases, seats, branches, sources, team, reasons, ageing: ageing.map((r) => ({ bucket: r.bucket, label: BUCKET[r.bucket], n: r.n })), byFields: fields, byField: byField ?? null, byRows,
    showCost: ['F', 'T', 'Mktg', 'V'].includes(level), showTeam: leadScope(ctx.perms) !== 'own' && level !== 'Fin.',
    year: ctx.years.find((y) => y.id === ctx.yearId)?.name, branchName: ctx.branchId ? ctx.branches.find((b) => b.id === ctx.branchId)?.name : null,
  };
}

on('GET', '/reports', async ({ req }) => {
  const { s, ctx } = await who(req);
  need(has(ctx.perms, 'reports'), 'Your role cannot open reports.');
  return asUser(s.userId, ctx.orgId, (db) => reportData(db, ctx, str(req.query.by)));
});

// ---------------------------------------------------------------- CSV (formula-safe, audited)
const cell = (v: unknown) => {
  let s = String(v ?? '');
  // Neutralise spreadsheet formulas in exported text.
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const csv = (head: string[], rows: unknown[][], footer?: string) => [head.join(','), ...rows.map((r) => r.map(cell).join(',')), ...(footer ? ['', cell(footer)] : [])].join('\n');
const fmtDate = (v: unknown) => (v ? new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: IST }).format(new Date(v as string)) : '');
const file = (body: string, name: string) => ({ status: 200, text: { body, contentType: 'text/csv; charset=utf-8', filename: name } });

/** CSV export of the filtered lead set. Permission-checked, logged, and watermarked with who exported it (CMPL-11). */
on('GET', '/export', async ({ req }) => {
  const { s, ctx, actor } = await who(req);
  need(['F', 'T', 'Part'].includes(lvl(ctx.perms, 'bulk')), 'Your role cannot export records.');
  const sp = Object.fromEntries(Object.entries(req.query).filter(([k]) => !['yearId', 'branchId'].includes(k))) as SP;
  return asUser(s.userId, ctx.orgId, async (db) => {
    const rows = await listLeads(db, ctx, sp, 5000);
    const fields = await db.q(
      `select f.key, f.label, coalesce(fs.sensitive, false) as sensitive from core.custom_fields f left join crm.field_settings fs on fs.org_id = f.org_id and fs.entity = 'enquiry' and fs.key = f.key
        where f.org_id = $1 and f.product_key = 'crm' and f.entity = 'enquiry' and f.active and f.deleted_at is null order by f.seq`,
      [ctx.orgId],
    );
    const sens = seesSensitive(ctx.perms);
    const head = ['Student', 'Parent', 'Mobile', 'Grade', 'Branch', 'Stage', 'Owner', 'Score', 'Temperature', 'First source', 'Created', 'Application no.', ...fields.map((f) => f.label)];
    const body = csv(
      head,
      rows.map((r) => [r.student, r.guardian, r.mobile, r.grade, r.branch, r.stage, r.owner, r.score, r.temperature, r.source, fmtDate(r.created_at), r.application_no, ...fields.map((f) => (f.sensitive && !sens ? '' : (r.custom?.[f.key] ?? '')))]),
      `Exported by ${ctx.user.name} (${ctx.user.email ?? ''}) on ${new Date().toISOString()} from AutoED CRM. Contains personal data: handle under your school's privacy policy.`,
    );
    await audit(db, actor, 'export', 'enquiry', null, `Exported ${rows.length} enquiries to CSV`, null, sp);
    return file(body, `autoed-leads-${new Date().toISOString().slice(0, 10)}.csv`);
  });
});

/** The report tables as CSV, so a number someone quotes can be re-checked in a spreadsheet. */
on('GET', '/reports/export', async ({ req }) => {
  const { s, ctx, actor } = await who(req);
  need(has(ctx.perms, 'reports'), 'Your role cannot open reports.');
  return asUser(s.userId, ctx.orgId, async (db) => {
    const d = await reportData(db, ctx, str(req.query.by));
    const t = str(req.query.table);
    const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) + '%' : '');
    let body = '';
    if (t === 'sources') body = csv(['Channel', 'Leads', 'Visits', 'Admissions', 'Lead to admission', ...(d.showCost ? ['Spend', 'Cost per lead', 'Cost per admission'] : [])], d.sources.map((r) => [r.channel, r.leads, r.visits, r.admissions, pct(r.admissions, r.leads), ...(d.showCost ? [r.cost, r.cost ? Math.round(r.cost / r.leads) : '', r.cost && r.admissions ? Math.round(r.cost / r.admissions) : ''] : [])]));
    else if (t === 'team') { need(d.showTeam, 'Your role cannot see the team report.'); body = csv(['Counsellor', 'Open', 'Admissions', 'Conversion', 'Calls, 7 days', 'Connected', 'Visits hosted, 30 days', 'Overdue tasks'], d.team.map((r) => [r.name, r.open, r.admitted, pct(r.admitted, r.total), r.calls, r.connected, r.visits, r.overdue])); }
    else if (t === 'branches') body = csv(['Branch', 'Enquiries', 'Visited', 'Admitted', 'Conversion'], d.branches.map((r) => [r.name, r.enquiries, r.visited, r.admitted, pct(r.admitted, r.enquiries)]));
    else if (t === 'seats') body = csv(['Grade', 'Capacity', 'Confirmed', 'In application to offer', 'Seats left'], d.seats.map((r) => [r.grade, r.capacity, r.confirmed, r.pipeline, Math.max(0, r.capacity - r.confirmed)]));
    else if (t === 'reasons') body = csv(['Closure reason', 'Enquiries'], d.reasons.map((r) => [r.reason, r.n]));
    else if (t === 'funnel') body = csv(['Measure', 'Value'], Object.entries(d.kpis).map(([k, v]) => [k, v]));
    else fail('Choose a report table.');
    await audit(db, actor, 'export', 'report', null, `Exported the ${t} report to CSV`);
    return file(body, `autoed-report-${t}-${new Date().toISOString().slice(0, 10)}.csv`);
  });
});

// ---------------------------------------------------------------- search (WS-08)
on('GET', '/search', async ({ req }) => {
  const { s, ctx } = await who(req);
  const term = str(req.query.q).toLowerCase();
  if (term.length < 2) return { hits: [] };
  return asUser(s.userId, ctx.orgId, async (db) => {
    const ps: any[] = [];
    const where = scopeSql(ctx, ps, 'e', false);
    ps.push('%' + term + '%');
    const n = '$' + ps.length;
    const rows = await db.q(
      `select e.id, e.household_id, st.full_name as student, e.grade, s.name as stage, y.name as year, g.name as guardian, g.mobile,
         case when e.application_no ilike ${n} then 'Application ' || e.application_no
              when exists (select 1 from crm.payments p where p.enquiry_id = e.id and p.receipt_no ilike ${n}) then 'Receipt match'
              when lower(st.full_name) like ${n} or lower(g.name) like ${n} or g.mobile like ${n} or lower(coalesce(g.email, '')) like ${n} then null
              else 'Mentioned in a note' end as why
       from crm.enquiries e join crm.prospects st on st.org_id = e.org_id and st.id = e.prospect_id join crm.stages s on s.org_id = e.org_id and s.id = e.stage_id join core.academic_years y on y.org_id = e.org_id and y.id = e.academic_year_id
       left join lateral (select name, phone as mobile, email from crm.guardians g where g.household_id = e.household_id order by is_primary desc limit 1) g on true
      where ${where} and (lower(st.full_name) like ${n} or lower(g.name) like ${n} or g.mobile like ${n} or lower(coalesce(g.email, '')) like ${n} or e.application_no ilike ${n}
         or exists (select 1 from crm.payments p where p.enquiry_id = e.id and p.receipt_no ilike ${n})
         or exists (select 1 from crm.activities a where a.enquiry_id = e.id and a.type = 'note' and lower(a.content) like ${n}))
      order by e.updated_at desc limit 12`,
      ps,
    );
    return { hits: rows.map((r) => ({ href: `/crm/households/${r.household_id}?e=${r.id}`, title: `${r.student} · ${r.guardian ?? ''}`, sub: [r.why, r.grade, r.stage, r.year, r.mobile].filter(Boolean).join(' · ') })) };
  });
});

// ---------------------------------------------------------------- duplicates and merge (DUP-02, DM-03)
/** Households that look like one family: they share a phone, an alternate phone or an email, or have the same child with the same parent name. */
on('GET', '/data/duplicates', async ({ req }) => {
  const { s, ctx } = await who(req);
  need(['F', 'T', 'Merge only'].includes(lvl(ctx.perms, 'delete')), 'Your role cannot merge families.');
  return asUser(s.userId, ctx.orgId, async (db) => {
    const rows = await db.q(
      `with g as (select g.household_id, g.name, g.phone, g.alt_phone, lower(g.email) as email from crm.guardians g where g.org_id = $1),
            pairs as (
              select a.household_id as a, b.household_id as b, case when a.phone = b.alt_phone or a.alt_phone = b.phone then 'a phone number matches an alternate number' when a.email is not null and a.email = b.email then 'same email address' else 'same alternate number' end as why
                from g a join g b on a.household_id < b.household_id
               where (a.phone = b.alt_phone or a.alt_phone = b.phone or (a.alt_phone is not null and a.alt_phone = b.alt_phone) or (a.email is not null and a.email = b.email))
              union
              select a.household_id, b.household_id, 'same parent name and child' from g a join g b on a.household_id < b.household_id and lower(a.name) = lower(b.name)
               where exists (select 1 from crm.prospects p1 join crm.prospects p2 on lower(p1.full_name) = lower(p2.full_name) where p1.household_id = a.household_id and p2.household_id = b.household_id))
       select a, b, min(why) as why from pairs group by a, b limit 100`,
      [ctx.orgId],
    );
    const ids = [...new Set(rows.flatMap((r) => [r.a, r.b]))];
    const info = ids.length
      ? await db.q(
          `select h.id, (select name from crm.guardians g where g.household_id = h.id order by is_primary desc limit 1) as guardian, (select phone from crm.guardians g where g.household_id = h.id order by is_primary desc limit 1) as mobile,
             (select string_agg(p.full_name, ', ') from crm.prospects p where p.household_id = h.id) as children, (select count(*)::int from crm.enquiries e where e.household_id = h.id) as enquiries
           from crm.households h where h.org_id = $1 and h.id in (select jsonb_array_elements_text($2::jsonb)::uuid)`,
          [ctx.orgId, ids],
        )
      : [];
    const by = new Map(info.map((i) => [i.id, i]));
    return { pairs: rows.map((r) => ({ a: by.get(r.a), b: by.get(r.b), why: r.why })).filter((p) => p.a && p.b) };
  });
});

/** Merges household :id (the duplicate) into `into` (the one to keep). Nothing is lost: every record moves, the same child twice keeps one open enquiry. */
on('POST', '/households/:id/merge', async ({ req, p, b }) => {
  const { s, ctx, actor } = await who(req);
  need(['F', 'T', 'Merge only'].includes(lvl(ctx.perms, 'delete')), 'Your role cannot merge families.');
  const from = p.id!, into = str(b.into);
  if (!into || into === from) fail('Choose the family to keep.');
  const seen = await asUser(s.userId, ctx.orgId, (db) => db.q('select id from crm.households where org_id = $1 and id in (select jsonb_array_elements_text($2::jsonb)::uuid)', [ctx.orgId, [from, into]]));
  if (seen.length !== 2) throw new NotFoundError('Family not found.');
  return asSystem(ctx.orgId, async (db) => {
    const org = ctx.orgId;
    // read first: once the enquiries move, the old household is no longer visible through any enquiry
    const old = (await db.one('select * from crm.households where id = $1', [from]))!;
    const tProspects = await db.q('select id, full_name as name, dob::text as dob from crm.prospects where org_id = $1 and household_id = $2', [org, into]);
    const sProspects = await db.q('select id, full_name as name, dob::text as dob from crm.prospects where org_id = $1 and household_id = $2', [org, from]);
    const dupStage = await stageByName(db, 'Junk / duplicate');
    let closed = 0;
    for (const sp of sProspects) {
      const twin = tProspects.find((t) => sameStudent(t as { name: string; dob: string | null }, sp as { name: string; dob: string | null }));
      if (!twin) continue;
      for (const e of await db.q('select id, academic_year_id, branch_id from crm.enquiries where org_id = $1 and prospect_id = $2', [org, sp.id])) {
        const clash = await db.one('select 1 from crm.enquiries where org_id = $1 and prospect_id = $2 and academic_year_id = $3 and branch_id = $4', [org, twin.id, e.academic_year_id, e.branch_id]);
        if (clash) {
          if (dupStage) { await changeStage(db, e.id, dupStage.id, actor, { closure_reason: 'Other', note: 'Merged: the same child already had an enquiry in the family kept' }); closed++; }
        } else await db.q('update crm.enquiries set prospect_id = $2 where org_id = $1 and id = $3', [org, twin.id, e.id]);
      }
    }
    // guardians: the same phone is the same person, so only new people move across
    for (const g of await db.q('select * from crm.guardians where org_id = $1 and household_id = $2', [org, from])) {
      const twin = await db.one('select id from crm.guardians where org_id = $1 and household_id = $2 and (phone = $3 or ($4::text is not null and lower(email) = lower($4)))', [org, into, g.phone, g.email]);
      if (twin) {
        await db.q("update core.consents set crm_contact_id = $2 where org_id = $1 and crm_contact_id = $3 and subject_type = 'crm_guardian' and not exists (select 1 from core.consents c2 where c2.org_id = $1 and c2.crm_contact_id = $2 and c2.purpose = core.consents.purpose and c2.subject_type = 'crm_guardian')", [org, twin.id, g.id]);
        await db.q('delete from crm.guardians where id = $1', [g.id]);
      } else await db.q('update crm.guardians set household_id = $2, is_primary = false where id = $1', [g.id, into]);
    }
    for (const t of ['crm.prospects', 'crm.activities', 'crm.follow_ups', 'crm.messages', 'crm.visits', 'crm.enquiries']) await db.q(`update ${t} set household_id = $2 where org_id = $1 and household_id = $3`, [org, into, from]);
    await db.q('update crm.households set sibling_in_school = sibling_in_school or $2, address = coalesce(address, $3), locality = coalesce(locality, $4), pincode = coalesce(pincode, $5), heard_about = coalesce(heard_about, $6) where id = $1', [into, old.sibling_in_school, old.address, old.locality, old.pincode, old.heard_about]);
    await db.q('select crm.delete_empty_household($1)', [from]);
    await logActivity(db, { householdId: into, type: 'system', actorId: actor.id, content: `Merged a duplicate family into this one (${sProspects.map((x) => x.name).join(', ') || 'no children'}). ${closed ? `${closed} repeated enquir${closed === 1 ? 'y was' : 'ies were'} closed as duplicate.` : ''}`.trim() });
    await audit(db, actor, 'merge', 'household', into, `Merged household ${from} into ${into}`, { from }, { into });
    return { ok: true, into, closedDuplicates: closed, message: 'Families merged. Every record moved to the family you kept.' };
  });
});

// ---------------------------------------------------------------- CSV import with a review queue and undo (CAP-08, DUP-03, HUB-04)
const ALIASES: Record<string, string[]> = {
  studentName: ['student', 'student name', 'child', 'child name', 'name'], guardianName: ['parent', 'parent name', 'guardian', 'father name', 'father', 'mother name'], mobile: ['mobile', 'phone', 'mobile number', 'contact', 'phone number'],
  email: ['email', 'email id'], grade: ['grade', 'class', 'course'], source: ['source', 'lead source'], stage: ['stage', 'status', 'lead stage', 'lead status'], subStage: ['sub stage', 'sub-stage', 'substage', 'sub status'],
};
async function dataAdmin(req: ApiRequest) {
  const w = await who(req);
  if (!adminSections(w.ctx.perms).includes('data')) throw new ForbiddenError('Your role cannot change this setting.');
  return w;
}

on('GET', '/admin/data', async ({ req }) => {
  const { s, ctx } = await dataAdmin(req);
  return asUser(s.userId, ctx.orgId, async (db) => {
    const org = ctx.orgId;
    const [batches, review, failed] = await Promise.all([
      db.q('select b.*, u.full_name as by from crm.import_batches b left join core.staff u on u.org_id = b.org_id and u.user_id = b.created_by where b.org_id = $1 order by b.created_at desc limit 15', [org]),
      db.q(
        `select r.id, r.data, r.match_household_id, b.file_name, g.name as guardian, (select string_agg(st.full_name, ', ') from crm.prospects st where st.household_id = r.match_household_id) as children
         from crm.import_rows r join crm.import_batches b on b.org_id = r.org_id and b.id = r.batch_id left join lateral (select name from crm.guardians g where g.household_id = r.match_household_id order by is_primary desc limit 1) g on true
        where r.org_id = $1 and r.status = 'review' order by b.created_at desc limit 100`,
        [org],
      ),
      db.q("select r.id, r.data, r.error, b.file_name from crm.import_rows r join crm.import_batches b on b.org_id = r.org_id and b.id = r.batch_id where r.org_id = $1 and r.status = 'failed' order by b.created_at desc limit 30", [org]),
    ]);
    return { batches, review, failed, branches: ctx.branches.map((x) => ({ id: x.id, name: x.name })), fullAdmin: isFullAdmin(ctx.perms), canMerge: ['F', 'T', 'Merge only'].includes(lvl(ctx.perms, 'delete')) };
  });
});

on('POST', '/admin/import', async ({ req, b }) => {
  const { ctx, actor } = await dataAdmin(req);
  const text = String(b.csv ?? '');
  if (!text.trim()) fail('Choose a CSV file.');
  if (text.length > 5_000_000) fail('That file is over 5 MB. Split it and import in parts.');
  const rows = parseCsv(text);
  if (rows.length < 2) fail('The file needs a header row and at least one data row.');
  const head = rows[0]!.map((h) => h.trim().toLowerCase());
  const col = (k: string) => head.findIndex((h) => ALIASES[k]!.includes(h));
  if (col('mobile') < 0 || col('studentName') < 0) fail('Could not find the columns. The header needs at least "Student name" and "Mobile" (also read: Parent name, Email, Grade, Source).');
  const strategy = ['review', 'skip', 'touch'].includes(str(b.strategy)) ? str(b.strategy) : 'review';
  const branchId = ctx.branches.find((x) => x.id === str(b.branch_id))?.id ?? ctx.branches[0]!.id;
  const fileName = str(b.fileName) || 'import.csv';
  // Imported records arrive for the whole organisation (owners are assigned by the routing rules), so the org automation actor
  // writes them after the person's own check above, exactly like a web form does.
  return asSystem(ctx.orgId, async (db) => {
    const batch = await db.insert('crm.import_batches', { file_name: fileName, total: rows.length - 1, created_by: actor.id });
    const grades: string[] = ctx.settings.grades ?? [];
    let created = 0, duplicates = 0, failed = 0;
    const unmapped = new Set<string>();
    const seen = new Set<string>();
    for (const r of rows.slice(1)) {
      if (r.every((c) => !c.trim())) continue;
      const get = (k: string) => (col(k) >= 0 ? (r[col(k)] ?? '').trim() : '');
      const data = { studentName: get('studentName'), guardianName: get('guardianName'), mobile: normMobile(get('mobile')), email: get('email'), grade: get('grade'), source: get('source'), stage: get('stage'), subStage: get('subStage') };
      const row = (status: string, extra: Row = {}) => db.insert('crm.import_rows', { batch_id: batch.id, data, status, ...extra });
      const error = !data.studentName ? 'Student name is missing.' : !validMobile(data.mobile) ? 'Mobile number is not a valid 10-digit Indian mobile.' : data.grade && !grades.includes(data.grade) ? `Grade "${data.grade}" is not one of your grades (${grades.slice(0, 4).join(', ')}…).` : seen.has(data.mobile + data.studentName.toLowerCase()) ? 'Same student and mobile appear earlier in this file.' : null;
      if (error) { failed++; await row('failed', { error }); continue; }
      seen.add(data.mobile + data.studentName.toLowerCase());
      const match = await findHousehold(db, { mobile: data.mobile, email: data.email });
      if (match && strategy !== 'touch') { duplicates++; await row(strategy === 'skip' ? 'skipped' : 'review', { match_household_id: match.household_id }); continue; }
      const mapped = data.stage ? mapStage(data.stage, data.subStage) : null;
      if (data.stage && !mapped) unmapped.add(data.stage);
      const res = await captureEnquiry(db, { ...data, guardianName: data.guardianName || 'Parent', grade: data.grade || undefined, branchId, yearId: ctx.yearId, channel: 'Data', source: data.source || `Import: ${fileName}`, asProspect: str(b.as) !== 'enquiry', consent: { source: str(b.consent_basis) || 'Imported list' }, tags: str(b.tag) ? [str(b.tag)] : [] }, actor);
      // Migrated records keep their place in the journey (Appendix B), without firing welcome workflows again.
      if (res.ok && res.status === 'created' && mapped) {
        const st = await stageByName(db, mapped.stage);
        if (st) {
          await db.q("update crm.enquiries set stage_id = $2, temperature = coalesce($3, temperature), closure_reason = case when $4 then 'Imported as closed' else closure_reason end where id = $1", [res.enquiryId, st.id, mapped.temperature ?? null, st.is_closed]);
          await logActivity(db, { householdId: res.householdId, enquiryId: res.enquiryId, type: 'system', content: `Imported from "${fileName}" with stage "${data.stage}${data.subStage ? ' / ' + data.subStage : ''}", mapped to ${mapped.stage}.` });
          if (st.is_closed || st.is_won || st.exempt_next_action) await db.q("update crm.follow_ups set status = 'cancelled' where enquiry_id = $1 and status = 'open'", [res.enquiryId]);
        }
      }
      if (!res.ok) { failed++; await row('failed', { error: res.error }); }
      else if (res.status === 'created') { created++; await row('created', { enquiry_id: res.enquiryId }); }
      else { duplicates++; await row('merged', { enquiry_id: res.enquiryId, match_household_id: res.householdId }); }
    }
    await db.update('crm.import_batches', batch.id, { created, duplicates, failed });
    await audit(db, actor, 'import', 'enquiry', batch.id, `Imported ${fileName}: ${created} created, ${duplicates} duplicates, ${failed} failed`);
    return { ok: true, id: batch.id, created, duplicates, failed, unmapped: [...unmapped], message: `Import finished: ${created} created, ${duplicates} already known${strategy === 'review' && duplicates ? ' (in the review queue)' : ''}, ${failed} with problems.` + (unmapped.size ? ` Stages not recognised (kept at the start of the pipeline): ${[...unmapped].slice(0, 5).join(', ')}.` : '') };
  });
});

on('POST', '/admin/import/review', async ({ req, b }) => {
  const { ctx, actor } = await dataAdmin(req);
  const what = str(b.what) === 'discard' ? 'discard' : 'merge';
  return asSystem(ctx.orgId, async (db) => {
    const rows = await db.q("select r.*, b.file_name from crm.import_rows r join crm.import_batches b on b.org_id = r.org_id and b.id = r.batch_id where r.org_id = $1 and r.status = 'review' and ($2 = '' or r.id::text = $2)", [ctx.orgId, str(b.rowId)]);
    for (const r of rows) {
      if (what === 'discard') { await db.update('crm.import_rows', r.id, { status: 'discarded' }); continue; }
      // Merge: the same child becomes a re-enquiry touch, a new name becomes a sibling in the matched household.
      const g = await db.one('select phone from crm.guardians where household_id = $1 order by is_primary desc limit 1', [r.match_household_id]);
      const res = await captureEnquiry(db, { studentName: r.data.studentName, guardianName: r.data.guardianName, mobile: g?.phone ?? r.data.mobile, grade: r.data.grade || undefined, branchId: ctx.branches[0]!.id, yearId: ctx.yearId, channel: 'Data', source: `Import: ${r.file_name}`, asProspect: true }, actor);
      await db.update('crm.import_rows', r.id, { status: res.ok ? 'merged' : 'failed', error: res.ok ? null : res.error, enquiry_id: res.ok ? res.enquiryId : null });
    }
    return { ok: true, count: rows.length, message: `${rows.length} row${rows.length === 1 ? '' : 's'} ${what === 'discard' ? 'discarded' : 'merged into existing households'}.` };
  });
});

on('POST', '/admin/import/:id/undo', async ({ req, p }) => {
  const { ctx, actor } = await dataAdmin(req);
  return asSystem(ctx.orgId, async (db) => {
    const batch = await db.one("select * from crm.import_batches where org_id = $1 and id = $2 and status = 'done'", [ctx.orgId, p.id]);
    if (!batch) throw new NotFoundError('Import not found, or it was already undone.');
    const rows = await db.q("select enquiry_id from crm.import_rows where org_id = $1 and batch_id = $2 and status = 'created' and enquiry_id is not null", [ctx.orgId, batch.id]);
    let removed = 0;
    for (const r of rows) {
      const e = await db.one('select household_id, prospect_id from crm.enquiries where org_id = $1 and id = $2', [ctx.orgId, r.enquiry_id]);
      if (!e) continue;
      await db.q('delete from crm.enquiries where id = $1', [r.enquiry_id]);
      await db.q('delete from crm.prospects where id = $1 and not exists (select 1 from crm.enquiries where prospect_id = $1)', [e.prospect_id]);
      await db.q('delete from crm.households where id = $1 and not exists (select 1 from crm.enquiries where household_id = $1) and not exists (select 1 from crm.prospects where household_id = $1)', [e.household_id]);
      removed++;
    }
    await db.update('crm.import_batches', batch.id, { status: 'undone' });
    await audit(db, actor, 'delete', 'enquiry', batch.id, `Undid import ${batch.file_name}: removed ${removed} records`);
    return { ok: true, removed, message: `Import undone: ${removed} records it created were removed. Records that already existed were not touched.` };
  });
});

/** Failed rows of an import as CSV, with the reason, ready to fix and re-upload (HUB-04). */
on('GET', '/admin/import/:id/failed', async ({ req, p }) => {
  const { s, ctx } = await dataAdmin(req);
  return asUser(s.userId, ctx.orgId, async (db) => {
    const rows = await db.q("select data, error from crm.import_rows where org_id = $1 and batch_id = $2 and status = 'failed'", [ctx.orgId, p.id]);
    return file(csv(['Student name', 'Parent name', 'Mobile', 'Email', 'Grade', 'Source', 'Problem'], rows.map((r) => [r.data.studentName, r.data.guardianName, r.data.mobile, r.data.email, r.data.grade, r.data.source, r.error])), 'import-problems.csv');
  });
});

// ---------------------------------------------------------------- data-subject requests (CMPL-03)
const familyOf = async (db: Db, orgId: string, mobile: string) => db.one('select household_id from crm.guardians where org_id = $1 and (phone = $2 or alt_phone = $2)', [orgId, normMobile(mobile)]);

/** Access request: everything held about one family, as a JSON download. */
on('GET', '/admin/dsr/access', async ({ req }) => {
  const { ctx, actor } = await dataAdmin(req);
  need(isFullAdmin(ctx.perms), "Only a group admin can export a family's data.");
  const mobile = normMobile(req.query.mobile);
  return asSystem(ctx.orgId, async (db) => {
    const g = await familyOf(db, ctx.orgId, mobile);
    if (!g) throw new NotFoundError('No household has that mobile number.');
    const h = g.household_id, t = ctx.orgId;
    const data = {
      exported_at: new Date().toISOString(), school: ctx.org.name,
      household: await db.one('select address, locality, pincode, heard_about, home_language, sibling_in_school, created_at from crm.households where id = $1', [h]),
      guardians: await db.q('select name, relation, phone, alt_phone, email, occupation, language from crm.guardians where org_id = $1 and household_id = $2', [t, h]),
      consents: await db.q("select c.purpose, c.granted, c.source, c.granted_at, c.withdrawn_at from core.consents c join crm.guardians g on g.id = c.crm_contact_id where c.org_id = $1 and c.subject_type = 'crm_guardian' and g.household_id = $2", [t, h]),
      students: await db.q('select full_name as name, dob::text, gender, current_school, current_grade, special_needs from crm.prospects where org_id = $1 and household_id = $2', [t, h]),
      enquiries: await db.q('select e.id, e.grade, e.board, s.name as stage, e.closure_reason, e.custom, e.tags, e.application_no, e.created_at from crm.enquiries_full e join crm.stages s on s.org_id = e.org_id and s.id = e.stage_id where e.org_id = $1 and e.household_id = $2', [t, h]),
      timeline: await db.q('select type, outcome, content, created_at from crm.activities where org_id = $1 and household_id = $2 order by created_at', [t, h]),
      messages: await db.q('select channel, direction, body, status, created_at from crm.messages where org_id = $1 and household_id = $2 order by created_at', [t, h]),
      visits: await db.q('select type, slot_at, status, outcome from crm.visits where org_id = $1 and household_id = $2', [t, h]),
      applications: await db.q('select a.answers, a.status, a.submitted_at from crm.applications a join crm.enquiries e on e.org_id = a.org_id and e.id = a.enquiry_id where e.org_id = $1 and e.household_id = $2', [t, h]),
      payments: await db.q('select p.purpose, p.amount, p.status, p.receipt_no, p.paid_at from crm.payments p join crm.enquiries e on e.org_id = p.org_id and e.id = p.enquiry_id where e.org_id = $1 and e.household_id = $2', [t, h]),
    };
    await audit(db, actor, 'export', 'household', h, "Exported one family's data for an access request");
    return { status: 200, text: { body: JSON.stringify(data, null, 2), contentType: 'application/json', filename: `family-data-${mobile}.json` } };
  });
});

/** Erasure request: personal data is anonymised; counts and stage history stay for reporting. */
on('POST', '/admin/dsr/erase', async ({ req, b }) => {
  const { ctx, actor } = await dataAdmin(req);
  need(isFullAdmin(ctx.perms), 'Only a group admin can erase personal data.');
  if (str(b.confirm) !== 'ERASE') fail('Type ERASE to confirm. This cannot be undone.');
  return asSystem(ctx.orgId, async (db) => {
    const g = await familyOf(db, ctx.orgId, str(b.mobile));
    if (!g) fail('No household has that mobile number.', 404);
    const h = g!.household_id;
    // A child admitted to the school already has a core.students row: that record belongs to the school's student file and is
    // handled with the compliance tooling (person erasure), not from the enquiry desk.
    const admitted = await db.one('select count(*)::int n from crm.prospects where org_id = $1 and household_id = $2 and core_student_id is not null', [ctx.orgId, h]);
    await db.q("update crm.guardians set name = 'Erased', phone = 'x' || substr(replace(id::text, '-', ''), 1, 12), alt_phone = null, email = null, occupation = null where org_id = $1 and household_id = $2", [ctx.orgId, h]);
    await db.q("update core.consents set granted = false, withdrawn_at = coalesce(withdrawn_at, now()) where org_id = $1 and subject_type = 'crm_guardian' and crm_contact_id in (select id from crm.guardians where household_id = $2)", [ctx.orgId, h]);
    await db.q("update crm.prospects set first_name = 'Erased', last_name = null, dob = null, special_needs = null, current_school = null where org_id = $1 and household_id = $2", [ctx.orgId, h]);
    await db.q('update crm.households set address = null, locality = null, pincode = null, heard_about = null where id = $1', [h]);
    await db.q('delete from crm.messages where org_id = $1 and household_id = $2', [ctx.orgId, h]);
    await db.q("update crm.activities set content = '[erased on request]', meta = '{}'::jsonb where org_id = $1 and household_id = $2", [ctx.orgId, h]);
    await db.q("update crm.applications set answers = '{}'::jsonb where org_id = $1 and enquiry_id in (select id from crm.enquiries where household_id = $2)", [ctx.orgId, h]);
    await db.q('delete from crm.enquiry_sensitive where org_id = $1 and enquiry_id in (select id from crm.enquiries where household_id = $2)', [ctx.orgId, h]);
    await db.q("update crm.enquiries set custom = '{}'::jsonb where org_id = $1 and household_id = $2", [ctx.orgId, h]);
    await audit(db, actor, 'erase', 'household', h, 'Erased personal data on a data-subject request');
    return { ok: true, admittedChildren: admitted!.n, message: 'Personal data erased. Anonymous counts remain for reports.' + (admitted!.n ? ' A child of this family is an admitted student: use the compliance tools to erase their student record.' : '') };
  });
});

void mask;
void num;
void bool;
