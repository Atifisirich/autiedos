/**
 * Timetable (PRD 5.3) and substitution (PRD 5.4).
 */
import { generateTimetable, detectClashes, clashesForMove, rankSubstitutes, isoWeekday, addDays, type GenInput, type TTEntry, type TeacherLimits, type SubCandidate } from '@autoed/shared';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError, insert, insertMany, maybe, one, q, update, asService, type Tx } from '../db';
import { branchInfo, need, needModule, run, localToday, staffWithRole, type Ctx } from '../core';
import { notify } from '../notify';
import { enqueue } from '../jobs';
import { systemTask } from './tasks';

// ---------------------------------------------------------------- inputs
export async function listAllocations(ctx: Ctx) {
  needModule(ctx, 'timetable');
  return run(ctx, async (c) =>
    q(
      c,
      `select ta.*, s.full_name as staff_name, cl.name || ' ' || se.name as section_name, sb.name as subject_name, co.full_name as co_teacher_name
       from public.teacher_allocations ta join public.staff s on s.id = ta.staff_id join public.sections se on se.id = ta.section_id join public.classes cl on cl.id = se.class_id
       join public.subjects sb on sb.id = ta.subject_id left join public.staff co on co.id = ta.co_teacher_id
       where ta.branch_id = $1 and ta.deleted_at is null order by cl.seq, se.name, sb.name`,
      [ctx.branchId],
    ),
  );
}

export async function saveAllocation(ctx: Ctx, input: { id?: string; staff_id: string; section_id: string; subject_id: string; periods_per_week: number; double_periods: number; co_teacher_id?: string | null; group_key?: string | null; combined_key?: string | null; room_type?: string | null }) {
  need(ctx, 'timetable', 'configure');
  return run(ctx, async (c) => {
    const ay = await maybe<{ id: string }>(c, `select id from public.academic_years where branch_id = $1 and is_current`, [ctx.branchId]);
    const row = { org_id: ctx.orgId, branch_id: ctx.branchId, academic_year_id: ay?.id ?? null, ...input };
    if (input.id) return update(c, 'teacher_allocations', input.id, row);
    return insert(c, 'teacher_allocations', row, { onConflict: '(section_id, subject_id, staff_id) do update set periods_per_week = excluded.periods_per_week, double_periods = excluded.double_periods, co_teacher_id = excluded.co_teacher_id, group_key = excluded.group_key, combined_key = excluded.combined_key, room_type = excluded.room_type, deleted_at = null' });
  });
}

