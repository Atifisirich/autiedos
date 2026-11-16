/**
 * School setup and configuration (PRD 4): setup wizard, Excel imports with row-level errors,
 * staff, org chart, roles and permission matrix, assignment rules, delegations, custom fields,
 * terminology, module flags, generic configuration screens with reset-to-preset and history.
 */
import ExcelJS from 'exceljs';
import { MODULE_KEYS, PERMISSION_MODULES, ACTIONS, PRESET_SUBJECTS, PRESET_WINGS, addDays, type PresetKey } from '@autoed/shared';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError, insert, maybe, one, q, update, type Tx } from '../db';
import { need, rank, run, type Ctx } from '../core';
import { applyArea, applyPreset, CONFIG_AREAS, type ConfigArea } from '../presets';
import { authUser } from '../seed/demo';
import { enqueue } from '../jobs';

const isSetupAdmin = (ctx: Ctx) => rank(ctx, 'setup', 'configure') >= 5;
function needSetup(ctx: Ctx) {
  if (!isSetupAdmin(ctx)) throw new ForbiddenError('missing_permission:setup.configure');
}

// ---------------------------------------------------------------- wizard
export async function wizardState(ctx: Ctx) {
  needSetup(ctx);
  return run(ctx, async (c) => {
    const org = await one<{ id: string; name: string; preset_key: string | null; setup_step: number; setup_completed_at: string | null; branding: Record<string, unknown> }>(c, `select id, name, preset_key, setup_step, setup_completed_at, branding from public.organizations where id = $1`, [ctx.orgId]);
    const branch = await one(c, `select * from public.branches where id = $1`, [ctx.branchId]);
    const counts = await one(c, `select (select count(*)::int from public.academic_years where branch_id = $1) as years, (select count(*)::int from public.wings where branch_id = $1 and deleted_at is null) as wings,
        (select count(*)::int from public.sections where branch_id = $1 and deleted_at is null) as sections, (select count(*)::int from public.subjects where (branch_id = $1 or branch_id is null) and org_id = $2 and deleted_at is null) as subjects,
        (select count(*)::int from public.staff where org_id = $2 and deleted_at is null) as staff, (select count(*)::int from public.staff where org_id = $2 and reports_to is not null) as reporting,
        (select count(*)::int from public.bell_schedules where branch_id = $1) as bells`, [ctx.branchId, ctx.orgId]);
    return { org, branch, counts, steps: ['profile', 'year', 'structure', 'subjects', 'staff', 'org_chart', 'roles', 'modules'] };
  });
}

export async function setStep(ctx: Ctx, step: number) {
  needSetup(ctx);
  return run(ctx, async (c) => {
    await c.query(`update public.organizations set setup_step = greatest(setup_step, $2), setup_completed_at = case when $2 >= 8 then coalesce(setup_completed_at, now()) else setup_completed_at end where id = $1`, [ctx.orgId, step]);
    return { step };
  });
}

/** Step 1: school profile and board; applies the chosen preset. */
export async function saveProfile(ctx: Ctx, input: { name: string; preset_key: PresetKey; branch: { name: string; code: string; address?: string; latitude?: number | null; longitude?: number | null; geofence_radius_m: number } }) {
  needSetup(ctx);
  return run(ctx, async (c, sys) => {
    await update(c, 'organizations', ctx.orgId, { name: input.name, preset_key: input.preset_key });
    await update(c, 'branches', ctx.branchId, { name: input.branch.name, code: input.branch.code, address: input.branch.address ?? null, latitude: input.branch.latitude ?? null, longitude: input.branch.longitude ?? null, geofence_radius_m: input.branch.geofence_radius_m });
    await sys(() => applyPreset(c, ctx.orgId, ctx.branchId, input.preset_key));
    await c.query(`update public.organizations set setup_step = greatest(setup_step, 1) where id = $1`, [ctx.orgId]);
    return { ok: true };
  });
}

/** Step 2: academic year, terms, working days, bell schedule per wing. */
export async function saveYear(ctx: Ctx, input: { name: string; starts_on: string; ends_on: string; working_days: number[]; terms: { name: string; starts_on: string; ends_on: string }[]; bell: { wing_id?: string | null; name: string; periods: { label: string; kind: 'period' | 'break' | 'assembly'; starts_at: string; ends_at: string }[] }[] }) {
  needSetup(ctx);
  if (input.ends_on <= input.starts_on) throw new ValidationError('year_dates');
  return run(ctx, async (c) => {
    await c.query(`update public.academic_years set is_current = false where branch_id = $1`, [ctx.branchId]);
    const ay = await insert<{ id: string }>(c, 'academic_years', { org_id: ctx.orgId, branch_id: ctx.branchId, name: input.name, starts_on: input.starts_on, ends_on: input.ends_on, is_current: true });
    for (const [i, t] of input.terms.entries()) await insert(c, 'terms', { org_id: ctx.orgId, branch_id: ctx.branchId, academic_year_id: ay.id, name: t.name, seq: i + 1, starts_on: t.starts_on, ends_on: t.ends_on });
    await c.query(`update public.branches set working_days = $2 where id = $1`, [ctx.branchId, input.working_days]);
    await c.query(`update public.bell_schedules set active = false where branch_id = $1`, [ctx.branchId]);
    for (const b of input.bell) {
      const bs = await insert<{ id: string }>(c, 'bell_schedules', { org_id: ctx.orgId, branch_id: ctx.branchId, wing_id: b.wing_id ?? null, name: b.name, days: input.working_days });
      let ti = 0;
      for (const [i, p] of b.periods.entries()) {
        if (p.ends_at <= p.starts_at) throw new ValidationError('period_times', { row: i + 1 });
        await insert(c, 'periods', { org_id: ctx.orgId, branch_id: ctx.branchId, bell_schedule_id: bs.id, seq: i + 1, label: p.label, kind: p.kind, starts_at: p.starts_at, ends_at: p.ends_at, teaching_index: p.kind === 'period' ? ++ti : null });
      }
    }
    await c.query(`update public.organizations set setup_step = greatest(setup_step, 2) where id = $1`, [ctx.orgId]);
    return { academic_year_id: ay.id };
  });
}

