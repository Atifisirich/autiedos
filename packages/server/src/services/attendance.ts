/**
 * Staff and student attendance (PRD 5.5) and leave (PRD 5.6).
 */
import {
  withinBoundary,
  staffStatus,
  parseBiometricRows,
  mergePunch,
  editPolicy,
  leaveBalance,
  validateLeave,
  countLeaveDays,
  attendancePct,
  consecutiveAbsences,
  daySummary,
  sessionKeysFor,
  toLocal,
  fromLocal,
  hhmmToMinutes,
  addDays,
  isWorkingDay,
  eachDate,
  type ColumnMapping,
  type LeaveTypeRule,
  type StudentMark,
} from '@autoed/shared';
import { ForbiddenError, NotFoundError, ValidationError, insert, maybe, one, q, update, type Tx } from '../db';
import { branchInfo, need, needModule, rank, run, workCalendar, localToday, now, staffWithRole, type Ctx } from '../core';
import { notify } from '../notify';
import { getWhatsApp } from '../adapters/channels';
import { registerApprovalHook, submitApproval } from './approvals';
import { systemTask } from './tasks';
import { generateForAbsence, cancelForLeave } from './timetable';

// ---------------------------------------------------------------- staff attendance
async function ruleFor(c: Tx, branchId: string, positionId: string | null) {
  return (
    (await maybe<{ shift_start: string; shift_end: string; grace_minutes: number; half_day_after_minutes: number; early_exit_minutes: number; checkin_cutoff: string; selfie_retention_days: number; student_cutoff: string; student_edit_window_minutes: number; student_threshold_pct: number; parent_absent_alert: boolean }>(
      c,
      `select shift_start::text, shift_end::text, grace_minutes, half_day_after_minutes, early_exit_minutes, checkin_cutoff::text, selfie_retention_days, student_cutoff::text, student_edit_window_minutes, student_threshold_pct, parent_absent_alert
       from public.attendance_rules where branch_id = $1 and (position_id = $2 or position_id is null) and deleted_at is null order by position_id nulls last limit 1`,
      [branchId, positionId],
    )) ?? { shift_start: '08:00', shift_end: '15:30', grace_minutes: 10, half_day_after_minutes: 120, early_exit_minutes: 30, checkin_cutoff: '08:30', selfie_retention_days: 90, student_cutoff: '09:30', student_edit_window_minutes: 120, student_threshold_pct: 75, parent_absent_alert: false }
  );
}

const shiftOf = (r: Awaited<ReturnType<typeof ruleFor>>) => ({ shiftStart: r.shift_start.slice(0, 5), shiftEnd: r.shift_end.slice(0, 5), graceMinutes: r.grace_minutes, halfDayAfterMinutes: r.half_day_after_minutes, earlyExitMinutes: r.early_exit_minutes });

/** App check-in / check-out inside the branch boundary, selfie stored as proof. Location read only now. */
export async function checkIn(ctx: Ctx, input: { kind: 'in' | 'out'; lat: number; lng: number; accuracy_m?: number; selfie_path?: string | null; client_at?: string }) {
  need(ctx, 'staff_attendance', 'create');
  return run(ctx, async (c) => {
    const b = await branchInfo(c, ctx.branchId);
    const geo = withinBoundary({ lat: input.lat, lng: input.lng }, { lat: b.latitude, lng: b.longitude, radiusM: b.geofence_radius_m });
    if (!geo.ok) throw new ValidationError(geo.reason!, { distance_m: geo.distanceM, radius_m: b.geofence_radius_m });
    if (input.selfie_path && !input.selfie_path.startsWith(`${ctx.orgId}/`)) throw new ForbiddenError('bad_path');
    const at = input.client_at ? new Date(input.client_at) : ctx.now;
    if (Math.abs(at.getTime() - ctx.now.getTime()) > 6 * 3600000) throw new ValidationError('stale_check_in');
    const local = toLocal(at, b.timezone);
    const rule = await ruleFor(c, ctx.branchId, ctx.staff.position_id);
    const existing = await maybe<{ id: string; check_in_at: string | null; check_out_at: string | null; source: string }>(c, `select id, check_in_at, check_out_at, source from public.staff_attendance where staff_id = $1 and date = $2`, [ctx.staffId, local.date]);
    if (input.kind === 'in') {
      if (existing?.check_in_at) return { status: 'already_checked_in', at: existing.check_in_at };
      const st = staffStatus(shiftOf(rule), local.minutes, null);
      const row = { org_id: ctx.orgId, branch_id: ctx.branchId, staff_id: ctx.staffId, date: local.date, check_in_at: at.toISOString(), check_in_lat: input.lat, check_in_lng: input.lng, check_in_distance_m: geo.distanceM, selfie_path: input.selfie_path ?? null, source: 'app', status: st.status, late_minutes: st.lateMinutes };
      if (existing) await update(c, 'staff_attendance', existing.id, row);
      else await insert(c, 'staff_attendance', row);
      return { status: st.status, late_minutes: st.lateMinutes, distance_m: geo.distanceM };
    }
    if (!existing?.check_in_at) throw new ValidationError('not_checked_in');
    const inMin = toLocal(new Date(existing.check_in_at), b.timezone).minutes;
    const st = staffStatus(shiftOf(rule), inMin, local.minutes);
    await update(c, 'staff_attendance', existing.id, { check_out_at: at.toISOString(), status: st.status, early_exit: st.earlyExit });
    return { status: st.status, early_exit: st.earlyExit };
  });
}