/** Builds the generator input from the database (teachers, limits, unavailable slots, fixed slots, rooms). */
export async function buildGenInput(c: Tx, branchId: string, lockedFromVersion?: string | null): Promise<GenInput> {
  const sections = await q<{ id: string; class_teacher_id: string | null; wing_id: string }>(c, `select se.id, se.class_teacher_id, cl.wing_id from public.sections se join public.classes cl on cl.id = se.class_id where se.branch_id = $1 and se.deleted_at is null`, [branchId]);
  const bells = await q<{ wing_id: string | null; days: number[]; n: number }>(
    c,
    `select bs.wing_id, bs.days, count(p.id) filter (where p.kind = 'period')::int as n from public.bell_schedules bs join public.periods p on p.bell_schedule_id = bs.id and p.deleted_at is null
     where bs.branch_id = $1 and bs.active and bs.deleted_at is null group by bs.id, bs.wing_id, bs.days`,
    [branchId],
  );
  const days = [...new Set(bells.flatMap((b) => b.days))].sort();
  const ppd = (wing: string) => {
    const own = bells.filter((b) => b.wing_id === wing);
    const list = own.length ? own : bells.filter((b) => b.wing_id === null);
    const map: Record<number, number> = {};
    for (const b of list) for (const d of b.days) map[d] = Math.max(map[d] ?? 0, b.n);
    return map;
  };
  const allocs = await q<{ id: string; section_id: string; subject_id: string; staff_id: string; periods_per_week: number; double_periods: number; group_key: string | null; combined_key: string | null; co_teacher_id: string | null; room_type: string | null; is_core: boolean }>(
    c,
    `select ta.id, ta.section_id, ta.subject_id, ta.staff_id, ta.periods_per_week, ta.double_periods, ta.group_key, ta.combined_key, ta.co_teacher_id, ta.room_type, sb.is_core
     from public.teacher_allocations ta join public.subjects sb on sb.id = ta.subject_id where ta.branch_id = $1 and ta.deleted_at is null and ta.periods_per_week > 0`,
    [branchId],
  );
  const staffIds = [...new Set(allocs.flatMap((a) => [a.staff_id, a.co_teacher_id].filter((x): x is string => !!x)))];
  const staff = await q<{ id: string; max_periods_day: number; max_periods_week: number; unavailable: { day: number; period_seq: number }[] }>(c, `select id, max_periods_day, max_periods_week, unavailable from public.staff where id = any($1)`, [staffIds]);
  const constraints = await q<{ kind: string; data: Record<string, unknown> }>(c, `select kind, data from public.timetable_constraints where branch_id = $1 and deleted_at is null`, [branchId]);
  const teachers: GenInput['teachers'] = {};
  for (const s of staff) teachers[s.id] = { maxPerDay: s.max_periods_day, maxPerWeek: s.max_periods_week, unavailable: (s.unavailable ?? []).map((u) => ({ day: u.day, periodSeq: u.period_seq })) };
  for (const k of constraints.filter((x) => x.kind === 'teacher_unavailable')) {
    const t = teachers[k.data.staff_id as string];
    if (t) t.unavailable.push({ day: Number(k.data.day), periodSeq: Number(k.data.period_seq) });
  }
  const fixedSlots = constraints.filter((x) => x.kind === 'fixed_slot').map((k) => ({ sectionId: (k.data.section_id as string) ?? null, day: Number(k.data.day), periodSeq: Number(k.data.period_seq), label: String(k.data.label ?? 'Fixed') }));
  const rooms = await q<{ id: string; room_type: string }>(c, `select id, room_type from public.rooms where branch_id = $1 and deleted_at is null and room_type <> 'classroom'`, [branchId]);
  const locked = lockedFromVersion
    ? (await q<{ day: number; period_seq: number; section_id: string; subject_id: string | null; staff_id: string | null; room_id: string | null; group_key: string | null }>(c, `select day, period_seq, section_id, subject_id, staff_id, room_id, group_key from public.timetable_entries where version_id = $1 and locked and fixed_label is null and deleted_at is null`, [lockedFromVersion])).map((e) => ({ day: e.day, periodSeq: e.period_seq, sectionId: e.section_id, subjectId: e.subject_id, staffId: e.staff_id, roomId: e.room_id, groupKey: e.group_key, combinedKey: null }))
    : [];
  return {
    days: days.length ? days : [1, 2, 3, 4, 5, 6],
    sections: sections.map((s) => ({ id: s.id, periodsPerDay: ppd(s.wing_id), classTeacherId: s.class_teacher_id })),
    allocations: allocs.map((a) => ({ id: a.id, sectionId: a.section_id, subjectId: a.subject_id, staffId: a.staff_id, periodsPerWeek: a.periods_per_week, doublePeriods: a.double_periods, groupKey: a.group_key, combinedKey: a.combined_key, coTeacherId: a.co_teacher_id, roomType: a.room_type, isCore: a.is_core })),
    teachers,
    rooms: rooms.map((r) => ({ id: r.id, type: r.room_type })),
    fixedSlots,
    locked,
  };
}

/** Starts generation as a background job (PRD 3.1). */
export async function startGeneration(ctx: Ctx, input: { name: string; keep_locked_from_version_id?: string | null }) {
  need(ctx, 'timetable', 'configure');
  return run(ctx, async (c, sys) => {
    const ay = await maybe<{ id: string }>(c, `select id from public.academic_years where branch_id = $1 and is_current`, [ctx.branchId]);
    const v = await insert<{ id: string }>(c, 'timetable_versions', { org_id: ctx.orgId, branch_id: ctx.branchId, academic_year_id: ay?.id ?? null, name: input.name, status: 'generating', based_on_version_id: input.keep_locked_from_version_id ?? null });
    const jobId = await sys(() => enqueue(c, 'timetable_generate', { version_id: v.id, branch_id: ctx.branchId, locked_from: input.keep_locked_from_version_id ?? null }, { orgId: ctx.orgId, branchId: ctx.branchId, dedupeKey: `ttgen:${v.id}`, maxAttempts: 2 }));
    await sys(() => c.query(`update public.timetable_versions set job_id = $2 where id = $1`, [v.id, jobId]));
    return { version_id: v.id, job_id: jobId };
  });
}

export async function runGeneration(versionId: string): Promise<{ entries: number; unplaced: number; ms: number }> {
  return asService(async (c) => {
    const v = await one<{ id: string; org_id: string; branch_id: string; based_on_version_id: string | null }>(c, `select id, org_id, branch_id, based_on_version_id from public.timetable_versions where id = $1`, [versionId]);
    const input = await buildGenInput(c, v.branch_id, v.based_on_version_id);
    const res = generateTimetable(input);
    const homeRoom = new Map((await q<{ id: string; room_id: string | null }>(c, `select id, room_id from public.sections where branch_id = $1`, [v.branch_id])).map((r) => [r.id, r.room_id]));
    await c.query(`delete from public.timetable_entries where version_id = $1`, [v.id]);
    await insertMany(c, 'timetable_entries', res.entries.map((e) => ({ org_id: v.org_id, branch_id: v.branch_id, version_id: v.id, day: e.day, period_seq: e.periodSeq, section_id: e.sectionId, subject_id: e.subjectId, staff_id: e.staffId, room_id: e.roomId ?? homeRoom.get(e.sectionId) ?? null, group_key: e.groupKey, fixed_label: e.fixedLabel ?? null, locked: !!e.locked })));
    await c.query(`update public.timetable_versions set status = 'generated', generated_at = now(), unplaced = $2, score = $3 where id = $1`, [v.id, JSON.stringify(res.unplaced), res.score]);
    return { entries: res.entries.length, unplaced: res.unplaced.length, ms: res.stats.ms };
  });
}