// ---------------------------------------------------------------- Excel templates and parsing
export const IMPORT_TEMPLATES: Record<string, { columns: string[]; sample: (string | number)[][] }> = {
  wings_classes_sections: { columns: ['Wing', 'Board', 'Class', 'Grade', 'Section', 'Strength', 'Room', 'Class teacher code'], sample: [['Middle', 'CBSE', 'Class 6', 6, 'A', 32, 'Room 101', ''], ['Middle', 'CBSE', 'Class 6', 6, 'B', 30, 'Room 102', '']] },
  subjects: { columns: ['Code', 'Name', 'Department', 'Language', 'Core', 'Class', 'Periods per week', 'Double periods', 'Room type'], sample: [['MAT', 'Mathematics', 'Mathematics', 'en', 'Y', 'Class 6', 7, 0, ''], ['SCI', 'Science', 'Science', 'en', 'Y', 'Class 6', 7, 1, 'lab']] },
  staff: { columns: ['Employee code', 'Full name', 'Email', 'Phone', 'Position', 'Department', 'Wing', 'Branch code', 'Language', 'Teaching'], sample: [['T001', 'Asha Rao', 'asha@school.in', '+919876500001', 'Subject Teacher', 'Mathematics', 'Middle', 'MAIN', 'en', 'Y']] },
  org_chart: { columns: ['Employee code', 'Reports to'], sample: [['T001', 'P001']] },
  students: { columns: ['Admission no', 'Full name', 'Class', 'Section', 'Roll no', 'Parent phone'], sample: [['A1001', 'Ravi Kumar', 'Class 6', 'A', 1, '+919876511111']] },
  rooms: { columns: ['Name', 'Type', 'Capacity'], sample: [['Room 101', 'classroom', 40], ['Science Lab', 'lab', 30]] },
  allocations: { columns: ['Employee code', 'Class', 'Section', 'Subject code', 'Periods per week', 'Double periods'], sample: [['T001', 'Class 6', 'A', 'MAT', 7, 0]] },
};

export async function templateXlsx(kind: string): Promise<Buffer> {
  const t = IMPORT_TEMPLATES[kind];
  if (!t) throw new NotFoundError();
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(kind);
  ws.addRow(t.columns).font = { bold: true };
  for (const r of t.sample) ws.addRow(r);
  t.columns.forEach((c, i) => (ws.getColumn(i + 1).width = Math.max(14, c.length + 4)));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Parses an uploaded .xlsx or .csv into header-keyed rows. */
export async function parseSheet(base64: string, fileName: string): Promise<Record<string, string>[]> {
  const buf = Buffer.from(base64, 'base64');
  if (buf.length > 5 * 1024 * 1024) throw new ValidationError('file_too_large');
  if (/\.csv$/i.test(fileName)) {
    const lines = buf.toString('utf8').replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
    const split = (l: string) => l.match(/("([^"]|"")*"|[^,]*)(,|$)/g)!.slice(0, -1).map((x) => x.replace(/,$/, '').replace(/^"|"$/g, '').replace(/""/g, '"').trim());
    const head = split(lines[0] ?? '');
    return lines.slice(1).map((l) => Object.fromEntries(split(l).map((v, i) => [head[i] ?? `col${i}`, v])));
  }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const ws = wb.worksheets[0];
  if (!ws) return [];
  const header: string[] = [];
  ws.getRow(1).eachCell((cell, col) => (header[col - 1] = String(cell.value ?? '').trim()));
  const rows: Record<string, string>[] = [];
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const o: Record<string, string> = {};
    header.forEach((h, i) => {
      const v = row.getCell(i + 1).value;
      o[h] = v == null ? '' : v instanceof Date ? v.toISOString().slice(0, 10) : typeof v === 'object' && 'text' in v ? String((v as { text: string }).text) : String(v).trim();
    });
    if (Object.values(o).some((v) => v !== '')) rows.push(o);
  });
  return rows;
}

interface ImportResult {
  ok: boolean;
  created: number;
  updated: number;
  errors: { row: number; column?: string; error: string; value?: string }[];
}

const get = (r: Record<string, unknown>, k: string) => String(r[k] ?? '').trim();
const yes = (v: string) => /^(y|yes|true|1)$/i.test(v);

/** Imports with row-level errors. dry_run validates without writing. All-or-nothing. */
export async function importRows(ctx: Ctx, kind: string, rows: Record<string, unknown>[], dryRun: boolean): Promise<ImportResult> {
  needSetup(ctx);
  return run(ctx, async (c, sys) => {
    await c.query('savepoint import');
    const res = await doImport(c, ctx, kind, rows, sys);
    if (dryRun || res.errors.length) await c.query('rollback to savepoint import');
    else {
      const stepFor: Record<string, number> = { wings_classes_sections: 3, subjects: 4, staff: 5, org_chart: 6 };
      if (stepFor[kind]) await c.query(`update public.organizations set setup_step = greatest(setup_step, $2) where id = $1`, [ctx.orgId, stepFor[kind]]);
    }
    return { ...res, ok: !res.errors.length };
  });
}