/** Saves the column mapping per device type and merges the device file with app records. */
export async function importBiometric(ctx: Ctx, input: { device_type: string; mapping: ColumnMapping; rows: Record<string, string>[]; file_name?: string; save_mapping: boolean }) {
  need(ctx, 'staff_attendance', 'configure', 5);
  return run(ctx, async (c) => {
    const b = await branchInfo(c, ctx.branchId);
    const { punches, errors } = parseBiometricRows(input.rows, input.mapping);
    const staff = new Map((await q<{ id: string; employee_code: string; position_id: string | null }>(c, `select id, employee_code, position_id from public.staff where org_id = $1 and deleted_at is null and employee_code is not null`, [ctx.orgId])).map((s) => [s.employee_code.toUpperCase(), s]));
    const imp = await insert<{ id: string }>(c, 'attendance_imports', { org_id: ctx.orgId, branch_id: ctx.branchId, device_type: input.device_type, mapping: input.mapping, file_name: input.file_name ?? null, rows_total: input.rows.length });
    const conflicts: unknown[] = [];
    const rowErrors: unknown[] = [...errors];
    let merged = 0;
    for (const p of punches) {
      const s = staff.get(p.employeeCode.toUpperCase());
      if (!s) {
        rowErrors.push({ row: p.row, error: 'unknown_employee_code', value: p.employeeCode });
        continue;
      }
      const ex = await maybe<{ id: string; check_in_at: string | null; check_out_at: string | null; source: 'app' | 'biometric' | 'merged' | 'manual' | 'regularised' }>(c, `select id, check_in_at, check_out_at, source from public.staff_attendance where staff_id = $1 and date = $2`, [s.id, p.date]);
      const hm = (iso: string | null) => (iso ? toHM(toLocal(new Date(iso), b.timezone).minutes) : null);
      const m = mergePunch(ex ? { checkIn: hm(ex.check_in_at), checkOut: hm(ex.check_out_at), source: ex.source } : null, p);
      const rule = await ruleFor(c, ctx.branchId, s.position_id);
      const st = staffStatus(shiftOf(rule), m.checkIn ? hhmmToMinutes(m.checkIn) : null, m.checkOut ? hhmmToMinutes(m.checkOut) : null);
      const row = { org_id: ctx.orgId, branch_id: ctx.branchId, staff_id: s.id, date: p.date, check_in_at: m.checkIn ? fromLocal(p.date, m.checkIn, b.timezone).toISOString() : null, check_out_at: m.checkOut ? fromLocal(p.date, m.checkOut, b.timezone).toISOString() : null, source: m.source, status: st.status, late_minutes: st.lateMinutes, early_exit: st.earlyExit, conflict: m.conflict.length ? m.conflict : null, import_id: imp.id };
      if (ex) await update(c, 'staff_attendance', ex.id, row);
      else await insert(c, 'staff_attendance', row);
      if (m.conflict.length) conflicts.push({ staff_id: s.id, employee_code: p.employeeCode, date: p.date, conflict: m.conflict });
      merged++;
    }
    await update(c, 'attendance_imports', imp.id, { rows_merged: merged, conflicts, errors: rowErrors });
    if (input.save_mapping) {
      const settings = { ...(b.settings as Record<string, unknown>), biometric_mappings: { ...(((b.settings as Record<string, unknown>).biometric_mappings as Record<string, unknown>) ?? {}), [input.device_type]: input.mapping } };
      await c.query(`update public.branches set settings = $2 where id = $1`, [ctx.branchId, JSON.stringify(settings)]);
    }
    return { import_id: imp.id, merged, conflicts, errors: rowErrors };
  });
}

export function monthEnd(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y!, m!, 0)).toISOString().slice(0, 10);
}

const toHM = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

export async function requestRegularisation(ctx: Ctx, input: { date: string; check_in?: string; check_out?: string; reason: string }) {
  need(ctx, 'staff_attendance', 'create');
  return run(ctx, async (c, sys) => {
    const req = await sys(() => submitApproval(c, { orgId: ctx.orgId, branchId: ctx.branchId, applicantId: ctx.staffId, typeKey: 'regularisation', title: `${ctx.t('attendance.regularisation')} · ${input.date}`, data: input, linkedType: 'staff_attendance', actorName: ctx.staff.full_name }));
    return { id: req.id, status: req.status };
  });
}

registerApprovalHook('regularisation', async (c, req, decision) => {
  if (decision !== 'approved') return;
  const d = req.data as { date: string; check_in?: string; check_out?: string };
  const b = await branchInfo(c, req.branch_id);
  const s = await one<{ position_id: string | null }>(c, `select position_id from public.staff where id = $1`, [req.applicant_id]);
  const rule = await ruleFor(c, req.branch_id, s.position_id);
  const ex = await maybe<{ id: string; check_in_at: string | null; check_out_at: string | null }>(c, `select id, check_in_at, check_out_at from public.staff_attendance where staff_id = $1 and date = $2`, [req.applicant_id, d.date]);
  const ci = d.check_in ?? (ex?.check_in_at ? toHM(toLocal(new Date(ex.check_in_at), b.timezone).minutes) : null);
  const co = d.check_out ?? (ex?.check_out_at ? toHM(toLocal(new Date(ex.check_out_at), b.timezone).minutes) : null);
  const st = staffStatus(shiftOf(rule), ci ? hhmmToMinutes(ci) : null, co ? hhmmToMinutes(co) : null);
  const row = { org_id: req.org_id, branch_id: req.branch_id, staff_id: req.applicant_id, date: d.date, check_in_at: ci ? fromLocal(d.date, ci, b.timezone).toISOString() : null, check_out_at: co ? fromLocal(d.date, co, b.timezone).toISOString() : null, source: 'regularised', status: st.status, late_minutes: st.lateMinutes };
  if (ex) await update(c, 'staff_attendance', ex.id, row);
  else await insert(c, 'staff_attendance', row);
});