export async function versions(ctx: Ctx) {
  needModule(ctx, 'timetable');
  return run(ctx, async (c) => q(c, `select id, name, status, effective_from, generated_at, unplaced, score, created_at from public.timetable_versions where branch_id = $1 and deleted_at is null order by created_at desc`, [ctx.branchId]));
}

export async function currentVersionId(c: Tx, branchId: string, date: string): Promise<string | null> {
  const v = await maybe<{ id: string }>(c, `select id from public.timetable_versions where branch_id = $1 and status = 'published' and (effective_from is null or effective_from <= $2) and deleted_at is null order by effective_from desc nulls last, created_at desc limit 1`, [branchId, date]);
  return v?.id ?? null;
}

/** Grid by section, teacher or room, with names, plus clash list. */
export async function grid(ctx: Ctx, input: { version_id?: string; by: 'section' | 'teacher' | 'room'; id: string }) {
  needModule(ctx, 'timetable');
  return run(ctx, async (c) => {
    const versionId = input.version_id ?? (await currentVersionId(c, ctx.branchId, localToday(ctx)));
    if (!versionId) return { version_id: null, entries: [], periods: [] };
    const col = input.by === 'section' ? 'e.section_id' : input.by === 'teacher' ? 'e.staff_id' : 'e.room_id';
    const entries = await q(
      c,
      `select e.id, e.day, e.period_seq, e.section_id, e.subject_id, e.staff_id, e.room_id, e.locked, e.group_key, e.fixed_label,
         cl.name || ' ' || se.name as section_name, sb.name as subject_name, s.full_name as staff_name, r.name as room_name
       from public.timetable_entries e join public.sections se on se.id = e.section_id join public.classes cl on cl.id = se.class_id
       left join public.subjects sb on sb.id = e.subject_id left join public.staff s on s.id = e.staff_id left join public.rooms r on r.id = e.room_id
       where e.version_id = $1 and ${col} = $2 and e.deleted_at is null order by e.day, e.period_seq`,
      [versionId, input.id],
    );
    const periods = await q(
      c,
      `select distinct on (p.teaching_index) p.teaching_index, p.label, p.starts_at::text, p.ends_at::text from public.periods p join public.bell_schedules bs on bs.id = p.bell_schedule_id
       where bs.branch_id = $1 and bs.active and p.kind = 'period' and p.deleted_at is null order by p.teaching_index, bs.wing_id nulls first`,
      [ctx.branchId],
    );
    const version = await one(c, `select id, name, status, effective_from, unplaced from public.timetable_versions where id = $1`, [versionId]);
    return { version, entries, periods };
  });
}

async function versionEntries(c: Tx, versionId: string): Promise<TTEntry[]> {
  return (await q<{ id: string; day: number; period_seq: number; section_id: string; staff_id: string | null; room_id: string | null; subject_id: string | null; group_key: string | null }>(c, `select id, day, period_seq, section_id, staff_id, room_id, subject_id, group_key from public.timetable_entries where version_id = $1 and fixed_label is null and deleted_at is null`, [versionId])).map((e) => ({ id: e.id, day: e.day, periodSeq: e.period_seq, sectionId: e.section_id, staffId: e.staff_id, roomId: e.room_id, subjectId: e.subject_id, groupKey: e.group_key }));
}

async function limitsFor(c: Tx, branchId: string): Promise<Record<string, TeacherLimits>> {
  const rows = await q<{ id: string; max_periods_day: number; max_periods_week: number; unavailable: { day: number; period_seq: number }[] }>(c, `select id, max_periods_day, max_periods_week, unavailable from public.staff where branch_id = $1 and is_teaching`, [branchId]);
  return Object.fromEntries(rows.map((r) => [r.id, { maxPerDay: r.max_periods_day, maxPerWeek: r.max_periods_week, unavailable: (r.unavailable ?? []).map((u) => ({ day: u.day, periodSeq: u.period_seq })) }]));
}

