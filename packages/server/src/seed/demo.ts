/**
 * Seed: "Demo International School" — 2 branches, 40 staff, 20 sections, students, a published
 * timetable, sample tasks and data for every module, so every screen can be opened and tested
 * (build rule 11). Run with `pnpm db:seed` (or `pnpm db:reset` for a clean database).
 */
import { randomUUID } from 'node:crypto';
import {
  PRESET_SUBJECTS,
  PRESET_RUBRIC,
  PRESET_APPRAISAL_WEIGHTS,
  addDays,
  isoWeekday,
  toLocal,
  generateTimetable,
  planPaperSlots,
  type GenAllocation,
} from '@autoed/shared';
import { asService, insert, insertMany, maybe, one, q, type Tx } from '../db';
import { applyPreset } from '../presets';
import { loadGlobalCurriculum } from '../curriculum';

export const DEMO_PASSWORDLESS_NOTE = 'Local dev login uses email only (AUTH_PROVIDER=dev).';

const today = process.env.SEED_TODAY ?? toLocal(new Date()).date;
const yearStart = Number(today.slice(0, 4)) - (Number(today.slice(5, 7)) < 4 ? 1 : 0);
const AY_START = `${yearStart}-04-01`;
const AY_END = `${yearStart + 1}-03-31`;

const STAFF_NAMES = [
  'Rajesh Reddy', 'Anita Sharma', // group
  'Meera Iyer', 'Suresh Rao', 'Kavitha Nair', 'Farhan Ali', 'Priya Menon', 'Lakshmi Devi', 'Ramesh Babu',
  'Deepa Krishnan', 'Arjun Mehta', 'Sneha Kulkarni', 'Vikram Singh', 'Pooja Verma', 'Imran Khan', 'Swathi Rao',
  'Naveen Kumar', 'Shalini Gupta', 'Kiran Joshi', 'Rohit Das', 'Ayesha Begum', 'Manoj Pillai', 'Geeta Patil', 'Srinivas Goud',
  // branch 2
  'Nandini Bose', 'Harish Chandra', 'Sarah Thomas', 'Aditya Rao', 'Fatima Sheikh', 'Gopal Krishna', 'Rekha Menon',
  'Varun Malhotra', 'Divya Prakash', 'Ravi Teja', 'Sunita Yadav', 'Abhishek Jain', 'Neha Kapoor', 'Mahesh Varma', 'Usha Rani', 'Kunal Shah',
];
const FIRST = ['Aarav', 'Vivaan', 'Aditya', 'Vihaan', 'Arjun', 'Sai', 'Reyansh', 'Ayaan', 'Krishna', 'Ishaan', 'Ananya', 'Diya', 'Aadhya', 'Saanvi', 'Pari', 'Anika', 'Navya', 'Myra', 'Sara', 'Kiara', 'Rohan', 'Kabir', 'Harsha', 'Tanvi', 'Meghana', 'Sahithi', 'Varun', 'Nikhil', 'Pranav', 'Riya'];
const LAST = ['Reddy', 'Sharma', 'Rao', 'Naidu', 'Patel', 'Gupta', 'Iyer', 'Khan', 'Verma', 'Kumar', 'Singh', 'Joshi', 'Menon', 'Das', 'Goud'];

interface StaffSpec {
  name: string;
  position: string;
  branch: 'G' | 'B1' | 'B2';
  dept?: string;
  wing?: string;
  teaches?: string[];
  extraRoles?: string[];
  reportsToIdx?: number;
}

export interface SeedOptions {
  log?: (m: string) => void;
  slug?: string;
  name?: string;
  domain?: string;
  phonePrefix?: string;
}