export async function myAttendance(ctx: Ctx, month: string) {
  return run(ctx, async (c) => q(c, `select date, check_in_at, check_out_at, status, late_minutes, early_exit, source, conflict from public.staff_attendance where staff_id = $1 and to_char(date, 'YYYY-MM') = $2 order by date`, [ctx.staffId, month]));
}

/** Monthly register for payroll: present, absent, late count, half days, leave by type, loss of pay. */
export async function staffRegister(ctx: Ctx, month: string, branchId?: string) {
  need(ctx, 'staff_attendance', 'view', 3);
  return run(ctx, async (c) => {
    const b = branchId ?? ctx.branchId;
    const from = `${month}-01`;
    const to = monthEnd(month);
    const cal = await workCalendar(c, b, from, to);
    const working = eachDate(from, to).filter((d) => isWorkingDay(d, cal) && d <= localToday(ctx, cal.timeZone));
    const staff = await q<{ id: string; full_name: string; employee_code: string }>(c, `select id, full_name, employee_code from public.staff where (branch_id = $1) and status = 'active' and deleted_at is null order by full_name`, [b]);
    const att = await q<{ staff_id: string; date: string; status: string }>(c, `select staff_id, date, status from public.staff_attendance where branch_id = $1 and date between $2 and $3`, [b, from, to]);
    const leaves = await q<{ staff_id: string; key: string; paid: boolean; start_date: string; end_date: string; half_day: string }>(
      c,
      `select lr.staff_id, lt.key, lt.paid, lr.start_date, lr.end_date, lr.half_day from public.leave_requests lr join public.leave_types lt on lt.id = lr.leave_type_id where lr.branch_id = $1 and lr.status = 'approved' and lr.end_date >= $2 and lr.start_date <= $3`,
      [b, from, to],
    );
    return {
      month,
      working_days: working.length,
      rows: staff.map((s) => {
        const mine = att.filter((a) => a.staff_id === s.id);
        const leaveDays: Record<string, number> = {};
        let lop = 0;
        const leaveDates = new Set<string>();
        for (const l of leaves.filter((x) => x.staff_id === s.id)) {
          for (const d of eachDate(l.start_date, l.end_date)) {
            if (!working.includes(d)) continue;
            const v = l.half_day !== 'none' ? 0.5 : 1;
            leaveDays[l.key] = (leaveDays[l.key] ?? 0) + v;
            if (!l.paid) lop += v;
            leaveDates.add(d);
          }
        }
        const present = mine.filter((a) => ['present', 'late'].includes(a.status)).length;
        const half = mine.filter((a) => a.status === 'half_day').length;
        const late = mine.filter((a) => a.status === 'late').length;
        const absent = working.filter((d) => !mine.some((a) => a.date === d && a.status !== 'absent') && !leaveDates.has(d)).length;
        return { staff_id: s.id, name: s.full_name, employee_code: s.employee_code, present, late, half_days: half, absent, leave: leaveDays, loss_of_pay_days: lop + absent + half * 0.5 };
      }),
    };
  });
}

export async function attendanceExceptions(ctx: Ctx, date?: string) {
  need(ctx, 'staff_attendance', 'view', 3);
  return run(ctx, async (c) => {
    const cal = await workCalendar(c, ctx.branchId);
    const d = date ?? localToday(ctx, cal.timeZone);
    const rows = await q(
      c,
      `select s.id as staff_id, s.full_name, sa.status, sa.check_in_at, sa.late_minutes, sa.conflict, sa.source,
         exists (select 1 from public.leave_requests lr where lr.staff_id = s.id and lr.status = 'approved' and $2::date between lr.start_date and lr.end_date) as on_leave
       from public.staff s left join public.staff_attendance sa on sa.staff_id = s.id and sa.date = $2
       where s.branch_id = $1 and s.status = 'active' and s.deleted_at is null and (sa.id is null or sa.status in ('late','half_day','absent') or sa.conflict is not null)
       order by s.full_name`,
      [ctx.branchId, d],
    );
    const pendingReg = await q(c, `select r.id, r.title, s.full_name from public.approval_requests r join public.approval_types t on t.id = r.approval_type_id join public.staff s on s.id = r.applicant_id where r.branch_id = $1 and t.key = 'regularisation' and r.status = 'pending'`, [ctx.branchId]);
    return { date: d, exceptions: rows, regularisations: pendingReg };
  });
}

/** After the check-in cut-off: teachers with no check-in and no leave are marked absent -> substitution. */
export async function absenceSweep(c: Tx, branchId: string, at: Date = now()): Promise<number> {
  const b = await branchInfo(c, branchId);
  const cal = await workCalendar(c, branchId);
  const local = toLocal(at, b.timezone);
  if (!isWorkingDay(local.date, cal)) return 0;
  const rule = await ruleFor(c, branchId, null);
  if (local.minutes < hhmmToMinutes(rule.checkin_cutoff.slice(0, 5))) return 0;
  const missing = await q<{ id: string }>(
    c,
    `select s.id from public.staff s where s.branch_id = $1 and s.status = 'active' and s.deleted_at is null and s.is_teaching
       and not exists (select 1 from public.staff_attendance sa where sa.staff_id = s.id and sa.date = $2 and sa.check_in_at is not null)
       and not exists (select 1 from public.leave_requests lr where lr.staff_id = s.id and lr.status = 'approved' and $2::date between lr.start_date and lr.end_date)`,
    [branchId, local.date],
  );
  let n = 0;
  for (const s of missing) {
    await c.query(`insert into public.staff_attendance (org_id, branch_id, staff_id, date, source, status) values ($1,$2,$3,$4,'manual','absent') on conflict (staff_id, date) do nothing`, [b.org_id, branchId, s.id, local.date]);
    n += await generateForAbsence(c, { orgId: b.org_id, branchId, staffId: s.id, date: local.date, source: 'absence' });
  }
  return n;
}

