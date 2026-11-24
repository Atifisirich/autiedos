#!/usr/bin/env node
// Generates apps/web/lib/erp/entities.gen.ts (UI metadata for the generic ERP list / edit / export screens) from
//   schema/erp-tables.mjs      the 126 erp tables (titles, labels, list columns, field types, options, references)
//   the CORE list below        the core tables the ERP edits through generic screens (setup masters) or shows as references
// Rerunning produces no diff:  node scripts/gen-erp-ui.mjs
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FILES } from '../schema/erp-tables.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cap = (s) => s.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

// permission module -> ERP capability used for the nav and requireCap (see apps/web/lib/erp/caps.ts)
const MODULE_CAP = { setup: 'admin', reports: 'reports', documents: 'documents', student_sensitive: 'sensitive', students: 'students', admissions: 'admissions', facilities: 'facilities',
  learning: 'learning', homework: 'homework', marks: 'marks', exams: 'exams', wellbeing: 'wellbeing', safeguarding: 'safeguarding', health: 'health', activities: 'activities', events: 'events',
  accounting: 'accounting', inventory: 'inventory', fees: 'fees', concessions: 'concessions', payroll: 'payroll', staff: 'staff', transport: 'transport', gate: 'gate', communication: 'messages',
  hostel: 'hostel', canteen: 'canteen', library: 'library', forms: 'forms' };

