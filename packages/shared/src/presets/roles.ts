/**
 * Preset positions and roles (PRD 4.2, 4.3). Preset roles match preset positions.
 * Everything here is a starting point; schools edit it on the permission matrix.
 */
import type { Action, PermissionModule, Scope } from '../modules';

export interface PresetPermission {
  module: PermissionModule;
  action: Action;
  scope: Scope;
}

export interface PresetRole {
  key: string;
  name: string;
  name_i18n: { hi: string; te: string };
  permissions: PresetPermission[];
}

export interface PresetPosition {
  key: string;
  name: string;
  rank: number;
  role: string;
  teaching: boolean;
  groupLevel?: boolean;
}

const P = (module: PermissionModule, actions: Action[], scope: Scope): PresetPermission[] => actions.map((action) => ({ module, action, scope }));

const ALL: Action[] = ['view', 'create', 'edit', 'delete', 'assign', 'approve', 'verify', 'export', 'configure'];
const WORK: Action[] = ['view', 'create', 'edit', 'assign', 'approve', 'verify', 'export'];

/** Every staff member can run their own day. */
const BASE: PresetPermission[] = [
  ...P('tasks', ['view', 'create', 'edit'], 'own'),
  ...P('checklists', ['view', 'create', 'edit'], 'own'),
  ...P('staff_attendance', ['view', 'create'], 'own'),
  ...P('leave', ['view', 'create', 'edit'], 'own'),
  ...P('approvals', ['view', 'create'], 'own'),
  ...P('helpdesk', ['view', 'create'], 'own'),
  ...P('circulars', ['view'], 'own'),
  ...P('calendar', ['view'], 'branch'),
  ...P('meetings', ['view'], 'branch'),
  ...P('events', ['view'], 'branch'),
  ...P('duty_roster', ['view'], 'own'),
  ...P('incidents', ['view', 'create'], 'own'),
  ...P('help_bot', ['view'], 'own'),
  ...P('substitution', ['view'], 'own'),
  ...P('timetable', ['view'], 'branch'),
  ...P('staff', ['view'], 'own'),
  ...P('observation', ['view'], 'own'),
  ...P('reports', ['view'], 'own'),
  ...P('ai', ['view', 'create'], 'own'),
];

const TEACHING: PresetPermission[] = [
  ...P('student_attendance', ['view', 'create', 'edit'], 'own'),
  ...P('students', ['view'], 'branch'),
  ...P('lesson_planner', ['view', 'create', 'edit'], 'own'),
  ...P('syllabus_coverage', ['view'], 'own'),
  ...P('class_log', ['view', 'create', 'edit'], 'own'),
  ...P('exams', ['view'], 'branch'),
  ...P('question_papers', ['view', 'create', 'edit'], 'own'),
  ...P('appraisal', ['view'], 'own'),
];

const LEADER = (scope: Scope): PresetPermission[] => [
  ...P('tasks', WORK, scope),
  ...P('checklists', WORK, scope),
  ...P('staff_attendance', ['view', 'export', 'approve'], scope),
  ...P('student_attendance', ['view', 'export', 'approve'], scope),
  ...P('students', ['view'], 'branch'),
  ...P('leave', ['view', 'approve', 'export'], scope),
  ...P('approvals', ['view', 'approve', 'export'], scope),
  ...P('lesson_planner', ['view', 'approve', 'export'], scope),
  ...P('syllabus_coverage', ['view', 'export'], scope),
  ...P('class_log', ['view', 'export', 'verify'], scope),
  ...P('observation', ['view', 'create', 'edit', 'export'], scope),
  ...P('appraisal', ['view', 'edit'], scope),
  ...P('substitution', ['view', 'edit', 'assign'], scope),
  ...P('staff', ['view'], scope),
  ...P('reports', ['view', 'export'], scope),
  ...P('incidents', ['view', 'edit'], scope),
  ...P('meetings', ['view', 'create', 'edit'], 'branch'),
  ...P('circulars', ['view', 'create', 'edit'], scope),
  ...P('duty_roster', ['view'], scope),
  ...P('exams', ['view', 'create', 'edit'], 'branch'),
];

const FULL = (scope: Scope): PresetPermission[] =>
  (
    [
      'tasks', 'checklists', 'timetable', 'substitution', 'staff_attendance', 'student_attendance', 'leave', 'approvals',
      'lesson_planner', 'syllabus_coverage', 'class_log', 'exams', 'observation', 'helpdesk', 'circulars', 'calendar',
      'meetings', 'events', 'duty_roster', 'incidents', 'compliance', 'reports', 'help_bot', 'setup', 'staff', 'students',
      'appraisal', 'question_papers', 'incidents_confidential', 'ai', 'audit',
    ] as PermissionModule[]
  ).flatMap((m) => P(m, ALL, scope));

