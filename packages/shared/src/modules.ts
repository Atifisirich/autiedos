/** Module keys from PRD section 3.2. Each can be switched per branch in module_flags. */
export const MODULE_KEYS = [
  'tasks',
  'checklists',
  'timetable',
  'substitution',
  'staff_attendance',
  'student_attendance',
  'leave',
  'approvals',
  'lesson_planner',
  'syllabus_coverage',
  'class_log',
  'exams',
  'observation',
  'helpdesk',
  'circulars',
  'calendar',
  'meetings',
  'events',
  'duty_roster',
  'incidents',
  'compliance',
  'reports',
  'help_bot',
] as const;
export type ModuleKey = (typeof MODULE_KEYS)[number];

/**
 * Permission modules: the switchable modules plus permission-only areas used by the
 * role matrix (structure setup, staff records, sensitive data, AI credits, audit).
 */
export const PERMISSION_MODULES = [
  ...MODULE_KEYS,
  'setup',
  'staff',
  'students',
  'appraisal',
  'question_papers',
  'incidents_confidential',
  'ai',
  'audit',
] as const;
export type PermissionModule = (typeof PERMISSION_MODULES)[number];

export const ACTIONS = ['view', 'create', 'edit', 'delete', 'assign', 'approve', 'verify', 'export', 'configure'] as const;
export type Action = (typeof ACTIONS)[number];

export const SCOPES = ['own', 'team', 'department', 'wing', 'branch', 'group'] as const;
export type Scope = (typeof SCOPES)[number];

export const SCOPE_RANK: Record<Scope, number> = { own: 1, team: 2, department: 3, wing: 4, branch: 5, group: 6 };

export function isModuleKey(v: string): v is ModuleKey {
  return (MODULE_KEYS as readonly string[]).includes(v);
}

/** Which switchable module a permission module belongs to (for flag checks). */
export function flagModuleFor(m: PermissionModule): ModuleKey | null {
  switch (m) {
    case 'appraisal':
      return 'observation';
    case 'question_papers':
      return 'exams';
    case 'incidents_confidential':
      return 'incidents';
    case 'students':
      return 'student_attendance';
    case 'setup':
    case 'staff':
    case 'ai':
    case 'audit':
      return null;
    default:
      return m;
  }
}

/** Mobile/web navigation entries. `module` null = always visible (subject to permission). */
export interface NavItem {
  key: string;
  href: string;
  labelKey: string;
  module: ModuleKey | null;
  perm?: { module: PermissionModule; action: Action };
  icon: string;
  webOnly?: boolean;
  group: 'day' | 'academic' | 'admin' | 'insight' | 'settings';
}

export const NAV_ITEMS: NavItem[] = [
  { key: 'my-day', href: '/os', labelKey: 'nav.myDay', module: null, icon: 'sun', group: 'day' },
  { key: 'tasks', href: '/os/tasks', labelKey: 'nav.tasks', module: 'tasks', icon: 'check-square', group: 'day' },
  { key: 'checklists', href: '/os/checklists', labelKey: 'nav.checklists', module: 'checklists', icon: 'list-checks', group: 'day' },
  { key: 'attendance', href: '/os/attendance', labelKey: 'nav.attendance', module: 'staff_attendance', icon: 'map-pin', group: 'day' },
  { key: 'student-attendance', href: '/os/student-attendance', labelKey: 'nav.studentAttendance', module: 'student_attendance', icon: 'users', group: 'day' },
  { key: 'leave', href: '/os/leave', labelKey: 'nav.leave', module: 'leave', icon: 'plane', group: 'day' },
  { key: 'approvals', href: '/os/approvals', labelKey: 'nav.approvals', module: 'approvals', icon: 'stamp', group: 'day' },
  { key: 'timetable', href: '/os/timetable', labelKey: 'nav.timetable', module: 'timetable', icon: 'grid', group: 'day' },
  { key: 'substitution', href: '/os/substitution', labelKey: 'nav.substitution', module: 'substitution', icon: 'shuffle', group: 'day' },
  { key: 'duty', href: '/os/duty', labelKey: 'nav.duty', module: 'duty_roster', icon: 'shield', group: 'day' },
  { key: 'lesson-plans', href: '/os/lesson-plans', labelKey: 'nav.lessonPlans', module: 'lesson_planner', icon: 'book', group: 'academic' },
  { key: 'coverage', href: '/os/coverage', labelKey: 'nav.coverage', module: 'syllabus_coverage', icon: 'gauge', group: 'academic' },
  { key: 'class-log', href: '/os/class-log', labelKey: 'nav.classLog', module: 'class_log', icon: 'notebook', group: 'academic' },
  { key: 'exams', href: '/os/exams', labelKey: 'nav.exams', module: 'exams', icon: 'file-text', group: 'academic' },
  { key: 'observation', href: '/os/observation', labelKey: 'nav.observation', module: 'observation', icon: 'eye', group: 'academic' },
  { key: 'helpdesk', href: '/os/helpdesk', labelKey: 'nav.helpdesk', module: 'helpdesk', icon: 'wrench', group: 'admin' },
  { key: 'circulars', href: '/os/circulars', labelKey: 'nav.circulars', module: 'circulars', icon: 'megaphone', group: 'admin' },
  { key: 'calendar', href: '/os/calendar', labelKey: 'nav.calendar', module: 'calendar', icon: 'calendar', group: 'admin' },
  { key: 'meetings', href: '/os/meetings', labelKey: 'nav.meetings', module: 'meetings', icon: 'message-circle', group: 'admin' },
  { key: 'events', href: '/os/events', labelKey: 'nav.events', module: 'events', icon: 'party', group: 'admin' },
  { key: 'incidents', href: '/os/incidents', labelKey: 'nav.incidents', module: 'incidents', icon: 'alert', group: 'admin' },
  { key: 'compliance', href: '/os/compliance', labelKey: 'nav.compliance', module: 'compliance', icon: 'shield-check', group: 'admin' },
  { key: 'reports', href: '/os/reports', labelKey: 'nav.reports', module: 'reports', icon: 'bar-chart', group: 'insight' },
  { key: 'inbox', href: '/os/inbox', labelKey: 'nav.inbox', module: null, icon: 'inbox', group: 'insight' },
  { key: 'ai-credits', href: '/os/ai-credits', labelKey: 'nav.aiCredits', module: null, perm: { module: 'ai', action: 'view' }, icon: 'sparkles', group: 'insight' },
  { key: 'setup', href: '/os/setup', labelKey: 'nav.setup', module: null, perm: { module: 'setup', action: 'configure' }, icon: 'settings', webOnly: true, group: 'settings' },
];
