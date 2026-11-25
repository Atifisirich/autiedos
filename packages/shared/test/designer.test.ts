/**
 * AI school designer: catalogue, changeset validation and repair, inverse operations, JSON schema, templates and the
 * deterministic mock planner (DECISIONS 56-59).
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  buildTemplate,
  canonical,
  catalogs,
  changesetJsonSchema,
  changesetSchema,
  getBlock,
  inverseChangeset,
  inverseOp,
  listBlocks,
  listTemplates,
  mockDesignerPlan,
  previewOps,
  registerBlocks,
  repairChangeset,
  timeIn,
  validateChangeset,
  zodToJsonSchema,
  defineBlock,
  type Changeset,
  type KnownConfig,
} from '../src';

const en = catalogs.en;
const known: KnownConfig = {
  products: ['os', 'core'],
  roles: { os: ['principal', 'director', 'academic_coordinator', 'hod', 'housekeeping_supervisor', 'admin_officer', 'class_teacher', 'security_supervisor'] },
  instances: { 'os.leave_type': ['casual', 'sick', 'earned'], 'os.approval_type': ['leave'], 'os.notification_rule': [] },
  system: { 'os.approval_type': ['leave'] },
  branches: ['GACH'],
};
const cs = (ops: Changeset['ops']): Changeset => ({ summary: 'x', ops, unsupported: [], questions: [] });

describe('block catalogue', () => {
  it('has the OS blocks the settings screens make configurable, plus the custom_object stub', () => {
    const keys = listBlocks().map((b) => b.key);
    for (const k of ['os.approval_type', 'os.checklist', 'os.task_category', 'os.recurring_task', 'os.escalation_rule', 'os.assignment_rule', 'os.notification_rule', 'os.leave_type', 'os.attendance_rule', 'os.module_flag', 'os.role', 'os.role_permission', 'os.custom_field', 'os.report_schedule', 'os.event_template', 'os.duty_type', 'os.plan_review_chain']) {
      expect(keys).toContain(k);
    }
    expect(keys).not.toContain('core.custom_object'); // stubs are hidden from the planner
    expect(getBlock('core.custom_object')?.stub).toBe(true);
    expect(listBlocks({ includeStubs: true }).map((b) => b.key)).toContain('core.custom_object');
  });

  it('every example is valid, has a stable key and a translated preview; every block has a UI title', () => {
    for (const b of listBlocks({ includeStubs: true })) {
      expect(en[`designer.block.${b.key}.title`], b.key).toBeTruthy();
      for (const ex of b.examples) {
        const s = b.settings.parse(ex.settings);
        expect(b.keyOf(s)).toMatch(/\S/);
        for (const l of b.describe(s)) expect(en[l.messageKey], `${b.key}: ${l.messageKey}`).toBeTruthy();
      }
    }
  });

  it('reuses the settings-screen rules: approval steps by role need a role, conditions name a form field', () => {
    const b = getBlock('os.approval_type')!;
    const base = { key: 'purchase', name: 'Purchase', fields: [{ key: 'amount', label: 'Amount', type: 'number' }], steps: [{ seq: 1, approver: 'role', role_key: 'principal' }] };
    expect(b.settings.safeParse(base).success).toBe(true);
    expect(b.settings.safeParse({ ...base, steps: [{ seq: 1, approver: 'role' }] }).success).toBe(false);
    expect(b.settings.safeParse({ ...base, steps: [{ seq: 1, approver: 'role', role_key: 'director', condition: { field: 'cost', op: '>', value: 5 } }] }).success).toBe(false);
    expect(b.settings.safeParse({ ...base, key: 'Bad Key' }).success).toBe(false);
  });

  it('is extensible: another product registers a block and the changeset accepts it', () => {
    registerBlocks([defineBlock({ key: 'crm.test_stage', product: 'crm', title: 'Stage', description: 'test', settings: z.object({ key: z.string(), name: z.string() }), keyOf: (s) => s.key, describe: () => [], examples: [] })]);
    const v = validateChangeset(cs([{ op: 'create', block: 'crm.test_stage', key: 'new', settings: { key: 'new', name: 'New' } }]));
    expect(v.ok).toBe(true);
    // ... but not for a school without CRM
    expect(validateChangeset(cs([{ op: 'create', block: 'crm.test_stage', key: 'new', settings: { key: 'new', name: 'New' } }]), known).issues.map((i) => i.code)).toContain('product_not_available');
    expect(() => defineBlock({ key: 'os.Bad', product: 'os', title: '', description: '', settings: z.object({}), keyOf: () => '', describe: () => [], examples: [] })).toThrow();
  });
});

describe('changeset validation and repair', () => {
  const checklist = { key: 'daily_opening', name: 'Daily opening', owner_role_key: 'housekeeping_supervisor', frequency: 'daily', time: '07:30', items: [{ label: 'Gates open', item_type: 'yesno' }] };

  it('accepts a valid op and fills defaults', () => {
    const v = validateChangeset(cs([{ op: 'create', block: 'os.checklist', key: 'daily_opening', settings: checklist }]), known);
    expect(v.issues).toEqual([]);
    expect(v.ops[0]!.settings).toMatchObject({ weekdays: [], items: [{ required: true, label_i18n: {} }] });
  });

  it('reports unknown blocks, bad settings, key mismatches, unknown roles, duplicates, missing and system items', () => {
    const v = validateChangeset(
      cs([
        { op: 'create', block: 'os.sql_runner', key: 'x', settings: {} },
        { op: 'create', block: 'os.checklist', key: 'daily_opening', settings: { ...checklist, time: '7.30' } },
        { op: 'create', block: 'os.checklist', key: 'other', settings: { ...checklist, key: 'night' } },
        { op: 'create', block: 'os.checklist', key: 'ghost', settings: { ...checklist, key: 'ghost', owner_role_key: 'ghostbuster' } },
        { op: 'update', block: 'os.leave_type', key: 'casual', settings: { key: 'casual', name: 'Casual' } },
        { op: 'update', block: 'os.leave_type', key: 'casual', settings: { key: 'casual', name: 'Casual' } },
        { op: 'delete', block: 'os.leave_type', key: 'nope' },
        { op: 'delete', block: 'os.approval_type', key: 'leave' },
        { op: 'update', block: 'os.role_permission', key: 'principal__setup__configure', settings: { role_key: 'principal', module: 'setup', action: 'configure', scope: 'group' } },
        { op: 'create', block: 'core.custom_object', key: 'visitors', settings: { key: 'visitors', name: 'Visitors' } },
      ]),
      known,
    );
    const codes = v.issues.map((i) => `${i.op}:${i.code}`);
    expect(codes).toEqual(expect.arrayContaining(['0:unknown_block', '1:invalid_settings', '2:key_mismatch', '3:unknown_role', '5:duplicate_op', '6:not_found', '7:system_item', '8:block_check', '9:block_not_available']));
    expect(v.ok).toBe(false);
    expect(validateChangeset(cs([]), known).issues).toEqual([{ op: null, code: 'no_changes' }]);
  });

  it('repair: create of an existing instance becomes an update, keys come from the settings, stubs move to "unsupported"', () => {
    const r = repairChangeset(
      cs([
        { op: 'create', block: 'os.leave_type', key: 'whatever', settings: { key: 'casual', name: 'Casual' } },
        { op: 'update', block: 'os.checklist', key: 'daily_opening', settings: checklist },
        { op: 'create', block: 'core.custom_object', key: 'visitors', settings: { key: 'visitors', name: 'Visitors' }, reason: 'Visitor log' },
      ]),
      known,
    );
    expect(r.ops.map((o) => `${o.op}:${o.key}`)).toEqual(['update:casual', 'create:daily_opening']);
    expect(r.unsupported).toEqual([{ product: 'core', request: 'Visitor log', note: 'stub_block' }]);
    expect(validateChangeset(r, known).ok).toBe(true);
  });

  it('preview: plain-language lines with i18n keys, the roles named and whether families are reached', () => {
    const v = validateChangeset(buildTemplate('substitution_workflow'), known);
    const p = previewOps(v.ops);
    expect(p[0]!.title).toEqual({ messageKey: 'designer.op.create', vars: { what: 'Approval type', name: 'Teacher absence over 2 days' } });
    expect(p[0]!.roles.sort()).toEqual(['academic_coordinator', 'principal']);
    expect(p[1]!.families).toBe(true);
    for (const o of p) for (const l of [o.title, ...o.lines]) expect(en[l.messageKey], l.messageKey).toBeTruthy();
  });
});

describe('inverse operations (one-click undo)', () => {
  const op = { block: 'os.leave_type', key: 'casual' };
  it('create -> delete, update -> update to before, delete -> create before', () => {
    expect(inverseOp({ ...op, op: 'create' }, null)).toEqual({ op: 'delete', block: 'os.leave_type', key: 'casual', settings: null });
    expect(inverseOp({ ...op, op: 'update' }, { key: 'casual', name: 'Old' })).toEqual({ op: 'update', block: 'os.leave_type', key: 'casual', settings: { key: 'casual', name: 'Old' } });
    expect(inverseOp({ ...op, op: 'delete' }, { key: 'casual', name: 'Old' })).toEqual({ op: 'create', block: 'os.leave_type', key: 'casual', settings: { key: 'casual', name: 'Old' } });
    // an update of something that did not exist (repaired create) is undone by deleting it
    expect(inverseOp({ ...op, op: 'update' }, null).op).toBe('delete');
  });

  it('a changeset is undone in reverse order', () => {
    const inv = inverseChangeset([
      { op: { op: 'create', block: 'os.role', key: 'a', settings: {} }, before: null },
      { op: { op: 'update', block: 'os.role_permission', key: 'a__leave__approve', settings: {} }, before: { scope: 'own' } },
    ]);
    expect(inv.map((o) => `${o.op}:${o.key}`)).toEqual(['update:a__leave__approve', 'delete:a']);
  });

  it('canonical JSON ignores key order (used to detect changes made after publishing)', () => {
    expect(canonical({ b: 1, a: [{ y: 2, x: null }] })).toBe(canonical({ a: [{ x: null, y: 2 }], b: 1 }));
    expect(canonical({ a: 1 })).not.toBe(canonical({ a: 2 }));
  });
});

describe('JSON schema for constrained AI output', () => {
  it('converts zod objects, enums, arrays, optionals and nullables', () => {
    const s = zodToJsonSchema(z.object({ a: z.string().max(5), b: z.enum(['x', 'y']).optional(), c: z.array(z.number().int().min(1)).max(3), d: z.boolean().nullable(), e: z.string().default('q') }));
    expect(s).toEqual({
      type: 'object',
      properties: { a: { type: 'string', maxLength: 5 }, b: { type: 'string', enum: ['x', 'y'] }, c: { type: 'array', items: { type: 'integer', minimum: 1 }, maxItems: 3 }, d: { type: ['boolean', 'null'] }, e: { type: 'string' } },
      required: ['a', 'c', 'd'],
      additionalProperties: false,
    });
  });

  it('the changeset schema lists one variant per block plus delete', () => {
    const s = changesetJsonSchema() as { properties: { ops: { items: { anyOf: { properties: { block: { enum: string[] } } }[] } } }; required: string[] };
    const variants = s.properties.ops.items.anyOf;
    expect(variants.length).toBe(listBlocks().length + 1);
    expect(variants.flatMap((v) => v.properties.block.enum)).toEqual(expect.arrayContaining(['os.approval_type', 'os.checklist']));
    expect(s.required).toEqual(['summary', 'ops', 'unsupported', 'questions']);
    expect(JSON.stringify(s)).not.toContain('custom_object');
  });
});

describe('templates (starter library from presets)', () => {
  it('every template builds a valid changeset with defaults, has UI strings, and accepts parameters', () => {
    expect(listTemplates().map((t) => t.key).sort()).toEqual(['daily_housekeeping_checklist', 'exam_week_duty_roster', 'lesson_plan_review_chain', 'parent_absence_alerts', 'standard_leave_policy', 'substitution_workflow']);
    for (const t of listTemplates()) {
      const v = validateChangeset(buildTemplate(t.key), known);
      expect(v.issues.filter((i) => i.code !== 'already_exists'), t.key).toEqual([]);
      expect(en[`designer.template.${t.key}.title`]).toBeTruthy();
      for (const p of t.params) expect(en[p.labelKey], p.labelKey).toBeTruthy();
    }
    const leave = buildTemplate('standard_leave_policy', { casual_days: 20 });
    expect(leave.ops.find((o) => o.key === 'casual')!.settings).toMatchObject({ yearly_quota: 20 });
    expect(() => buildTemplate('standard_leave_policy', { casual_days: -1 })).toThrow();
  });
});

describe('mock planner (demo without Gemini)', () => {
  const plan = (p: string) => changesetSchema.parse(mockDesignerPlan(p, { roles: known.roles.os }));

  it('teacher absence -> substitution workflow with the numbers and roles from the text', () => {
    const r = plan('teacher absent more than 3 days -> coordinator arranges substitution, notify parents, principal approves in exam week');
    expect(r.template_key).toBe('substitution_workflow');
    const at = r.ops.find((o) => o.block === 'os.approval_type')!.settings as { steps: { role_key: string; condition: { value: unknown } }[] };
    expect(at.steps.map((s) => s.role_key)).toEqual(['academic_coordinator', 'principal']);
    expect(at.steps[0]!.condition.value).toBe(3);
    expect(r.ops.some((o) => o.key === 'absence.extended__family')).toBe(true);
    expect(validateChangeset(r, known).ok).toBe(true);
  });

  it('checklist at a time, purchase approval above an amount, recurring task on a weekday', () => {
    const c = plan('Daily opening checklist for housekeeping at 7:30');
    expect(c.ops[0]!.settings).toMatchObject({ owner_role_key: 'housekeeping_supervisor', time: '07:30', frequency: 'daily' });
    const p = plan('Purchases above 25,000 need director approval');
    expect((p.ops[0]!.settings as { steps: { condition?: { value: number } }[] }).steps[1]!.condition!.value).toBe(25000);
    const r = plan('Every Friday the admin officer checks fire extinguishers by 3 pm');
    expect(r.ops[0]!.settings).toMatchObject({ role_key: 'admin_officer', frequency: 'weekly', weekdays: [5], due_time: '15:00' });
    for (const x of [c, p, r]) expect(validateChangeset(x, known).ok).toBe(true);
  });

  it('ERP and CRM requests are honest "not supported yet" notes; unclear ones get a question', () => {
    const fee = plan('fee concession above 10% needs director approval');
    expect(fee.ops).toEqual([]);
    expect(fee.unsupported[0]!.product).toBe('erp');
    expect(plan('new enquiry follow-up within 24h').unsupported[0]!.product).toBe('crm');
    expect(plan('make it nicer').questions.length).toBe(1);
  });

  it('reads times the way people write them', () => {
    expect(timeIn('at 7:30')).toBe('07:30');
    expect(timeIn('by 3 pm')).toBe('15:00');
    expect(timeIn('at 12 am')).toBe('00:00');
    expect(timeIn('more than 2 days')).toBeNull();
  });
});