const SUPPORT_SUPERVISOR: PresetPermission[] = [
  ...P('tasks', ['view', 'create', 'edit', 'assign', 'verify'], 'team'),
  ...P('checklists', ['view', 'create', 'edit', 'verify'], 'team'),
  ...P('helpdesk', ['view', 'edit'], 'team'),
  ...P('duty_roster', ['view'], 'team'),
];

function merge(...lists: PresetPermission[][]): PresetPermission[] {
  const RANK: Record<Scope, number> = { own: 1, team: 2, department: 3, wing: 4, branch: 5, group: 6 };
  const m = new Map<string, PresetPermission>();
  for (const p of lists.flat()) {
    const k = `${p.module}.${p.action}`;
    const prev = m.get(k);
    if (!prev || RANK[p.scope] > RANK[prev.scope]) m.set(k, p);
  }
  return [...m.values()].sort((a, b) => a.module.localeCompare(b.module) || a.action.localeCompare(b.action));
}

export const PRESET_ROLES: PresetRole[] = [
  { key: 'chairman', name: 'Chairman', name_i18n: { hi: 'अध्यक्ष', te: 'ఛైర్మన్' }, permissions: merge(BASE, FULL('group')) },
  { key: 'director', name: 'Director', name_i18n: { hi: 'निदेशक', te: 'డైరెక్టర్' }, permissions: merge(BASE, FULL('group')) },
  { key: 'principal', name: 'Principal', name_i18n: { hi: 'प्रधानाचार्य', te: 'ప్రిన్సిపాల్' }, permissions: merge(BASE, TEACHING, FULL('branch')) },
  {
    key: 'vice_principal',
    name: 'Vice Principal',
    name_i18n: { hi: 'उप-प्रधानाचार्य', te: 'వైస్ ప్రిన్సిపాల్' },
    permissions: merge(BASE, TEACHING, LEADER('branch'), P('timetable', ALL, 'branch'), P('substitution', ALL, 'branch'), P('calendar', ['view', 'create', 'edit'], 'branch'), P('exams', ALL, 'branch'), P('duty_roster', ALL, 'branch'), P('question_papers', ['view', 'approve'], 'branch'), P('incidents_confidential', ['view'], 'branch'), P('events', ['view', 'create', 'edit'], 'branch')),
  },
  {
    key: 'academic_coordinator',
    name: 'Academic Coordinator',
    name_i18n: { hi: 'शैक्षणिक समन्वयक', te: 'అకడమిక్ కోఆర్డినేటర్' },
    permissions: merge(BASE, TEACHING, LEADER('wing'), P('substitution', ['view', 'edit', 'assign', 'configure'], 'branch'), P('timetable', ['view', 'edit'], 'branch'), P('lesson_planner', ['view', 'approve', 'configure'], 'wing'), P('question_papers', ['view', 'approve'], 'wing'), P('exams', ['view', 'create', 'edit', 'assign'], 'branch'), P('duty_roster', ['view', 'create', 'edit', 'assign'], 'branch'), P('calendar', ['view', 'create'], 'branch')),
  },
  {
    key: 'hod',
    name: 'Head of Department',
    name_i18n: { hi: 'विभागाध्यक्ष', te: 'విభాగాధిపతి' },
    permissions: merge(BASE, TEACHING, LEADER('department'), P('question_papers', ['view', 'approve'], 'department'), P('lesson_planner', ['view', 'approve'], 'department')),
  },
  { key: 'class_teacher', name: 'Class Teacher', name_i18n: { hi: 'कक्षा अध्यापक', te: 'క్లాస్ టీచర్' }, permissions: merge(BASE, TEACHING) },
  { key: 'subject_teacher', name: 'Subject Teacher', name_i18n: { hi: 'विषय अध्यापक', te: 'సబ్జెక్ట్ టీచర్' }, permissions: merge(BASE, TEACHING) },
  {
    key: 'admin_officer',
    name: 'Admin Officer',
    name_i18n: { hi: 'प्रशासनिक अधिकारी', te: 'అడ్మిన్ ఆఫీసర్' },
    permissions: merge(BASE, P('staff_attendance', ALL, 'branch'), P('staff', ['view', 'create', 'edit'], 'branch'), P('students', ALL, 'branch'), P('circulars', ['view', 'create', 'edit', 'export'], 'branch'), P('approvals', ['view', 'approve', 'export'], 'branch'), P('helpdesk', ['view', 'create', 'edit', 'assign', 'configure', 'export'], 'branch'), P('leave', ['view', 'export'], 'branch'), P('tasks', ['view', 'create', 'edit', 'assign', 'verify'], 'branch'), P('checklists', ['view', 'create', 'edit', 'configure', 'export'], 'branch'), P('calendar', ['view', 'create', 'edit'], 'branch'), P('compliance', ['view', 'create', 'edit', 'export'], 'branch'), P('events', ['view', 'create', 'edit'], 'branch'), P('meetings', ['view', 'create', 'edit'], 'branch'), P('reports', ['view', 'export'], 'branch'), P('duty_roster', ['view'], 'branch')),
  },
  { key: 'front_office', name: 'Front Office Executive', name_i18n: { hi: 'फ्रंट ऑफिस कार्यकारी', te: 'ఫ్రంట్ ఆఫీస్ ఎగ్జిక్యూటివ్' }, permissions: merge(BASE, P('helpdesk', ['view', 'create'], 'branch'), P('circulars', ['view'], 'branch')) },
  { key: 'accountant', name: 'Accountant', name_i18n: { hi: 'लेखाकार', te: 'అకౌంటెంట్' }, permissions: merge(BASE, P('approvals', ['view', 'approve'], 'branch'), P('staff_attendance', ['view', 'export'], 'branch'), P('leave', ['view', 'export'], 'branch')) },
  { key: 'transport_incharge', name: 'Transport In-charge', name_i18n: { hi: 'परिवहन प्रभारी', te: 'రవాణా ఇన్‌ఛార్జ్' }, permissions: merge(BASE, SUPPORT_SUPERVISOR) },
  { key: 'housekeeping_supervisor', name: 'Housekeeping Supervisor', name_i18n: { hi: 'हाउसकीपिंग पर्यवेक्षक', te: 'హౌస్‌కీపింగ్ సూపర్‌వైజర్' }, permissions: merge(BASE, SUPPORT_SUPERVISOR) },
  { key: 'it_admin', name: 'IT Administrator', name_i18n: { hi: 'आईटी प्रशासक', te: 'ఐటీ అడ్మినిస్ట్రేటర్' }, permissions: merge(BASE, SUPPORT_SUPERVISOR) },
  { key: 'lab_assistant', name: 'Lab Assistant', name_i18n: { hi: 'प्रयोगशाला सहायक', te: 'ల్యాబ్ అసిస్టెంట్' }, permissions: merge(BASE) },
  { key: 'librarian', name: 'Librarian', name_i18n: { hi: 'पुस्तकालयाध्यक्ष', te: 'గ్రంథపాలకుడు' }, permissions: merge(BASE) },
  { key: 'security_supervisor', name: 'Security Supervisor', name_i18n: { hi: 'सुरक्षा पर्यवेक्षक', te: 'సెక్యూరిటీ సూపర్‌వైజర్' }, permissions: merge(BASE, SUPPORT_SUPERVISOR) },
  { key: 'support_staff', name: 'Support Staff', name_i18n: { hi: 'सहायक कर्मचारी', te: 'సహాయక సిబ్బంది' }, permissions: merge(BASE) },
];