/** Drag and drop with live clash warnings, swap, lock, undo (client sends the inverse op). */
export async function editTimetable(ctx: Ctx, versionId: string, op: { op: 'move' | 'swap' | 'lock' | 'unlock' | 'clear' | 'set'; entry_id?: string; other_entry_id?: string; day?: number; period_seq?: number; section_id?: string; subject_id?: string | null; staff_id?: string | null; room_id?: string | null; force: boolean }) {
  need(ctx, 'timetable', 'edit');
  return run(ctx, async (c) => {
    const v = await maybe<{ status: string; branch_id: string }>(c, `select status, branch_id from public.timetable_versions where id = $1`, [versionId]);
    if (!v) throw new NotFoundError();
    if (v.status === 'published' || v.status === 'archived') throw new ConflictError('published_versions_are_read_only_create_revision');
    const all = await versionEntries(c, versionId);
    const limits = await limitsFor(c, v.branch_id);
    const get = (id?: string) => {
      const e = all.find((x) => x.id === id);
      if (!e) throw new NotFoundError('entry');
      return e;
    };
    let proposed: TTEntry[] = [];
    if (op.op === 'move') {
      const e = get(op.entry_id);
      const locked = await one<{ locked: boolean }>(c, `select locked from public.timetable_entries where id = $1`, [e.id]);
      if (locked.locked) throw new ConflictError('entry_locked');
      proposed = [{ ...e, day: op.day!, periodSeq: op.period_seq! }];
    } else if (op.op === 'swap') {
      const a = get(op.entry_id);
      const b = get(op.other_entry_id);
      proposed = [{ ...a, day: b.day, periodSeq: b.periodSeq }, { ...b, day: a.day, periodSeq: a.periodSeq }];
    } else if (op.op === 'set') {
      proposed = [{ id: op.entry_id ?? 'new', day: op.day!, periodSeq: op.period_seq!, sectionId: op.section_id!, staffId: op.staff_id ?? null, roomId: op.room_id ?? null, subjectId: op.subject_id ?? null }];
    }
    let clashes: ReturnType<typeof detectClashes> = [];
    if (proposed.length) {
      const others = all.filter((x) => !proposed.some((p) => p.id === x.id));
      clashes = detectClashes([...others, ...proposed], limits).filter((cl) => cl.entryIds.some((id) => proposed.some((p) => p.id === id)));
      if (clashes.length && !op.force) return { applied: false, clashes };
    }
    if (op.op === 'move' || op.op === 'swap') for (const p of proposed) await update(c, 'timetable_entries', p.id, { day: p.day, period_seq: p.periodSeq });
    if (op.op === 'lock' || op.op === 'unlock') await update(c, 'timetable_entries', op.entry_id!, { locked: op.op === 'lock' });
    if (op.op === 'clear') await c.query(`delete from public.timetable_entries where id = $1 and version_id = $2`, [op.entry_id, versionId]);
    if (op.op === 'set') {
      const p = proposed[0]!;
      if (op.entry_id) await update(c, 'timetable_entries', op.entry_id, { day: p.day, period_seq: p.periodSeq, section_id: p.sectionId, subject_id: p.subjectId, staff_id: p.staffId, room_id: p.roomId });
      else await insert(c, 'timetable_entries', { org_id: ctx.orgId, branch_id: v.branch_id, version_id: versionId, day: p.day, period_seq: p.periodSeq, section_id: p.sectionId, subject_id: p.subjectId, staff_id: p.staffId, room_id: p.roomId });
    }
    return { applied: true, clashes };
  });
}

export async function checkMove(ctx: Ctx, versionId: string, entryId: string, day: number, periodSeq: number) {
  return run(ctx, async (c) => {
    const all = await versionEntries(c, versionId);
    const e = all.find((x) => x.id === entryId);
    if (!e) throw new NotFoundError();
    const v = await one<{ branch_id: string }>(c, `select branch_id from public.timetable_versions where id = $1`, [versionId]);
    return { clashes: clashesForMove(all, { ...e, day, periodSeq }, await limitsFor(c, v.branch_id)) };
  });
}

/** Changes after publishing are versioned with an effective date. */
export async function createRevision(ctx: Ctx, fromVersionId: string, name: string) {
  need(ctx, 'timetable', 'edit');
  return run(ctx, async (c) => {
    const src = await one<{ academic_year_id: string | null; branch_id: string }>(c, `select academic_year_id, branch_id from public.timetable_versions where id = $1`, [fromVersionId]);
    const v = await insert<{ id: string }>(c, 'timetable_versions', { org_id: ctx.orgId, branch_id: src.branch_id, academic_year_id: src.academic_year_id, name, status: 'draft', based_on_version_id: fromVersionId });
    await c.query(
      `insert into public.timetable_entries (org_id, branch_id, version_id, day, period_seq, section_id, subject_id, staff_id, room_id, locked, group_key, fixed_label)
       select org_id, branch_id, $2, day, period_seq, section_id, subject_id, staff_id, room_id, locked, group_key, fixed_label from public.timetable_entries where version_id = $1 and deleted_at is null`,
      [fromVersionId, v.id],
    );
    return { version_id: v.id };
  });
}