async function doImport(c: Tx, ctx: Ctx, kind: string, rows: Record<string, unknown>[], sys: <T>(f: () => Promise<T>) => Promise<T>): Promise<Omit<ImportResult, 'ok'>> {
  const errors: ImportResult['errors'] = [];
  let created = 0;
  let updated = 0;
  const err = (row: number, column: string, error: string, value?: string) => errors.push({ row: row + 2, column, error, value });
  const need1 = (r: Record<string, unknown>, i: number, cols: string[]) => {
    let ok = true;
    for (const col of cols) if (!get(r, col)) (err(i, col, 'required'), (ok = false));
    return ok;
  };
  const ay = await maybe<{ id: string }>(c, `select id from public.academic_years where branch_id = $1 and is_current`, [ctx.branchId]);
  switch (kind) {
    case 'rooms':
      for (const [i, r] of rows.entries()) {
        if (!need1(r, i, ['Name'])) continue;
        const cap = Number(get(r, 'Capacity') || 40);
        if (!Number.isInteger(cap) || cap < 1) {
          err(i, 'Capacity', 'must_be_positive_integer', get(r, 'Capacity'));
          continue;
        }
        const ex = await maybe<{ id: string }>(c, `select id from public.rooms where branch_id = $1 and name = $2 and deleted_at is null`, [ctx.branchId, get(r, 'Name')]);
        if (ex) (await update(c, 'rooms', ex.id, { room_type: get(r, 'Type') || 'classroom', capacity: cap }), updated++);
        else (await insert(c, 'rooms', { org_id: ctx.orgId, branch_id: ctx.branchId, name: get(r, 'Name'), room_type: get(r, 'Type') || 'classroom', capacity: cap }), created++);
      }
      break;
    case 'wings_classes_sections':
      for (const [i, r] of rows.entries()) {
        if (!need1(r, i, ['Wing', 'Class', 'Grade', 'Section'])) continue;
        const board = (get(r, 'Board') || 'CBSE').toUpperCase();
        if (!['CBSE', 'CAMBRIDGE', 'BOTH'].includes(board)) {
          err(i, 'Board', 'must_be_CBSE_CAMBRIDGE_or_BOTH', board);
          continue;
        }
        const grade = Number(get(r, 'Grade'));
        if (!Number.isInteger(grade) || grade < -3 || grade > 13) {
          err(i, 'Grade', 'invalid_grade', get(r, 'Grade'));
          continue;
        }
        let wing = await maybe<{ id: string }>(c, `select id from public.wings where branch_id = $1 and name = $2 and deleted_at is null`, [ctx.branchId, get(r, 'Wing')]);
        if (!wing) wing = await insert<{ id: string }>(c, 'wings', { org_id: ctx.orgId, branch_id: ctx.branchId, name: get(r, 'Wing'), board });
        let cls = await maybe<{ id: string }>(c, `select id from public.classes where branch_id = $1 and name = $2 and deleted_at is null`, [ctx.branchId, get(r, 'Class')]);
        if (!cls) cls = await insert<{ id: string }>(c, 'classes', { org_id: ctx.orgId, branch_id: ctx.branchId, wing_id: wing.id, name: get(r, 'Class'), grade_level: grade, seq: grade + 10 });
        const room = get(r, 'Room') ? await maybe<{ id: string }>(c, `select id from public.rooms where branch_id = $1 and name = $2`, [ctx.branchId, get(r, 'Room')]) : null;
        const roomId = room?.id ?? (get(r, 'Room') ? (await insert<{ id: string }>(c, 'rooms', { org_id: ctx.orgId, branch_id: ctx.branchId, name: get(r, 'Room'), room_type: 'classroom', capacity: 40 })).id : null);
        const ct = get(r, 'Class teacher code') ? await maybe<{ id: string }>(c, `select id from public.staff where org_id = $1 and employee_code = $2`, [ctx.orgId, get(r, 'Class teacher code')]) : null;
        if (get(r, 'Class teacher code') && !ct) err(i, 'Class teacher code', 'unknown_employee_code', get(r, 'Class teacher code'));
        const ex = await maybe<{ id: string }>(c, `select id from public.sections where class_id = $1 and name = $2 and deleted_at is null`, [cls.id, get(r, 'Section')]);
        const row = { org_id: ctx.orgId, branch_id: ctx.branchId, class_id: cls.id, academic_year_id: ay?.id ?? null, name: get(r, 'Section'), strength: Number(get(r, 'Strength') || 0), room_id: roomId, class_teacher_id: ct?.id ?? null };
        if (ex) (await update(c, 'sections', ex.id, row), updated++);
        else (await insert(c, 'sections', row), created++);
      }
      break;
    case 'subjects':
      for (const [i, r] of rows.entries()) {
        if (!need1(r, i, ['Code', 'Name'])) continue;
        const lang = (get(r, 'Language') || 'en').toLowerCase();
        if (!['en', 'hi', 'te', 'other'].includes(lang)) {
          err(i, 'Language', 'must_be_en_hi_te_or_other', lang);
          continue;
        }
        let dept = get(r, 'Department') ? await maybe<{ id: string }>(c, `select id from public.departments where org_id = $1 and name = $2`, [ctx.orgId, get(r, 'Department')]) : null;
        if (get(r, 'Department') && !dept) dept = await insert<{ id: string }>(c, 'departments', { org_id: ctx.orgId, name: get(r, 'Department') });
        let subj = await maybe<{ id: string }>(c, `select id from public.subjects where org_id = $1 and code = $2 and (branch_id = $3 or branch_id is null) and deleted_at is null`, [ctx.orgId, get(r, 'Code'), ctx.branchId]);
        if (!subj) (subj = await insert<{ id: string }>(c, 'subjects', { org_id: ctx.orgId, branch_id: ctx.branchId, code: get(r, 'Code'), name: get(r, 'Name'), department_id: dept?.id ?? null, content_language: lang, is_core: get(r, 'Core') ? yes(get(r, 'Core')) : true })), created++;
        if (get(r, 'Class')) {
          const cls = await maybe<{ id: string }>(c, `select id from public.classes where branch_id = $1 and name = $2 and deleted_at is null`, [ctx.branchId, get(r, 'Class')]);
          if (!cls) {
            err(i, 'Class', 'unknown_class', get(r, 'Class'));
            continue;
          }
          const ppw = Number(get(r, 'Periods per week') || 0);
          if (!Number.isInteger(ppw) || ppw < 0 || ppw > 60) {
            err(i, 'Periods per week', 'invalid_number', get(r, 'Periods per week'));
            continue;
          }
          await c.query(`insert into public.class_subjects (org_id, branch_id, class_id, subject_id, periods_per_week, double_periods, room_type) values ($1,$2,$3,$4,$5,$6,$7) on conflict (class_id, subject_id) do update set periods_per_week = excluded.periods_per_week, double_periods = excluded.double_periods, room_type = excluded.room_type`, [ctx.orgId, ctx.branchId, cls.id, subj.id, ppw, Number(get(r, 'Double periods') || 0), get(r, 'Room type') || null]);
        }
      }
      break;
    case 'staff': {
      const positions = await q<{ id: string; key: string; name: string; default_role_id: string | null }>(c, `select id, key, name, default_role_id from public.positions where org_id = $1 and deleted_at is null`, [ctx.orgId]);
      for (const [i, r] of rows.entries()) {
        if (!need1(r, i, ['Employee code', 'Full name', 'Position'])) continue;
        const email = get(r, 'Email');
        const phone = get(r, 'Phone');
        if (!email && !phone) {
          err(i, 'Email', 'email_or_phone_required');
          continue;
        }
        if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
          err(i, 'Email', 'invalid_email', email);
          continue;
        }
        if (phone && !/^\+?\d{10,13}$/.test(phone.replace(/[\s-]/g, ''))) {
          err(i, 'Phone', 'invalid_phone', phone);
          continue;
        }
        const pos = positions.find((p) => p.name.toLowerCase() === get(r, 'Position').toLowerCase() || p.key === get(r, 'Position').toLowerCase().replace(/\s+/g, '_'));
        if (!pos) {
          err(i, 'Position', 'unknown_position', get(r, 'Position'));
          continue;
        }
        const branchCode = get(r, 'Branch code');
        const branch = branchCode ? await maybe<{ id: string }>(c, `select id from public.branches where org_id = $1 and code = $2`, [ctx.orgId, branchCode]) : { id: ctx.branchId };
        if (!branch) {
          err(i, 'Branch code', 'unknown_branch', branchCode);
          continue;
        }
        const dept = get(r, 'Department') ? await maybe<{ id: string }>(c, `select id from public.departments where org_id = $1 and name = $2`, [ctx.orgId, get(r, 'Department')]) : null;
        if (get(r, 'Department') && !dept) {
          err(i, 'Department', 'unknown_department', get(r, 'Department'));
          continue;
        }
        const wing = get(r, 'Wing') ? await maybe<{ id: string }>(c, `select id from public.wings where org_id = $1 and name = $2`, [ctx.orgId, get(r, 'Wing')]) : null;
        if (get(r, 'Wing') && !wing) {
          err(i, 'Wing', 'unknown_wing', get(r, 'Wing'));
          continue;
        }
        const lang = (get(r, 'Language') || 'en').toLowerCase();
        const groupLevel = ['chairman', 'director'].includes(pos.key);
        const ex = await maybe<{ id: string }>(c, `select id from public.staff where org_id = $1 and employee_code = $2`, [ctx.orgId, get(r, 'Employee code')]);
        const row = { org_id: ctx.orgId, branch_id: groupLevel ? null : branch.id, employee_code: get(r, 'Employee code'), full_name: get(r, 'Full name'), email: email || null, phone: phone || null, position_id: pos.id, department_id: dept?.id ?? null, wing_id: wing?.id ?? null, language: ['en', 'hi', 'te'].includes(lang) ? lang : 'en', is_teaching: get(r, 'Teaching') ? yes(get(r, 'Teaching')) : ['class_teacher', 'subject_teacher', 'hod', 'academic_coordinator'].includes(pos.key) };
        if (ex) {
          await sys(() => update(c, 'staff', ex.id, row));
          updated++;
          continue;
        }
        // Staff are invited by the school; there is no self sign-up.
        const dupe = email ? await sys(() => maybe(c, `select 1 from public.staff where lower(email) = lower($1)`, [email])) : null;
        if (dupe) {
          err(i, 'Email', 'email_already_used', email);
          continue;
        }
        const userId = await sys(() => authUser(c, email || `${get(r, 'Employee code').toLowerCase()}@${ctx.orgId.slice(0, 8)}.invite`, phone || `+910000${Math.floor(Math.random() * 1e6)}`));
        const st = await sys(() => insert<{ id: string }>(c, 'staff', { ...row, user_id: userId, status: 'invited' }));
        if (pos.default_role_id) await sys(() => insert(c, 'staff_roles', { org_id: ctx.orgId, branch_id: row.branch_id, staff_id: st.id, role_id: pos.default_role_id }));
        created++;
      }
      break;
    }
    case 'org_chart': {
      for (const [i, r] of rows.entries()) {
        if (!need1(r, i, ['Employee code', 'Reports to'])) continue;
        const s = await maybe<{ id: string }>(c, `select id from public.staff where org_id = $1 and employee_code = $2`, [ctx.orgId, get(r, 'Employee code')]);
        const m = await maybe<{ id: string }>(c, `select id from public.staff where org_id = $1 and employee_code = $2`, [ctx.orgId, get(r, 'Reports to')]);
        if (!s) err(i, 'Employee code', 'unknown_employee_code', get(r, 'Employee code'));
        if (!m) err(i, 'Reports to', 'unknown_employee_code', get(r, 'Reports to'));
        if (!s || !m) continue;
        if (s.id === m.id) {
          err(i, 'Reports to', 'cannot_report_to_self');
          continue;
        }
        await sys(() => c.query(`update public.staff set reports_to = $2 where id = $1`, [s.id, m.id]));
        updated++;
      }
      const cycle = await sys(() => maybe<{ id: string }>(c, `with recursive up(id, mgr, path) as (select id, reports_to, array[id] from public.staff where org_id = $1 union all select up.id, s.reports_to, up.path || s.id from up join public.staff s on s.id = up.mgr where not s.id = any(up.path)) select id from up where mgr = any(path) limit 1`, [ctx.orgId]));
      if (cycle) errors.push({ row: 0, error: 'reporting_cycle_detected' });
      break;
    }
    case 'students':
      for (const [i, r] of rows.entries()) {
        if (!need1(r, i, ['Admission no', 'Full name', 'Class', 'Section'])) continue;
        const sec = await maybe<{ id: string; class_id: string }>(c, `select se.id, se.class_id from public.sections se join public.classes cl on cl.id = se.class_id where se.branch_id = $1 and cl.name = $2 and se.name = $3 and se.deleted_at is null`, [ctx.branchId, get(r, 'Class'), get(r, 'Section')]);
        if (!sec) {
          err(i, 'Section', 'unknown_class_section', `${get(r, 'Class')} ${get(r, 'Section')}`);
          continue;
        }
        const res = await q(c, `insert into public.students (org_id, branch_id, class_id, section_id, full_name, admission_no, roll_no, parent_phone) values ($1,$2,$3,$4,$5,$6,$7,$8)
           on conflict (branch_id, admission_no) do update set class_id = excluded.class_id, section_id = excluded.section_id, full_name = excluded.full_name, roll_no = excluded.roll_no, parent_phone = excluded.parent_phone returning (xmax = 0) as inserted`, [ctx.orgId, ctx.branchId, sec.class_id, sec.id, get(r, 'Full name'), get(r, 'Admission no'), Number(get(r, 'Roll no')) || null, get(r, 'Parent phone') || null]);
        if ((res[0] as { inserted: boolean }).inserted) created++;
        else updated++;
      }
      break;
    case 'allocations':
      for (const [i, r] of rows.entries()) {
        if (!need1(r, i, ['Employee code', 'Class', 'Section', 'Subject code', 'Periods per week'])) continue;
        const s = await maybe<{ id: string }>(c, `select id from public.staff where org_id = $1 and employee_code = $2`, [ctx.orgId, get(r, 'Employee code')]);
        const sec = await maybe<{ id: string }>(c, `select se.id from public.sections se join public.classes cl on cl.id = se.class_id where se.branch_id = $1 and cl.name = $2 and se.name = $3`, [ctx.branchId, get(r, 'Class'), get(r, 'Section')]);
        const subj = await maybe<{ id: string }>(c, `select id from public.subjects where org_id = $1 and code = $2 and (branch_id = $3 or branch_id is null)`, [ctx.orgId, get(r, 'Subject code'), ctx.branchId]);
        if (!s) err(i, 'Employee code', 'unknown_employee_code', get(r, 'Employee code'));
        if (!sec) err(i, 'Section', 'unknown_class_section');
        if (!subj) err(i, 'Subject code', 'unknown_subject', get(r, 'Subject code'));
        if (!s || !sec || !subj) continue;
        await c.query(`insert into public.teacher_allocations (org_id, branch_id, academic_year_id, staff_id, section_id, subject_id, periods_per_week, double_periods) values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (section_id, subject_id, staff_id) do update set periods_per_week = excluded.periods_per_week, double_periods = excluded.double_periods`, [ctx.orgId, ctx.branchId, ay?.id ?? null, s.id, sec.id, subj.id, Number(get(r, 'Periods per week')), Number(get(r, 'Double periods') || 0)]);
        created++;
      }
      break;
    default:
      throw new ValidationError('unknown_import_kind');
  }
  return { created, updated, errors };
}