export async function seedDemo(opts: SeedOptions = {}): Promise<{ orgId: string; branchIds: string[] }> {
  const log = opts.log ?? (() => undefined);
  const slug = opts.slug ?? 'demo';
  const orgName = opts.name ?? 'Demo International School';
  const domain = opts.domain ?? 'demo.school';
  const phonePrefix = opts.phonePrefix ?? '+9190000';
  return asService(async (c) => {
    const exists = await maybe<{ id: string }>(c, `select id from public.organizations where slug = $1`, [slug]);
    if (exists) {
      log('Demo school already seeded');
      const b = await q<{ id: string }>(c, `select id from public.branches where org_id = $1 order by code`, [exists.id]);
      return { orgId: exists.id, branchIds: b.map((x) => x.id) };
    }

    log('Curriculum library');
    await loadGlobalCurriculum(c);

    // ---------------------------------------------------------------- platform
    const superUser = await authUser(c, 'admin@autoed.dev', '+919000000000');
    await insert(c, 'platform_admins', { user_id: superUser, name: 'AutoEd Support (Digivate)' }, { onConflict: '(user_id) do nothing' });

    // ---------------------------------------------------------------- org & branches
    log('Organisation');
    const org = await insert<{ id: string }>(c, 'organizations', {
      name: orgName,
      slug,
      preset_key: 'dual',
      branding: { header: orgName, footer: 'Hyderabad · demo.school', color: '#1d4ed8' },
      settings: { plan_bank_group_sharing: true },
      setup_step: 8,
      setup_completed_at: new Date().toISOString(),
    });
    const orgId = org.id;
    const b1 = await insert<{ id: string }>(c, 'branches', {
      org_id: orgId, name: 'Gachibowli Campus (CBSE)', code: 'GACH', address: 'Gachibowli, Hyderabad', latitude: 17.4401, longitude: 78.3489, geofence_radius_m: 250,
      settings: { quiet_hours: { start: '20:00', end: '06:30' }, day_close_time: '17:30', substitution_mode: 'confirm', digest_time: '07:30', coverage_at_risk: 3, coverage_critical: 8, bot_enabled: true },
    });
    const b2 = await insert<{ id: string }>(c, 'branches', {
      org_id: orgId, name: 'Kondapur Campus (Cambridge)', code: 'KOND', address: 'Kondapur, Hyderabad', latitude: 17.46, longitude: 78.357, geofence_radius_m: 200,
      settings: { quiet_hours: { start: '20:00', end: '06:30' }, day_close_time: '17:30', substitution_mode: 'auto', digest_time: '07:30', coverage_at_risk: 3, coverage_critical: 8, bot_enabled: true },
    });
    const branchIds = [b1.id, b2.id];

    log('Presets');
    await applyPreset(c, orgId, b1.id, 'cbse');
    await applyPreset(c, orgId, b2.id, 'cambridge');
    // Branch 2 uses "Stage" for classes
    await insert(c, 'terminology', { org_id: orgId, branch_id: b2.id, term_key: 'class', value: { en: 'Stage', hi: 'स्टेज', te: 'స్టేజ్' } });

    const roles = Object.fromEntries((await q<{ key: string; id: string }>(c, `select key, id from public.roles where org_id = $1`, [orgId])).map((r) => [r.key, r.id]));
    const positions = Object.fromEntries((await q<{ key: string; id: string }>(c, `select key, id from public.positions where org_id = $1`, [orgId])).map((r) => [r.key, r.id]));
    const depts = Object.fromEntries((await q<{ name: string; id: string }>(c, `select name, id from public.departments where org_id = $1`, [orgId])).map((r) => [r.name, r.id]));

    // ---------------------------------------------------------------- years, terms, calendar
    const years: Record<string, string> = {};
    for (const b of branchIds) {
      const ay = await insert<{ id: string }>(c, 'academic_years', { org_id: orgId, branch_id: b, name: `${yearStart}-${String(yearStart + 1).slice(2)}`, starts_on: AY_START, ends_on: AY_END, is_current: true });
      years[b] = ay.id;
      await insert(c, 'terms', { org_id: orgId, branch_id: b, academic_year_id: ay.id, name: 'Term 1', seq: 1, starts_on: AY_START, ends_on: `${yearStart}-09-30` });
      await insert(c, 'terms', { org_id: orgId, branch_id: b, academic_year_id: ay.id, name: 'Term 2', seq: 2, starts_on: `${yearStart}-10-01`, ends_on: AY_END });
    }
    const holidays: [string, string, string][] = [
      [`${yearStart}-08-15`, `${yearStart}-08-15`, 'Independence Day'],
      [`${yearStart}-10-02`, `${yearStart}-10-02`, 'Gandhi Jayanti'],
      [`${yearStart}-10-19`, `${yearStart}-10-23`, 'Dussehra break'],
      [`${yearStart}-12-25`, `${yearStart}-12-25`, 'Christmas'],
      [`${yearStart + 1}-01-14`, `${yearStart + 1}-01-16`, 'Sankranti'],
      [`${yearStart + 1}-01-26`, `${yearStart + 1}-01-26`, 'Republic Day'],
    ];
    for (const [s, e, t] of holidays) await insert(c, 'calendar_events', { org_id: orgId, branch_id: null, layer: 'holiday', title: t, starts_on: s, ends_on: e, is_working_day: false });
    await insert(c, 'calendar_events', { org_id: orgId, branch_id: b1.id, layer: 'exam', title: 'Term 2 exams', starts_on: `${yearStart + 1}-02-23`, ends_on: `${yearStart + 1}-03-06` });
    await insert(c, 'calendar_events', { org_id: orgId, branch_id: b1.id, layer: 'ptm', title: 'Parent-teacher meeting', starts_on: addDays(today, 12), ends_on: addDays(today, 12) });
    await insert(c, 'calendar_events', { org_id: orgId, branch_id: null, layer: 'training', title: 'Staff training: assessment for learning', starts_on: addDays(today, 5), ends_on: addDays(today, 5) });
    await insert(c, 'calendar_events', { org_id: orgId, branch_id: b1.id, layer: 'deadline', title: 'Term 2 question papers due', starts_on: addDays(today, 20), ends_on: addDays(today, 20) });

    // ---------------------------------------------------------------- structure
    log('Wings, classes, sections, rooms, subjects');
    const wingsB1 = {
      Middle: await insert<{ id: string }>(c, 'wings', { org_id: orgId, branch_id: b1.id, name: 'Middle', board: 'CBSE', seq: 1, student_attendance_mode: 'daily_once', homework_limit_minutes: 90 }),
      Secondary: await insert<{ id: string }>(c, 'wings', { org_id: orgId, branch_id: b1.id, name: 'Secondary', board: 'CBSE', seq: 2, student_attendance_mode: 'daily_once', homework_limit_minutes: 120 }),
    };
    const wingsB2 = {
      'Lower Secondary': await insert<{ id: string }>(c, 'wings', { org_id: orgId, branch_id: b2.id, name: 'Lower Secondary', board: 'CAMBRIDGE', seq: 1, student_attendance_mode: 'daily_twice', homework_limit_minutes: 90 }),
      IGCSE: await insert<{ id: string }>(c, 'wings', { org_id: orgId, branch_id: b2.id, name: 'IGCSE', board: 'CAMBRIDGE', seq: 2, student_attendance_mode: 'daily_once', homework_limit_minutes: 120 }),
    };

    const rooms: Record<string, { id: string; type: string; name: string }[]> = { [b1.id]: [], [b2.id]: [] };
    for (const b of branchIds) {
      for (let i = 1; i <= 10; i++) rooms[b]!.push({ ...(await insert<{ id: string }>(c, 'rooms', { org_id: orgId, branch_id: b, name: `Room ${100 + i}`, room_type: 'classroom', capacity: 40 })), type: 'classroom', name: `Room ${100 + i}` });
      for (const name of ['Science Lab 1', 'Science Lab 2']) rooms[b]!.push({ ...(await insert<{ id: string }>(c, 'rooms', { org_id: orgId, branch_id: b, name, room_type: 'lab', capacity: 30 })), type: 'lab', name });
      for (const [name, type, cap] of [['Computer Lab', 'computer_lab', 30], ['Library', 'library', 60], ['Assembly Hall', 'hall', 400], ['Staff Room', 'other', 30]] as const)
        rooms[b]!.push({ ...(await insert<{ id: string }>(c, 'rooms', { org_id: orgId, branch_id: b, name, room_type: type, capacity: cap })), type, name });
    }

    const subj: Record<string, Record<string, { id: string; periods: number; core: boolean; roomType?: string; doubles?: number }>> = { [b1.id]: {}, [b2.id]: {} };
    for (const [b, key] of [[b1.id, 'cbse'], [b2.id, 'cambridge']] as const) {
      for (const s of PRESET_SUBJECTS[key]) {
        const row = await insert<{ id: string }>(c, 'subjects', { org_id: orgId, branch_id: b, name: s.name, code: s.code, department_id: depts[s.department], content_language: s.language, is_core: s.core });
        subj[b]![s.code] = { id: row.id, periods: s.periods, core: s.core, roomType: s.roomType, doubles: s.doubles };
      }
    }
    const b2Periods: Record<string, number> = { ENG: 7, MAT: 7, SCI: 6, GP: 2, HIN: 3, ICT: 2, PE: 3, ART: 1, WB: 1 }; // 32 of 36 slots; keeps every teacher within 36 periods

    const classDefs: { b: string; wing: string; name: string; grade: number }[] = [
      ...[6, 7, 8].map((g) => ({ b: b1.id, wing: wingsB1.Middle.id, name: `Class ${g}`, grade: g })),
      ...[9, 10].map((g) => ({ b: b1.id, wing: wingsB1.Secondary.id, name: `Class ${g}`, grade: g })),
      ...[7, 8, 9].map((g) => ({ b: b2.id, wing: wingsB2['Lower Secondary'].id, name: `Stage ${g}`, grade: g })),
      { b: b2.id, wing: wingsB2.IGCSE.id, name: 'Year 10', grade: 10 },
      { b: b2.id, wing: wingsB2.IGCSE.id, name: 'Year 11', grade: 11 },
    ];
    const classes: { id: string; b: string; wing: string; name: string; grade: number }[] = [];
    let seq = 1;
    for (const cd of classDefs) classes.push({ ...cd, id: (await insert<{ id: string }>(c, 'classes', { org_id: orgId, branch_id: cd.b, wing_id: cd.wing, name: cd.name, grade_level: cd.grade, seq: seq++ })).id });
    for (const cl of classes) {
      const map = cl.b === b1.id ? subj[b1.id]! : subj[b2.id]!;
      for (const [code, s] of Object.entries(map)) {
        await insert(c, 'class_subjects', { org_id: orgId, branch_id: cl.b, class_id: cl.id, subject_id: s.id, periods_per_week: cl.b === b1.id ? s.periods : b2Periods[code] ?? s.periods, double_periods: s.doubles ?? 0, room_type: s.roomType ?? null });
      }
    }

    // ---------------------------------------------------------------- staff
    log('Staff');
    const specs: StaffSpec[] = [
      { name: STAFF_NAMES[0]!, position: 'chairman', branch: 'G', dept: 'Administration' },
      { name: STAFF_NAMES[1]!, position: 'director', branch: 'G', dept: 'Administration', reportsToIdx: 0 },
      // Branch 1 (22)
      { name: STAFF_NAMES[2]!, position: 'principal', branch: 'B1', dept: 'Administration', reportsToIdx: 1 }, // 2
      { name: STAFF_NAMES[3]!, position: 'vice_principal', branch: 'B1', dept: 'Administration', reportsToIdx: 2 }, // 3
      { name: STAFF_NAMES[4]!, position: 'academic_coordinator', branch: 'B1', dept: 'Science', wing: 'Middle', reportsToIdx: 3, teaches: ['SCI'] }, // 4
      { name: STAFF_NAMES[5]!, position: 'admin_officer', branch: 'B1', dept: 'Administration', reportsToIdx: 2 }, // 5
      { name: STAFF_NAMES[6]!, position: 'hod', branch: 'B1', dept: 'Science', wing: 'Secondary', reportsToIdx: 4, teaches: ['SCI'] }, // 6
      { name: STAFF_NAMES[7]!, position: 'hod', branch: 'B1', dept: 'Languages', wing: 'Middle', reportsToIdx: 4, teaches: ['HIN'] }, // 7
      { name: STAFF_NAMES[8]!, position: 'hod', branch: 'B1', dept: 'Mathematics', wing: 'Secondary', reportsToIdx: 4, teaches: ['MAT'] }, // 8
      { name: STAFF_NAMES[9]!, position: 'class_teacher', branch: 'B1', dept: 'Science', wing: 'Secondary', reportsToIdx: 6, teaches: ['SCI'] }, // 9
      { name: STAFF_NAMES[10]!, position: 'class_teacher', branch: 'B1', dept: 'Mathematics', wing: 'Middle', reportsToIdx: 8, teaches: ['MAT'] }, // 10
      { name: STAFF_NAMES[11]!, position: 'class_teacher', branch: 'B1', dept: 'Languages', wing: 'Middle', reportsToIdx: 7, teaches: ['ENG'] }, // 11
      { name: STAFF_NAMES[12]!, position: 'class_teacher', branch: 'B1', dept: 'Social Studies', wing: 'Secondary', reportsToIdx: 4, teaches: ['SST'] }, // 12
      { name: STAFF_NAMES[13]!, position: 'class_teacher', branch: 'B1', dept: 'Languages', wing: 'Secondary', reportsToIdx: 7, teaches: ['ENG'] }, // 13
      { name: STAFF_NAMES[14]!, position: 'subject_teacher', branch: 'B1', dept: 'Mathematics', wing: 'Middle', reportsToIdx: 8, teaches: ['MAT'] }, // 14
      { name: STAFF_NAMES[15]!, position: 'subject_teacher', branch: 'B1', dept: 'Languages', wing: 'Middle', reportsToIdx: 7, teaches: ['TEL'] }, // 15
      { name: STAFF_NAMES[16]!, position: 'subject_teacher', branch: 'B1', dept: 'Social Studies', wing: 'Middle', reportsToIdx: 4, teaches: ['SST'] }, // 16
      { name: STAFF_NAMES[17]!, position: 'subject_teacher', branch: 'B1', dept: 'Languages', wing: 'Secondary', reportsToIdx: 7, teaches: ['HIN'] }, // 17
      { name: STAFF_NAMES[18]!, position: 'subject_teacher', branch: 'B1', dept: 'Computer Science', wing: 'Middle', reportsToIdx: 4, teaches: ['CS', 'ART'] }, // 18
      { name: STAFF_NAMES[19]!, position: 'subject_teacher', branch: 'B1', dept: 'Physical Education', wing: 'Middle', reportsToIdx: 3, teaches: ['PE', 'LIB'] }, // 19
      { name: STAFF_NAMES[20]!, position: 'subject_teacher', branch: 'B1', dept: 'Science', wing: 'Middle', reportsToIdx: 6, teaches: ['SCI'] }, // 20
      { name: STAFF_NAMES[21]!, position: 'housekeeping_supervisor', branch: 'B1', dept: 'Operations', reportsToIdx: 5 }, // 21
      { name: STAFF_NAMES[22]!, position: 'transport_incharge', branch: 'B1', dept: 'Operations', reportsToIdx: 5 }, // 22
      { name: STAFF_NAMES[23]!, position: 'support_staff', branch: 'B1', dept: 'Operations', reportsToIdx: 21 }, // 23
      // Branch 2 (16)
      { name: STAFF_NAMES[24]!, position: 'principal', branch: 'B2', dept: 'Administration', reportsToIdx: 1 }, // 24
      { name: STAFF_NAMES[25]!, position: 'academic_coordinator', branch: 'B2', dept: 'Mathematics', wing: 'Lower Secondary', reportsToIdx: 24, teaches: ['MAT'] }, // 25
      { name: STAFF_NAMES[26]!, position: 'admin_officer', branch: 'B2', dept: 'Administration', reportsToIdx: 24 }, // 26
      { name: STAFF_NAMES[27]!, position: 'hod', branch: 'B2', dept: 'Science', wing: 'IGCSE', reportsToIdx: 25, teaches: ['SCI'] }, // 27
      { name: STAFF_NAMES[28]!, position: 'class_teacher', branch: 'B2', dept: 'Languages', wing: 'Lower Secondary', reportsToIdx: 25, teaches: ['ENG'] }, // 28
      { name: STAFF_NAMES[29]!, position: 'class_teacher', branch: 'B2', dept: 'Mathematics', wing: 'IGCSE', reportsToIdx: 25, teaches: ['MAT'] }, // 29
      { name: STAFF_NAMES[30]!, position: 'class_teacher', branch: 'B2', dept: 'Science', wing: 'Lower Secondary', reportsToIdx: 27, teaches: ['SCI'] }, // 30
      { name: STAFF_NAMES[31]!, position: 'subject_teacher', branch: 'B2', dept: 'Languages', wing: 'IGCSE', reportsToIdx: 25, teaches: ['ENG'] }, // 31
      { name: STAFF_NAMES[32]!, position: 'subject_teacher', branch: 'B2', dept: 'Social Studies', wing: 'Lower Secondary', reportsToIdx: 25, teaches: ['GP', 'WB'] }, // 32
      { name: STAFF_NAMES[33]!, position: 'subject_teacher', branch: 'B2', dept: 'Languages', wing: 'Lower Secondary', reportsToIdx: 25, teaches: ['HIN'] }, // 33
      { name: STAFF_NAMES[34]!, position: 'subject_teacher', branch: 'B2', dept: 'Computer Science', wing: 'IGCSE', reportsToIdx: 25, teaches: ['ICT', 'ART'] }, // 34
      { name: STAFF_NAMES[35]!, position: 'subject_teacher', branch: 'B2', dept: 'Physical Education', wing: 'Lower Secondary', reportsToIdx: 25, teaches: ['PE'] }, // 35
      { name: STAFF_NAMES[36]!, position: 'subject_teacher', branch: 'B2', dept: 'Science', wing: 'IGCSE', reportsToIdx: 27, teaches: ['SCI'] }, // 36
      { name: STAFF_NAMES[37]!, position: 'subject_teacher', branch: 'B2', dept: 'Mathematics', wing: 'Lower Secondary', reportsToIdx: 25, teaches: ['MAT'] }, // 37
      { name: STAFF_NAMES[38]!, position: 'subject_teacher', branch: 'B2', dept: 'Languages', wing: 'IGCSE', reportsToIdx: 25, teaches: ['ENG'] }, // 38
      { name: STAFF_NAMES[39]!, position: 'support_staff', branch: 'B2', dept: 'Operations', reportsToIdx: 26 }, // 39
    ];
    const staffIds: string[] = [];
    const branchOf = (s: StaffSpec) => (s.branch === 'B1' ? b1.id : s.branch === 'B2' ? b2.id : null);
    const wingOf = (s: StaffSpec) => (s.wing ? ({ ...wingsB1, ...wingsB2 } as Record<string, { id: string }>)[s.wing]?.id ?? null : null);
    const emails: string[] = [];
    for (let i = 0; i < specs.length; i++) {
      const s = specs[i]!;
      const email = emailFor(s, i, domain);
      emails.push(email);
      const userId = await authUser(c, email, `${phonePrefix}${String(10000 + i).slice(1)}`);
      const pos = positions[s.position]!;
      const st = await insert<{ id: string }>(c, 'staff', {
        org_id: orgId,
        branch_id: branchOf(s),
        user_id: userId,
        employee_code: `E${String(i + 1).padStart(3, '0')}`,
        full_name: s.name,
        email,
        phone: `${phonePrefix}${String(10000 + i).slice(1)}`,
        position_id: pos,
        department_id: s.dept ? depts[s.dept] : null,
        wing_id: wingOf(s),
        language: i === 23 ? 'te' : i === 39 ? 'hi' : 'en',
        status: 'active',
        joined_on: '2022-06-01',
        is_teaching: !!s.teaches,
        max_periods_day: 7,
        max_periods_week: 36,
        ui_prefs: s.position === 'support_staff' ? { simplified_home: true, large_text: true } : {},
      });
      staffIds.push(st.id);
      const roleKeys = new Set([positionRole(s.position), ...(s.extraRoles ?? [])]);
      if (s.teaches && s.position !== 'subject_teacher' && s.position !== 'class_teacher') roleKeys.add('subject_teacher');
      for (const rk of roleKeys) await insert(c, 'staff_roles', { org_id: orgId, branch_id: branchOf(s), staff_id: st.id, role_id: roles[rk] });
    }
    for (let i = 0; i < specs.length; i++) {
      const r = specs[i]!.reportsToIdx;
      if (r !== undefined) await c.query(`update public.staff set reports_to = $1 where id = $2`, [staffIds[r], staffIds[i]]);
    }
    // Science HOD of branch 1 is also secondary manager of the Middle-school science teacher
    await insert(c, 'reporting_lines', { org_id: orgId, branch_id: b1.id, staff_id: staffIds[20], manager_id: staffIds[4] });
    // Department heads
    await c.query(`update public.departments set head_staff_id = $1 where id = $2`, [staffIds[6], depts['Science']]);
    await c.query(`update public.departments set head_staff_id = $1 where id = $2`, [staffIds[8], depts['Mathematics']]);
    await c.query(`update public.departments set head_staff_id = $1 where id = $2`, [staffIds[7], depts['Languages']]);
    // Director has access to both branches by being group-level; VP of B1 also covers B2 events
    await insert(c, 'staff_branch_access', { org_id: orgId, branch_id: b2.id, staff_id: staffIds[3] });
    // Admin officer may assign to all teachers (override example from PRD 4.3)
    for (const to of ['class_teacher', 'subject_teacher']) await insert(c, 'assignment_rules', { org_id: orgId, from_role_id: roles['admin_officer'], to_role_id: roles[to], rule: 'assign' });

    // ---------------------------------------------------------------- sections & students
    log('Sections and students');
    const sections: { id: string; b: string; classId: string; wing: string; name: string; grade: number }[] = [];
    let roomIdx: Record<string, number> = { [b1.id]: 0, [b2.id]: 0 };
    const classTeachersB1 = [9, 10, 11, 12, 13];
    const classTeachersB2 = [28, 29, 30];
    let ctI1 = 0;
    let ctI2 = 0;
    for (const cl of classes) {
      for (const letter of ['A', 'B']) {
        const room = rooms[cl.b]![roomIdx[cl.b]!++]!;
        let ct: string | null = null;
        if (cl.b === b1.id && letter === 'A' && ctI1 < classTeachersB1.length) ct = staffIds[classTeachersB1[ctI1++]!]!;
        if (cl.b === b2.id && letter === 'A' && ctI2 < classTeachersB2.length) ct = staffIds[classTeachersB2[ctI2++]!]!;
        const sec = await insert<{ id: string }>(c, 'sections', { org_id: orgId, branch_id: cl.b, class_id: cl.id, academic_year_id: years[cl.b], name: letter, class_teacher_id: ct, room_id: room.id, strength: 20, profile: { ability_mix: 'mixed', medium: 'English' } });
        sections.push({ id: sec.id, b: cl.b, classId: cl.id, wing: cl.wing, name: `${cl.name} ${letter}`, grade: cl.grade });
      }
    }
    roomIdx = {};
    const students: Record<string, unknown>[] = [];
    let adm = 1000;
    sections.forEach((s, si) => {
      for (let r = 1; r <= 20; r++) {
        const fn = FIRST[(si * 7 + r * 3) % FIRST.length]!;
        const ln = LAST[(si + r * 5) % LAST.length]!;
        students.push({ id: randomUUID(), org_id: orgId, branch_id: s.b, class_id: s.classId, section_id: s.id, full_name: `${fn} ${ln}`, admission_no: `A${adm++}`, roll_no: r, status: 'active', parent_phone: `+9198${slug === 'demo' ? '0' : '1'}00${String(adm).padStart(5, '0')}` });
      }
    });
    await insertMany(c, 'students', students);

    // ---------------------------------------------------------------- bell schedules & timetable
    log('Bell schedules and timetable');
    const bell = async (b: string, name: string, slots: [string, 'period' | 'break' | 'assembly', string, string][]) => {
      const bs = await insert<{ id: string }>(c, 'bell_schedules', { org_id: orgId, branch_id: b, name, days: [1, 2, 3, 4, 5, 6] });
      let ti = 0;
      let sq = 1;
      for (const [label, kind, s, e] of slots) await insert(c, 'periods', { org_id: orgId, branch_id: b, bell_schedule_id: bs.id, seq: sq++, label, kind, starts_at: s, ends_at: e, teaching_index: kind === 'period' ? ++ti : null });
    };
    await bell(b1.id, 'Main schedule', [
      ['Assembly', 'assembly', '08:10', '08:30'], ['Period 1', 'period', '08:30', '09:10'], ['Period 2', 'period', '09:10', '09:50'], ['Period 3', 'period', '09:50', '10:30'],
      ['Short break', 'break', '10:30', '10:45'], ['Period 4', 'period', '10:45', '11:25'], ['Period 5', 'period', '11:25', '12:05'], ['Lunch', 'break', '12:05', '12:40'],
      ['Period 6', 'period', '12:40', '13:20'], ['Period 7', 'period', '13:20', '14:00'],
    ]);
    await bell(b2.id, 'Main schedule', [
      ['Registration', 'assembly', '08:00', '08:20'], ['Period 1', 'period', '08:20', '09:05'], ['Period 2', 'period', '09:05', '09:50'], ['Break', 'break', '09:50', '10:10'],
      ['Period 3', 'period', '10:10', '10:55'], ['Period 4', 'period', '10:55', '11:40'], ['Lunch', 'break', '11:40', '12:20'], ['Period 5', 'period', '12:20', '13:05'], ['Period 6', 'period', '13:05', '13:50'],
    ]);

    // allocations: spread each subject's sections across its teachers
    const allocRows: Record<string, unknown>[] = [];
    for (const b of branchIds) {
      const bSections = sections.filter((s) => s.b === b);
      const teacherIdx = specs.map((s, i) => ({ s, i })).filter((x) => branchOf(x.s) === b && x.s.teaches);
      for (const [code, sj] of Object.entries(subj[b]!)) {
        const teachers = teacherIdx.filter((x) => x.s.teaches!.includes(code)).map((x) => staffIds[x.i]!);
        if (!teachers.length) continue;
        bSections.forEach((sec, k) => {
          // prefer class teacher for their own section's subject
          const secRow = sec;
          const t = teachers[Math.floor((k * teachers.length) / bSections.length)]!;
          const periods = b === b1.id ? sj.periods : b2Periods[code] ?? sj.periods;
          allocRows.push({ id: randomUUID(), org_id: orgId, branch_id: b, academic_year_id: years[b], staff_id: t, section_id: secRow.id, subject_id: sj.id, periods_per_week: periods, double_periods: sj.doubles ?? 0, room_type: sj.roomType ?? null });
        });
      }
    }
    await insertMany(c, 'teacher_allocations', allocRows);

    for (const b of branchIds) {
      const bSections = sections.filter((s) => s.b === b);
      const sectionRows = await q<{ id: string; class_teacher_id: string | null }>(c, `select id, class_teacher_id from public.sections where branch_id = $1`, [b]);
      const allocs = allocRows.filter((a) => a.branch_id === b);
      const subjCore = new Map(Object.values(subj[b]!).map((s) => [s.id, s.core]));
      const teachersInvolved = [...new Set(allocs.map((a) => a.staff_id as string))];
      const gen = generateTimetable({
        days: [1, 2, 3, 4, 5, 6],
        sections: bSections.map((s) => ({ id: s.id, periodsPerDay: b === b1.id ? 7 : 6, classTeacherId: sectionRows.find((r) => r.id === s.id)?.class_teacher_id ?? null })),
        allocations: allocs.map<GenAllocation>((a) => ({ id: a.id as string, sectionId: a.section_id as string, subjectId: a.subject_id as string, staffId: a.staff_id as string, periodsPerWeek: a.periods_per_week as number, doublePeriods: a.double_periods as number, roomType: (a.room_type as string) ?? null, isCore: subjCore.get(a.subject_id as string) ?? true })),
        teachers: Object.fromEntries(teachersInvolved.map((t) => [t, { maxPerDay: 7, maxPerWeek: 36, unavailable: [] }])),
        rooms: rooms[b]!.filter((r) => r.type === 'lab').map((r) => ({ id: r.id, type: r.type })),
      });
      const v = await insert<{ id: string }>(c, 'timetable_versions', { org_id: orgId, branch_id: b, academic_year_id: years[b], name: 'Main timetable', status: 'published', effective_from: AY_START, generated_at: new Date().toISOString(), unplaced: gen.unplaced, score: gen.score });
      const homeRoom = new Map((await q<{ id: string; room_id: string }>(c, `select id, room_id from public.sections where branch_id = $1`, [b])).map((r) => [r.id, r.room_id]));
      await insertMany(
        c,
        'timetable_entries',
        gen.entries.map((e) => ({ org_id: orgId, branch_id: b, version_id: v.id, day: e.day, period_seq: e.periodSeq, section_id: e.sectionId, subject_id: e.subjectId, staff_id: e.staffId, room_id: e.roomId ?? homeRoom.get(e.sectionId) ?? null, group_key: e.groupKey, fixed_label: e.fixedLabel ?? null, locked: !!e.locked })),
      );
      log(`  timetable ${b === b1.id ? 'GACH' : 'KOND'}: ${gen.entries.length} entries, ${gen.unplaced.length} unplaced groups`);
    }

    // ---------------------------------------------------------------- AI plan & credits
    const growth = await one<{ id: string }>(c, `select id from public.plans where key = 'growth'`);
    for (const b of branchIds) {
      await insert(c, 'branch_subscriptions', { org_id: orgId, branch_id: b, plan_id: growth.id, starts_on: AY_START, teacher_monthly_cap: 60 });
      await insert(c, 'ai_credit_ledger', { org_id: orgId, branch_id: b, kind: 'allowance', period: today.slice(0, 7), credits: 1000, note: 'Monthly allowance (Growth)' });
    }

    // ---------------------------------------------------------------- sample operational data
    log('Sample tasks, attendance, leave, tickets, circulars, meetings, events');
    const S = (i: number) => staffIds[i]!;
    const cat = Object.fromEntries((await q<{ key: string; id: string }>(c, `select key, id from public.task_categories where org_id = $1`, [orgId])).map((r) => [r.key, r.id]));
    const at = (d: string, hhmm: string) => new Date(`${d}T${hhmm}:00+05:30`).toISOString();
    const task = async (t: Record<string, unknown>) => {
      const row = await insert<{ id: string }>(c, 'tasks', { org_id: orgId, branch_id: b1.id, priority: 'normal', source: 'assigned', proof_required: 'none', verification_required: false, ...t });
      await insert(c, 'task_events', { org_id: orgId, branch_id: b1.id, task_id: row.id, actor_id: t.assigner_id ?? t.owner_id, event: 'created', to_status: t.status ?? 'todo' });
      return row.id;
    };
    await task({ title: 'Submit Class 10 Science unit test question paper', category_id: cat.academic, owner_id: S(9), assigner_id: S(6), due_at: at(addDays(today, 2), '16:00'), priority: 'high', proof_required: 'file', verification_required: true });
    await task({ title: 'Update notice board for PTM', category_id: cat.admin, owner_id: S(11), assigner_id: S(4), due_at: at(today, '15:00') });
    await task({ title: 'Collect fee reminder acknowledgements from Class 8A', category_id: cat.parent, owner_id: S(11), assigner_id: S(5), due_at: at(addDays(today, -1), '14:00'), status: 'todo' });
    await task({ title: 'Lab equipment inventory', category_id: cat.academic, owner_id: S(20), assigner_id: S(6), due_at: at(addDays(today, -2), '16:00'), status: 'in_progress' });
    await task({ title: 'Prepare Annual Day dance practice list', category_id: cat.event, owner_id: S(19), assigner_id: S(3), due_at: at(addDays(today, 7), '16:00'), proof_required: 'photo', verification_required: true });
    await task({ title: 'Fix projector in Room 104', category_id: cat.maintenance, owner_id: S(21), assigner_id: S(5), due_at: at(today, '12:00'), status: 'done', completed_at: at(today, '11:00'), verification_required: true, proof_required: 'photo', proof_path: `${orgId}/demo/projector.jpg` });
    await task({ title: 'Plan revision worksheets for Class 9', source: 'self', category_id: cat.personal, owner_id: S(9), assigner_id: S(9), due_at: at(today, '17:00') });
    await task({ title: 'Called parent about absence (unplanned)', source: 'sudden', unplanned: true, owner_id: S(10), assigner_id: S(10), status: 'done', completed_at: at(today, '10:15'), time_spent_minutes: 15 });
    await task({ title: 'Can you share last year’s sports day plan?', source: 'request', status: 'requested', owner_id: S(13), assigner_id: S(19), due_at: at(addDays(today, 3), '16:00') });
    await task({ title: 'Verify CCTV storage report', category_id: cat.compliance, owner_id: S(21), assigner_id: S(2), due_at: at(addDays(today, -3), '12:00'), status: 'verified', completed_at: at(addDays(today, -3), '11:00'), verified_at: at(addDays(today, -3), '15:00'), verified_by: S(2) });
    // a group task: each class teacher completes it
    const parent = await task({ title: 'Share Term 2 syllabus with parents', category_id: cat.academic, owner_id: null, assigner_id: S(2), is_group_parent: true, group_mode: 'each', due_at: at(addDays(today, 4), '16:00') });
    for (const i of classTeachersB1) await task({ title: 'Share Term 2 syllabus with parents', category_id: cat.academic, owner_id: S(i), assigner_id: S(2), parent_task_id: parent, due_at: at(addDays(today, 4), '16:00') });
    // recurring
    await insert(c, 'task_recurrences', { org_id: orgId, branch_id: b1.id, template: { title: 'Weekly lab safety walk-through', category_id: cat.academic, priority: 'normal' }, target: { staff_ids: [S(20)] }, frequency: 'weekly', weekdays: [1], due_time: '15:00', starts_on: AY_START, assigner_id: S(6) });

    // staff attendance for yesterday and today
    const attRows: Record<string, unknown>[] = [];
    for (const d of [addDays(today, -1), today]) {
      if (isoWeekday(d) === 7) continue;
      staffIds.forEach((sid, i) => {
        const b = branchOf(specs[i]!);
        if (!b) return;
        if (d === today && (i === 14 || i === 33)) return; // absent today -> substitution demo
        const late = i % 9 === 0;
        attRows.push({ org_id: orgId, branch_id: b, staff_id: sid, date: d, check_in_at: at(d, late ? '08:25' : '07:52'), check_out_at: d === today ? null : at(d, '15:40'), source: 'app', status: late ? 'late' : 'present', late_minutes: late ? 25 : 0, check_in_lat: 17.4401, check_in_lng: 78.3489, check_in_distance_m: 30 });
      });
    }
    await insertMany(c, 'staff_attendance', attRows);

    // leave: an approved leave today for staff 14 (math, B1) -> substitutions; a pending one
    const lt = Object.fromEntries((await q<{ key: string; id: string }>(c, `select key, id from public.leave_types where org_id = $1`, [orgId])).map((r) => [r.key, r.id]));
    await insert(c, 'leave_requests', { org_id: orgId, branch_id: b1.id, staff_id: S(14), leave_type_id: lt.sick, start_date: today, end_date: today, days: 1, reason: 'Fever', status: 'approved', decided_at: new Date().toISOString() });
    const pendingType = await one<{ id: string }>(c, `select id from public.approval_types where org_id = $1 and key = 'leave'`, [orgId]);
    const lr = await insert<{ id: string }>(c, 'leave_requests', { org_id: orgId, branch_id: b1.id, staff_id: S(11), leave_type_id: lt.casual, start_date: addDays(today, 3), end_date: addDays(today, 3), days: 1, reason: 'Family function', handover_note: 'Worksheets are in the staff room', status: 'pending' });
    const ar = await insert<{ id: string }>(c, 'approval_requests', { org_id: orgId, branch_id: b1.id, approval_type_id: pendingType.id, applicant_id: S(11), title: `Casual leave · ${addDays(today, 3)}`, data: { days: 1 }, status: 'pending', current_seq: 1, pending_approver_ids: [S(7)], linked_type: 'leave_request', linked_id: lr.id, step_due_at: at(addDays(today, 2), '16:00') });
    await c.query(`update public.leave_requests set approval_request_id = $1 where id = $2`, [ar.id, lr.id]);
    await insert(c, 'approval_actions', { org_id: orgId, branch_id: b1.id, request_id: ar.id, step_seq: 0, actor_id: S(11), action: 'submit' });
    // purchase request pending with principal
    const purchase = await one<{ id: string }>(c, `select id from public.approval_types where org_id = $1 and key = 'purchase'`, [orgId]);
    await insert(c, 'approval_requests', { org_id: orgId, branch_id: b1.id, approval_type_id: purchase.id, applicant_id: S(6), title: 'Lab glassware restock', data: { item: 'Beakers and test tubes', amount: 8500, vendor: 'Hyderabad Scientific' }, status: 'pending', current_seq: 2, pending_approver_ids: [S(2)] });

    // leave balances for everyone
    const ltRows = await q<{ id: string; key: string }>(c, `select id, key from public.leave_types where org_id = $1 and key in ('casual','sick','earned')`, [orgId]);
    const balRows: Record<string, unknown>[] = [];
    staffIds.forEach((sid, i) => {
      const b = branchOf(specs[i]!);
      for (const t of ltRows) balRows.push({ org_id: orgId, branch_id: b, staff_id: sid, leave_type_id: t.id, academic_year_id: years[b ?? b1.id], opening: t.key === 'earned' ? 6 : t.key === 'sick' ? 4 : 0 });
    });
    await insertMany(c, 'leave_balances', balRows);

    // tickets
    const tcat = Object.fromEntries((await q<{ key: string; id: string }>(c, `select key, id from public.ticket_categories where org_id = $1`, [orgId])).map((r) => [r.key, r.id]));
    await insert(c, 'tickets', { org_id: orgId, branch_id: b1.id, category_id: tcat.electrical, room_id: rooms[b1.id]![3]!.id, title: 'Fan not working', priority: 'high', status: 'assigned', raised_by: S(11), owner_id: S(21), due_at: at(addDays(today, 1), '12:00') });
    await insert(c, 'tickets', { org_id: orgId, branch_id: b1.id, category_id: tcat.it, room_id: rooms[b1.id]![12]!.id, title: 'Two computers not booting', priority: 'normal', status: 'open', raised_by: S(18), owner_id: null, due_at: at(addDays(today, 2), '12:00') });
    await insert(c, 'tickets', { org_id: orgId, branch_id: b1.id, category_id: tcat.plumbing, room_id: rooms[b1.id]![0]!.id, title: 'Leaking tap near Room 101', priority: 'low', status: 'resolved', raised_by: S(21), owner_id: S(21), resolved_at: at(addDays(today, -1), '13:00'), cost: 450, vendor: 'Local plumber' });

    // circular
    const circ = await insert<{ id: string }>(c, 'circulars', { org_id: orgId, branch_id: b1.id, author_id: S(2), title: 'PTM schedule and dress code', body: 'Dear colleagues, the parent-teacher meeting is scheduled for the coming Saturday from 9 am to 1 pm. Please wear formal attire and keep student progress notes ready.', target: { branch_ids: [b1.id] }, response_mode: 'acknowledge', important: true, tags: ['ptm'], status: 'sent', sent_at: new Date().toISOString() });
    const recRows = staffIds.filter((_, i) => branchOf(specs[i]!) === b1.id).map((sid, k) => ({ org_id: orgId, branch_id: b1.id, circular_id: circ.id, staff_id: sid, read_at: k % 3 === 0 ? new Date().toISOString() : null, acknowledged_at: k % 6 === 0 ? new Date().toISOString() : null }));
    await insertMany(c, 'circular_receipts', recRows);

    // meetings
    const m1 = await insert<{ id: string }>(c, 'meetings', { org_id: orgId, branch_id: b1.id, series_id: randomUUID(), title: 'Weekly staff meeting', agenda: '1. PTM preparation\n2. Term 2 exam timeline\n3. Any other business', starts_at: at(addDays(today, -7), '15:45'), ends_at: at(addDays(today, -7), '16:30'), room_id: rooms[b1.id]![15]!.id, organizer_id: S(2), attendee_ids: staffIds.slice(2, 21), status: 'held', minutes: 'Discussed PTM preparation and exam timeline.', attendance: Object.fromEntries(staffIds.slice(2, 21).map((s, k) => [s, k % 7 !== 0])) });
    const mt = await task({ title: 'Circulate exam timeline draft', category_id: cat.admin, owner_id: S(4), assigner_id: S(2), due_at: at(addDays(today, 1), '16:00'), linked_type: 'meeting', linked_id: m1.id });
    await insert(c, 'meeting_actions', { org_id: orgId, branch_id: b1.id, meeting_id: m1.id, description: 'Circulate exam timeline draft', owner_id: S(4), due_on: addDays(today, 1), task_id: mt });
    await insert(c, 'meetings', { org_id: orgId, branch_id: b1.id, series_id: (await one<{ series_id: string }>(c, 'select series_id from public.meetings where id = $1', [m1.id])).series_id, previous_meeting_id: m1.id, title: 'Weekly staff meeting', agenda: '1. Review of action items\n2. Annual Day planning', starts_at: at(addDays(today, isoWeekday(today) <= 5 ? 5 - isoWeekday(today) : 6), '15:45'), ends_at: at(addDays(today, isoWeekday(today) <= 5 ? 5 - isoWeekday(today) : 6), '16:30'), room_id: rooms[b1.id]![15]!.id, organizer_id: S(2), attendee_ids: staffIds.slice(2, 21), status: 'scheduled' });

    // event from template
    const annual = await one<{ id: string; task_pack: { title: string; role_key: string; days_before: number; priority: string }[] }>(c, `select id, task_pack from public.event_templates where org_id = $1 and key = 'annual_day'`, [orgId]);
    const evDate = addDays(today, 40);
    const ev = await insert<{ id: string }>(c, 'events', { org_id: orgId, branch_id: b1.id, template_id: annual.id, name: 'Annual Day', event_date: evDate, owner_id: S(3), budget: [{ line: 'Stage and sound', amount: 80000, approved: false }, { line: 'Costumes', amount: 40000, approved: false }], committees: [{ name: 'Stage', members: [S(19)] }] });
    const roleHolder: Record<string, string> = { academic_coordinator: S(4), admin_officer: S(5), vice_principal: S(3) };
    for (const tp of annual.task_pack) await task({ title: tp.title, category_id: cat.event, owner_id: roleHolder[tp.role_key] ?? S(3), assigner_id: S(3), priority: tp.priority, due_at: at(addDays(evDate, -tp.days_before), '16:00'), linked_type: 'event', linked_id: ev.id });

    // duty assignments this week
    const duty = await q<{ id: string; key: string }>(c, `select id, key from public.duty_types where org_id = $1 and key in ('gate','lunch')`, [orgId]);
    const dutyRows: Record<string, unknown>[] = [];
    for (let d = 0; d < 5; d++) {
      const date = addDays(today, d);
      if (isoWeekday(date) === 7) continue;
      duty.forEach((dt, k) => dutyRows.push({ org_id: orgId, branch_id: b1.id, duty_type_id: dt.id, staff_id: S(9 + ((d + k * 3) % 10)), date }));
    }
    await insertMany(c, 'duty_assignments', dutyRows);

    // incidents & compliance
    const someStudents = students.filter((s) => s.branch_id === b1.id).slice(0, 2).map((s) => s.id as string);
    await insert(c, 'incidents', { org_id: orgId, branch_id: b1.id, type: 'injury', student_ids: [someStudents[0]], occurred_at: at(addDays(today, -1), '11:10'), location_text: 'Playground', description: 'Student scraped knee during games period.', action_taken: 'First aid given; parent informed.', severity: 'low', owner_id: S(19), reported_by: S(19), status: 'closed' });
    await insert(c, 'incidents', { org_id: orgId, branch_id: b1.id, type: 'discipline', student_ids: someStudents, occurred_at: at(today, '10:00'), location_text: 'Corridor', description: 'Argument between two students.', action_taken: 'Counselled; follow-up with class teacher.', severity: 'medium', confidential: true, owner_id: S(3), reported_by: S(12), status: 'follow_up' });
    const comp = await q<{ id: string; name: string }>(c, `select id, name from public.compliance_items where org_id = $1`, [orgId]);
    for (const [k, item] of comp.entries()) {
      const exp = k % 5 === 0 ? addDays(today, 25) : k % 7 === 0 ? addDays(today, -5) : addDays(today, 200 + k * 10);
      await c.query(`update public.compliance_items set owner_id = $2, issued_on = $3, expires_on = $4, status = case when $4::date < $5::date then 'overdue' when $4::date <= ($5::date + 60) then 'expiring' else 'valid' end where id = $1`, [item.id, S(5), addDays(today, -300), exp, today]);
    }

    // checklist runs today
    const tpls = await q<{ id: string; branch_id: string; owner_role_id: string; schedule: { time: string; frequency: string } }>(c, `select id, branch_id, owner_role_id, schedule from public.checklist_templates where org_id = $1 and deleted_at is null`, [orgId]);
    for (const t of tpls) {
      if (t.schedule.frequency !== 'daily') continue;
      const owner = await maybe<{ staff_id: string }>(c, `select sr.staff_id from public.staff_roles sr join public.staff s on s.id = sr.staff_id where sr.role_id = $1 and s.branch_id = $2 limit 1`, [t.owner_role_id, t.branch_id]);
      const fallback = t.branch_id === b1.id ? S(21) : S(39);
      await insert(c, 'checklist_runs', { org_id: orgId, branch_id: t.branch_id, template_id: t.id, owner_id: owner?.staff_id ?? fallback, run_date: today, due_at: at(today, t.schedule.time), status: 'pending' });
    }

    // ---------------------------------------------------------------- academics
    log('Academics: annual plan, lesson plans, class log, exams, observation');
    const cbse10sci = await one<{ id: string }>(c, `select cs.id from public.curriculum_subjects cs join public.curriculum_boards b on b.id = cs.board_id where b.org_id is null and b.key = 'CBSE' and cs.grade_level = 10 and cs.name = 'Science'`);
    const chapters = await q<{ id: string; name: string; est_periods: number }>(c, `select t.id, t.name, t.est_periods from public.curriculum_topics t join public.curriculum_units u on u.id = t.unit_id where u.subject_id = $1 and t.kind = 'chapter' order by u.seq, t.seq`, [cbse10sci.id]);
    const class10 = classes.find((x) => x.b === b1.id && x.grade === 10)!;
    const ap = await insert<{ id: string }>(c, 'annual_plans', { org_id: orgId, branch_id: b1.id, academic_year_id: years[b1.id], class_id: class10.id, subject_id: subj[b1.id]!.SCI!.id, curriculum_subject_id: cbse10sci.id, staff_id: S(9), status: 'published' });
    let cursor = AY_START;
    for (const [k, chp] of chapters.entries()) {
      const end = addDays(cursor, Math.round(chp.est_periods * 1.0));
      await insert(c, 'annual_plan_items', { org_id: orgId, branch_id: b1.id, annual_plan_id: ap.id, topic_id: chp.id, seq: k + 1, planned_start: cursor, planned_end: end, planned_periods: chp.est_periods });
      cursor = addDays(end, 1);
    }
    const topic = await one<{ id: string }>(c, `select t.id from public.curriculum_topics t where t.parent_topic_id = $1 order by seq limit 1`, [chapters[0]!.id]);
    const sec10A = sections.find((s) => s.b === b1.id && s.name === 'Class 10 A')!;
    const sampleContent = {
      objectives: [{ text: 'Write balanced chemical equations from word descriptions', bloom: 'apply', outcome_codes: ['CB.SCI.10.1.1.1.1'] }],
      board_elements: { competencies: ['Represents changes symbolically'], nep_elements: ['Experiential learning: burning magnesium ribbon demo'], key_vocabulary: ['reactant', 'product'], success_criteria: [], assessment_objectives: [] },
      prior_knowledge: ['Symbols and formulae of common elements'],
      materials: ['Magnesium ribbon', 'Tongs', 'Burner'],
      flow: [
        { phase: 'opening', minutes: 5, teacher_activity: 'Show burning magnesium ribbon video clip', student_activity: 'Note observations' },
        { phase: 'teaching', minutes: 15, teacher_activity: 'Model writing and balancing an equation', student_activity: 'Follow along in notebooks' },
        { phase: 'guided_practice', minutes: 10, teacher_activity: 'Pairs balance three equations', student_activity: 'Work in pairs' },
        { phase: 'closure', minutes: 10, teacher_activity: 'Exit ticket', student_activity: 'Balance one equation independently' },
      ],
      differentiation: { support: 'Use atom-count tables', core: 'Balance standard equations', extension: 'Balance equations with polyatomic ions' },
      questions: [{ text: 'Why must an equation be balanced?', level: 'higher', competency: true }],
      exit_ticket: [{ question: 'Balance: H2 + O2 → H2O', answer: '2H2 + O2 → 2H2O' }],
      homework: { description: 'Balance 5 equations from the worksheet', minutes: 20 },
      links: ['Rusting of iron gates in monsoon'],
      board_work: 'Steps to balance an equation',
      reflection: '',
    };
    const lp = await insert<{ id: string }>(c, 'lesson_plans', { org_id: orgId, branch_id: b1.id, level: 'daily', staff_id: S(9), section_id: sec10A.id, section_ids: [sec10A.id], subject_id: subj[b1.id]!.SCI!.id, topic_id: topic.id, plan_date: today, period_count: 1, period_minutes: 40, teaching_model: '5E', content: sampleContent, status: 'approved', confirmed_by_teacher: true, submitted_at: at(addDays(today, -1), '15:00'), approved_at: at(addDays(today, -1), '17:00'), in_bank: true, rating_sum: 9, rating_count: 2, usage_count: 3 });
    await insert(c, 'lesson_plan_versions', { org_id: orgId, branch_id: b1.id, plan_id: lp.id, version: 1, content: sampleContent, note: 'Initial' });
    await insert(c, 'lesson_plans', { org_id: orgId, branch_id: b1.id, level: 'daily', staff_id: S(9), section_id: sec10A.id, section_ids: [sec10A.id], subject_id: subj[b1.id]!.SCI!.id, topic_id: topic.id, plan_date: addDays(today, 1), period_count: 1, period_minutes: 40, teaching_model: '5E', content: sampleContent, status: 'submitted', confirmed_by_teacher: true, submitted_at: new Date().toISOString(), due_at: at(today, '16:00') });
    // class logs for past days -> coverage
    const logRows: Record<string, unknown>[] = [];
    for (let d = 1; d <= 30; d++) {
      const date = addDays(today, -d);
      if (isoWeekday(date) === 7) continue;
      logRows.push({ org_id: orgId, branch_id: b1.id, section_id: sec10A.id, subject_id: subj[b1.id]!.SCI!.id, staff_id: S(9), date, period_seq: 2, topic_id: chapters[Math.min(chapters.length - 1, Math.floor(d / 8))]!.id, taught_as_planned: d % 5 !== 0, topic_text: 'Lesson taught', classwork: 'Notebook exercise' });
    }
    await insertMany(c, 'class_logs', logRows);
    await insert(c, 'homework', { org_id: orgId, branch_id: b1.id, section_id: sec10A.id, subject_id: subj[b1.id]!.SCI!.id, staff_id: S(9), assigned_on: today, due_on: addDays(today, 1), description: 'Balance 5 equations', est_minutes: 20 });
    await insert(c, 'homework', { org_id: orgId, branch_id: b1.id, section_id: sec10A.id, subject_id: subj[b1.id]!.MAT!.id, staff_id: S(8), assigned_on: today, due_on: addDays(today, 1), description: 'Exercise 4.2 Q1–10', est_minutes: 45 });
    await insert(c, 'homework', { org_id: orgId, branch_id: b1.id, section_id: sec10A.id, subject_id: subj[b1.id]!.SST!.id, staff_id: S(12), assigned_on: today, due_on: addDays(today, 1), description: 'Map work: rivers of India', est_minutes: 60 });

    // exams
    const term = await one<{ id: string }>(c, `select id from public.terms where branch_id = $1 and seq = 2`, [b1.id]);
    const et = await one<{ id: string }>(c, `select id from public.exam_types where org_id = $1 and key = 'term_exam'`, [orgId]);
    const exam = await insert<{ id: string }>(c, 'exams', { org_id: orgId, branch_id: b1.id, academic_year_id: years[b1.id], term_id: term.id, exam_type_id: et.id, name: 'Term 2 examination', starts_on: `${yearStart + 1}-02-23`, ends_on: `${yearStart + 1}-03-06`, class_ids: classes.filter((x) => x.b === b1.id).map((x) => x.id), status: 'planning' });
    await insert(c, 'exam_schedules', { org_id: orgId, branch_id: b1.id, exam_id: exam.id, class_id: class10.id, subject_id: subj[b1.id]!.SCI!.id, date: `${yearStart + 1}-02-23`, starts_at: '09:00', ends_at: '12:00', room_ids: rooms[b1.id]!.slice(0, 2).map((r) => r.id) });
    const ch3 = chapters.slice(0, 3);
    const weight: Record<string, number> = { [ch3[0]!.id]: 15, [ch3[1]!.id]: 15, [ch3[2]!.id]: 10 };
    const bp = await insert<{ id: string }>(c, 'paper_blueprints', { org_id: orgId, branch_id: b1.id, name: 'Class 10 Science unit test (40 marks)', board: 'CBSE', class_id: class10.id, subject_id: subj[b1.id]!.SCI!.id, total_marks: 40, duration_minutes: 90, sections: [{ name: 'A', question_type: 'mcq', count: 10, marks_each: 1 }, { name: 'B', question_type: 'short', count: 5, marks_each: 2 }, { name: 'C', question_type: 'long', count: 4, marks_each: 5 }], chapter_weightage: weight, difficulty: { easy: 30, medium: 50, hard: 20 }, competency_pct: 20, is_template: true, instructions: 'All questions are compulsory. Internal choice is given where indicated.' });
    // question bank: enough approved questions for a bank-only paper
    const slots = planPaperSlots({ totalMarks: 40, sections: [{ name: 'A', questionType: 'mcq', count: 10, marksEach: 1 }, { name: 'B', questionType: 'short', count: 5, marksEach: 2 }, { name: 'C', questionType: 'long', count: 4, marksEach: 5 }], chapterWeightage: weight, difficulty: { easy: 30, medium: 50, hard: 20 } }).slots;
    const qb: Record<string, unknown>[] = [];
    for (const s of slots) {
      for (let v = 0; v < 2; v++) {
        const chName = chapters.find((x) => x.id === s.topicId)!.name;
        qb.push({ org_id: orgId, branch_id: b1.id, subject_id: subj[b1.id]!.SCI!.id, class_id: class10.id, topic_id: s.topicId, question_type: s.questionType, difficulty: s.difficulty, marks: s.marks, bloom: s.difficulty === 'hard' ? 'analyse' : 'understand', competency: s.marks >= 5, content: { text: `[${chName}] ${s.questionType === 'mcq' ? 'Choose the correct option' : 'Answer'} (bank Q${s.no}${v ? 'b' : 'a'})`, options: s.questionType === 'mcq' ? ['A', 'B', 'C', 'D'] : undefined, answer: 'See marking scheme', marking: [{ step: 'Correct answer', marks: s.marks }] }, status: 'approved', source: 'manual' });
      }
    }
    await insertMany(c, 'question_bank', qb);
    void bp;

    // observation, appraisal, trainings
    const rubric = await one<{ id: string }>(c, `select id from public.observation_rubrics where org_id = $1 and is_preset`, [orgId]);
    const scores: Record<string, number> = {};
    for (const d of PRESET_RUBRIC.domains) for (const i of d.indicators) scores[`${d.key}.${i.key}`] = 3;
    await insert(c, 'observations', { org_id: orgId, branch_id: b1.id, rubric_id: rubric.id, observer_id: S(4), teacher_id: S(9), section_id: sec10A.id, subject_id: subj[b1.id]!.SCI!.id, scheduled_at: at(addDays(today, -6), '09:10'), status: 'shared', scores, overall: 66.7, feedback: 'Good use of demonstration; increase pair talk.' });
    await insert(c, 'observations', { org_id: orgId, branch_id: b1.id, rubric_id: rubric.id, observer_id: S(4), teacher_id: S(10), scheduled_at: at(addDays(today, 2), '10:45'), announced: false, status: 'scheduled' });
    await insert(c, 'appraisal_cycles', { org_id: orgId, branch_id: b1.id, name: `${yearStart}-${String(yearStart + 1).slice(2)} annual appraisal`, starts_on: AY_START, ends_on: AY_END, weights: PRESET_APPRAISAL_WEIGHTS });
    await insert(c, 'trainings', { org_id: orgId, branch_id: b1.id, staff_id: S(9), title: 'CBSE capacity building: competency-based assessment', provider: 'CBSE COE', attended_on: addDays(today, -40), hours: 6 });

    // ---------------------------------------------------------------- every remaining table gets sample rows
    log('Sample rows for remaining modules');
    const cf = await insert<{ id: string }>(c, 'custom_fields', { org_id: orgId, entity: 'task', key: 'parent_informed', label: { en: 'Parent informed?', hi: 'अभिभावक को सूचित किया?', te: 'తల్లిదండ్రులకు తెలియజేశారా?' }, field_type: 'yesno' });
    const anyTask = await one<{ id: string }>(c, `select id from public.tasks where org_id = $1 and title like 'Collect fee%'`, [orgId]);
    await insert(c, 'custom_field_values', { org_id: orgId, branch_id: b1.id, field_id: cf.id, entity: 'task', entity_id: anyTask.id, value: true });
    await insert(c, 'task_assignees', { org_id: orgId, branch_id: b1.id, task_id: anyTask.id, staff_id: S(4), kind: 'watcher' });
    await insert(c, 'task_comments', { org_id: orgId, branch_id: b1.id, task_id: anyTask.id, author_id: S(11), body: '12 of 20 collected so far.', kind: 'comment' });
    await insert(c, 'task_attachments', { org_id: orgId, branch_id: b1.id, task_id: anyTask.id, kind: 'attachment', storage_path: `${orgId}/tasks/${anyTask.id}/list.pdf`, mime: 'application/pdf', size_bytes: 20480 });
    await insert(c, 'delegations', { org_id: orgId, branch_id: b1.id, staff_id: S(2), delegate_id: S(3), starts_on: addDays(today, 20), ends_on: addDays(today, 24), reason: 'Principal at conference' });
    await insert(c, 'timetable_constraints', { org_id: orgId, branch_id: b1.id, kind: 'teacher_unavailable', data: { staff_id: S(19), day: 6, period_seq: 7 } });
    await insert(c, 'attendance_imports', { org_id: orgId, branch_id: b1.id, device_type: 'eSSL', mapping: { employeeCode: 'EmpCode', date: 'Date', checkIn: 'In', checkOut: 'Out', dateFormat: 'DD/MM/YYYY' }, file_name: 'essl-export.csv', rows_total: 0, rows_merged: 0 });

    // student attendance yesterday for every section
    const yday = isoWeekday(addDays(today, -1)) === 7 ? addDays(today, -2) : addDays(today, -1);
    for (const s of sections) {
      const sess = await insert<{ id: string }>(c, 'student_attendance_sessions', { org_id: orgId, branch_id: s.b, section_id: s.id, date: yday, session_key: s.wing === wingsB2['Lower Secondary'].id ? 'am' : 'day', marked_by: null, status: 'submitted', submitted_at: at(yday, '09:05') });
      const roster = students.filter((x) => x.section_id === s.id);
      await insertMany(c, 'student_attendance_marks', roster.map((st, k) => ({ org_id: orgId, branch_id: s.b, session_id: sess.id, student_id: st.id, status: k === 3 ? 'absent' : k === 7 ? 'late' : 'present' })));
    }

    // checklist responses for one completed run
    const run = await one<{ id: string; template_id: string; branch_id: string }>(c, `select r.id, r.template_id, r.branch_id from public.checklist_runs r join public.checklist_templates t on t.id = r.template_id where r.org_id = $1 and t.key = 'closing' and r.branch_id = $2`, [orgId, b1.id]);
    const items = await q<{ id: string; item_type: string }>(c, `select id, item_type from public.checklist_items where template_id = $1`, [run.template_id]);
    for (const it of items) await insert(c, 'checklist_responses', { org_id: orgId, branch_id: run.branch_id, run_id: run.id, item_id: it.id, value: true, passed: true });

    const tk = await one<{ id: string }>(c, `select id from public.tickets where org_id = $1 and title = 'Fan not working'`, [orgId]);
    await insert(c, 'ticket_events', { org_id: orgId, branch_id: b1.id, ticket_id: tk.id, actor_id: S(5), event: 'assigned', from_status: 'open', to_status: 'assigned' });
    const submittedPlan = await one<{ id: string }>(c, `select id from public.lesson_plans where org_id = $1 and status = 'submitted'`, [orgId]);
    await insert(c, 'lesson_plan_reviews', { org_id: orgId, branch_id: b1.id, plan_id: submittedPlan.id, step_seq: 1, reviewer_id: S(6), action: 'comment', section_key: 'flow', comment: 'Add a safety note for the demo.' });
    await insert(c, 'notebook_checks', { org_id: orgId, branch_id: b1.id, section_id: sec10A.id, subject_id: subj[b1.id]!.SCI!.id, staff_id: S(9), kind: 'spot_check', checked_on: addDays(today, -2), checked_by: S(4), rubric: { neatness: 3, corrections: 4 }, score: 3.5 });

    const sched = await one<{ id: string }>(c, `select id from public.exam_schedules where exam_id = $1`, [exam.id]);
    await insert(c, 'invigilation_duties', { org_id: orgId, branch_id: b1.id, exam_schedule_id: sched.id, room_id: rooms[b1.id]![0]!.id, staff_id: S(13) });
    await insert(c, 'seating_plans', { org_id: orgId, branch_id: b1.id, exam_id: exam.id, date: `${yearStart + 1}-02-23`, room_id: rooms[b1.id]![0]!.id, layout: students.filter((x) => x.section_id === sec10A.id).slice(0, 5).map((x, k) => ({ seat: k + 1, student_id: x.id, class_id: class10.id })) });
    const paperQs = slots.map((s) => ({ ...s, text: `Question ${s.no}`, answer: 'See scheme', marking: [{ step: 'Answer', marks: s.marks }] }));
    const paper = await insert<{ id: string }>(c, 'question_papers', { org_id: orgId, branch_id: b1.id, exam_id: exam.id, exam_schedule_id: sched.id, blueprint_id: bp.id, subject_id: subj[b1.id]!.SCI!.id, class_id: class10.id, set_no: 1, setter_id: S(9), reviewer_ids: [S(6), S(4)], exam_date: `${yearStart + 1}-02-23`, status: 'hod_review', questions: paperQs, blueprint_table: [] });
    await insert(c, 'paper_access_log', { org_id: orgId, branch_id: b1.id, paper_id: paper.id, staff_id: S(9), action: 'view' });

    const cycle = await one<{ id: string }>(c, `select id from public.appraisal_cycles where org_id = $1`, [orgId]);
    await insert(c, 'appraisal_scores', { org_id: orgId, branch_id: b1.id, cycle_id: cycle.id, staff_id: S(9), components: { observation: 66.7, task_on_time: 80 }, total: 72.4, computed_at: new Date().toISOString() });

    const doc = await insert<{ id: string }>(c, 'school_documents', { org_id: orgId, branch_id: b1.id, title: 'Class 10 Science year plan', kind: 'year_plan', storage_path: `${orgId}/documents/year-plan.txt`, mime: 'text/plain', size_bytes: 512, subject_id: subj[b1.id]!.SCI!.id, class_id: class10.id, status: 'embedded' });
    await insert(c, 'document_chunks', { org_id: orgId, branch_id: b1.id, document_id: doc.id, seq: 1, content: 'Term 1 covers chemical reactions, acids, bases and salts with two lab activities per chapter. Use local examples like curd setting and antacids.' });

    const gen = await insert<{ id: string }>(c, 'ai_generations', { org_id: orgId, branch_id: b1.id, staff_id: S(9), action: 'daily_plan', model: 'mock', provider: 'mock', input: { subject: 'Science', topic: 'Writing and balancing chemical equations' }, output: { ok: true }, status: 'ok', input_tokens: 1200, output_tokens: 1800, credits: 1, linked_type: 'lesson_plan', linked_id: lp.id });
    await insert(c, 'ai_credit_ledger', { org_id: orgId, branch_id: b1.id, staff_id: S(9), kind: 'usage', action: 'daily_plan', period: today.slice(0, 7), credits: -1, generation_id: gen.id, tokens: 3000 });
    await insert(c, 'credit_topup_requests', { org_id: orgId, branch_id: b2.id, requested_by: S(26), credits: 200, note: 'Exam season', status: 'pending' });

    const notif = await insert<{ id: string }>(c, 'notifications', { org_id: orgId, branch_id: b1.id, staff_id: S(9), event_key: 'task.assigned', title: 'New task: Submit Class 10 Science unit test question paper', body: 'Due in 2 days', link: '/os/tasks', channels: ['inapp', 'push'] });
    await insert(c, 'notification_prefs', { org_id: orgId, branch_id: b1.id, staff_id: S(9), event_key: 'task.comment', muted: true });
    await insert(c, 'device_tokens', { org_id: orgId, branch_id: b1.id, staff_id: S(9), token: `ExponentPushToken[demo-${orgId.slice(0, 8)}]`, platform: 'android', device_name: 'Redmi Note' });
    await insert(c, 'message_usage', { org_id: orgId, branch_id: b1.id, channel: 'whatsapp', template_key: 'os_substitution', notification_id: notif.id, status: 'sent', units: 1, provider_ref: 'mock-1' });
    const sr = await insert<{ id: string }>(c, 'saved_reports', { org_id: orgId, branch_id: b1.id, owner_id: S(2), name: 'Overdue tasks by department', dataset: 'tasks', config: { columns: ['department', 'count'], filters: [{ column: 'overdue', op: '=', value: true }], group_by: 'department', chart: 'bar' } });
    await insert(c, 'report_schedules', { org_id: orgId, branch_id: b1.id, report_key: 'daily_digest', frequency: 'daily', send_time: '07:30', recipient_ids: [S(2), S(1)], channel: 'inapp' });
    void sr;
    const sop = await insert<{ id: string }>(c, 'kb_articles', { org_id: orgId, branch_id: null, slug: 'sop-bus-delay', language: 'en', title: 'SOP: bus running late', body: 'If a bus is more than 15 minutes late, inform the transport in-charge, message parents through the school app, and log a ticket under Transport.', role_keys: [], tags: ['sop', 'transport'], module_key: 'helpdesk' });
    await insert(c, 'kb_chunks', { org_id: orgId, article_id: sop.id, language: 'en', seq: 1, content: 'If a bus is more than 15 minutes late, inform the transport in-charge and log a ticket under Transport.' });
    const conv = await insert<{ id: string }>(c, 'bot_conversations', { org_id: orgId, branch_id: b1.id, staff_id: S(9), language: 'en', screen_path: '/os/tasks', messages: [{ role: 'user', content: 'How do I assign a task to all class teachers?' }, { role: 'assistant', content: '1. Open Tasks → New task. 2. Under Assign to, choose the Class Teacher role. 3. Pick "each person completes it". 4. Save.', link: '/os/tasks/new' }], status: 'answered' });
    await insert(c, 'bot_feedback', { org_id: orgId, branch_id: b1.id, conversation_id: conv.id, staff_id: S(9), message_index: 1, rating: 1, question: 'How do I assign a task to all class teachers?' });
    await insert(c, 'support_tickets', { org_id: orgId, branch_id: b1.id, staff_id: S(5), subject: 'Need help importing biometric file', body: 'Our device exports .dat files.', status: 'open' });
    await insert(c, 'view_as_sessions', { org_id: orgId, admin_user_id: superUser, reason: 'Onboarding call: checking setup wizard', starts_at: at(addDays(today, -10), '11:00'), expires_at: at(addDays(today, -10), '11:30') });
    await insert(c, 'presets', { org_id: orgId, key: 'demo_school_config', area: 'all', name: 'Demo school configuration snapshot', payload: { note: 'Saved by school' } });
    await insert(c, 'substitutions', { org_id: orgId, branch_id: b1.id, date: addDays(today, -7), day: isoWeekday(addDays(today, -7)), period_seq: 3, section_id: sections[0]!.id, subject_id: subj[b1.id]!.MAT!.id, absent_staff_id: S(10), substitute_staff_id: S(14), status: 'assigned', resolution: 'substitute', source: 'manual' });
    // a school copy of the CBSE map
    const { cloneBoard } = await import('../curriculum');
    const gBoard = await one<{ id: string }>(c, `select id from public.curriculum_boards where org_id is null and key = 'CBSE' and is_latest`);
    await cloneBoard(c, orgId, gBoard.id);

    log('Done');
    log(`Logins (dev): principal ${emails[2]}, teacher ${emails[9]}, coordinator ${emails[4]}, admin ${emails[5]}, chairman ${emails[0]}, super admin admin@autoed.dev`);
    return { orgId, branchIds };
  });
}