export async function publish(ctx: Ctx, versionId: string, effectiveFrom: string) {
  need(ctx, 'timetable', 'configure');
  return run(ctx, async (c, sys) => {
    const all = await versionEntries(c, versionId);
    const v = await one<{ branch_id: string; status: string }>(c, `select branch_id, status from public.timetable_versions where id = $1`, [versionId]);
    if (v.status === 'generating') throw new ConflictError('still_generating');
    const clashes = detectClashes(all, await limitsFor(c, v.branch_id)).filter((x) => ['teacher', 'section', 'room'].includes(x.type));
    if (clashes.length) throw new ValidationError('clashes_present', { clashes });
    await update(c, 'timetable_versions', versionId, { status: 'published', effective_from: effectiveFrom });
    const teachers = [...new Set(all.map((e) => e.staffId).filter((x): x is string => !!x))];
    await sys(() => notify(c, { orgId: ctx.orgId, branchId: v.branch_id, staffIds: teachers, event: 'meeting.scheduled', titleKey: 'notif.timetable.published', vars: { date: effectiveFrom }, link: '/os/timetable', priority: 'low' }));
    return { ok: true };
  });
}

/** Free-teacher finder for any period. */
export async function freeTeachers(ctx: Ctx, date: string, periodSeq: number) {
  needModule(ctx, 'timetable');
  return run(ctx, async (c) => {
    const vid = await currentVersionId(c, ctx.branchId, date);
    return q(
      c,
      `select s.id, s.full_name, d.name as department,
         (select count(*)::int from public.timetable_entries e where e.version_id = $2 and e.staff_id = s.id and e.day = $3) as periods_today
       from public.staff s left join public.departments d on d.id = s.department_id
       where s.branch_id = $1 and s.is_teaching and s.status = 'active' and s.deleted_at is null
         and not exists (select 1 from public.timetable_entries e where e.version_id = $2 and e.staff_id = s.id and e.day = $3 and e.period_seq = $4)
         and not exists (select 1 from public.substitutions su where su.substitute_staff_id = s.id and su.date = $5 and su.period_seq = $4 and su.status = 'assigned')
         and not exists (select 1 from public.leave_requests lr where lr.staff_id = s.id and lr.status = 'approved' and $5::date between lr.start_date and lr.end_date)
       order by periods_today, s.full_name`,
      [ctx.branchId, vid, isoWeekday(date), periodSeq, date],
    );
  });
}

export async function workload(ctx: Ctx, versionId?: string) {
  needModule(ctx, 'timetable');
  return run(ctx, async (c) => {
    const vid = versionId ?? (await currentVersionId(c, ctx.branchId, localToday(ctx)));
    return q(
      c,
      `select s.id, s.full_name, s.max_periods_week, count(e.id)::int as periods_week,
         max(per_day.n)::int as max_day, json_object_agg(coalesce(per_day.day, 0), per_day.n) filter (where per_day.day is not null) as by_day
       from public.staff s left join public.timetable_entries e on e.staff_id = s.id and e.version_id = $2
       left join lateral (select day, count(*)::int as n from public.timetable_entries x where x.staff_id = s.id and x.version_id = $2 group by day) per_day on true
       where s.branch_id = $1 and s.is_teaching and s.deleted_at is null group by s.id order by periods_week desc`,
      [ctx.branchId, vid],
    );
  });
}