/** Preset structure for a board: wings, classes and subjects without importing a file. */
export async function applyStructurePreset(ctx: Ctx, preset: PresetKey, sectionsPerClass: number) {
  needSetup(ctx);
  const rows: Record<string, unknown>[] = [];
  for (const w of PRESET_WINGS[preset]) for (const cl of w.classes) for (let s = 0; s < sectionsPerClass; s++) rows.push({ Wing: w.name, Board: w.board, Class: cl.name, Grade: cl.grade, Section: String.fromCharCode(65 + s), Strength: 30 });
  const res = await importRows(ctx, 'wings_classes_sections', rows, false);
  const subj = PRESET_SUBJECTS[preset].map((s) => ({ Code: s.code, Name: s.name, Department: s.department, Language: s.language, Core: s.core ? 'Y' : 'N' }));
  const res2 = await importRows(ctx, 'subjects', subj, false);
  return { structure: res, subjects: res2 };
}

// ---------------------------------------------------------------- staff
export async function listStaff(ctx: Ctx, opts: { q?: string; branch_id?: string; all?: boolean }) {
  return run(ctx, async (c) =>
    q(
      c,
      `select s.id, s.full_name, s.employee_code, s.email, s.phone, s.status, s.branch_id, s.language, s.is_teaching, s.reports_to, s.department_id, s.wing_id, s.max_periods_day, s.max_periods_week,
         p.name as position, d.name as department, w.name as wing, m.full_name as manager, b.name as branch_name,
         coalesce((select array_agg(r.key) from public.staff_roles sr join public.roles r on r.id = sr.role_id where sr.staff_id = s.id and sr.deleted_at is null), '{}') as role_keys
       from public.staff s left join public.positions p on p.id = s.position_id left join public.departments d on d.id = s.department_id left join public.wings w on w.id = s.wing_id
       left join public.staff m on m.id = s.reports_to left join public.branches b on b.id = s.branch_id
       where s.deleted_at is null and ($1::text is null or s.full_name ilike '%' || $1 || '%' or s.employee_code ilike $1) and ($2::uuid is null or s.branch_id = $2) and ($3 or s.status <> 'left')
       order by s.full_name limit 1000`,
      [opts.q ?? null, opts.branch_id ?? null, !!opts.all],
    ),
  );
}