export const PRESET_POSITIONS: PresetPosition[] = [
  { key: 'chairman', name: 'Chairman', rank: 1, role: 'chairman', teaching: false, groupLevel: true },
  { key: 'director', name: 'Director', rank: 2, role: 'director', teaching: false, groupLevel: true },
  { key: 'principal', name: 'Principal', rank: 10, role: 'principal', teaching: false },
  { key: 'vice_principal', name: 'Vice Principal', rank: 15, role: 'vice_principal', teaching: false },
  { key: 'academic_coordinator', name: 'Academic Coordinator', rank: 20, role: 'academic_coordinator', teaching: true },
  { key: 'hod', name: 'Head of Department', rank: 25, role: 'hod', teaching: true },
  { key: 'class_teacher', name: 'Class Teacher', rank: 30, role: 'class_teacher', teaching: true },
  { key: 'subject_teacher', name: 'Subject Teacher', rank: 31, role: 'subject_teacher', teaching: true },
  { key: 'admin_officer', name: 'Admin Officer', rank: 20, role: 'admin_officer', teaching: false },
  { key: 'front_office', name: 'Front Office Executive', rank: 40, role: 'front_office', teaching: false },
  { key: 'accountant', name: 'Accountant', rank: 35, role: 'accountant', teaching: false },
  { key: 'transport_incharge', name: 'Transport In-charge', rank: 35, role: 'transport_incharge', teaching: false },
  { key: 'housekeeping_supervisor', name: 'Housekeeping Supervisor', rank: 35, role: 'housekeeping_supervisor', teaching: false },
  { key: 'it_admin', name: 'IT Administrator', rank: 35, role: 'it_admin', teaching: false },
  { key: 'lab_assistant', name: 'Lab Assistant', rank: 45, role: 'lab_assistant', teaching: false },
  { key: 'librarian', name: 'Librarian', rank: 40, role: 'librarian', teaching: false },
  { key: 'security_supervisor', name: 'Security Supervisor', rank: 40, role: 'security_supervisor', teaching: false },
  { key: 'support_staff', name: 'Support Staff', rank: 60, role: 'support_staff', teaching: false },
];