// ---------------------------------------------------------------- substitution
/** Builds candidates and ranks them for each affected period (PRD 5.4). */
export async function generateForAbsence(c: Tx, input: { orgId: string; branchId: string; staffId: string; date: string; source: 'leave' | 'absence' | 'manual'; leaveRequestId?: string; halfDay?: 'none' | 'first' | 'second' }): Promise<number> {
  const flag = await maybe<{ enabled: boolean }>(c, `select enabled from public.module_flags where branch_id = $1 and module_key = 'substitution'`, [input.branchId]);
  if (flag && !flag.enabled) return 0;
  const vid = await currentVersionId(c, input.branchId, input.date);
  if (!vid) return 0;
  const day = isoWeekday(input.date);
  let affected = await q<{ id: string; period_seq: number; section_id: string; subject_id: string | null; wing_id: string }>(
    c,
    `select e.id, e.period_seq, e.section_id, e.subject_id, cl.wing_id from public.timetable_entries e join public.sections se on se.id = e.section_id join public.classes cl on cl.id = se.class_id
     where e.version_id = $1 and e.day = $2 and e.staff_id = $3 and e.deleted_at is null order by e.period_seq`,
    [vid, day, input.staffId],
  );
  if (input.halfDay && input.halfDay !== 'none') {
    const maxSeq = (await one<{ m: number }>(c, `select coalesce(max(period_seq), 0)::int as m from public.timetable_entries where version_id = $1 and day = $2`, [vid, day])).m;
    const half = Math.ceil(maxSeq / 2);
    affected = affected.filter((a) => (input.halfDay === 'first' ? a.period_seq <= half : a.period_seq > half));
  }
  if (!affected.length) return 0;
  const branch = await branchInfo(c, input.branchId);
  const mode = branch.settings.substitution_mode ?? 'confirm';
  let created = 0;
  for (const a of affected) {
    const exists = await maybe(c, `select 1 from public.substitutions where date = $1 and period_seq = $2 and section_id = $3 and absent_staff_id = $4 and status <> 'cancelled'`, [input.date, a.period_seq, a.section_id, input.staffId]);
    if (exists) continue;
    const candidates = await candidatesFor(c, input.branchId, vid, input.date, day, a.period_seq);
    const ranked = rankSubstitutes({ sectionId: a.section_id, subjectId: a.subject_id, wingId: a.wing_id }, candidates.filter((x) => x.staffId !== input.staffId));
    const top = ranked.ranked[0];
    const sub = await insert<{ id: string }>(c, 'substitutions', {
      org_id: input.orgId,
      branch_id: input.branchId,
      date: input.date,
      day,
      period_seq: a.period_seq,
      section_id: a.section_id,
      subject_id: a.subject_id,
      absent_staff_id: input.staffId,
      substitute_staff_id: mode === 'auto' && top ? top.staffId : null,
      status: !top ? 'uncovered' : 'suggested',
      source: input.source,
      leave_request_id: input.leaveRequestId ?? null,
      timetable_entry_id: a.id,
      ranked: ranked.ranked.slice(0, 5),
    });
    created++;
    if (mode === 'auto' && top) await assignInternal(c, sub.id, 'substitute', top.staffId, null);
  }
  const coords = [...(await staffWithRole(c, input.orgId, 'academic_coordinator', input.branchId)), ...(await staffWithRole(c, input.orgId, 'vice_principal', input.branchId))];
  const uncovered = await one<{ n: number }>(c, `select count(*)::int as n from public.substitutions where absent_staff_id = $1 and date = $2 and status in ('uncovered','suggested')`, [input.staffId, input.date]);
  if (uncovered.n) await notify(c, { orgId: input.orgId, branchId: input.branchId, staffIds: coords, event: 'substitution.uncovered', titleKey: 'notif.substitution.needed', vars: { count: uncovered.n, date: input.date }, link: `/os/substitution?date=${input.date}`, priority: 'urgent', dedupeKey: `subneed:${input.staffId}:${input.date}` });
  return created;
}

async function candidatesFor(c: Tx, branchId: string, versionId: string, date: string, day: number, periodSeq: number): Promise<SubCandidate[]> {
  const rows = await q<{ id: string; full_name: string; wing_id: string | null; max_periods_day: number; subject_ids: string[]; section_ids: string[]; busy: boolean; on_duty: boolean; in_exam: boolean; absent: boolean; periods_today: number; subs_week: number; subs_month: number }>(
    c,
    `select s.id, s.full_name, s.wing_id, s.max_periods_day,
       coalesce((select array_agg(distinct ta.subject_id) from public.teacher_allocations ta where ta.staff_id = s.id and ta.deleted_at is null), '{}') as subject_ids,
       coalesce((select array_agg(distinct ta.section_id) from public.teacher_allocations ta where ta.staff_id = s.id and ta.deleted_at is null), '{}') as section_ids,
       (exists (select 1 from public.timetable_entries e where e.version_id = $2 and e.staff_id = s.id and e.day = $4 and e.period_seq = $5)
         or exists (select 1 from public.substitutions su where su.substitute_staff_id = s.id and su.date = $3 and su.period_seq = $5 and su.status = 'assigned')) as busy,
       exists (select 1 from public.duty_assignments da join public.duty_types dt on dt.id = da.duty_type_id where da.staff_id = s.id and da.date = $3 and dt.overlaps_period_seq = $5 and da.status = 'assigned') as on_duty,
       exists (select 1 from public.invigilation_duties i join public.exam_schedules es on es.id = i.exam_schedule_id where i.staff_id = s.id and es.date = $3 and i.status <> 'swapped') as in_exam,
       (exists (select 1 from public.leave_requests lr where lr.staff_id = s.id and lr.status = 'approved' and $3::date between lr.start_date and lr.end_date)
         or exists (select 1 from public.staff_attendance sa where sa.staff_id = s.id and sa.date = $3 and sa.status = 'absent')) as absent,
       ((select count(*) from public.timetable_entries e where e.version_id = $2 and e.staff_id = s.id and e.day = $4)
         + (select count(*) from public.substitutions su where su.substitute_staff_id = s.id and su.date = $3 and su.status = 'assigned'))::int as periods_today,
       (select count(*)::int from public.substitutions su where su.substitute_staff_id = s.id and su.status = 'assigned' and su.date between date_trunc('week', $3::date)::date and $3::date) as subs_week,
       (select count(*)::int from public.substitutions su where su.substitute_staff_id = s.id and su.status = 'assigned' and su.date between date_trunc('month', $3::date)::date and $3::date) as subs_month
     from public.staff s where s.branch_id = $1 and s.is_teaching and s.status = 'active' and s.deleted_at is null`,
    [branchId, versionId, date, day, periodSeq],
  );
  return rows.map((r) => ({ staffId: r.id, name: r.full_name, subjectIds: r.subject_ids, wingId: r.wing_id, sectionIds: r.section_ids, busy: r.busy, onDuty: r.on_duty, inExamDuty: r.in_exam, absent: r.absent, periodsToday: r.periods_today, maxPeriodsDay: r.max_periods_day, subsThisWeek: r.subs_week, subsThisMonth: r.subs_month }));
}