export async function updateStaff(ctx: Ctx, id: string, patch: Record<string, unknown>) {
  need(ctx, 'staff', 'edit');
  const allowedKeys = ['full_name', 'email', 'phone', 'position_id', 'department_id', 'wing_id', 'reports_to', 'branch_id', 'language', 'is_teaching', 'is_part_time', 'max_periods_day', 'max_periods_week', 'unavailable', 'status', 'employee_code'];
  const clean = Object.fromEntries(Object.entries(patch).filter(([k]) => allowedKeys.includes(k)));
  if (clean.reports_to === id) throw new ValidationError('cannot_report_to_self');
  return run(ctx, async (c) => {
    if (clean.reports_to) {
      const subs = await one<{ ids: string[] }>(c, `select app.subordinates_of($1) as ids`, [id]);
      if (subs.ids.includes(clean.reports_to as string)) throw new ConflictError('reporting_cycle');
    }
    return update(c, 'staff', id, clean);
  });
}

/** Org chart: drag a person under a new manager (cycles refused). */
export async function moveInOrgChart(ctx: Ctx, staffId: string, reportsTo: string | null) {
  return updateStaff(ctx, staffId, { reports_to: reportsTo });
}

export async function orgChart(ctx: Ctx) {
  return run(ctx, async (c) => q(c, `select s.id, s.full_name, s.reports_to, p.name as position, s.branch_id, d.name as department from public.staff s left join public.positions p on p.id = s.position_id left join public.departments d on d.id = s.department_id where s.org_id = $1 and s.deleted_at is null and s.status <> 'left' order by p.rank nulls last, s.full_name`, [ctx.orgId]));
}

export async function inviteStaff(ctx: Ctx, input: { full_name: string; email?: string; phone?: string; employee_code: string; position_id: string; department_id?: string | null; wing_id?: string | null; reports_to?: string | null }) {
  need(ctx, 'staff', 'create');
  return run(ctx, async (c, sys) => {
    const pos = await one<{ default_role_id: string | null; key: string }>(c, `select default_role_id, key from public.positions where id = $1`, [input.position_id]);
    if (!input.email && !input.phone) throw new ValidationError('email_or_phone_required');
    const userId = await sys(() => authUser(c, input.email ?? `${input.employee_code.toLowerCase()}@${ctx.orgId.slice(0, 8)}.invite`, input.phone ?? `+910000${Math.floor(Math.random() * 1e6)}`));
    const s = await sys(() => insert<{ id: string }>(c, 'staff', { org_id: ctx.orgId, branch_id: ['chairman', 'director'].includes(pos.key) ? null : ctx.branchId, user_id: userId, full_name: input.full_name, email: input.email ?? null, phone: input.phone ?? null, employee_code: input.employee_code, position_id: input.position_id, department_id: input.department_id ?? null, wing_id: input.wing_id ?? null, reports_to: input.reports_to ?? null, status: 'invited' }));
    if (pos.default_role_id) await sys(() => insert(c, 'staff_roles', { org_id: ctx.orgId, staff_id: s.id, role_id: pos.default_role_id }));
    return { id: s.id };
  });
}

