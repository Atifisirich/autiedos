/**
 * Core blocks: shared by every product. core.custom_object is the custom records engine (docs/custom-records.md): a
 * new register or form the school keeps ("hostel visitor log", "sports day equipment checklist") defined as data, not
 * code. Its settings ARE the engine's definition schema (recordObjectSchema, the one the object builder uses); the
 * server side goes through the engine's designer adapter (packages/server/src/custom-records/designer-adapter.ts:
 * validate / apply / inverse), under the engine's RLS. The AI only ever handles definitions, never records.
 */
import { recordObjectSchema, type RecordObjectDef } from '../custom-records';
import { defineBlock, type BlockDef, type PreviewLine } from './catalogue';

const L = (messageKey: string, vars?: Record<string, string | number>): PreviewLine => ({ messageKey, vars });
const scope = (v?: string) => (v === 'all' ? 'all' : v === 'own' ? 'own' : 'none');

export const customObjectBlock = defineBlock({
  key: 'core.custom_object',
  product: 'core',
  title: 'Custom register or form',
  description:
    'A new register / form / log the school keeps when no AutoEd screen fits (visitor log, equipment checklist, late-return register). ' +
    'key (lower_case), label_singular / label_plural, product_key (core = every product of the school, or os / crm / erp), fields (key, label, type: text, long_text, number, money, date, datetime, yes_no, ' +
    'choice + options, multi_choice + options, person = a staff member, learner = a student, section = a class, branch, file, phone, email, url; required, unique), title_field, list_columns, ' +
    'permissions (who: all_staff or role with product + role key of that product; view / edit / delete = all, own or none; create, export), ' +
    'optional states (a workflow: list of states, initial, transitions from -> to, approval true + approver_roles "product:role" for an approval step), ' +
    'portal (families see entries about their own child through a learner field; off by default), schedule.reminder (date field, days before). Records themselves are never part of a plan.',
  settings: recordObjectSchema,
  keyOf: (s) => s.key,
  describe: (s: RecordObjectDef) => {
    const lines: PreviewLine[] = [L('designer.preview.record.fields', { n: s.fields.length, list: s.fields.map((f) => `${f.label} (${f.type}${f.required ? ', required' : ''})`).join(', ') })];
    for (const p of s.permissions) {
      lines.push(L('designer.preview.record.permission', { who: p.who === 'all_staff' ? 'all staff' : `${p.product}:${p.role}`, view: scope(p.view), create: p.create ? 'yes' : 'no', edit: scope(p.edit) }));
    }
    if (s.states) {
      const lab = (k: string) => s.states!.list.find((x) => x.key === k)?.label ?? k;
      lines.push(L('designer.preview.record.workflow', { states: s.states.list.map((x) => x.label).join(' → ') }));
      for (const t of s.states.transitions) if (t.approval) lines.push(L('designer.preview.record.approval', { from: lab(t.from), to: lab(t.to), roles: t.approver_roles?.length ? t.approver_roles.join(', ') : 'management' }));
    }
    if (s.portal.enabled) lines.push(L('designer.preview.record.portal'));
    if (s.schedule?.reminder) lines.push(L('designer.preview.record.reminder', { field: s.schedule.reminder.date_field, days: s.schedule.reminder.days_before }));
    return lines;
  },
  reachesFamilies: (s: RecordObjectDef) => !!s.portal.enabled,
  examples: [
    {
      prompt: 'Make a hostel visitor log with visitor name, student, time in and time out',
      settings: {
        key: 'hostel_visitor_log',
        product_key: 'core',
        label_singular: 'Hostel visitor',
        label_plural: 'Hostel visitor log',
        icon: 'list',
        fields: [
          { key: 'visitor_name', label: 'Visitor name', type: 'text', required: true },
          { key: 'student', label: 'Student', type: 'learner', required: true },
          { key: 'time_in', label: 'Time in', type: 'datetime', default: 'now' },
          { key: 'time_out', label: 'Time out', type: 'datetime' },
        ],
        title_field: 'visitor_name',
        list_columns: ['visitor_name', 'student', 'time_in', 'time_out'],
        permissions: [{ who: 'all_staff', view: 'all', create: true, edit: 'own', delete: 'none' }],
        portal: { enabled: false },
      },
    },
  ],
});

export const CORE_BLOCKS: BlockDef[] = [customObjectBlock] as unknown as BlockDef[];