export async function purgeSelfies(c: Tx, at: Date = now()): Promise<number> {
  const rows = await q<{ id: string; selfie_path: string }>(
    c,
    `select sa.id, sa.selfie_path from public.staff_attendance sa join public.attendance_rules ar on ar.branch_id = sa.branch_id and ar.position_id is null
     where sa.selfie_path is not null and sa.date < ($1::date - ar.selfie_retention_days)`,
    [at.toISOString().slice(0, 10)],
  );
  const { deleteObject } = await import('../adapters/channels');
  for (const r of rows) {
    await deleteObject(r.selfie_path).catch(() => undefined);
    await c.query(`update public.staff_attendance set selfie_path = null where id = $1`, [r.id]);
  }
  return rows.length;
}

// ---------------------------------------------------------------- student attendance
async function canMarkSection(c: Tx, ctx: Ctx, sectionId: string): Promise<boolean> {
  if (rank(ctx, 'student_attendance', 'edit') >= 4) return true;
  const r = await maybe(
    c,
    `select 1 from public.sections where id = $1 and class_teacher_id = $2 union select 1 from public.teacher_allocations where section_id = $1 and staff_id = $2 and deleted_at is null
     union select 1 from public.substitutions where section_id = $1 and substitute_staff_id = $2 and date = current_date and status = 'assigned'`,
    [sectionId, ctx.staffId],
  );
  return !!r;
}

export async function rosterForMarking(ctx: Ctx, sectionId: string, date: string, sessionKey: string) {
  needModule(ctx, 'student_attendance');
  return run(ctx, async (c) => {
    const section = await maybe<{ id: string; name: string; class_name: string; mode: string }>(c, `select se.id, se.name, cl.name as class_name, w.student_attendance_mode as mode from public.sections se join public.classes cl on cl.id = se.class_id join public.wings w on w.id = cl.wing_id where se.id = $1`, [sectionId]);
    if (!section) throw new NotFoundError();
    const students = await q<{ id: string; full_name: string; roll_no: number }>(c, `select id, full_name, roll_no from public.students where section_id = $1 and status = 'active' and deleted_at is null order by roll_no, full_name`, [sectionId]);
    const session = await maybe<{ id: string; status: string; submitted_at: string | null }>(c, `select id, status, submitted_at from public.student_attendance_sessions where section_id = $1 and date = $2 and session_key = $3`, [sectionId, date, sessionKey]);
    const marks = session ? await q<{ student_id: string; status: StudentMark; note: string | null }>(c, `select student_id, status, note from public.student_attendance_marks where session_id = $1`, [session.id]) : [];
    const rule = await ruleFor(c, ctx.branchId, null);
    const editable = !session?.submitted_at ? 'open' : editPolicy(new Date(session.submitted_at), ctx.now, rule.student_edit_window_minutes);
    return { section, session, editable, students: students.map((s) => ({ ...s, status: marks.find((m) => m.student_id === s.id)?.status ?? 'present', note: marks.find((m) => m.student_id === s.id)?.note ?? null })) };
  });
}

export async function submitStudentAttendance(ctx: Ctx, input: { section_id: string; date: string; session_key: string; marks: { student_id: string; status: StudentMark; note?: string }[]; edit_reason?: string; client_id?: string }) {
  need(ctx, 'student_attendance', 'create');
  return run(ctx, async (c, sys) => {
    if (!(await canMarkSection(c, ctx, input.section_id))) throw new ForbiddenError('not_your_section');
    const section = await one<{ branch_id: string; org_id: string; class_teacher_id: string | null; name: string; class_name: string }>(c, `select se.branch_id, se.org_id, se.class_teacher_id, se.name, cl.name as class_name from public.sections se join public.classes cl on cl.id = se.class_id where se.id = $1`, [input.section_id]);
    const roster = new Set((await q<{ id: string }>(c, `select id from public.students where section_id = $1 and deleted_at is null`, [input.section_id])).map((s) => s.id));
    for (const m of input.marks) if (!roster.has(m.student_id)) throw new ValidationError('student_not_in_section');
    const existing = await maybe<{ id: string; submitted_at: string | null; client_id: string | null }>(c, `select id, submitted_at, client_id from public.student_attendance_sessions where section_id = $1 and date = $2 and session_key = $3`, [input.section_id, input.date, input.session_key]);
    if (existing && input.client_id && existing.client_id === input.client_id) return { session_id: existing.id, status: 'duplicate' };
    const rule = await ruleFor(c, section.branch_id, null);
    if (existing?.submitted_at) {
      const policy = editPolicy(new Date(existing.submitted_at), ctx.now, rule.student_edit_window_minutes);
      if (!input.edit_reason) throw new ValidationError('edit_reason_required');
      if (policy === 'approval_required') {
        const req = await sys(() => submitApproval(c, { orgId: ctx.orgId, branchId: section.branch_id, applicantId: ctx.staffId, typeKey: 'attendance_edit', title: `${section.class_name} ${section.name} · ${input.date}`, data: { ...input, session_id: existing.id }, linkedType: 'student_attendance_session', linkedId: existing.id, actorName: ctx.staff.full_name }));
        return { session_id: existing.id, status: 'approval_requested', approval_id: req.id };
      }
    }
    const sessionId = await sys(async () => {
      const s = existing
        ? await update<{ id: string }>(c, 'student_attendance_sessions', existing.id, { edit_reason: input.edit_reason ?? null, marked_by: ctx.staffId, client_id: input.client_id ?? existing.client_id })
        : await insert<{ id: string }>(c, 'student_attendance_sessions', { org_id: ctx.orgId, branch_id: section.branch_id, section_id: input.section_id, date: input.date, session_key: input.session_key, marked_by: ctx.staffId, status: 'submitted', submitted_at: ctx.now.toISOString(), client_id: input.client_id ?? null });
      await writeMarks(c, ctx.orgId, section.branch_id, s.id, input.marks);
      // resolve any reminder task for this section/day
      await c.query(`update public.tasks set status = 'done', completed_at = now() where system_key like $1 and status = 'todo'`, [`att:${input.section_id}:${input.date}%`]);
      return s.id;
    });
    if (!existing && rule.parent_absent_alert) {
      const absent = input.marks.filter((m) => m.status === 'absent').map((m) => m.student_id);
      if (absent.length) await sys(() => parentAbsentAlerts(c, ctx.orgId, section.branch_id, absent, input.date));
    }
    return { session_id: sessionId, status: existing ? 'edited' : 'submitted' };
  });
}