/** A staff member leaves: deactivate (tasks are reassigned via the tasks bulk action). */
export async function deactivateStaff(ctx: Ctx, id: string) {
  need(ctx, 'staff', 'edit', 5);
  return run(ctx, async (c, sys) => {
    await sys(() => update(c, 'staff', id, { status: 'left' }));
    await sys(() => c.query(`update public.device_tokens set revoked_at = now() where staff_id = $1 and revoked_at is null`, [id]));
    const open = await one<{ n: number }>(c, `select count(*)::int as n from public.tasks where owner_id = $1 and status in ('todo','in_progress','blocked','reopened')`, [id]);
    return { open_tasks: open.n };
  });
}

// ---------------------------------------------------------------- roles & matrix
export async function rolesMatrix(ctx: Ctx) {
  return run(ctx, async (c) => {
    const roles = await q(c, `select id, key, name, description, is_preset from public.roles where org_id = $1 and deleted_at is null order by is_preset desc, name`, [ctx.orgId]);
    const perms = await q(c, `select role_id, module, action, scope from public.role_permissions where org_id = $1 and deleted_at is null`, [ctx.orgId]);
    return { roles, permissions: perms, modules: PERMISSION_MODULES, actions: ACTIONS };
  });
}

/** Matrix edit: modules as rows, actions as columns, scope as a dropdown. Takes effect immediately. */
export async function setPermission(ctx: Ctx, input: { role_id: string; module: string; action: string; scope: string | null }) {
  needSetup(ctx);
  return run(ctx, async (c) => {
    if (input.scope === null) await c.query(`delete from public.role_permissions where role_id = $1 and module = $2 and action = $3`, [input.role_id, input.module, input.action]);
    else await c.query(`insert into public.role_permissions (org_id, role_id, module, action, scope) values ($1,$2,$3,$4,$5) on conflict (role_id, module, action) do update set scope = excluded.scope, deleted_at = null`, [ctx.orgId, input.role_id, input.module, input.action, input.scope]);
    return { ok: true };
  });
}

export async function createRole(ctx: Ctx, input: { key: string; name: string; description?: string; copy_from_role_id?: string }) {
  needSetup(ctx);
  return run(ctx, async (c) => {
    const role = await insert<{ id: string }>(c, 'roles', { org_id: ctx.orgId, key: input.key, name: input.name, description: input.description ?? null, is_preset: false });
    if (input.copy_from_role_id) await c.query(`insert into public.role_permissions (org_id, role_id, module, action, scope) select org_id, $2, module, action, scope from public.role_permissions where role_id = $1 and deleted_at is null`, [input.copy_from_role_id, role.id]);
    return role;
  });
}

export async function setStaffRoles(ctx: Ctx, staffId: string, roleIds: string[]) {
  needSetup(ctx);
  return run(ctx, async (c) => {
    await c.query(`delete from public.staff_roles where staff_id = $1 and not (role_id = any($2))`, [staffId, roleIds]);
    for (const r of roleIds) await c.query(`insert into public.staff_roles (org_id, staff_id, role_id) values ($1,$2,$3) on conflict (staff_id, role_id) do update set deleted_at = null`, [ctx.orgId, staffId, r]);
    return { ok: true };
  });
}

export async function assignmentRules(ctx: Ctx) {
  return run(ctx, async (c) => q(c, `select ar.*, f.name as from_name, t.name as to_name from public.assignment_rules ar join public.roles f on f.id = ar.from_role_id join public.roles t on t.id = ar.to_role_id where ar.org_id = $1 and ar.deleted_at is null`, [ctx.orgId]));
}

export async function setAssignmentRule(ctx: Ctx, input: { from_role_id: string; to_role_id: string; rule: string | null }) {
  needSetup(ctx);
  return run(ctx, async (c) => {
    if (input.rule === null) await c.query(`delete from public.assignment_rules where org_id = $1 and from_role_id = $2 and to_role_id = $3`, [ctx.orgId, input.from_role_id, input.to_role_id]);
    else await c.query(`insert into public.assignment_rules (org_id, from_role_id, to_role_id, rule) values ($1,$2,$3,$4) on conflict (org_id, from_role_id, to_role_id) do update set rule = excluded.rule, deleted_at = null`, [ctx.orgId, input.from_role_id, input.to_role_id, input.rule]);
    return { ok: true };
  });
}

export async function delegations(ctx: Ctx) {
  return run(ctx, async (c) => q(c, `select d.*, s.full_name as staff_name, dl.full_name as delegate_name from public.delegations d join public.staff s on s.id = d.staff_id join public.staff dl on dl.id = d.delegate_id where d.org_id = $1 and d.ends_on >= current_date - 30 and d.deleted_at is null order by d.starts_on desc`, [ctx.orgId]));
}

export async function addDelegation(ctx: Ctx, input: { staff_id: string; delegate_id: string; starts_on: string; ends_on: string; reason?: string | null }) {
  if (input.staff_id !== ctx.staffId) need(ctx, 'staff', 'edit', 5);
  return run(ctx, async (c, sys) => sys(() => insert(c, 'delegations', { org_id: ctx.orgId, branch_id: ctx.branchId, ...input, reason: input.reason ?? null })));
}

// ---------------------------------------------------------------- module flags, branding, branch settings
export async function moduleFlags(ctx: Ctx) {
  return run(ctx, async (c) => {
    const flags = await q<{ branch_id: string; module_key: string; enabled: boolean }>(c, `select branch_id, module_key, enabled from public.module_flags where branch_id = any($1)`, [ctx.branchIds]);
    return MODULE_KEYS.map((m) => ({ module_key: m, branches: Object.fromEntries(ctx.branchIds.map((b) => [b, flags.find((f) => f.branch_id === b && f.module_key === m)?.enabled ?? true])) }));
  });
}

export async function setModuleFlag(ctx: Ctx, input: { branch_id: string; module_key: string; enabled: boolean }) {
  needSetup(ctx);
  if (!ctx.branchIds.includes(input.branch_id)) throw new ForbiddenError();
  return run(ctx, async (c) => {
    await c.query(`insert into public.module_flags (org_id, branch_id, module_key, enabled) values ($1,$2,$3,$4) on conflict (branch_id, module_key) do update set enabled = excluded.enabled`, [ctx.orgId, input.branch_id, input.module_key, input.enabled]);
    return { ok: true };
  });
}

