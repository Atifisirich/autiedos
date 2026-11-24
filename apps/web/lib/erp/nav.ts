import type { Ctx } from './ctx';
import { ENTITIES } from './entities.gen';

export const PRODUCT = { name: 'AutoEd ERP', tagline: 'The school operating system' };

type Item = { href: string; label: string; cap?: string; roles?: string[]; module?: string };
type Group = { title: string; items: Item[] };

/** Navigation grouped by job. Each role sees only what it can use (PRD 18.1). */
const NAV: Group[] = [
  { title: 'Today', items: [
    { href: '/erp', label: 'Home' },
    { href: '/erp/approvals', label: 'Approvals' },
    { href: '/erp/inbox', label: 'Notifications' },
  ] },
  { title: 'Students', items: [
    { href: '/erp/students', label: 'Students', cap: 'students' },
    { href: '/erp/attendance', label: 'Attendance', cap: 'attendance' },
    { href: '/erp/admissions', label: 'Admissions', cap: 'admissions' },
    { href: '/erp/wellbeing', label: 'Wellbeing and health', cap: 'wellbeing' },
  ] },
  { title: 'Academics', items: [
    { href: '/erp/timetable', label: 'Timetable', cap: 'timetable' },
    { href: '/erp/homework', label: 'Homework and diary', cap: 'homework' },
    { href: '/erp/assessments', label: 'Assessment', cap: 'marks' },
    { href: '/erp/report-cards', label: 'Report cards', cap: 'marks' },
    { href: '/erp/exams', label: 'Exam cell and tests', cap: 'exams' },
    { href: '/erp/m/learning', label: 'Curriculum and learning', cap: 'learning' },
  ] },
  { title: 'Finance', items: [
    { href: '/erp/fees/counter', label: 'Fee counter', cap: 'fees' },
    { href: '/erp/fees', label: 'Fees and dues', cap: 'fees' },
    { href: '/erp/accounting', label: 'Accounting', cap: 'accounting' },
  ] },
  { title: 'People', items: [
    { href: '/erp/hr', label: 'Staff and HR', cap: 'staff' },
    { href: '/erp/hr/leave', label: 'Leave', cap: 'leave' },
    { href: '/erp/hr/payroll', label: 'Payroll', cap: 'payroll' },
    { href: '/erp/me', label: 'My leave and payslips' },
  ] },
  { title: 'Operations', items: [
    { href: '/erp/transport', label: 'Transport', cap: 'transport', module: 'transport' },
    { href: '/erp/transport/driver', label: 'Driver app', roles: ['driver', 'transport', 'group_admin'], module: 'transport' },
    { href: '/erp/gate-desk', label: 'Gate and visitors', cap: 'gate' },
    { href: '/erp/library', label: 'Library', cap: 'library', module: 'library' },
    { href: '/erp/store', label: 'Store and canteen', cap: 'inventory', module: 'inventory' },
    { href: '/erp/m/hostel', label: 'Hostel', cap: 'hostel', module: 'hostel' },
    { href: '/erp/m/facilities', label: 'Facilities', cap: 'facilities' },
  ] },
  { title: 'Communication', items: [
    { href: '/erp/messages', label: 'Messages', cap: 'messages' },
    { href: '/erp/helpdesk', label: 'Helpdesk', cap: 'helpdesk' },
    { href: '/erp/m/events', label: 'Calendar and events', cap: 'events' },
    { href: '/erp/forms', label: 'Forms and surveys', cap: 'forms' },
    { href: '/erp/documents', label: 'Certificates', cap: 'documents' },
  ] },
  { title: 'Insight', items: [
    { href: '/erp/reports', label: 'Reports', cap: 'reports' },
    { href: '/erp/insights', label: 'AI insights', roles: ['group_admin', 'principal', 'system_admin', 'coordinator'] },
    { href: '/erp/group', label: 'Group console', roles: ['group_admin'] },
    { href: '/erp/modules', label: 'All modules', roles: ['group_admin', 'system_admin', 'principal'] },
    { href: '/erp/admin', label: 'Admin console', cap: 'admin' },
  ] },
];

export function navFor(ctx: Ctx): Group[] {
  return NAV.map((g) => ({
    title: g.title,
    items: g.items.filter((i) => (!i.cap || ctx.can(i.cap)) && (!i.roles || i.roles.includes(ctx.role)) && (!i.module || ctx.moduleOn(i.module))),
  })).filter((g) => g.items.length);
}

export const MODULE_TITLES: Record<string, string> = {
  sis: 'Student information', attendance: 'Attendance', timetable: 'Timetable', learning: 'Curriculum and learning', homework: 'Homework', assessment: 'Assessment',
  exams: 'Exam cell', wellbeing: 'Wellbeing and conduct', health: 'Health and infirmary', activities: 'Co-curricular and houses', admissions: 'Admissions', fees: 'Fees',
  accounting: 'Accounting and budgets', hr: 'HR and payroll', transport: 'Transport', safety: 'Gate and campus safety', hostel: 'Hostel', canteen: 'Canteen',
  inventory: 'Store, inventory and procurement', library: 'Library', documents: 'Documents', communication: 'Communication', events: 'Calendar, events and PTM',
  helpdesk: 'Helpdesk', forms: 'Forms', workflow: 'Workflows', reports: 'Reports', adoption: 'Adoption monitor', alumni: 'Alumni', group: 'Group and franchise',
  statutory: 'Statutory reporting', facilities: 'Facilities and maintenance', admin: 'Set-up', privacy: 'Privacy and consent',
};
/** Entities of one screen group (the original "module"), for /erp/m/[module]. */
export const entitiesOf = (group: string) => Object.values(ENTITIES).filter((e) => e.schema === 'erp' && e.group === group && !e.hidden);