async function writeMarks(c: Tx, orgId: string, branchId: string, sessionId: string, marks: { student_id: string; status: StudentMark; note?: string }[]) {
  for (const m of marks) {
    await c.query(
      `insert into public.student_attendance_marks (org_id, branch_id, session_id, student_id, status, note) values ($1,$2,$3,$4,$5,$6)
       on conflict (session_id, student_id) do update set status = excluded.status, note = excluded.note`,
      [orgId, branchId, sessionId, m.student_id, m.status, m.note ?? null],
    );
  }
}

registerApprovalHook('attendance_edit', async (c, req, decision) => {
  if (decision !== 'approved') return;
  const d = req.data as { session_id: string; marks: { student_id: string; status: StudentMark; note?: string }[]; edit_reason?: string };
  await writeMarks(c, req.org_id, req.branch_id, d.session_id, d.marks);
  await c.query(`update public.student_attendance_sessions set edit_reason = $2, edit_approval_request_id = $3 where id = $1`, [d.session_id, d.edit_reason ?? null, req.id]);
});

/** Optional per branch: absent alert to parents over WhatsApp (CRM messaging adapter). */
async function parentAbsentAlerts(c: Tx, orgId: string, branchId: string, studentIds: string[], date: string) {
  const students = await q<{ id: string; full_name: string; parent_phone: string | null }>(c, `select id, full_name, parent_phone from public.students where id = any($1)`, [studentIds]);
  const wa = getWhatsApp();
  for (const s of students) {
    if (!s.parent_phone) continue;
    const r = await wa.send({ to: s.parent_phone, template: 'os_student_absent', language: 'en', variables: [s.full_name, date] });
    await insert(c, 'message_usage', { org_id: orgId, branch_id: branchId, channel: 'whatsapp', template_key: 'os_student_absent', status: r.ok ? 'sent' : 'failed', units: 1, provider_ref: r.ref ?? null });
  }
}

/** Unmarked attendance after cut-off: system task + reminder to the teacher, then the coordinator. */
export async function unmarkedSweep(c: Tx, branchId: string, at: Date = now()): Promise<number> {
  const b = await branchInfo(c, branchId);
  const cal = await workCalendar(c, branchId);
  const local = toLocal(at, b.timezone);
  if (!isWorkingDay(local.date, cal)) return 0;
  const rule = await ruleFor(c, branchId, null);
  const cutoff = hhmmToMinutes(rule.student_cutoff.slice(0, 5));
  if (local.minutes < cutoff) return 0;
  const sections = await q<{ id: string; name: string; class_name: string; class_teacher_id: string | null; mode: 'daily_once' | 'daily_twice' | 'period'; wing_id: string }>(
    c,
    `select se.id, se.name, cl.name as class_name, se.class_teacher_id, w.student_attendance_mode as mode, w.id as wing_id from public.sections se join public.classes cl on cl.id = se.class_id join public.wings w on w.id = cl.wing_id
     where se.branch_id = $1 and se.deleted_at is null`,
    [branchId],
  );
  let n = 0;
  for (const s of sections) {
    const key = sessionKeysFor(s.mode, 1)[0]!; // first session of the day is the one due at cut-off
    const done = await maybe(c, `select 1 from public.student_attendance_sessions where section_id = $1 and date = $2 and session_key = $3`, [s.id, local.date, key]);
    if (done || !s.class_teacher_id) continue;
    const owner = s.class_teacher_id;
    const onLeave = await maybe(c, `select 1 from public.leave_requests where staff_id = $1 and status = 'approved' and $2::date between start_date and end_date`, [owner, local.date]);
    const taskOwner = onLeave ? (await staffWithRole(c, b.org_id, 'academic_coordinator', branchId))[0] ?? owner : owner;
    const id = await systemTask(c, { orgId: b.org_id, branchId, ownerId: taskOwner, title: `Mark attendance: ${s.class_name} ${s.name}`, systemKey: `att:${s.id}:${local.date}`, dueAt: fromLocal(local.date, cutoff + 30, b.timezone).toISOString(), linkedType: 'section', linkedId: s.id, priority: 'high' });
    if (id) {
      await notify(c, { orgId: b.org_id, branchId, staffIds: [taskOwner], event: 'attendance.unmarked', titleKey: 'notif.attendance.unmarked', vars: { section: `${s.class_name} ${s.name}` }, link: `/os/student-attendance?section=${s.id}`, priority: 'urgent' });
      n++;
    } else if (local.minutes >= cutoff + 60) {
      const coords = await staffWithRole(c, b.org_id, 'academic_coordinator', branchId);
      await notify(c, { orgId: b.org_id, branchId, staffIds: coords, event: 'attendance.unmarked', titleKey: 'notif.attendance.unmarkedCoordinator', vars: { section: `${s.class_name} ${s.name}` }, link: `/os/student-attendance/summary`, dedupeKey: `attc:${s.id}:${local.date}` });
    }
  }
  return n;
}