export async function updateBranding(ctx: Ctx, input: { logo_url?: string | null; branding: Record<string, string>; settings?: Record<string, unknown> }) {
  needSetup(ctx);
  return run(ctx, async (c) => update(c, 'organizations', ctx.orgId, { logo_url: input.logo_url ?? null, branding: input.branding, ...(input.settings ? { settings: input.settings } : {}) }));
}

export async function updateBranchSettings(ctx: Ctx, input: { name?: string; latitude?: number | null; longitude?: number | null; geofence_radius_m?: number; working_days?: number[]; settings?: Record<string, unknown> }) {
  needSetup(ctx);
  return run(ctx, async (c) => {
    const b = await one<{ settings: Record<string, unknown> }>(c, `select settings from public.branches where id = $1`, [ctx.branchId]);
    return update(c, 'branches', ctx.branchId, { ...input, settings: input.settings ? { ...b.settings, ...input.settings } : undefined });
  });
}

export async function addBranch(ctx: Ctx, input: { name: string; code: string; preset_key: PresetKey }) {
  if (rank(ctx, 'setup', 'configure') < 6) throw new ForbiddenError();
  return run(ctx, async (c, sys) => {
    const b = await insert<{ id: string }>(c, 'branches', { org_id: ctx.orgId, name: input.name, code: input.code });
    await sys(() => applyPreset(c, ctx.orgId, b.id, input.preset_key));
    return { id: b.id };
  });
}

// ---------------------------------------------------------------- generic configuration screens
/** Config tables editable through one screen pattern, each with reset-to-preset and history. */
export const CONFIG_ENTITIES: Record<string, { table: string; area?: ConfigArea; module: Parameters<typeof rank>[1]; columns: string[]; branchScoped?: boolean; order?: string }> = {
  task_categories: { table: 'task_categories', area: 'task_categories', module: 'tasks', columns: ['key', 'name', 'name_i18n', 'color', 'default_proof', 'default_verification', 'escalation_rule_id'] },
  escalation_rules: { table: 'escalation_rules', area: 'escalation', module: 'tasks', columns: ['name', 'remind_before_minutes', 'notify_owner_at_due', 'notify_assigner_after_working_minutes', 'notify_manager_after_working_days', 'urgent_factor'] },
  leave_types: { table: 'leave_types', area: 'leave_types', module: 'leave', columns: ['key', 'name', 'name_i18n', 'unit', 'yearly_quota', 'accrual', 'carry_forward', 'carry_forward_max', 'half_day_allowed', 'notice_days', 'doc_required_after_days', 'sandwich_rule', 'paid', 'active'] },
  ticket_categories: { table: 'ticket_categories', area: 'ticket_categories', module: 'helpdesk', columns: ['key', 'name', 'name_i18n', 'owner_role_id', 'owner_staff_id', 'sla_hours', 'cost_approval_limit'] },
  duty_types: { table: 'duty_types', area: 'duty_types', module: 'duty_roster', columns: ['key', 'name', 'name_i18n', 'location', 'starts_at', 'ends_at', 'overlaps_period_seq', 'staff_needed', 'days'] },
  exam_types: { table: 'exam_types', area: 'exam_types', module: 'exams', columns: ['key', 'name', 'name_i18n'] },
  event_templates: { table: 'event_templates', area: 'event_templates', module: 'events', columns: ['key', 'name', 'name_i18n', 'task_pack', 'committees', 'checklist', 'budget_lines'] },
  observation_rubrics: { table: 'observation_rubrics', area: 'rubric', module: 'observation', columns: ['name', 'domains', 'scale'] },
  notification_rules: { table: 'notification_rules', area: 'notification_rules', module: 'setup', columns: ['event_key', 'channels', 'recipients', 'optional', 'urgent', 'whatsapp_template', 'enabled'], order: 'event_key' },
  attendance_rules: { table: 'attendance_rules', area: 'attendance_rules', module: 'staff_attendance', columns: ['position_id', 'shift_start', 'shift_end', 'grace_minutes', 'half_day_after_minutes', 'early_exit_minutes', 'checkin_cutoff', 'selfie_retention_days', 'student_cutoff', 'student_edit_window_minutes', 'student_threshold_pct', 'parent_absent_alert'], branchScoped: true },
  plan_submission_rules: { table: 'plan_submission_rules', area: 'plan_rules', module: 'lesson_planner', columns: ['level', 'name', 'wing_id', 'due_weekday', 'due_time', 'days_before', 'review_steps', 'active'] },
  lesson_plan_templates: { table: 'lesson_plan_templates', area: 'lesson_template', module: 'lesson_planner', columns: ['name', 'wing_id', 'sections', 'header', 'default_teaching_model', 'is_default'] },
  custom_fields: { table: 'custom_fields', module: 'setup', columns: ['entity', 'key', 'label', 'field_type', 'options', 'required', 'seq'] },
  terminology: { table: 'terminology', module: 'setup', columns: ['term_key', 'value', 'branch_id'] },
  departments: { table: 'departments', area: 'departments', module: 'setup', columns: ['name', 'head_staff_id', 'branch_id'] },
  positions: { table: 'positions', area: 'roles', module: 'setup', columns: ['key', 'name', 'rank', 'default_role_id'] },
  rooms: { table: 'rooms', module: 'setup', columns: ['name', 'room_type', 'capacity'], branchScoped: true },
  wings: { table: 'wings', module: 'setup', columns: ['name', 'board', 'seq', 'student_attendance_mode', 'homework_limit_minutes'], branchScoped: true, order: 'seq' },
  classes: { table: 'classes', module: 'setup', columns: ['name', 'wing_id', 'grade_level', 'seq'], branchScoped: true, order: 'seq' },
  sections: { table: 'sections', module: 'setup', columns: ['name', 'class_id', 'class_teacher_id', 'room_id', 'strength', 'profile'], branchScoped: true },
  subjects: { table: 'subjects', module: 'setup', columns: ['name', 'code', 'department_id', 'content_language', 'is_core'] },
  class_subjects: { table: 'class_subjects', module: 'setup', columns: ['class_id', 'subject_id', 'periods_per_week', 'double_periods', 'room_type'], branchScoped: true },
  calendar_holidays: { table: 'calendar_events', module: 'calendar', columns: ['layer', 'title', 'starts_on', 'ends_on', 'is_working_day'] },
  timetable_constraints: { table: 'timetable_constraints', module: 'timetable', columns: ['kind', 'data'], branchScoped: true },
};