// core tables: key = table name (the DSL references them by that name)
const CORE = {
  students: { label: ['first_name', 'last_name'], title: 'Students' },
  staff: { label: ['first_name', 'last_name'], title: 'Staff' },
  households: { label: ['family_name'], title: 'Families' },
  guardians: { label: ['name'], title: 'Guardians' },
  programmes: { label: ['name'], title: 'Classes and programmes', generic: 'admin', list: ['name', 'board', 'stage', 'level', 'capacity', 'active'],
    fields: [['name', 'text', 1], ['board', 'text'], ['stage', 'text'], ['stream', 'text'], ['level', 'number'], ['seq', 'number', 0, '0'], ['capacity', 'number'], ['active', 'bool', 0, 'true']] },
  sections: { label: ['name'], title: 'Sections', generic: 'admin', list: ['name', 'programme_id', 'class_teacher_id', 'room_id', 'capacity'],
    fields: [['programme_id', 'ref:programmes', 1], ['academic_year_id', 'ref:academic_years'], ['name', 'text', 1], ['class_teacher_id', 'ref:staff'], ['room_id', 'ref:rooms'], ['capacity', 'number'], ['seq', 'number', 0, '0']] },
  subjects: { label: ['name'], title: 'Subjects', generic: 'admin', list: ['name', 'code', 'department_id'],
    fields: [['name', 'text', 1], ['code', 'text'], ['department_id', 'ref:departments']] },
  rooms: { label: ['name'], title: 'Rooms', generic: 'admin', list: ['name', 'branch_id', 'capacity'],
    fields: [['branch_id', 'ref:branches'], ['name', 'text', 1], ['capacity', 'number']] },
  departments: { label: ['name'], title: 'Departments', generic: 'admin', list: ['name', 'head_staff_id'], fields: [['name', 'text', 1], ['head_staff_id', 'ref:staff']] },
  positions: { label: ['name'], title: 'Positions', generic: 'admin', list: ['name', 'key', 'rank', 'is_teaching'],
    fields: [['key', 'text', 1], ['name', 'text', 1], ['rank', 'number', 0, '50'], ['is_teaching', 'bool', 0, 'false']] },
  wings: { label: ['name'], title: 'Wings', generic: 'admin', list: ['name', 'board'], fields: [['name', 'text', 1], ['board', 'text']] },
  academic_years: { label: ['name'], title: 'Academic years', generic: 'admin', list: ['name', 'starts_on', 'ends_on', 'is_current', 'status'],
    fields: [['name', 'text', 1], ['starts_on', 'date', 1], ['ends_on', 'date', 1], ['is_current', 'bool', 0, 'false'], ['status', 'select:planning|active|closed', 0, 'planning']] },
  terms: { label: ['name'], title: 'Terms', generic: 'admin', list: ['name', 'academic_year_id', 'seq'],
    fields: [['academic_year_id', 'ref:academic_years', 1], ['name', 'text', 1], ['seq', 'number', 0, '1']] },
  leave_types: { label: ['name'], title: 'Leave types', generic: 'leave', list: ['name', 'key', 'applies_to', 'yearly_quota', 'paid', 'active'],
    fields: [['key', 'text', 1], ['name', 'text', 1], ['applies_to', 'select:staff|student', 0, 'staff'], ['yearly_quota', 'number'], ['paid', 'bool', 0, 'true'], ['carry_forward', 'bool', 0, 'false'], ['half_day_allowed', 'bool', 0, 'true'], ['active', 'bool', 0, 'true']] },
  calendar_events: { label: ['title'], title: 'Calendar', generic: 'events', list: ['title', 'starts_on', 'ends_on', 'layer', 'audience'],
    fields: [['title', 'text', 1], ['starts_on', 'date', 1], ['ends_on', 'date'], ['layer', 'select:event|holiday|exam|staff_meeting|ptm|other', 0, 'event'], ['audience', 'select:all|staff|parents', 0, 'all']] },
  files: { label: ['file_name'], title: 'Files' },
  class_posts: { label: ['title'], title: 'Class posts' },
  events: { label: ['name'], title: 'Events' },
  approval_requests: { label: ['title'], title: 'Approvals' },
  branches: { label: ['name'], title: 'Branches' },
  bell_schedules: { label: ['name'], title: 'Bell schedules', generic: 'timetable', list: ['name', 'days', 'active'],
    fields: [['name', 'text', 1], ['active', 'bool', 0, 'true']] },
  periods: { label: ['label'], title: 'Bell periods', generic: 'timetable', list: ['bell_schedule_id', 'seq', 'label', 'kind', 'starts_at', 'ends_at'],
    fields: [['bell_schedule_id', 'ref:bell_schedules', 1], ['seq', 'number', 1], ['label', 'text', 1], ['kind', 'select:period|break|assembly', 0, 'period'], ['starts_at', 'time', 1], ['ends_at', 'time', 1], ['teaching_index', 'number']] },
  teacher_allocations: { label: ['id'], title: 'Teaching assignments', generic: 'timetable', list: ['staff_id', 'section_id', 'subject_id', 'periods_per_week'],
    fields: [['staff_id', 'ref:staff', 1], ['section_id', 'ref:sections', 1], ['subject_id', 'ref:subjects', 1], ['academic_year_id', 'ref:academic_years'], ['periods_per_week', 'number'], ['double_periods', 'number', 0, '0']] },
  number_series: { label: ['key'], title: 'Number series', generic: 'admin', list: ['key', 'prefix', 'suffix', 'padding', 'next_value', 'active'],
    fields: [['key', 'text', 1], ['prefix', 'text', 0, ''], ['suffix', 'text', 0, ''], ['padding', 'number', 0, '4'], ['next_value', 'number', 0, '1'], ['reset_policy', 'select:never|yearly', 0, 'never'], ['academic_year_id', 'ref:academic_years'], ['active', 'bool', 0, 'true']] },
  ticket_categories: { label: ['name'], title: 'Helpdesk categories', generic: 'helpdesk', list: ['key', 'name', 'owner_role_key', 'sla_hours', 'active'],
    fields: [['key', 'text', 1], ['name', 'text', 1], ['owner_role_key', 'text'], ['sla_hours', 'number'], ['active', 'bool', 0, 'true']] },
  exam_types: { label: ['name'], title: 'Exam types', generic: 'exams', list: ['key', 'name', 'weight', 'seq'], fields: [['key', 'text', 1], ['name', 'text', 1], ['weight', 'number'], ['seq', 'number', 0, '1']] },
  message_templates: { label: ['name'], title: 'Message templates', generic: 'messages', list: ['name', 'event_key', 'channel', 'language', 'status', 'enabled'],
    fields: [['name', 'text', 1], ['event_key', 'text'], ['channel', 'select:app|whatsapp|sms|email|voice|push', 0, 'app'], ['language', 'select:en|hi|te', 0, 'en'], ['body', 'textarea', 1], ['enabled', 'bool', 0, 'true']] },
  custom_fields: { label: ['label'], title: 'Custom fields', generic: 'admin', list: ['entity', 'key', 'label', 'field_type', 'required', 'active'],
    fields: [['entity', 'text', 1], ['key', 'text', 1], ['label', 'text', 1], ['field_type', 'select:text|number|date|boolean|select|multiselect|phone|email|file', 0, 'text'], ['required', 'bool', 0, 'false'], ['seq', 'number', 0, '0'], ['active', 'bool', 0, 'true']] },
  delegations: { label: ['id'], title: 'Delegations', generic: 'admin', list: ['staff_id', 'delegate_id', 'starts_on', 'ends_on'],
    fields: [['staff_id', 'ref:staff', 1], ['delegate_id', 'ref:staff', 1], ['starts_on', 'date', 1], ['ends_on', 'date', 1]] },
  exams: { label: ['name'], title: 'Exams', generic: 'exams', list: ['name', 'exam_type_id', 'starts_on', 'ends_on', 'status'],
    fields: [['name', 'text', 1], ['academic_year_id', 'ref:academic_years'], ['term_id', 'ref:terms'], ['exam_type_id', 'ref:exam_types'], ['starts_on', 'date'], ['ends_on', 'date'], ['status', 'select:planning|scheduled|in_progress|completed', 0, 'planning']] },
  exam_schedules: { label: ['id'], title: 'Exam date sheet', generic: 'exams', list: ['exam_id', 'programme_id', 'subject_id', 'exam_date', 'starts_at', 'max_marks'],
    fields: [['exam_id', 'ref:exams', 1], ['programme_id', 'ref:programmes'], ['section_id', 'ref:sections'], ['subject_id', 'ref:subjects', 1], ['exam_date', 'date'], ['starts_at', 'time'], ['ends_at', 'time'], ['max_marks', 'number'], ['pass_marks', 'number'], ['room_id', 'ref:rooms']] },
  question_bank: { label: ['id'], title: 'Question bank', generic: 'exams', list: ['subject_id', 'difficulty', 'bloom', 'marks', 'status', 'source'],
    fields: [['subject_id', 'ref:subjects'], ['programme_id', 'ref:programmes'], ['content', 'json', 1, '{"type":"mcq","text":"","options":["","","",""],"answer":""}'], ['difficulty', 'select:easy|medium|hard'], ['bloom', 'text'], ['marks', 'number', 0, '1'], ['source', 'select:manual|ai|paper', 0, 'manual'], ['status', 'select:draft|approved|archived', 0, 'draft']] },
  org_users: { label: ['display_name'], title: 'Users', key: 'user_id' },
};