/** Assigns a substitute: system task, cover material, push + WhatsApp alert. */
async function assignInternal(c: Tx, subId: string, resolution: 'substitute' | 'combine' | 'library' | 'games' | 'supervision', staffId: string | null, actorId: string | null) {
  const s = await one<{ id: string; org_id: string; branch_id: string; date: string; period_seq: number; section_id: string; subject_id: string | null; absent_staff_id: string; status: string; section_name: string; subject_name: string | null }>(
    c,
    `select su.*, su.date::text, cl.name || ' ' || se.name as section_name, sb.name as subject_name from public.substitutions su join public.sections se on se.id = su.section_id join public.classes cl on cl.id = se.class_id left join public.subjects sb on sb.id = su.subject_id where su.id = $1`,
    [subId],
  );
  if (resolution !== 'substitute') {
    await c.query(`update public.substitutions set status = 'resolved_other', resolution = $2, substitute_staff_id = $3 where id = $1`, [subId, resolution, staffId]);
    if (staffId) await notify(c, { orgId: s.org_id, branchId: s.branch_id, staffIds: [staffId], event: 'substitution.assigned', titleKey: 'notif.substitution.supervision', vars: { section: s.section_name, period: s.period_seq, date: s.date }, link: '/os', priority: 'urgent' });
    return;
  }
  if (!staffId) throw new ValidationError('substitute_required');
  // The period's own lesson plan if one exists, else a one-period cover plan (PRD 6.1 companions).
  const plan = await maybe<{ id: string }>(c, `select id from public.lesson_plans where staff_id = $1 and plan_date = $2 and $3 = any(section_ids) and status in ('approved','submitted','in_review','delivered') and deleted_at is null limit 1`, [s.absent_staff_id, s.date, s.section_id]);
  let coverId = plan?.id ?? null;
  if (!coverId) {
    const { coverPlan } = await import('./planning');
    coverId = await coverPlan(c, { orgId: s.org_id, branchId: s.branch_id, sectionId: s.section_id, subjectId: s.subject_id, date: s.date, substituteId: staffId });
  }
  const taskId = await systemTask(c, { orgId: s.org_id, branchId: s.branch_id, ownerId: staffId, title: `Substitution: ${s.subject_name ?? ''} ${s.section_name} · P${s.period_seq}`, systemKey: `sub:${subId}:${staffId}`, linkedType: 'lesson_plan', linkedId: coverId ?? undefined, priority: 'high', assignerId: actorId, categoryKey: 'academic' });
  await c.query(`update public.substitutions set status = 'assigned', resolution = 'substitute', substitute_staff_id = $2, cover_plan_id = $3, task_id = $4, notified_at = now() where id = $1`, [subId, staffId, coverId, taskId]);
  await notify(c, { orgId: s.org_id, branchId: s.branch_id, staffIds: [staffId], event: 'substitution.assigned', titleKey: 'notif.substitution.assigned', vars: { section: s.section_name, period: s.period_seq, date: s.date }, link: coverId ? `/os/lesson-plans/${coverId}` : '/os', priority: 'urgent', data: { substitution_id: subId } });
}

export async function assignSubstitute(ctx: Ctx, input: { substitution_id: string; resolution: 'substitute' | 'combine' | 'library' | 'games' | 'supervision'; substitute_staff_id?: string | null }) {
  need(ctx, 'substitution', 'assign');
  return run(ctx, async (c, sys) => {
    const s = await maybe<{ id: string; branch_id: string; status: string; substitute_staff_id: string | null; task_id: string | null }>(c, `select id, branch_id, status, substitute_staff_id, task_id from public.substitutions where id = $1`, [input.substitution_id]);
    if (!s || !ctx.branchIds.includes(s.branch_id)) throw new NotFoundError();
    await sys(async () => {
      if (s.task_id && s.substitute_staff_id !== input.substitute_staff_id) await c.query(`update public.tasks set status = 'cancelled' where id = $1 and status = 'todo'`, [s.task_id]);
      await assignInternal(c, s.id, input.resolution, input.substitute_staff_id ?? null, ctx.staffId);
    });
    return { ok: true };
  });
}

