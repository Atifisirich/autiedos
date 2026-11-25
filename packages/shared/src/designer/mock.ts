/**
 * Deterministic planner used by the mock AI provider (development and tests; production uses Gemini). It recognises a
 * set of standard requests so the designer can be demonstrated end to end without a model:
 *
 *   "teacher absent more than 2 days -> coordinator arranges substitution, notify parents, principal approves in exam week"
 *   "daily opening checklist for housekeeping at 7:30"
 *   "standard leave policy", "lesson plan review", "exam week duty roster", "tell parents when a child is absent"
 *   "purchases above 10000 need director approval", "every friday the admin officer ..." (recurring task)
 *   "fee concession above 10% needs director approval"   -> ERP: not supported yet (note)
 *   "new enquiry follow-up within 24h"                    -> CRM: not supported yet (note)
 *
 * It only ever sees the redacted request and the school's role keys (the same input the real model gets).
 */
import { buildTemplate } from './templates';
import type { Changeset, ChangeOp } from './changeset';

export interface MockPlanContext {
  /** Role keys of the school (OS). */
  roles?: string[];
  /** Code of the active branch (module flags). */
  branch_code?: string;
}

const ROLE_WORDS: [RegExp, string][] = [
  [/vice[\s-]?principal/i, 'vice_principal'],
  [/principal/i, 'principal'],
  [/director/i, 'director'],
  [/chairman|chairperson/i, 'chairman'],
  [/co-?ordinator/i, 'academic_coordinator'],
  [/\bhods?\b|head of (the )?department/i, 'hod'],
  [/class teacher/i, 'class_teacher'],
  [/accountant|accounts/i, 'accountant'],
  [/admin(istration)? officer|office admin/i, 'admin_officer'],
  [/housekeeping|cleaning|cleaner/i, 'housekeeping_supervisor'],
  [/security|guard/i, 'security_supervisor'],
  [/transport|bus/i, 'transport_incharge'],
  [/lab assistant|laborator/i, 'lab_assistant'],
  [/librar/i, 'librarian'],
  [/front office|reception/i, 'front_office'],
  [/\bit\b|computer admin/i, 'it_admin'],
];

function rolesIn(text: string): string[] {
  const out: string[] = [];
  let rest = text;
  for (const [re, key] of ROLE_WORDS) {
    if (re.test(rest)) {
      out.push(key);
      rest = rest.replace(new RegExp(re.source, 'gi'), ' ');
    }
  }
  return out;
}

