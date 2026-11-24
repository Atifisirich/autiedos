/**
 * ERP capability -> platform permission modules (core.role_permissions.module_key). Same table as schema/erp-roles.mjs CAP_MODULES;
 * the UI keeps the capability names of the source ERP (nav, screens) and resolves them here. Keep the two in step.
 */
export const CAP_MODULES: Record<string, string[]> = {
  students: ['students'], sensitive: ['student_sensitive'], attendance: ['student_attendance', 'staff_attendance'], timetable: ['timetable'], learning: ['learning'],
  homework: ['homework', 'class_posts'], marks: ['marks'], exams: ['exams'], wellbeing: ['wellbeing'], safeguarding: ['safeguarding'], health: ['health'], activities: ['activities'],
  admissions: ['admissions'], fees: ['fees'], concessions: ['concessions'], accounting: ['accounting'], staff: ['staff'], payroll: ['payroll'], leave: ['leave'],
  messages: ['communication', 'notifications'], transport: ['transport'], gate: ['gate', 'incidents'], hostel: ['hostel'], canteen: ['canteen'], inventory: ['inventory'],
  library: ['library'], documents: ['documents', 'files'], events: ['events', 'calendar'], helpdesk: ['helpdesk'], forms: ['forms'], reports: ['reports'],
  admin: ['setup', 'approvals', 'compliance', 'integrations', 'users'], audit: ['audit'], facilities: ['facilities'], leadership: ['leadership'],
};

/** The original ERP's per-capability level and what it means on the platform (view/create/edit/delete/configure/manage by scope). */
export const LEVELS = ['F', 'B', 'S', 'V', 'O', 'R', '-'] as const;
export type Level = (typeof LEVELS)[number];
export const LEVEL_LABEL: Record<Level, string> = { F: 'Full (all branches, configure)', B: 'Branch (edit)', S: 'Scoped (own classes)', V: 'View only', O: 'Own records', R: 'Can request', '-': 'No access' };
const FULL = ['view', 'create', 'edit', 'delete', 'configure', 'manage'];
export function levelRows(level: Level): { action: string; scope: 'org' | 'branch' }[] {
  if (level === 'F') return FULL.map((action) => ({ action, scope: 'org' }));
  if (level === 'B') return ['view', 'create', 'edit', 'delete'].map((action) => ({ action, scope: 'branch' }));
  if (level === 'S') return ['view', 'create', 'edit'].map((action) => ({ action, scope: 'branch' }));
  if (level === 'V') return [{ action: 'view', scope: 'branch' }];
  return [];
}
/** Reverse: the level a role holds on a capability, from its permission rows. */
export function levelOf(cap: string, perms: { module_key: string; action: string; scope: string }[]): Level {
  const mods = CAP_MODULES[cap] ?? [cap];
  const mine = perms.filter((p) => mods.includes(p.module_key) || p.module_key === '*');
  const has = (a: string) => mine.some((p) => p.action === a || p.action === '*');
  if (has('configure') || has('manage')) return 'F';
  if (has('delete')) return 'B';
  if (has('create') || has('edit')) return 'S';
  if (has('view')) return 'V';
  return '-';
}