export async function markAbsent(ctx: Ctx, input: { staff_id: string; date: string }) {
  need(ctx, 'substitution', 'edit');
  return run(ctx, async (c, sys) => {
    const s = await maybe<{ branch_id: string | null }>(c, `select branch_id from public.staff where id = $1`, [input.staff_id]);
    if (!s?.branch_id || !ctx.branchIds.includes(s.branch_id)) throw new NotFoundError();
    const n = await sys(async () => {
      await c.query(`insert into public.staff_attendance (org_id, branch_id, staff_id, date, source, status) values ($1,$2,$3,$4,'manual','absent') on conflict (staff_id, date) do update set status = 'absent'`, [ctx.orgId, s.branch_id, input.staff_id, input.date]);
      return generateForAbsence(c, { orgId: ctx.orgId, branchId: s.branch_id!, staffId: input.staff_id, date: input.date, source: 'manual' });
    });
    return { created: n };
  });
}

export async function cancelForLeave(c: Tx, leaveRequestId: string) {
  const rows = await q<{ id: string; task_id: string | null; substitute_staff_id: string | null; org_id: string; branch_id: string }>(c, `update public.substitutions set status = 'cancelled' where leave_request_id = $1 and date >= current_date and status <> 'cancelled' returning id, task_id, substitute_staff_id, org_id, branch_id`, [leaveRequestId]);
  for (const r of rows) {
    if (r.task_id) await c.query(`update public.tasks set status = 'cancelled' where id = $1 and status = 'todo'`, [r.task_id]);
  }
}

export async function board(ctx: Ctx, date: string) {
  needModule(ctx, 'substitution');
  return run(ctx, async (c) =>
    q(
      c,
      `select su.id, su.date, su.period_seq, su.status, su.resolution, su.source, su.ranked, su.cover_plan_id,
         cl.name || ' ' || se.name as section_name, sb.name as subject_name, a.full_name as absent_name, s.full_name as substitute_name, su.substitute_staff_id
       from public.substitutions su join public.sections se on se.id = su.section_id join public.classes cl on cl.id = se.class_id left join public.subjects sb on sb.id = su.subject_id
       join public.staff a on a.id = su.absent_staff_id left join public.staff s on s.id = su.substitute_staff_id
       where su.branch_id = $1 and su.date = $2 and su.status <> 'cancelled' and su.deleted_at is null order by su.period_seq, section_name`,
      [ctx.branchId, date],
    ),
  );
}

export async function substitutionReports(ctx: Ctx, from: string, to: string) {
  need(ctx, 'substitution', 'view', 3);
  return run(ctx, async (c) => {
    const register = await q(c, `select su.date, su.period_seq, cl.name || ' ' || se.name as section, sb.name as subject, a.full_name as absent, s.full_name as substitute, su.status, su.resolution from public.substitutions su join public.sections se on se.id = su.section_id join public.classes cl on cl.id = se.class_id left join public.subjects sb on sb.id = su.subject_id join public.staff a on a.id = su.absent_staff_id left join public.staff s on s.id = su.substitute_staff_id where su.branch_id = $1 and su.date between $2 and $3 and su.status <> 'cancelled' order by su.date, su.period_seq`, [ctx.branchId, from, to]);
    const fairness = await q(c, `select s.id, s.full_name, count(su.id)::int as substitutions from public.staff s left join public.substitutions su on su.substitute_staff_id = s.id and su.status = 'assigned' and su.date between $2 and $3 where s.branch_id = $1 and s.is_teaching and s.deleted_at is null group by s.id order by substitutions desc, s.full_name`, [ctx.branchId, from, to]);
    const lost = await q(c, `select cl.name || ' ' || se.name as section, sb.name as subject, count(*)::int as periods_lost from public.substitutions su join public.sections se on se.id = su.section_id join public.classes cl on cl.id = se.class_id left join public.subjects sb on sb.id = su.subject_id where su.branch_id = $1 and su.date between $2 and $3 and (su.status in ('uncovered','resolved_other') or su.resolution <> 'substitute') group by 1, 2 order by periods_lost desc`, [ctx.branchId, from, to]);
    return { register, fairness, lost };
  });
}

export async function mySubstitutions(ctx: Ctx) {
  return run(ctx, async (c) => q(c, `select su.*, cl.name || ' ' || se.name as section_name, sb.name as subject_name from public.substitutions su join public.sections se on se.id = su.section_id join public.classes cl on cl.id = se.class_id left join public.subjects sb on sb.id = su.subject_id where su.substitute_staff_id = $1 and su.date >= $2 and su.status = 'assigned' order by su.date, su.period_seq`, [ctx.staffId, addDays(localToday(ctx), -7)]));
}

export { ForbiddenError };