export async function studentDaySummary(ctx: Ctx, date: string) {
  need(ctx, 'student_attendance', 'view');
  return run(ctx, async (c) => {
    const rows = await q<{ section_id: string; section: string; wing: string; marked: boolean; marks: StudentMark[] | null; total: number }>(
      c,
      `select se.id as section_id, cl.name || ' ' || se.name as section, w.name as wing,
         exists (select 1 from public.student_attendance_sessions s where s.section_id = se.id and s.date = $2) as marked,
         (select array_agg(m.status) from public.student_attendance_marks m join public.student_attendance_sessions s on s.id = m.session_id where s.section_id = se.id and s.date = $2 and s.session_key in ('day','am','p1')) as marks,
         (select count(*)::int from public.students st where st.section_id = se.id and st.status = 'active') as total
       from public.sections se join public.classes cl on cl.id = se.class_id join public.wings w on w.id = cl.wing_id where se.branch_id = $1 and se.deleted_at is null order by cl.seq, se.name`,
      [ctx.branchId, date],
    );
    const absentees = await q(
      c,
      `select st.id, st.full_name, st.roll_no, cl.name || ' ' || se.name as section, m.status from public.student_attendance_marks m join public.student_attendance_sessions s on s.id = m.session_id
       join public.students st on st.id = m.student_id join public.sections se on se.id = st.section_id join public.classes cl on cl.id = se.class_id
       where s.branch_id = $1 and s.date = $2 and m.status in ('absent','leave') order by section, st.roll_no`,
      [ctx.branchId, date],
    );
    return { date, sections: rows.map((r) => ({ ...r, summary: r.marks ? daySummary(r.marks) : null, pct: r.marks ? attendancePct(r.marks) : null })), absentees };
  });
}

export async function studentAlerts(ctx: Ctx, from: string, to: string) {
  need(ctx, 'student_attendance', 'view');
  return run(ctx, async (c) => {
    const rule = await ruleFor(c, ctx.branchId, null);
    const rows = await q<{ student_id: string; full_name: string; section: string; marks: StudentMark[] }>(
      c,
      `select st.id as student_id, st.full_name, cl.name || ' ' || se.name as section, array_agg(m.status order by s.date) as marks
       from public.student_attendance_marks m join public.student_attendance_sessions s on s.id = m.session_id join public.students st on st.id = m.student_id
       join public.sections se on se.id = st.section_id join public.classes cl on cl.id = se.class_id
       where s.branch_id = $1 and s.date between $2 and $3 and s.session_key in ('day','am','p1') group by 1, 2, 3`,
      [ctx.branchId, from, to],
    );
    const enriched = rows.map((r) => ({ student_id: r.student_id, full_name: r.full_name, section: r.section, pct: attendancePct(r.marks), consecutive_absences: consecutiveAbsences(r.marks) }));
    return { threshold: rule.student_threshold_pct, below: enriched.filter((r) => r.pct < rule.student_threshold_pct), consecutive: enriched.filter((r) => r.consecutive_absences >= 3) };
  });
}

/** Monthly register in the format schools print: one row per student, one column per day. */
export async function studentRegister(ctx: Ctx, sectionId: string, month: string) {
  need(ctx, 'student_attendance', 'view');
  return run(ctx, async (c) => {
    const students = await q<{ id: string; full_name: string; roll_no: number }>(c, `select id, full_name, roll_no from public.students where section_id = $1 and deleted_at is null order by roll_no`, [sectionId]);
    const marks = await q<{ student_id: string; date: string; status: StudentMark }>(
      c,
      `select m.student_id, s.date::text, m.status from public.student_attendance_marks m join public.student_attendance_sessions s on s.id = m.session_id where s.section_id = $1 and to_char(s.date, 'YYYY-MM') = $2 and s.session_key in ('day','am','p1')`,
      [sectionId, month],
    );
    const dates = [...new Set(marks.map((m) => m.date))].sort();
    const code: Record<StudentMark, string> = { present: 'P', absent: 'A', late: 'L', half_day: 'H', on_duty: 'OD', leave: 'LV' };
    return {
      dates,
      rows: students.map((s) => {
        const mine = marks.filter((m) => m.student_id === s.id);
        return { roll_no: s.roll_no, name: s.full_name, days: Object.fromEntries(dates.map((d) => [d, code[mine.find((m) => m.date === d)?.status ?? 'present']])), pct: attendancePct(mine.map((m) => m.status)) };
      }),
    };
  });
}

