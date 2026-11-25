/**
 * Deterministic planner used by the mock AI provider (development and tests; production uses Gemini). It recognises a
 * set of standard requests so the designer can be demonstrated end to end without a model:
 *
 *   OS   "teacher absent more than 2 days -> coordinator arranges substitution, notify parents, principal approves in exam week"
 *        "daily opening checklist for housekeeping at 7:30", "standard leave policy", "lesson plan review", "exam week duty roster",
 *        "tell parents when a child is absent", "purchases above 10000 need director approval", "every friday the admin officer ..."
 *   CRM  "new enquiry follow-up within 24h else escalate to admission head", quiet hours / message cap, lead sources,
 *        round-robin routing to a role, lead scoring thresholds, the first-contact and nurture recipe packs
 *   ERP  "fee concession above 10% needs director approval", "remind parents 3 days before fee due, then on due date, then
 *        weekly", late fee per day, absence alerts, CBSE grading, switching a module off
 *   core "make a hostel visitor log with visitor name, student, time in/out, approved by warden" (a custom register)
 *
 * A request for a product the school does not have comes back as an "unsupported" note (nothing is planned).
 * It only ever sees the redacted request, the school's products and role keys (the same input the real model gets).
 */
import { buildTemplate } from './templates';
import type { Changeset, ChangeOp } from './changeset';

export interface MockPlanContext {
  /** Role keys of the school (OS). */
  roles?: string[];
  /** Code of the active branch (module flags). */
  branch_code?: string;
  /** Products of the school (default: all). */
  products?: string[];
  /** Role keys per product (crm.roles / ERP role keys). */
  product_roles?: Record<string, string[]>;
  /** Role keys usable in custom registers, as "product:key" (core.roles). */
  record_roles?: string[];
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

const notInPlan = (product: 'crm' | 'erp' | 'os', request: string): Changeset => ({
  summary: `This needs the ${product.toUpperCase()}, which is not part of your school's plan.`,
  ops: [],
  unsupported: [{ product, request, note: `Your school does not have the ${product.toUpperCase()}, so its settings cannot be changed. Nothing was changed.` }],
  questions: [],
  template_key: null,
});

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'n$1');
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "admission head" -> admission_head, among the product's role keys (fallback when none matches). */
function productRole(text: string, keys: string[], fallback: string): string {
  const t = text.toLowerCase();
  const want: [RegExp, string[]][] = [
    [/admission(s)? head|head of admission/, ['admission_head']],
    [/branch admin/, ['branch_admin']],
    [/group admin|owner|management/, ['group_admin']],
    [/director|chairman|correspondent/, ['director', 'group_admin']],
    [/vice[\s-]?principal/, ['vice_principal', 'principal']],
    [/principal/, ['principal']],
    [/accounts?|accountant|finance/, ['accounts', 'accountant']],
    [/counsell?or/, ['counsellor']],
    [/front office|reception/, ['front_office']],
    [/marketing/, ['marketing']],
    [/\bhr\b|human resource/, ['hr']],
    [/coordinator/, ['coordinator', 'academic_coordinator']],
    [/class teacher/, ['class_teacher']],
    [/warden/, ['warden']],
    [/transport/, ['transport']],
  ];
  for (const [re, ks] of want) if (re.test(t)) return ks.find((k) => !keys.length || keys.includes(k)) ?? (keys.length ? fallback : ks[0]!);
  return fallback;
}

/** Hours from "within 24h", "24 hours", "2 days", "30 minutes". */
function hoursIn(text: string): number | null {
  const m = /(\d+(?:\.\d+)?)\s*(h|hrs?|hours?|d|days?|mins?|minutes?)\b/i.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  const u = m[2]!.toLowerCase();
  return u.startsWith('d') ? n * 24 : u.startsWith('m') ? Math.max(0.25, n / 60) : n;
}

// ---------------------------------------------------------------- custom registers (core.custom_object)
const FIELD_TYPES: [RegExp, string][] = [
  [/\b(student|child|pupil|ward|learner)\b/i, 'learner'],
  [/\b(class|section|grade)\b/i, 'section'],
  [/\b(staff|teacher|employee|escort)\b/i, 'person'],
  [/\b(phone|mobile|contact number)\b/i, 'phone'],
  [/\be-?mail\b/i, 'email'],
  [/\b(amount|fee|cost|price|fine)\b/i, 'money'],
  [/\b(count|number of|quantity|qty|marks|score)\b/i, 'number'],
  [/\b(time|in at|out at)\b/i, 'datetime'],
  [/\b(date|day|due)\b/i, 'date'],
  [/\b(photo|picture|file|document|attachment|scan)\b/i, 'file'],
  [/\b(remarks?|notes?|comments?|description|details)\b/i, 'long_text'],
  [/\b(returned|done|approved\?|paid|yes\/no)\b/i, 'yes_no'],
];