/** "7:30", "7.30 am", "4 pm", "16:00" -> "HH:MM". */
export function timeIn(text: string): string | null {
  const m = /\b(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?(?=\b|\s|$)/i.exec(text.replace(/\b(\d+)\s*(days?|hours?|h|%|percent|minutes?|mins?)\b/gi, ' '));
  if (!m || (!m[2] && !m[3])) return null;
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  const ap = m[3]?.toLowerCase().replace(/\./g, '');
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

function numberAfter(text: string, words: RegExp): number | null {
  const m = new RegExp(`(?:${words.source})\\s*(?:than\\s*)?(?:rs\\.?|₹|inr)?\\s*([\\d,]+)`, 'i').exec(text);
  return m ? Number(m[1]!.replace(/,/g, '')) : null;
}

const WEEKDAYS: [RegExp, number][] = [[/monday/i, 1], [/tuesday/i, 2], [/wednesday/i, 3], [/thursday/i, 4], [/friday/i, 5], [/saturday/i, 6], [/sunday/i, 7]];

const note = (product: 'crm' | 'erp', request: string, what: string): Changeset => ({
  summary: `This needs ${product.toUpperCase()} building blocks, which the designer does not have yet.`,
  ops: [],
  unsupported: [{ product, request, note: `${what} will be possible once the ${product.toUpperCase()} blocks are added to the designer. Nothing was changed.` }],
  questions: [],
  template_key: null,
});

export function mockDesignerPlan(prompt: string, ctx: MockPlanContext = {}): Changeset {
  const text = prompt.trim();
  const has = (re: RegExp) => re.test(text);
  const known = new Set(ctx.roles ?? []);
  const pick = (want: string[], fallback: string) => want.find((r) => !known.size || known.has(r)) ?? fallback;

  // ERP and CRM requests: honest "not yet" notes until those blocks exist.
  if (has(/\bfee|concession|scholarship|invoice|receipt|payroll|salary/i)) return note('erp', text, 'Fee and finance rules');
  if (has(/\benquir|\blead\b|\bleads\b|admission follow|follow[\s-]?up.*(enquir|lead|parent)|counsell?or/i)) return note('crm', text, 'Enquiry follow-up rules');

  // Teacher absence -> substitution workflow (template with parameters from the text).
  if (has(/absen/i) && has(/substitut|cover|arrange/i)) {
    const days = numberAfter(text, /more|over|longer|exceeds?|above|>/) ?? 2;
    const roles = rolesIn(text);
    const arranger = roles.includes('academic_coordinator') ? 'academic_coordinator' : pick(roles.filter((r) => r !== 'principal'), 'academic_coordinator');
    const examRole = has(/exam/i) ? (roles.includes('principal') ? 'principal' : pick(roles.filter((r) => r !== arranger), 'principal')) : 'principal';
    return buildTemplate('substitution_workflow', { min_days: Math.max(1, Math.min(30, days)), arranger_role: arranger, exam_week_role: examRole, notify_parents: has(/parent|famil|guardian/i) });
  }
  // Parent alerts on absence.
  if (has(/parent|famil|guardian/i) && has(/absent|absence|attendance/i)) return buildTemplate('parent_absence_alerts', { whatsapp: !has(/no whatsapp|without whatsapp/i) });
  // Checklists.
  if (has(/checklist|check list/i)) {
    const role = rolesIn(text)[0] ?? 'housekeeping_supervisor';
    const time = timeIn(text) ?? '07:30';
    if (has(/opening|morning|open/i) || role === 'housekeeping_supervisor') return buildTemplate('daily_housekeeping_checklist', { time, role: pick([role], 'housekeeping_supervisor') });
    const weekday = WEEKDAYS.find(([re]) => re.test(text))?.[1];
    const name = has(/closing|evening/i) ? 'Closing checklist' : has(/safety/i) ? 'Safety checklist' : 'Checklist';
    const key = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    return {
      summary: `${name} for ${role}${weekday ? ' every week' : ' every day'} at ${time}.`,
      ops: [{ op: 'create', block: 'os.checklist', key, settings: { key, name, owner_role_key: role, frequency: weekday ? 'weekly' : 'daily', weekdays: weekday ? [weekday] : [], time, items: [{ label: 'Area checked and in order', label_i18n: {}, item_type: 'yesno', required: true, on_fail: { action: 'task', role_key: pick(['admin_officer'], role) } }, { label: 'Photo of the area', label_i18n: {}, item_type: 'photo', required: false }] } }],
      unsupported: [],
      questions: [],
      template_key: null,
    };
  }
  if (has(/leave polic|leave rules|leave types|casual leave|sick leave/i)) {
    const casual = numberAfter(text, /casual(?: leaves?)?(?: of)?/) ?? undefined;
    return buildTemplate('standard_leave_policy', casual ? { casual_days: casual } : {});
  }
  if (has(/lesson plan|plan review|review chain/i)) return buildTemplate('lesson_plan_review_chain', { due_time: timeIn(text) ?? '16:00' });
  if (has(/exam/i) && has(/duty|roster|relief|invigilat/i)) return buildTemplate('exam_week_duty_roster', {});

  // Generic amount-based approval ("purchases above 10000 need director approval").
  if (has(/approv/i) && has(/above|over|more than|exceed|>/i)) {
    const amount = numberAfter(text, /above|over|more than|exceeds?|>/) ?? 10000;
    const roles = rolesIn(text);
    const top = pick(roles.filter((r) => ['director', 'chairman', 'principal'].includes(r)), 'director');
    const subject = /(purchase|reimbursement|expense|repair|maintenance|event budget|trip)/i.exec(text)?.[1]?.toLowerCase() ?? 'expense';
    const key = `${subject.replace(/[^a-z]+/g, '_')}_approval`;
    const first = top === 'principal' ? 'manager_of_applicant' : 'role';
    const ops: ChangeOp[] = [
      {
        op: 'create',
        block: 'os.approval_type',
        key,
        settings: {
          key,
          name: `${subject.charAt(0).toUpperCase()}${subject.slice(1)} approval`,
          fields: [{ key: 'amount', label: 'Amount', type: 'number', required: true, options: [] }, { key: 'details', label: 'Details', type: 'text', required: true, options: [] }],
          steps: [first === 'role' ? { seq: 1, approver: 'role', role_key: pick(['principal'], 'principal'), time_limit_hours: 48 } : { seq: 1, approver: 'manager_of_applicant', time_limit_hours: 48 }, { seq: 2, approver: 'role', role_key: top, condition: { field: 'amount', op: '>', value: amount }, time_limit_hours: 48 }],
          tasks: [],
        },
        reason: `Above ${amount} the ${top} must approve.`,
      },
    ];
    return { summary: `${subject} requests above ${amount} need the ${top}'s approval.`, ops, unsupported: [], questions: [], template_key: null };
  }
  // Recurring task ("every Friday the admin officer checks fire extinguishers by 3 pm").
  if (has(/every (day|week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|daily|weekly|monthly/i)) {
    const role = rolesIn(text)[0];
    if (role) {
      const weekday = WEEKDAYS.find(([re]) => re.test(text))?.[1];
      const monthly = has(/month/i);
      const title = text.replace(/^(every|each)\s+\w+\s*,?\s*/i, '').replace(/\s+(by|at|before)\s+[\d:.]+\s*(am|pm)?\.?$/i, '').slice(0, 120) || 'Recurring task';
      const key = `rec_${title.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'task'}`;
      return {
        summary: `A ${weekday ? 'weekly' : monthly ? 'monthly' : 'daily'} task for ${role}.`,
        ops: [{ op: 'create', block: 'os.recurring_task', key, settings: { key, title: title.charAt(0).toUpperCase() + title.slice(1), role_key: role, frequency: weekday ? 'weekly' : monthly ? 'monthly' : 'daily', weekdays: weekday ? [weekday] : [], month_day: monthly ? 1 : null, due_time: timeIn(text) ?? '17:00', priority: 'normal' } }],
        unsupported: [],
        questions: [],
        template_key: null,
      };
    }
  }
  return {
    summary: 'I could not match this to a building block yet.',
    ops: [],
    unsupported: [],
    questions: ['Could you say who should do what, when, and who approves? For example: "Daily opening checklist for housekeeping at 7:30".'],
    template_key: null,
  };
}