/** Sections the current teacher can mark today (class teacher, subject teacher, substitute). */
export async function mySections(ctx: Ctx) {
  return run(ctx, async (c) =>
    q(
      c,
      `select distinct se.id, cl.name || ' ' || se.name as name, w.student_attendance_mode as mode, cl.seq, se.class_teacher_id = $1 as is_class_teacher
       from public.sections se join public.classes cl on cl.id = se.class_id join public.wings w on w.id = cl.wing_id
       where se.branch_id = $2 and se.deleted_at is null and (se.class_teacher_id = $1 or exists (select 1 from public.teacher_allocations ta where ta.section_id = se.id and ta.staff_id = $1 and ta.deleted_at is null) or $3)
       order by cl.seq, name`,
      [ctx.staffId, ctx.branchId, rank(ctx, 'student_attendance', 'edit') >= 4],
    ),
  );
}

// ---------------------------------------------------------------- leave
async function leaveCtx(c: Tx, staffId: string, branchId: string) {
  const ay = await maybe<{ id: string; starts_on: string; ends_on: string }>(c, `select id, starts_on::text, ends_on::text from public.academic_years where branch_id = $1 and is_current and deleted_at is null`, [branchId]);
  if (!ay) throw new ValidationError('no_current_academic_year');
  const cal = await workCalendar(c, branchId, ay.starts_on, ay.ends_on);
  const staff = await one<{ joined_on: string | null; org_id: string; department_id: string | null }>(c, `select joined_on::text, org_id, department_id from public.staff where id = $1`, [staffId]);
  return { ay, cal, staff };
}

function typeRule(t: { unit: 'day' | 'hour'; yearly_quota: number; accrual: 'yearly' | 'monthly'; carry_forward: boolean; carry_forward_max: number; half_day_allowed: boolean; notice_days: number; doc_required_after_days: number | null; sandwich_rule: boolean }): LeaveTypeRule {
  return { unit: t.unit, yearlyQuota: Number(t.yearly_quota), accrual: t.accrual, carryForward: t.carry_forward, carryForwardMax: Number(t.carry_forward_max), halfDayAllowed: t.half_day_allowed, noticeDays: t.notice_days, docRequiredAfterDays: t.doc_required_after_days, sandwichRule: t.sandwich_rule };
}

export async function balances(c: Tx, staffId: string, branchId: string, asOf: string) {
  const { ay, staff } = await leaveCtx(c, staffId, branchId);
  const types = await q<Parameters<typeof typeRule>[0] & { id: string; key: string; name: string; name_i18n: Record<string, string>; paid: boolean }>(c, `select * from public.leave_types where org_id = $1 and active and deleted_at is null order by name`, [staff.org_id]);
  const reqs = await q<{ leave_type_id: string; start_date: string; end_date: string; days: number; status: 'pending' | 'approved' | 'rejected' | 'returned' | 'cancelled' }>(c, `select leave_type_id, start_date::text, end_date::text, days, status from public.leave_requests where staff_id = $1 and deleted_at is null`, [staffId]);
  const bal = await q<{ leave_type_id: string; opening: number; adjusted: number }>(c, `select leave_type_id, opening, adjusted from public.leave_balances where staff_id = $1 and academic_year_id = $2 and deleted_at is null`, [staffId, ay.id]);
  return types.map((t) => {
    const b = bal.find((x) => x.leave_type_id === t.id);
    const r = leaveBalance({ type: typeRule(t), yearStart: ay.starts_on, yearEnd: ay.ends_on, asOf, joinedOn: staff.joined_on, opening: Number(b?.opening ?? 0), adjusted: Number(b?.adjusted ?? 0), requests: reqs.filter((x) => x.leave_type_id === t.id).map((x) => ({ startDate: x.start_date, endDate: x.end_date, days: Number(x.days), status: x.status })) });
    return { leave_type_id: t.id, key: t.key, name: t.name, name_i18n: t.name_i18n, unit: t.unit, paid: t.paid, quota: Number(t.yearly_quota), ...r };
  });
}

export async function myBalances(ctx: Ctx, staffId?: string) {
  needModule(ctx, 'leave');
  return run(ctx, async (c) => {
    const who = staffId ?? ctx.staffId;
    if (who !== ctx.staffId) {
      const s = await maybe<{ branch_id: string | null; department_id: string | null; wing_id: string | null }>(c, `select branch_id, department_id, wing_id from public.staff where id = $1`, [who]);
      if (!s) throw new NotFoundError();
      const { needTarget } = await import('../core');
      await needTarget(c, ctx, 'leave', 'view', { branch_id: s.branch_id, owner_id: who, department_id: s.department_id, wing_id: s.wing_id });
    }
    return balances(c, who, ctx.branchId, localToday(ctx));
  });
}

/** Preview before submitting: days, balance, validation, clashes in the department. */
export async function previewLeave(ctx: Ctx, input: { leave_type_id: string; start_date: string; end_date: string; half_day: 'none' | 'first' | 'second'; hours?: number | null; attachment_path?: string | null }) {
  needModule(ctx, 'leave');
  return run(ctx, async (c) => preview(c, ctx, input));
}