export async function listConfig(ctx: Ctx, entity: string) {
  const def = CONFIG_ENTITIES[entity];
  if (!def) throw new NotFoundError('entity');
  return run(ctx, async (c) => {
    const branchFilter = def.branchScoped ? `and branch_id = $2` : `and (branch_id is null or branch_id = $2)`;
    const extra = entity === 'calendar_holidays' ? ` and layer = 'holiday'` : '';
    return q(c, `select * from public."${def.table}" where org_id = $1 ${branchFilter} and deleted_at is null${extra} order by ${def.order ?? 'created_at'}`, [ctx.orgId, ctx.branchId]);
  });
}

export async function saveConfig(ctx: Ctx, entity: string, id: string | undefined, data: Record<string, unknown>) {
  const def = CONFIG_ENTITIES[entity];
  if (!def) throw new NotFoundError('entity');
  if (def.module === 'setup') needSetup(ctx);
  else need(ctx, def.module, 'configure');
  const clean = Object.fromEntries(Object.entries(data).filter(([k]) => def.columns.includes(k)));
  return run(ctx, async (c) => {
    if (id) return update(c, def.table, id, clean);
    return insert(c, def.table, { org_id: ctx.orgId, ...(def.branchScoped || clean.branch_id === undefined ? { branch_id: def.branchScoped ? ctx.branchId : (clean.branch_id as string | null) ?? null } : {}), ...clean });
  });
}

export async function deleteConfig(ctx: Ctx, entity: string, id: string) {
  const def = CONFIG_ENTITIES[entity];
  if (!def) throw new NotFoundError('entity');
  if (def.module === 'setup') needSetup(ctx);
  else need(ctx, def.module, 'configure');
  return run(ctx, async (c) => update(c, def.table, id, { deleted_at: new Date().toISOString() }));
}

/** Every configuration screen has Reset to preset. */
export async function resetConfig(ctx: Ctx, entity: string) {
  const def = CONFIG_ENTITIES[entity];
  if (!def?.area) throw new ValidationError('no_preset_for_entity');
  if (def.module === 'setup') needSetup(ctx);
  else need(ctx, def.module, 'configure');
  return run(ctx, async (c, sys) => {
    const org = await one<{ preset_key: PresetKey | null }>(c, `select preset_key from public.organizations where id = $1`, [ctx.orgId]);
    await sys(() => applyArea(c, def.area!, ctx.orgId, ctx.branchId, org.preset_key ?? 'cbse', { reset: true }));
    return { ok: true };
  });
}

/** … and a change history. */
export async function configHistory(ctx: Ctx, entity: string, entityId?: string) {
  const def = CONFIG_ENTITIES[entity];
  return run(ctx, async (c) => q(c, `select h.*, s.full_name as actor_name from public.config_history h left join public.staff s on s.user_id = h.actor_user_id where h.org_id = $1 and ($2::text is null or h.entity = $2) and ($3::uuid is null or h.entity_id = $3) order by h.created_at desc limit 200`, [ctx.orgId, def?.table ?? null, entityId ?? null]));
}

export async function resetArea(ctx: Ctx, area: ConfigArea) {
  needSetup(ctx);
  if (!CONFIG_AREAS.includes(area)) throw new ValidationError('unknown_area');
  return run(ctx, async (c, sys) => {
    const org = await one<{ preset_key: PresetKey | null }>(c, `select preset_key from public.organizations where id = $1`, [ctx.orgId]);
    await sys(() => applyArea(c, area, ctx.orgId, ctx.branchId, org.preset_key ?? 'cbse', { reset: true }));
    return { ok: true };
  });
}

// ---------------------------------------------------------------- year rollover
/** Copies structure, promotes sections, archives the old year read-only. */
export async function yearRollover(ctx: Ctx, input: { name: string; starts_on: string; ends_on: string }) {
  needSetup(ctx);
  return run(ctx, async (c, sys) => {
    const old = await one<{ id: string; starts_on: string }>(c, `select id, starts_on::text from public.academic_years where branch_id = $1 and is_current`, [ctx.branchId]);
    await c.query(`update public.academic_years set is_current = false, archived = true where id = $1`, [old.id]);
    const ay = await insert<{ id: string }>(c, 'academic_years', { org_id: ctx.orgId, branch_id: ctx.branchId, name: input.name, starts_on: input.starts_on, ends_on: input.ends_on, is_current: true });
    const shift = Math.round((Date.parse(input.starts_on) - Date.parse(old.starts_on)) / 86400000);
    await c.query(`insert into public.terms (org_id, branch_id, academic_year_id, name, seq, starts_on, ends_on) select org_id, branch_id, $2, name, seq, starts_on + $3::int, ends_on + $3::int from public.terms where academic_year_id = $1`, [old.id, ay.id, shift]);
    const classes = await q<{ id: string; grade_level: number; wing_id: string }>(c, `select id, grade_level, wing_id from public.classes where branch_id = $1 and deleted_at is null order by grade_level desc`, [ctx.branchId]);
    let promoted = 0;
    for (const cl of classes) {
      const next = classes.find((x) => x.grade_level === cl.grade_level + 1);
      const secs = await q<{ id: string; name: string }>(c, `select id, name from public.sections where class_id = $1 and academic_year_id = $2 and deleted_at is null`, [cl.id, old.id]);
      for (const s of secs) {
        // New year's section of the same class and name (structure copied).
        await insert(c, 'sections', { org_id: ctx.orgId, branch_id: ctx.branchId, class_id: cl.id, academic_year_id: ay.id, name: s.name });
        if (next) {
          const target = await maybe<{ id: string }>(c, `select id from public.sections where class_id = $1 and academic_year_id = $2 and name = $3`, [next.id, ay.id, s.name]);
          const tid = target?.id ?? (await insert<{ id: string }>(c, 'sections', { org_id: ctx.orgId, branch_id: ctx.branchId, class_id: next.id, academic_year_id: ay.id, name: s.name })).id;
          const r = await sys(() => q(c, `update public.students set class_id = $2, section_id = $3 where section_id = $1 and status = 'active' returning id`, [s.id, next.id, tid]));
          promoted += r.length;
        } else await sys(() => c.query(`update public.students set status = 'left' where section_id = $1 and status = 'active'`, [s.id]));
      }
    }
    // Leave balances: carry forward per type rules on the new year.
    await sys(() => enqueue(c, 'leave_carry_forward', { branch_id: ctx.branchId, from_year: old.id, to_year: ay.id }, { dedupeKey: `lcf:${ay.id}` }));
    return { academic_year_id: ay.id, promoted, next_year_start: addDays(input.starts_on, 0) };
  });
}