export function mockRecordObject(text: string, ctx: MockPlanContext = {}): Changeset | null {
  const m = /\b(?:make|create|add|keep|start|set up|need|build)\b\s+(?:a|an|the|new)?\s*([a-z][a-z0-9 '-]{2,60}?\b(?:log|register|book|tracker|list|form|checklist|record))s?\b(?:\s+(?:with|for|having|that has|capturing)\s+(.+))?$/i.exec(text.replace(/[.;]\s*$/, ''));
  if (!m) return null;
  const label = m[1]!.trim().replace(/\s+/g, ' ');
  const key = slug(label).slice(0, 39) || 'register';
  const parts = (m[2] ?? '').split(/,|\band\b|;/i).map((x) => x.trim()).filter(Boolean);
  const fields: Record<string, unknown>[] = [];
  let approver: string | null = null;
  let approvalAsked = false;
  const add = (lab: string, type: string, extra: Record<string, unknown> = {}) => {
    const k = slug(lab).slice(0, 39) || `field_${fields.length + 1}`;
    if (fields.some((f) => f.key === k)) return;
    fields.push({ key: k, label: cap(lab), type, ...extra });
  };
  for (const raw of parts) {
    const ap = /^(?:approved|signed|checked|verified|cleared)\s+by\s+(?:the\s+)?(.+)$/i.exec(raw);
    if (ap) {
      approvalAsked = true;
      const who = ap[1]!.toLowerCase();
      approver = (ctx.record_roles ?? []).find((r) => who.split(/\s+/).some((w) => w.length > 3 && r.split(':')[1]!.includes(w))) ?? null;
      continue;
    }
    const io = /^(time|date)\s+in\s*\/\s*out$|^(time|date)\s+in\s+(?:and|&)\s+out$/i.exec(raw);
    if (io) {
      const unit = (io[1] ?? io[2] ?? 'time').toLowerCase();
      add(`${unit} in`, unit === 'time' ? 'datetime' : 'date', unit === 'time' ? { default: 'now', required: true } : { default: 'today', required: true });
      add(`${unit} out`, unit === 'time' ? 'datetime' : 'date');
      continue;
    }
    const lab = raw.replace(/^(the|a|an)\s+/i, '').slice(0, 60);
    const type = FIELD_TYPES.find(([re]) => re.test(lab))?.[1] ?? 'text';
    add(lab, type, fields.length === 0 ? { required: true } : type === 'learner' ? { required: true } : {});
  }
  if (!fields.length) add('Details', 'long_text', { required: true });
  const titleField = (fields.find((f) => f.type === 'text') ?? fields[0])!.key as string;
  const states = approvalAsked
    ? {
        list: [{ key: 'pending', label: 'Waiting for approval' }, { key: 'approved', label: 'Approved' }, { key: 'rejected', label: 'Rejected', final: true }],
        initial: 'pending',
        transitions: [
          { from: 'pending', to: 'approved', label: 'Approve', approval: true, ...(approver ? { approver_roles: [approver] } : {}) },
          { from: 'pending', to: 'rejected', label: 'Reject' },
        ],
      }
    : null;
  const singular = cap(label.replace(/\s+(log|register|book|tracker|list|record)$/i, '') || label);
  return {
    summary: `A new register "${cap(label)}" with ${fields.length} fields${approvalAsked ? `; each entry is approved by ${approver ? approver.split(':')[1]!.replace(/_/g, ' ') : 'management'}` : ''}.`,
    ops: [
      {
        op: 'create',
        block: 'core.custom_object',
        key,
        settings: {
          key,
          product_key: 'core',
          label_singular: singular.slice(0, 80),
          label_plural: cap(label).slice(0, 80),
          icon: 'list',
          fields,
          title_field: titleField,
          list_columns: fields.slice(0, 5).map((f) => f.key),
          permissions: [{ who: 'all_staff', view: 'all', create: true, edit: 'own', delete: 'none', export: false }],
          states,
          portal: { enabled: false },
        },
        reason: 'A new register the school fills in from the web and mobile app.',
      },
    ],
    unsupported: [],
    questions: approvalAsked && !approver ? ['No role of that name exists in the school yet, so management approves entries. Add the role first if someone else should approve.'] : [],
    template_key: null,
  };
}

// ---------------------------------------------------------------- CRM requests
function crmPlan(text: string, ctx: MockPlanContext): Changeset | null {
  const has = (re: RegExp) => re.test(text);
  const roles = ctx.product_roles?.crm ?? [];
  if (has(/follow[\s-]?up|first (call|response)|respond|response time|\bsla\b|untouched/i) && has(/enquir|lead/i)) {
    return buildTemplate('crm_enquiry_follow_up', { hours: hoursIn(text) ?? 24, escalate_role: productRole(text.replace(/.*(escalat|alert|inform|notify)/i, ''), roles, 'admission_head'), reassign: !has(/no reassign|don'?t reassign|without reassign/i) });
  }
  if (has(/quiet hours|after \d+\s*(pm|am)|at night|messages? (a|per) day|per day/i) && has(/message|whatsapp|sms/i)) {
    const nums = [...text.matchAll(/(\d{1,2})\s*(am|pm)/gi)].map((x) => (Number(x[1]) % 12) + (x[2]!.toLowerCase() === 'pm' ? 12 : 0));
    const perDay = /(\d+)\s*(?:messages?\s*)?(?:a|per)\s*day/i.exec(text);
    return buildTemplate('crm_quiet_hours', { ...(nums[0] != null ? { quiet_from: nums[0] } : {}), ...(nums[1] != null ? { quiet_to: nums[1] } : {}), ...(perDay ? { max_per_day: Number(perDay[1]) } : {}) });
  }
  if (has(/round[\s-]?robin|in turn|assign|routing|distribute/i) && has(/enquir|lead/i)) {
    const role = productRole(text, roles, 'counsellor');
    const capN = /(?:at most|max(?:imum)?|up to)\s*(\d+)/i.exec(text);
    const name = `${cap(role.replace(/_/g, ' '))}s in turn`;
    return {
      summary: `New enquiries go to the ${role.replace(/_/g, ' ')}s ${has(/least|fewest|load|capacity/i) ? 'with the fewest open enquiries' : 'in turn'}.`,
      ops: [{ op: 'create', block: 'crm.assignment_rule', key: slug(name), settings: { name, seq: 1, method: has(/least|fewest|load|capacity/i) ? 'least_load' : 'round_robin', role_key: role, grades: [], ...(capN ? { daily_capacity: Number(capN[1]) } : {}) } }],
      unsupported: [], questions: [], template_key: null,
    };
  }
  if (has(/\bsource\b|campaign|newspaper|hoarding|flyer|insert/i) && has(/track|add|new/i)) {
    const name = /(?:from|called|named)\s+(?:the\s+)?([a-z][a-z0-9 ]{2,40}?)(?:,|\.|$| it| costs?| at)/i.exec(text)?.[1]?.trim() ?? 'Newspaper insert';
    const cost = /(?:costs?|spend|rs\.?|₹)\s*([\d,]+)/i.exec(text);
    return { summary: `Track enquiries from "${cap(name)}".`, ops: [{ op: 'create', block: 'crm.lead_source', key: slug(name), settings: { channel: has(/newspaper|hoarding|flyer|insert/i) ? 'Offline' : 'Events', name: cap(name), cost: cost ? Number(cost[1]!.replace(/,/g, '')) : 0, active: true } }], unsupported: [], questions: [], template_key: null };
  }
  if (has(/\bhot\b|scor/i)) {
    const hot = /hot\s*(?:from|at|above|over)?\s*(\d+)/i.exec(text);
    const hotAt = hot ? Number(hot[1]) : 60;
    return { summary: `Enquiries become hot from ${hotAt} points.`, ops: [{ op: 'update', block: 'crm.scoring', key: 'scoring', settings: { weights: has(/visit/i) ? { visit_done: 35 } : {}, hot_at: hotAt, warm_at: Math.min(30, hotAt - 1) } }], unsupported: [], questions: [], template_key: null };
  }
  if (has(/welcome|missed call|first contact/i)) return buildTemplate('crm_first_contact', {});
  if (has(/no[\s-]?show|nurture|abandon|documents? (pending|chase)/i)) return buildTemplate('crm_visit_application_nurture', {});
  return null;
}

// ---------------------------------------------------------------- ERP requests
function erpPlan(text: string, ctx: MockPlanContext): Changeset | null {
  const has = (re: RegExp) => re.test(text);
  const roles = ctx.product_roles?.erp ?? [];
  if (has(/concession|discount|scholarship|waiver/i) && has(/approv/i)) {
    const pct = /(\d+(?:\.\d+)?)\s*(%|percent)/i.exec(text);
    return buildTemplate('erp_concession_approval', { percent: pct ? Number(pct[1]) : 10, approver_role: productRole(text, roles, 'group_admin') });
  }
  if (has(/remind|reminder/i) && has(/\bfees?\b|dues?\b|payment/i)) {
    const before = /(\d+)\s*days?\s*before/i.exec(text);
    const weekly = has(/weekly|every week/i) ? 7 : Number(/every\s*(\d+)\s*days?/i.exec(text)?.[1] ?? 0);
    return buildTemplate('erp_fee_reminder_ladder', { days_before: before ? Number(before[1]) : 3, on_due_date: has(/on (the )?due date|on the day/i), repeat_every_days: weekly });
  }
  if (has(/late fee|late fine|fine for late|penalty/i)) {
    const amt = /(?:rs\.?|₹)?\s*(\d+)\s*(?:rupees|rs)?\s*(?:a|per)\s*day/i.exec(text);
    const grace = /(?:after|grace(?: of)?)\s*(\d+)\s*days?/i.exec(text);
    const max = /(?:at most|max(?:imum)?|cap(?:ped)? at)\s*(?:rs\.?|₹)?\s*([\d,]+)/i.exec(text);
    return buildTemplate('erp_late_fee', { ...(amt ? { amount: Number(amt[1]) } : {}), ...(grace ? { grace_days: Number(grace[1]) } : {}), ...(max ? { cap: Number(max[1]!.replace(/,/g, '')) } : {}) });
  }
  if (has(/absen/i) && has(/parent|famil|alert|notice/i)) return buildTemplate('erp_absence_alerts', { after_consecutive: Number(/(\d+)\s*(?:days|consecutive)/i.exec(text)?.[1] ?? 3) });
  if (has(/cbse/i) && has(/grad|assessment|scheme|report card/i)) return buildTemplate('erp_cbse_board_pack', {});
  const mod = /(?:turn|switch)\s+off\s+(?:the\s+)?([a-z_]+)(?:\s+module)?/i.exec(text);
  if (mod && ['hostel', 'transport', 'canteen', 'library', 'inventory', 'payroll', 'gate', 'health', 'events', 'facilities'].includes(mod[1]!.toLowerCase())) {
    const m = mod[1]!.toLowerCase();
    return { summary: `The ${m} module is switched off for the whole school.`, ops: [{ op: 'create', block: 'erp.module_flag', key: `${m}__ALL`, settings: { module_key: m, branch_code: null, enabled: false } }], unsupported: [], questions: [], template_key: null };
  }
  if (has(/library fine/i)) {
    const n = /(\d+)/.exec(text);
    return { summary: 'Library fine per late day.', ops: [{ op: 'update', block: 'erp.campus_settings', key: 'campus', settings: { library_fine_per_day: n ? Number(n[1]) : 2 } }], unsupported: [], questions: [], template_key: null };
  }
  return null;
}

export function mockDesignerPlan(prompt: string, ctx: MockPlanContext = {}): Changeset {
  const text = prompt.trim();
  const has = (re: RegExp) => re.test(text);
  const known = new Set(ctx.roles ?? []);
  const pick = (want: string[], fallback: string) => want.find((r) => !known.size || known.has(r)) ?? fallback;

  const products = ctx.products ?? ['os', 'crm', 'erp'];
  // A custom register ("make a hostel visitor log with ...") works for every product.
  const record = mockRecordObject(text, ctx);
  if (record) return record;
  // ERP and CRM requests: planned when the school has the product, otherwise an honest "not in your plan" note.
  if (has(/\bfee|concession|scholarship|invoice|receipt|payroll|salary|late fine|library fine|grading|assessment scheme|cbse|module/i) && !has(/\benquir|\blead\b/i)) {
    if (!products.includes('erp')) return notInPlan('erp', text);
    const p = erpPlan(text, ctx);
    if (p) return p;
  }
  if (has(/\benquir|\blead\b|\bleads\b|admission follow|follow[\s-]?up.*(enquir|lead|parent)|counsell?or|lead scor|\bsource\b|quiet hours|automatic messages|automated messages|messages? (a|per) day/i)) {
    if (!products.includes('crm')) return notInPlan('crm', text);
    const p = crmPlan(text, ctx);
    if (p) return p;
  }
  if (products.includes('erp') && !products.includes('os')) {
    const p = erpPlan(text, ctx);
    if (p) return p;
  }

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
