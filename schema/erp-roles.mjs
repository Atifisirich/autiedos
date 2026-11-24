// ERP capabilities and default roles on the platform permission model (core.roles / core.role_permissions, read by
// app.can). Source: hbi83701-tech/autoederp supabase/migrations/004_logic_core.sql `app.seed_permissions`, PRD section 15.
// scripts/gen-erp.mjs turns this file into the function erp.seed_roles(org) (migration ..._erp_roles.sql).
//
// The ERP's own matrix had one level per capability: F full, B branch, S scoped (own sections / subjects), O own records
// only, V view, R request, - none. On the platform a level becomes (action, scope) rows per permission module:
//   F  view create edit delete configure manage   at scope org
//   B  view create edit delete                    at scope branch
//   S  view create edit                           at scope branch   (section/subject limits stay in the app; no delete)
//   V  view                                       at scope branch
//   O  no database permission: own records are reached through the "own" / "staff own" policies (own leave, own payslip)
//   R  no database permission: requests go through the "own" insert policies (a teacher requests a concession)
// A user with no home branch works at org level, so `branch` scope covers all branches for them (app.user_branch_ids()).

/** ERP capability -> permission modules it grants. Modules used by core tables (staff, leave, ...) are included so a
 *  role works for the core rows the ERP edits (core.student writes need students.*, etc.). */
export const CAP_MODULES = {
  students: ['students'],
  sensitive: ['student_sensitive'],
  attendance: ['student_attendance', 'staff_attendance'],
  timetable: ['timetable'],
  learning: ['learning'],
  homework: ['homework', 'class_posts'],
  marks: ['marks'],
  exams: ['exams'],
  wellbeing: ['wellbeing'],
  safeguarding: ['safeguarding'],
  health: ['health'],
  activities: ['activities'],
  admissions: ['admissions'],
  fees: ['fees'],
  concessions: ['concessions'],
  accounting: ['accounting'],
  staff: ['staff'],
  payroll: ['payroll'],
  leave: ['leave'],
  messages: ['communication', 'notifications'],
  transport: ['transport'],
  gate: ['gate', 'incidents'],
  hostel: ['hostel'],
  canteen: ['canteen'],
  inventory: ['inventory'],
  library: ['library'],
  documents: ['documents', 'files'],
  events: ['events', 'calendar'],
  helpdesk: ['helpdesk'],
  forms: ['forms'],
  reports: ['reports'],
  admin: ['setup', 'approvals', 'compliance', 'integrations', 'users'],
  audit: ['audit'],
  facilities: ['facilities'],
  leadership: ['leadership'],
};

export const ROLE_NAMES = {
  group_admin: 'Group admin', system_admin: 'System admin', principal: 'Principal', coordinator: 'Coordinator',
  class_teacher: 'Class teacher', subject_teacher: 'Subject teacher', accounts: 'Accounts', hr: 'HR',
  front_office: 'Front office', transport: 'Transport manager', librarian: 'Librarian', store: 'Store and canteen',
  warden: 'Warden', counsellor: 'Counsellor', nurse: 'Nurse', security: 'Security', driver: 'Driver / attendant',
  portal: 'Parent and student portal',
};

/** group_admin has F on every capability (including leadership). The rest are the ERP's seed matrix, unchanged. */
export const ROLE_MATRIX = {
  group_admin: 'ALL:F',
  system_admin: 'students:B,attendance:B,timetable:B,learning:B,homework:B,marks:B,exams:B,wellbeing:V,health:V,activities:B,admissions:B,fees:B,concessions:V,accounting:V,staff:B,payroll:V,leave:B,messages:B,transport:B,gate:B,hostel:B,canteen:B,inventory:B,library:B,documents:B,events:B,helpdesk:B,forms:B,reports:V,admin:F,audit:F,facilities:B',
  principal: 'students:B,sensitive:B,attendance:B,timetable:B,learning:B,homework:B,marks:B,exams:B,wellbeing:B,safeguarding:B,health:B,activities:B,admissions:B,fees:V,concessions:B,accounting:V,staff:B,leave:B,messages:B,transport:V,gate:B,hostel:B,canteen:V,inventory:V,library:V,documents:B,events:B,helpdesk:B,forms:B,reports:V,admin:V,audit:V,facilities:B,leadership:V',
  coordinator: 'students:V,attendance:B,timetable:B,learning:B,homework:B,marks:B,exams:B,wellbeing:B,health:V,activities:B,leave:V,messages:B,documents:V,events:B,helpdesk:B,forms:B,reports:V,library:V,facilities:V',
  class_teacher: 'students:V,sensitive:V,attendance:S,timetable:V,learning:S,homework:S,marks:S,exams:V,wellbeing:S,health:V,activities:S,fees:V,concessions:R,leave:O,messages:S,documents:V,events:V,helpdesk:S,forms:V,reports:V,library:V,facilities:V',
  subject_teacher: 'students:V,attendance:S,timetable:V,learning:S,homework:S,marks:S,exams:V,wellbeing:S,activities:V,leave:O,messages:S,events:V,helpdesk:V,forms:V,reports:V,library:V,facilities:V',
  accounts: 'students:V,fees:B,concessions:V,accounting:B,payroll:V,leave:O,messages:S,inventory:V,canteen:V,transport:V,documents:V,helpdesk:B,reports:V',
  hr: 'staff:F,payroll:F,leave:F,attendance:B,documents:B,helpdesk:B,events:V,reports:V,messages:S',
  front_office: 'students:B,admissions:B,fees:V,attendance:V,gate:B,messages:B,documents:B,events:B,helpdesk:B,forms:B,reports:V,transport:V,library:V,leave:O',
  transport: 'students:V,attendance:S,transport:B,fees:V,messages:S,gate:V,helpdesk:B,reports:V,leave:O',
  librarian: 'students:V,library:B,inventory:V,reports:V,leave:O',
  store: 'students:V,inventory:B,canteen:B,fees:V,reports:V,leave:O',
  warden: 'students:V,hostel:B,attendance:S,wellbeing:S,gate:B,health:V,messages:S,leave:O',
  counsellor: 'students:V,sensitive:V,wellbeing:B,safeguarding:B,health:V,events:V,leave:O',
  nurse: 'students:V,sensitive:V,health:B,leave:O',
  security: 'students:V,gate:B,transport:V,leave:O',
  driver: 'leave:O',
  portal: '',
};