const TYPES = { text: 'text', int: 'number', numeric: 'number', money: 'number', bool: 'bool', date: 'date', time: 'time', ts: 'datetime', jsonb: 'json', uuid: 'uuid' };
const TEXTAREA = /(^|_)(notes?|description|body|address|remarks?|reason|details|summary|content|comment|message|text)$/;
function parseCol(spec) {
  let m = spec.match(/^(\w+)>(@?\w+)(!)?(?:=(.*))?$/);
  if (m) return { k: m[1], t: 'ref', ref: m[2] === '@users' ? 'org_users' : m[2], req: !!m[3], def: m[4] === 'uid' ? undefined : m[4] };
  m = spec.match(/^(\w+)(?::(\w+))?(!)?(.*)$/);
  const type = m[2] ?? 'text';
  let rest = m[4], opts, def;
  const om = rest.match(/^\{([^}]*)\}(.*)$/);
  if (om) { opts = om[1].split('|'); rest = om[2]; }
  if (rest.startsWith('=')) def = rest.slice(1);
  if (def === 'now' || def === 'today') def = undefined;
  let t = TYPES[type];
  if (opts) t = 'select';
  else if (t === 'text' && TEXTAREA.test(m[1])) t = 'textarea';
  const f = { k: m[1], t };
  if (opts) f.opts = opts;
  if (m[3]) f.req = true;
  if (def !== undefined && def !== '') f.def = def;
  return f;
}
const withLabel = (f) => ({ ...f, label: cap(f.k.replace(/_id$/, '')) });

const ENTITIES = {};
for (const file of FILES) for (const t of file.tables) {
  const fields = t.cols.map(parseCol).map(withLabel);
  const labelCols = t.label ? (Array.isArray(t.label) ? t.label : [t.label]) : [fields.find((f) => f.t === 'text')?.k ?? 'id'];
  const list = t.list ?? fields.filter((f) => !['json', 'textarea'].includes(f.t)).slice(0, 6).map((f) => f.k);
  ENTITIES[t.name] = {
    schema: 'erp', table: t.name, title: t.title ?? cap(t.name), module: t.module, cap: MODULE_CAP[t.module] ?? t.module, group: t.group, label: labelCols,
    branch: !!t.branch, year: !!t.year, hidden: !!t.hidden, readonly: !!t.readonly || !!t.immutable || !!t.noInsert, desc: t.desc ?? '', list, fields,
  };
}
for (const [name, c] of Object.entries(CORE)) {
  const fields = (c.fields ?? []).map(([k, spec, req, def]) => {
    const f = { k, label: cap(k.replace(/_id$/, '')), t: 'text' };
    if (spec.startsWith('ref:')) { f.t = 'ref'; f.ref = spec.slice(4); } else if (spec.startsWith('select:')) { f.t = 'select'; f.opts = spec.slice(7).split('|'); } else f.t = spec;
    if (req) f.req = true;
    if (def !== undefined) f.def = def;
    return f;
  });
  ENTITIES[name] = { schema: 'core', table: name, title: c.title, module: 'core', cap: c.generic ?? 'admin', group: 'core', label: c.label, branch: false, year: false, hidden: !c.generic, readonly: !c.generic, desc: '', list: c.list ?? c.label, fields, ...(c.key ? { idCol: c.key } : {}) };
}
// the module screens (/erp/m/[module]) group the entities by permission module
const out = `// GENERATED by scripts/gen-erp-ui.mjs from schema/erp-tables.mjs. Do not edit by hand.
export type FieldDef = { k: string; label: string; t: 'text' | 'textarea' | 'number' | 'bool' | 'date' | 'time' | 'datetime' | 'json' | 'uuid' | 'select' | 'ref'; ref?: string; opts?: string[]; req?: boolean; def?: string };
export type EntityDef = { schema: 'erp' | 'core'; table: string; title: string; module: string; cap: string; group: string; label: string[]; branch: boolean; year: boolean; hidden: boolean; readonly: boolean; desc: string; list: string[]; fields: FieldDef[]; idCol?: string };
export const ENTITIES: Record<string, EntityDef> = ${JSON.stringify(ENTITIES)};
`;
writeFileSync(join(root, 'apps/web/lib/erp/entities.gen.ts'), out);
console.log(`entities.gen.ts: ${Object.keys(ENTITIES).length} entities`);