async function preview(c: Tx, ctx: Ctx, input: { leave_type_id: string; start_date: string; end_date: string; half_day: 'none' | 'first' | 'second'; hours?: number | null; attachment_path?: string | null }) {
  const t = await maybe<Parameters<typeof typeRule>[0] & { id: string }>(c, `select * from public.leave_types where id = $1 and org_id = $2 and deleted_at is null`, [input.leave_type_id, ctx.orgId]);
  if (!t) throw new NotFoundError('leave_type');
  const { cal } = await leaveCtx(c, ctx.staffId, ctx.branchId);
  const bal = (await balances(c, ctx.staffId, ctx.branchId, localToday(ctx))).find((b) => b.leave_type_id === t.id)!;
  const v = validateLeave({ startDate: input.start_date, endDate: input.end_date, halfDay: input.half_day, hours: input.hours ?? undefined }, typeRule(t), cal, localToday(ctx), { hasAttachment: !!input.attachment_path, available: bal.requestable });
  const clashes = await q<{ full_name: string; start_date: string; end_date: string }>(
    c,
    `select s.full_name, lr.start_date::text, lr.end_date::text from public.leave_requests lr join public.staff s on s.id = lr.staff_id
     where s.department_id = $1 and lr.staff_id <> $2 and lr.status in ('approved','pending') and lr.start_date <= $4 and lr.end_date >= $3 and lr.deleted_at is null`,
    [ctx.staff.department_id, ctx.staffId, input.start_date, input.end_date],
  );
  return { days: v.days, errors: v.errors, balance: bal, clash_count: clashes.length, clashes };
}

export async function applyLeave(ctx: Ctx, input: { leave_type_id: string; start_date: string; end_date: string; half_day: 'none' | 'first' | 'second'; hours?: number | null; reason?: string | null; attachment_path?: string | null; handover_note?: string | null; parent_request_id?: string | null }) {
  need(ctx, 'leave', 'create');
  return run(ctx, async (c, sys) => {
    const p = await preview(c, ctx, input);
    if (p.errors.length) throw new ValidationError('leave_invalid', { errors: p.errors });
    const lr = await insert<{ id: string }>(c, 'leave_requests', { org_id: ctx.orgId, branch_id: ctx.branchId, staff_id: ctx.staffId, leave_type_id: input.leave_type_id, start_date: input.start_date, end_date: input.end_date, half_day: input.half_day, hours: input.hours ?? null, days: p.days, reason: input.reason ?? null, attachment_path: input.attachment_path ?? null, handover_note: input.handover_note ?? null, parent_request_id: input.parent_request_id ?? null, status: 'pending' });
    const req = await sys(() => submitApproval(c, { orgId: ctx.orgId, branchId: ctx.branchId, applicantId: ctx.staffId, typeKey: 'leave', title: `${p.balance.name} · ${input.start_date}${input.end_date !== input.start_date ? ` → ${input.end_date}` : ''}`, data: { days: p.days, leave_type: p.balance.key, start_date: input.start_date, end_date: input.end_date }, linkedType: 'leave_request', linkedId: lr.id, actorName: ctx.staff.full_name }));
    await sys(() => c.query(`update public.leave_requests set approval_request_id = $2, status = case when $3 = 'approved' then 'approved' else status end where id = $1`, [lr.id, req.id, req.status]));
    return { id: lr.id, approval_id: req.id, days: p.days, clash_count: p.clash_count };
  });
}

registerApprovalHook('leave', async (c, req, decision) => {
  if (!req.linked_id) return;
  const lr = await maybe<{ id: string; staff_id: string; start_date: string; end_date: string; half_day: string; status: string; branch_id: string; org_id: string }>(c, `select id, staff_id, start_date::text, end_date::text, half_day, status, branch_id, org_id from public.leave_requests where id = $1`, [req.linked_id]);
  if (!lr) return;
  const wasApproved = lr.status === 'approved';
  await c.query(`update public.leave_requests set status = $2, decided_at = now() where id = $1`, [lr.id, decision]);
  if (decision === 'approved') {
    // Approval triggers substitution for affected periods (PRD 5.6).
    const cal = await workCalendar(c, lr.branch_id, lr.start_date, lr.end_date);
    for (const d of eachDate(lr.start_date, lr.end_date)) {
      if (!isWorkingDay(d, cal)) continue;
      await generateForAbsence(c, { orgId: lr.org_id, branchId: lr.branch_id, staffId: lr.staff_id, date: d, source: 'leave', leaveRequestId: lr.id, halfDay: lr.half_day as 'none' | 'first' | 'second' });
    }
  }
  if (decision === 'cancelled' && wasApproved) await cancelForLeave(c, lr.id);
});

export async function myLeave(ctx: Ctx) {
  return run(ctx, async (c) => q(c, `select lr.*, lt.name as type_name, lt.name_i18n, lt.key as type_key from public.leave_requests lr join public.leave_types lt on lt.id = lr.leave_type_id where lr.staff_id = $1 and lr.deleted_at is null order by lr.start_date desc`, [ctx.staffId]));
}

/** Leave calendar by department and branch. */
export async function leaveCalendar(ctx: Ctx, from: string, to: string, departmentId?: string) {
  needModule(ctx, 'leave');
  return run(ctx, async (c) =>
    q(
      c,
      `select lr.id, lr.staff_id, s.full_name, d.name as department, lr.start_date, lr.end_date, lr.half_day, lr.status, lt.name as type_name, lt.key as type_key
       from public.leave_requests lr join public.staff s on s.id = lr.staff_id left join public.departments d on d.id = s.department_id join public.leave_types lt on lt.id = lr.leave_type_id
       where lr.branch_id = $1 and lr.status in ('approved','pending') and lr.end_date >= $2 and lr.start_date <= $3 and ($4::uuid is null or s.department_id = $4) and lr.deleted_at is null order by lr.start_date`,
      [ctx.branchId, from, to, departmentId ?? null],
    ),
  );
}

export { countLeaveDays };