function positionRole(p: string) {
  return p;
}

function emailFor(s: StaffSpec, i: number, domain: string): string {
  const first = s.name.split(' ')[0]!.toLowerCase();
  const role = { chairman: 'chairman', director: 'director', principal: 'principal', vice_principal: 'vp', academic_coordinator: 'coordinator', admin_officer: 'admin', hod: 'hod', class_teacher: 'teacher', subject_teacher: 'teacher', housekeeping_supervisor: 'housekeeping', transport_incharge: 'transport', support_staff: 'support' }[s.position] ?? 'staff';
  const br = s.branch === 'B2' ? '.kond' : '';
  if (['chairman', 'director'].includes(s.position)) return `${role}@${domain}`;
  if (['principal', 'vice_principal', 'academic_coordinator', 'admin_officer'].includes(s.position)) return `${role}${br}@${domain}`;
  return `${first}.${role}${br}${i}@${domain}`;
}

/** Creates (or finds) an auth user. Locally inserts into auth.users; on Supabase uses the admin API. */
export async function authUser(c: Tx, email: string, phone: string): Promise<string> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (url && key) {
    const res = await fetch(`${url}/auth/v1/admin/users`, { method: 'POST', headers: { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ email, phone, email_confirm: true, phone_confirm: true }) });
    const body = (await res.json()) as { id?: string; msg?: string };
    if (body.id) return body.id;
    const found = await maybe<{ id: string }>(c, `select id from auth.users where email = $1`, [email]);
    if (found) return found.id;
    throw new Error(`could not create auth user ${email}: ${body.msg ?? res.status}`);
  }
  const found = await maybe<{ id: string }>(c, `select id from auth.users where email = $1`, [email]);
  if (found) return found.id;
  return (await one<{ id: string }>(c, `insert into auth.users (email, phone) values ($1, $2) returning id`, [email, phone])).id;
}
