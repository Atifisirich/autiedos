// Domain logic shared by the staff app, public forms, the REST API, the workflow engine and tests.
// Ported from autoedcrm lib/core.ts. What changed (docs/adr/crm-port.md):
//   - every function takes a Db (a transaction bound to one org and one actor) instead of a tenant id; tenant
//     filters are gone, org_id + RLS do that job;
//   - users -> crm.staff_v (core.staff + access + role), students -> crm.prospects, tasks -> crm.follow_ups,
//     templates -> core.message_templates, consent jsonb -> core.consents through crm.set_consent / core.can_contact,
//     wallet -> crm.wallet_post, application/receipt counters -> crm.next_number, jobs -> private.jobs.
// Nothing here imports a web framework.
import crypto from 'node:crypto';
import { type Db, type Row } from './db';

export type Actor = { id: string; name: string } | null;

// ---------- small helpers ----------

/** Indian mobiles: keep the last ten digits so +91 / 0 prefixes match the same parent. */
export function normMobile(s: string | null | undefined): string {
  const d = (s ?? '').replace(/\D/g, '');
  return d.length > 10 ? d.slice(-10) : d;
}
/** Schools in this release run on India time whatever the server's zone is. */
export const hourIST = (d = new Date()) => Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: 'Asia/Kolkata' }).format(d)) % 24;
export const validMobile = (m: string) => /^[6-9]\d{9}$/.test(m);

const normName = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '');
function lev(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length]![b.length]!;
}
/** Fuzzy student match used for duplicate and sibling detection (DUP-01). */
export function sameStudent(a: { name: string; dob?: string | null }, b: { name: string; dob?: string | null }): boolean {
  const x = normName(a.name),
    y = normName(b.name);
  if (!x || !y) return false;
  if (a.dob && b.dob && a.dob !== b.dob) return false;
  if (x === y) return true;
  if (lev(x, y) <= 2 && Math.min(x.length, y.length) >= 5) return true;
  const fa = a.name.trim().toLowerCase().split(/\s+/)[0] ?? '',
    fb = b.name.trim().toLowerCase().split(/\s+/)[0] ?? '';
  return fa === fb && fa.length >= 3 && (x.startsWith(y) || y.startsWith(x));
}

export function renderTemplate(body: string, vars: Record<string, string | null | undefined>): string {
  return body.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => vars[k] ?? '');
}

/** CRM `students.name` -> crm.prospects first_name / last_name. */
export function splitName(name: string): { first: string; last: string | null } {
  const parts = name.trim().split(/\s+/);
  return { first: parts[0] ?? '', last: parts.length > 1 ? parts.slice(1).join(' ') : null };
}
/** CRM free-text gender (Girl/Boy) -> core vocabulary. */
export function mapGender(g: string | null | undefined): string | null {
  const v = (g ?? '').trim().toLowerCase();
  if (['girl', 'female', 'f'].includes(v)) return 'female';
  if (['boy', 'male', 'm'].includes(v)) return 'male';
  return v ? 'other' : null;
}
/** CRM relation (Parent/Father/Mother) -> core vocabulary. */
export function mapRelation(r: string | null | undefined): string {
  const v = (r ?? '').trim().toLowerCase();
  return ['father', 'mother', 'guardian', 'other'].includes(v) ? v : 'guardian';
}

export async function tenantSettings(db: Db): Promise<Row> {
  return (await db.one('select settings from crm.settings where org_id = $1', [db.requireOrg()]))?.settings ?? {};
}

/** Branch with its CRM settings (opening hours, visit capacity); boards is a text[] in core. */
export async function branchOf(db: Db, id: string): Promise<Row | null> {
  return db.one(
    `select b.*, coalesce(bs.open_hour, 9) as open_hour, coalesce(bs.close_hour, 18) as close_hour, coalesce(bs.visit_capacity, 3) as visit_capacity
       from core.branches b left join crm.branch_settings bs on bs.org_id = b.org_id and bs.branch_id = b.id
      where b.org_id = $1 and b.id = $2`,
    [db.requireOrg(), id],
  );
}

export async function audit(db: Db, actor: Actor, action: string, entity: string, entityId: string | null, summary: string, before?: unknown, after?: unknown) {
  await db.q('select crm.audit_event($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, null)', [
    action, entity, entityId, summary, before == null ? null : JSON.stringify(before), after == null ? null : JSON.stringify(after), actor?.name ?? 'System',
  ]);
}

export async function notify(db: Db, userId: string, category: string, title: string, link?: string) {
  // no RETURNING: a notification for a colleague is not readable by the sender (core.notifications is private to its user)
  await db.insert('core.notifications', { user_id: userId, product_key: 'crm', event_key: category, title, link: link ?? null }, { returning: false });
  await pushToPhones(db, userId, title, link);
}

/** Sends the alert to the user's Android app through Expo's push service. Never blocks or fails the caller. */
async function pushToPhones(db: Db, userId: string, title: string, link?: string) {
  if (process.env.PUSH_DISABLED === '1') return;
  const tokens = (await db.sub(() => db.q('select crm.push_tokens($1) as token', [userId])).catch(() => [])) as Row[];
  if (!tokens.length) return;
  try {
    const r = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(tokens.map((t) => ({ to: t.token, title: 'AutoED', body: title, data: { link: link ?? '/' }, sound: 'default', channelId: 'default' }))),
      signal: AbortSignal.timeout(4000),
    });
    const res = (await r.json().catch(() => null)) as { data?: { details?: { error?: string } }[] } | null;
    // Expo reports uninstalled apps per token; forget those so we stop sending to them.
    for (const [i, d] of (res?.data ?? []).entries()) {
      if (d?.details?.error === 'DeviceNotRegistered') await db.q('update core.device_tokens set revoked_at = now() where org_id = $1 and token = $2', [db.requireOrg(), tokens[i]!.token]).catch(() => undefined);
    }
  } catch {
    /* push is best effort */
  }
}

/** Admission heads and admins who should hear about escalations for a branch. */
export async function headsFor(db: Db, branchId: string): Promise<Row[]> {
  return db.q(
    `select u.id, u.name from crm.staff_v u
      where u.org_id = $1 and u.active and u.role_key is not null and u.permissions->>'reassign' in ('F','T')
        and (u.branch_ids = '[]'::jsonb or u.branch_ids @> to_jsonb($2::text))`,
    [db.requireOrg(), branchId],
  );
}

// ---------- duplicates ----------

export async function findHousehold(db: Db, k: { mobile?: string; altMobile?: string; email?: string }): Promise<Row | null> {
  const mobiles = [normMobile(k.mobile), normMobile(k.altMobile)].filter((m) => m.length >= 10);
  const email = (k.email ?? '').trim().toLowerCase();
  if (!mobiles.length && !email) return null;
  return db.one(
    `select g.household_id, g.id as guardian_id, g.name as guardian_name, g.phone as mobile from crm.guardians g
      where g.org_id = $1 and (g.phone in (select jsonb_array_elements_text($2::jsonb))
         or g.alt_phone in (select jsonb_array_elements_text($2::jsonb))
         or ($3 <> '' and lower(g.email) = $3))
      order by g.is_primary desc limit 1`,
    [db.requireOrg(), mobiles, email],
  );
}

/** What the create forms show while the user types. */
export async function duplicatePreview(db: Db, k: { mobile?: string; altMobile?: string; email?: string }) {
  const hit = await findHousehold(db, k);
  if (!hit) return null;
  const enquiries = await db.q(
    `select e.id, s.full_name as student, e.grade, st.name as stage, u.name as owner, y.name as year, b.name as branch
       from crm.enquiries e join crm.prospects s on s.org_id = e.org_id and s.id = e.prospect_id
       join crm.stages st on st.org_id = e.org_id and st.id = e.stage_id
       join crm.staff_v u on u.org_id = e.org_id and u.id = e.owner_id
       join core.academic_years y on y.org_id = e.org_id and y.id = e.academic_year_id
       join core.branches b on b.org_id = e.org_id and b.id = e.branch_id
      where e.org_id = $1 and e.household_id = $2 order by e.created_at desc`,
    [db.requireOrg(), hit.household_id],
  );
  return { householdId: hit.household_id as string, guardian: hit.guardian_name as string, mobile: hit.mobile as string, enquiries };
}

// ---------- assignment (ASG-01..03, ASG-06) ----------

export type AssignAttrs = { branchId: string; board?: string | null; grade?: string | null; channel?: string | null; householdId?: string | null };

const ruleMatches = (c: Row, a: AssignAttrs) =>
  (!c.branch_id || c.branch_id === a.branchId) && (!c.board || c.board === a.board) && (!c.channel || c.channel === a.channel) && (!c.grades?.length || c.grades.includes(a.grade));

/**
 * Picks an owner. Order: sticky owner for the family, then the first matching rule with
 * an available counsellor (active, not on leave, under daily capacity), then least-loaded fallback.
 * dryRun explains the decision without advancing round-robin pointers.
 */
export async function assignOwner(db: Db, a: AssignAttrs, dryRun = false): Promise<{ ownerId: string; ownerName: string; reason: string }> {
  const org = db.requireOrg();
  if (a.householdId) {
    const sticky = await db.one(
      `select u.id, u.name from crm.enquiries e join crm.staff_v u on u.org_id = e.org_id and u.id = e.owner_id
        where e.org_id = $1 and e.household_id = $2 and u.active and u.role_key is not null and not u.on_leave order by e.created_at desc limit 1`,
      [org, a.householdId],
    );
    if (sticky) return { ownerId: sticky.id, ownerName: sticky.name, reason: 'Sticky owner: this family already works with ' + sticky.name };
  }
  const users = await db.q(
    `select u.id, u.name, u.daily_capacity, u.on_leave, u.branch_ids, u.permissions->>'leads' as lead_level,
       (select count(*)::int from crm.enquiries e where e.org_id = u.org_id and e.owner_id = u.id and e.created_at::date = now()::date) as today,
       (select count(*)::int from crm.enquiries e join crm.stages s on s.org_id = e.org_id and s.id = e.stage_id
         where e.org_id = u.org_id and e.owner_id = u.id and not s.is_closed and not s.is_won) as open_load
     from crm.staff_v u where u.org_id = $1 and u.active and u.role_key is not null and u.role_key <> 'system' order by u.name`,
    [org],
  );
  const inBranch = (u: Row) => !u.branch_ids.length || u.branch_ids.includes(a.branchId);
  const available = (u: Row) => !u.on_leave && u.today < u.daily_capacity && inBranch(u);
  const rules = await db.q('select * from crm.assignment_rules where org_id = $1 and active order by seq', [org]);
  for (const r of rules) {
    if (!ruleMatches(r.conditions, a)) continue;
    const pool = (r.user_ids as string[]).map((id) => users.find((u) => u.id === id)).filter((u): u is Row => !!u && available(u));
    if (!pool.length) continue;
    let pick: Row;
    if (r.method === 'least_load') pick = [...pool].sort((x, y) => x.open_load - y.open_load)[0]!;
    else {
      // Round robin walks the configured order, skipping anyone unavailable today.
      const order = r.user_ids as string[];
      let p = r.pointer % order.length;
      for (let i = 0; i < order.length && !pool.some((u) => u.id === order[p]); i++) p = (p + 1) % order.length;
      pick = pool.find((u) => u.id === order[p])!;
      if (!dryRun) await db.q('update crm.assignment_rules set pointer = $2 where id = $1', [r.id, (p + 1) % order.length]);
    }
    return { ownerId: pick.id, ownerName: pick.name, reason: `Rule "${r.name}" (${r.method === 'least_load' ? 'least open load' : 'round robin'})` };
  }
  const fallback =
    users.filter((u) => ['O', 'T'].includes(u.lead_level) && available(u)).sort((x, y) => x.open_load - y.open_load)[0] ??
    users.filter((u) => ['F', 'T'].includes(u.lead_level) && inBranch(u))[0] ??
    users[0];
  if (!fallback) throw new Error('No counsellor is available to own this enquiry. Add a user with a CRM role first.');
  return { ownerId: fallback.id, ownerName: fallback.name, reason: 'Catch-all: least-loaded available person in the branch' };
}

// ---------- stages ----------

export async function stageByName(db: Db, name: string): Promise<Row | null> {
  return db.one(
    `select s.*, p.key as phase_key from crm.stages s join crm.phases p on p.org_id = s.org_id and p.id = s.phase_id
      where s.org_id = $1 and s.name = $2 and s.active order by p.seq limit 1`,
    [db.requireOrg(), name],
  );
}

export async function getEnquiry(db: Db, id: string): Promise<Row | null> {
  return db.one(
    `select e.*, s.name as stage_name, s.is_closed, s.is_won, s.exempt_next_action, p.key as phase_key, st.full_name as student_name,
            u.full_name as owner_name, b.name as branch_name
       from crm.enquiries e join crm.stages s on s.org_id = e.org_id and s.id = e.stage_id
       join crm.phases p on p.org_id = s.org_id and p.id = s.phase_id
       join crm.prospects st on st.org_id = e.org_id and st.id = e.prospect_id
       left join core.staff u on u.org_id = e.org_id and u.user_id = e.owner_id
       join core.branches b on b.org_id = e.org_id and b.id = e.branch_id
      where e.org_id = $1 and e.id = $2`,
    [db.requireOrg(), id],
  );
}

export const FIELD_LABELS: Record<string, string> = { closure_reason: 'Closure reason', visit: 'A booked campus visit', expected_decision: 'Expected decision date' };

/** Moves a stage, asking only for what that stage requires (L360-05). Reaching a won stage admits the student in core. */
export async function changeStage(
  db: Db, enquiryId: string, stageId: string, actor: Actor,
  extra: { closure_reason?: string; expected_decision?: string; note?: string } = {},
): Promise<{ ok: boolean; missing?: string[]; error?: string; admission?: Row }> {
  const org = db.requireOrg();
  const e = await getEnquiry(db, enquiryId);
  const to = await db.one('select s.*, p.key as phase_key from crm.stages s join crm.phases p on p.org_id = s.org_id and p.id = s.phase_id where s.org_id = $1 and s.id = $2', [org, stageId]);
  if (!e || !to) return { ok: false, error: 'Record or stage not found.' };
  if (e.stage_id === to.id) return { ok: true };
  const missing: string[] = [];
  for (const f of to.required_fields as string[]) {
    if (f === 'closure_reason' && !extra.closure_reason) missing.push(f);
    if (f === 'expected_decision' && !extra.expected_decision && !e.expected_decision) missing.push(f);
    if (f === 'visit' && !(await db.one("select 1 from crm.visits where org_id = $1 and enquiry_id = $2 and status in ('scheduled','done')", [org, enquiryId]))) missing.push(f);
  }
  if (missing.length) return { ok: false, missing };
  await db.update('crm.enquiries', enquiryId, {
    stage_id: to.id,
    stage_entered_at: new Date(),
    closure_reason: to.is_closed ? (extra.closure_reason ?? null) : null,
    expected_decision: extra.expected_decision || undefined,
  });
  await logActivity(db, {
    householdId: e.household_id,
    enquiryId,
    type: 'stage_change',
    actorId: actor?.id,
    content: `Stage moved from ${e.stage_name} to ${to.name}` + (extra.closure_reason ? `. Reason: ${extra.closure_reason}` : '') + (extra.note ? `. ${extra.note}` : ''),
    meta: { from: e.stage_name, to: to.name },
  });
  if (to.is_closed || to.is_won) await db.q("update crm.follow_ups set status = 'cancelled' where org_id = $1 and enquiry_id = $2 and status = 'open'", [org, enquiryId]);
  let admission: Row | undefined;
  // Decision 38: the core student exists only after admission. One transaction with the stage change.
  if (to.is_won) admission = (await db.one('select core.admit_student($1) as r', [enquiryId]))!.r;
  await emit(db, 'stage_changed', enquiryId);
  if (to.is_won) await emit(db, 'admission_confirmed', enquiryId);
  if (to.is_closed) await emit(db, 'enquiry_closed', enquiryId);
  return { ok: true, admission };
}

// ---------- timeline, scoring ----------

export const DEFAULT_SCORING: Record<string, number> = {
  call_connected: 10, call_attempt: 2, whatsapp_in: 12, whatsapp_out: 2, sms: 1, email: 1, note: 1,
  visit_booked: 15, visit_done: 25, form_started: 15, form_submitted: 25, payment: 30, re_enquiry: 10, sibling: 15,
};
export const SCORE_LABELS: Record<string, string> = {
  call_connected: 'Connected calls', call_attempt: 'Call attempts', whatsapp_in: 'Parent WhatsApp replies', whatsapp_out: 'WhatsApp sent', sms: 'SMS sent', email: 'Emails sent',
  note: 'Notes', visit_booked: 'Visit booked', visit_done: 'Visit completed', form_started: 'Application started', form_submitted: 'Application submitted', payment: 'Payment received',
  re_enquiry: 'Re-enquired', sibling: 'Sibling in school',
};

function scoreKey(a: Row): string | null {
  switch (a.type) {
    case 'call': return a.outcome === 'connected' ? 'call_connected' : 'call_attempt';
    case 'whatsapp': return a.meta?.direction === 'in' ? 'whatsapp_in' : a.meta?.status === 'failed' ? null : 'whatsapp_out';
    case 'sms': case 'email': return a.meta?.status === 'failed' ? null : a.type;
    case 'note': return 'note';
    case 'visit': return a.outcome === 'done' ? 'visit_done' : a.outcome === 'booked' ? 'visit_booked' : null;
    case 'form': return a.outcome === 'submitted' ? 'form_submitted' : a.outcome === 'started' ? 'form_started' : null;
    case 'payment': return a.outcome === 'paid' ? 'payment' : null;
    case 'touch': return a.outcome === 're_enquiry' ? 're_enquiry' : null;
    default: return null;
  }
}

/** Rule-based score with the breakdown shown to users as "what moved it" (AI-01). */
export async function scoreBreakdown(db: Db, enquiryId: string): Promise<{ score: number; parts: { key: string; label: string; count: number; points: number }[] }> {
  const rules: Record<string, number> = { ...DEFAULT_SCORING, ...((await tenantSettings(db)).scoring ?? {}) };
  const acts = await db.q('select type, outcome, meta from crm.activities where org_id = $1 and enquiry_id = $2', [db.requireOrg(), enquiryId]);
  const counts: Record<string, number> = {};
  for (const a of acts) {
    const k = scoreKey(a);
    if (k) counts[k] = (counts[k] ?? 0) + 1;
  }
  const hh = await db.one('select h.sibling_in_school from crm.enquiries e join crm.households h on h.org_id = e.org_id and h.id = e.household_id where e.id = $1', [enquiryId]);
  if (hh?.sibling_in_school) counts.sibling = 1;
  // Repeated activity of one kind counts at most three times so a chatty thread cannot max the score.
  const parts = Object.entries(counts)
    .map(([key, count]) => ({ key, label: SCORE_LABELS[key] ?? key, count, points: Math.min(count, 3) * (rules[key] ?? 0) }))
    .filter((p) => p.points)
    .sort((a, b) => b.points - a.points);
  return { score: Math.min(100, parts.reduce((s, p) => s + p.points, 0)), parts };
}

export const temperatureFor = (score: number, s: Row) => (score >= (s.hot_at ?? 60) ? 'Hot' : score >= (s.warm_at ?? 30) ? 'Warm' : 'Cold');

export async function rescore(db: Db, enquiryId: string) {
  const { score } = await scoreBreakdown(db, enquiryId);
  const settings = await tenantSettings(db);
  const before = await db.one('select temperature, owner_id, household_id from crm.enquiries where id = $1', [enquiryId]);
  const temperature = temperatureFor(score, settings);
  await db.q('update crm.enquiries set score = $2, temperature = $3 where id = $1', [enquiryId, score, temperature]);
  if (before && before.temperature !== 'Hot' && temperature === 'Hot') await emit(db, 'hot_lead', enquiryId);
}

const HUMAN_CONTACT = ['call', 'whatsapp', 'sms', 'email'];

export async function logActivity(db: Db, a: { householdId: string; enquiryId?: string | null; type: string; actorId?: string | null; outcome?: string | null; content?: string | null; meta?: Row; at?: Date }): Promise<Row> {
  const row = await db.insert('crm.activities', {
    household_id: a.householdId, enquiry_id: a.enquiryId ?? null, type: a.type, actor_id: a.actorId ?? null,
    outcome: a.outcome ?? null, content: a.content ?? null, meta: a.meta ?? {}, created_at: a.at,
  });
  if (a.enquiryId) {
    const human = !!a.actorId && HUMAN_CONTACT.includes(a.type) && a.meta?.direction !== 'in';
    await db.q(
      `update crm.enquiries set last_activity_at = now(), updated_at = now(),
         first_response_at = case when $2 and first_response_at is null then now() else first_response_at end where id = $1`,
      [a.enquiryId, human],
    );
    await rescore(db, a.enquiryId);
  }
  return row;
}

// ---------- tasks (TSK-01..03) ----------

export const TASK_TYPES: Record<string, string> = {
  call_back: 'Call back', whatsapp_follow_up: 'WhatsApp follow-up', visit: 'Visit', document_chase: 'Document chase', payment_chase: 'Payment chase', interaction: 'Interaction', custom: 'Other',
};

export async function addTask(db: Db, t: { enquiryId: string; type?: string; title: string; dueAt: Date; ownerId?: string; priority?: string }): Promise<Row> {
  const e = await db.one('select household_id, owner_id from crm.enquiries where org_id = $1 and id = $2', [db.requireOrg(), t.enquiryId]);
  if (!e) throw new Error('Enquiry not found');
  return db.insert('crm.follow_ups', { enquiry_id: t.enquiryId, household_id: e.household_id, type: t.type ?? 'call_back', title: t.title, due_at: t.dueAt, owner_id: t.ownerId ?? e.owner_id, priority: t.priority ?? 'normal' });
}

/** True when an open enquiry in a non-exempt stage has no open task left. */
export async function needsNextAction(db: Db, enquiryId: string): Promise<boolean> {
  const e = await getEnquiry(db, enquiryId);
  if (!e || e.is_closed || e.is_won || e.exempt_next_action) return false;
  return !(await db.one("select 1 from crm.follow_ups where org_id = $1 and enquiry_id = $2 and status = 'open'", [db.requireOrg(), enquiryId]));
}

export async function completeTask(db: Db, taskId: string, actor: Actor, outcome: string): Promise<{ enquiryId: string | null; needsNext: boolean }> {
  const t = await db.one('select * from crm.follow_ups where org_id = $1 and id = $2', [db.requireOrg(), taskId]);
  if (!t || t.status !== 'open') return { enquiryId: t?.enquiry_id ?? null, needsNext: false };
  await db.update('crm.follow_ups', taskId, { status: 'done', outcome, completed_at: new Date() });
  await logActivity(db, { householdId: t.household_id, enquiryId: t.enquiry_id, type: 'task', actorId: actor?.id, outcome: 'done', content: `Task done: ${t.title}${outcome ? ` — ${outcome}` : ''}` });
  return { enquiryId: t.enquiry_id, needsNext: t.enquiry_id ? await needsNextAction(db, t.enquiry_id) : false };
}

// ---------- capture (CAP-01..08, DUP-01..03, DM-01..03) ----------

export type CaptureInput = {
  studentName: string; guardianName: string; mobile: string; altMobile?: string; email?: string; relation?: string; dob?: string; gender?: string;
  branchId: string; yearId?: string; board?: string; grade?: string; locality?: string; currentSchool?: string;
  sourceId?: string; channel?: string; source?: string; campaign?: string; utm?: Row; heardAbout?: string;
  consent?: { source: string; wording?: string }; note?: string; custom?: Row; asProspect?: boolean; tags?: string[];
  /** Set when the person entering the lead should own it (a counsellor adding their own enquiry). Sticky family owners still win. */
  preferOwnerId?: string;
};
export type CaptureResult = { ok: true; status: 'created' | 'sibling_added' | 're_enquiry'; householdId: string; enquiryId: string; ownerId: string; ownerName: string } | { ok: false; error: string };

const CONSENT_CHANNELS = ['whatsapp', 'sms', 'email', 'call'] as const;

/** Resolves the enquiry's year: the given one, else the current / newest. */
async function pickYear(db: Db, yearId?: string): Promise<Row | null> {
  const org = db.requireOrg();
  return yearId
    ? db.one('select id from core.academic_years where org_id = $1 and id = $2', [org, yearId])
    : db.one('select id from core.academic_years where org_id = $1 and deleted_at is null order by is_current desc, seq desc limit 1', [org]);
}

export async function captureEnquiry(db: Db, input: CaptureInput, actor: Actor = null): Promise<CaptureResult> {
  const org = db.requireOrg();
  const mobile = normMobile(input.mobile);
  if (!validMobile(mobile)) return { ok: false, error: 'Enter a valid 10-digit mobile number.' };
  if (!input.studentName?.trim()) return { ok: false, error: 'Student name is required.' };
  const branch = await branchOf(db, input.branchId);
  if (!branch) return { ok: false, error: 'Choose a branch.' };
  const year = await pickYear(db, input.yearId);
  if (!year) return { ok: false, error: 'No academic year is open for admissions.' };
  const src = input.sourceId ? await db.one('select * from crm.sources where org_id = $1 and id = $2', [org, input.sourceId]) : null;
  const channel = src?.channel ?? input.channel ?? 'Direct';
  const sourceName = src?.name ?? input.source ?? 'Manual entry';
  const touch = (enquiryId: string) => db.insert('crm.source_touches', { enquiry_id: enquiryId, source_id: src?.id ?? null, channel, source: sourceName, campaign: input.campaign ?? null, utm: input.utm ?? {} });
  const now = new Date();
  const consentSource = input.consent?.source ?? (actor ? 'Recorded by staff at entry' : 'Web form');
  const consentWording = input.consent?.wording ?? 'v1';

  const existing = await findHousehold(db, { mobile, altMobile: input.altMobile, email: input.email });
  if (existing) {
    const householdId = existing.household_id as string;
    const students = await db.q('select id, full_name as name, dob::text as dob from crm.prospects where org_id = $1 and household_id = $2', [org, householdId]);
    const student = students.find((s) => sameStudent(s as { name: string; dob: string | null }, { name: input.studentName, dob: input.dob }));
    const prior = student
      ? await db.one(
          'select e.*, s.is_closed, s.name as stage_name from crm.enquiries e join crm.stages s on s.org_id = e.org_id and s.id = e.stage_id where e.org_id = $1 and e.prospect_id = $2 and e.academic_year_id = $3 and e.branch_id = $4',
          [org, student.id, year.id, branch.id],
        )
      : null;
    if (prior) {
      // DM-01: never a silent duplicate. Add a touch, flag the re-enquiry and tell the owner.
      await touch(prior.id);
      await db.q('update crm.enquiries set reenquired = true, updated_at = now() where id = $1', [prior.id]);
      await logActivity(db, { householdId, enquiryId: prior.id, type: 'touch', actorId: actor?.id, outcome: 're_enquiry', content: `Re-enquired through ${sourceName} (${channel})` + (input.note ? `. ${input.note}` : '') });
      const settings = await tenantSettings(db);
      if (prior.is_closed && settings.reopen_on_reenquiry !== false) {
        const st = await stageByName(db, 'New');
        if (st) await changeStage(db, prior.id, st.id, null, { note: 'Re-opened automatically because the family enquired again' });
      }
      const owner = await db.one('select id, name from crm.staff_v where org_id = $1 and id = $2', [org, prior.owner_id]);
      await notify(db, prior.owner_id, 'assigned', `${existing.guardian_name} enquired again for ${student!.name}`, `/households/${householdId}?e=${prior.id}`);
      if (await needsNextAction(db, prior.id)) await addTask(db, { enquiryId: prior.id, title: 'Call back: family re-enquired', dueAt: new Date(Date.now() + 15 * 60000), priority: 'high' });
      await emit(db, 're_enquiry', prior.id);
      return { ok: true, status: 're_enquiry', householdId, enquiryId: prior.id, ownerId: owner!.id, ownerName: owner!.name };
    }
    const prospectId = student?.id ?? (await newProspect(householdId)).id;
    const made = await createEnquiry(householdId, prospectId);
    return { ok: true, status: student ? 'created' : 'sibling_added', householdId, ...made };
  }

  const hh = await db.insert('crm.households', { locality: input.locality ?? null, heard_about: input.heardAbout ?? null });
  const g = await db.insert('crm.guardians', {
    household_id: hh.id, name: input.guardianName?.trim() || 'Parent', relation: mapRelation(input.relation), phone: mobile,
    alt_phone: normMobile(input.altMobile) || null, email: input.email?.trim().toLowerCase() || null,
  });
  for (const ch of CONSENT_CHANNELS) await db.q('select crm.set_consent($1, $2, true, $3, $4)', [g.id, ch, consentSource, consentWording]);
  const st = await newProspect(hh.id);
  const made = await createEnquiry(hh.id, st.id);
  return { ok: true, status: 'created', householdId: hh.id, ...made };

  async function newProspect(householdId: string) {
    const n = splitName(input.studentName.trim());
    return db.insert('crm.prospects', { household_id: householdId, first_name: n.first, last_name: n.last, dob: input.dob || null, gender: mapGender(input.gender), current_school: input.currentSchool ?? null });
  }

  async function createEnquiry(householdId: string, prospectId: string) {
    const stage = await stageByName(db, input.asProspect ? 'New data' : 'New');
    if (!stage) throw new Error('Pipeline has no starting stage');
    let owner = await assignOwner(db, { branchId: branch!.id, board: input.board, grade: input.grade, channel, householdId: existing ? householdId : null });
    if (input.preferOwnerId && !owner.reason.startsWith('Sticky')) {
      const self = await db.one('select id, name from crm.staff_v where org_id = $1 and id = $2 and active and role_key is not null', [org, input.preferOwnerId]);
      if (self) owner = { ownerId: self.id, ownerName: self.name, reason: 'Added by the counsellor themselves' };
    }
    const prog = input.grade ? await db.one('select id from core.programmes where org_id = $1 and name = $2 and (branch_id is null or branch_id = $3) and deleted_at is null order by branch_id nulls last limit 1', [org, input.grade, branch!.id]) : null;
    const e = await db.insert('crm.enquiries', {
      household_id: householdId, prospect_id: prospectId, branch_id: branch!.id, academic_year_id: year!.id, programme_id: prog?.id ?? null,
      board: input.board ?? branch!.boards?.[0] ?? null, grade: input.grade ?? null, stage_id: stage.id, owner_id: owner.ownerId, custom: input.custom ?? {}, tags: input.tags ?? [],
    });
    await touch(e.id);
    await logActivity(db, {
      householdId, enquiryId: e.id, type: 'touch', actorId: actor?.id, outcome: 'created',
      content: `Enquiry created from ${sourceName} (${channel}). Assigned to ${owner.ownerName}: ${owner.reason}.` + (input.note ? ` Note: ${input.note}` : ''),
    });
    await notify(db, owner.ownerId, 'assigned', `New enquiry: ${input.studentName} (${input.grade ?? 'grade not set'})`, `/households/${householdId}?e=${e.id}`);
    if (!input.asProspect) {
      const hour = hourIST(now);
      const outOfHours = hour < branch!.open_hour || hour >= branch!.close_hour;
      await emit(db, outOfHours ? 'out_of_hours' : 'enquiry_created', e.id);
      // TSK-03: an open enquiry always has a next action, even if no workflow created one.
      if (await needsNextAction(db, e.id)) await addTask(db, { enquiryId: e.id, title: 'First call to the parent', dueAt: new Date(Date.now() + 5 * 60000), priority: 'high' });
      if (existing) await emit(db, 'sibling_enquiry', e.id);
    }
    await dispatchWebhooks(db, 'enquiry.created', { enquiry_id: e.id, household_id: householdId, student: input.studentName, grade: input.grade, channel, source: sourceName });
    return { enquiryId: e.id as string, ownerId: owner.ownerId, ownerName: owner.ownerName };
  }
}

// ---------- messaging (WA-04, MSG-01..05, L360-03) ----------

export const MESSAGE_COST: Record<string, number> = { whatsapp: 0.8, sms: 0.25, email: 0.02 };
const CHANNEL_NAME: Record<string, string> = { whatsapp: 'WhatsApp', sms: 'SMS', email: 'email' };

/** Statuses of core.message_templates from Meta's template status. */
export const templateStatus = (metaStatus: string): string => (metaStatus === 'APPROVED' ? 'approved' : ['REJECTED', 'DISABLED'].includes(metaStatus) ? 'rejected' : metaStatus === 'PAUSED' ? 'paused' : 'submitted');

export async function waWalletBalance(db: Db): Promise<number> {
  return Number((await db.one('select wallet_balance from crm.settings where org_id = $1', [db.requireOrg()]))?.wallet_balance ?? 0);
}

/**
 * Sends a message to the household's primary guardian.
 * WhatsApp goes through the school's own Meta Cloud API account when connected; otherwise, and for
 * SMS and email until those providers are connected, the bundled simulator records it and charges the
 * wallet without reaching a phone. Failures are stored in plain language with a suggested next step.
 * Consent is read through core.can_contact (no record means no consent).
 */
export async function sendMessage(
  db: Db,
  m: { householdId: string; enquiryId?: string | null; channel: string; body: string; actorId?: string | null; campaignId?: string | null; template?: Row | null; vars?: Record<string, string | null | undefined>; deferred?: boolean },
): Promise<{ status: 'sent' | 'delivered' | 'queued' | 'failed'; reason?: string }> {
  const org = db.requireOrg();
  const g = await db.one('select * from crm.guardians where org_id = $1 and household_id = $2 order by is_primary desc, created_at limit 1', [org, m.householdId]);
  // Automated messages (workflows) respect the school's quiet hours and a daily cap per family (MSG-05).
  if (!m.actorId && !m.campaignId && !m.deferred) {
    const settings = await tenantSettings(db);
    const quiet = settings.quiet_hours ?? { from: 21, to: 8 };
    const h = hourIST();
    const inQuiet = quiet.from > quiet.to ? h >= quiet.from || h < quiet.to : h >= quiet.from && h < quiet.to;
    if (inQuiet) {
      const wait = (((quiet.to - h + 24) % 24) || 24) * 3600e3 - new Date().getMinutes() * 60e3;
      await db.q("select app.enqueue_job('crm', 'send_message', $1::jsonb, $2::timestamptz)", [JSON.stringify({ ...m, templateId: m.template?.id ?? null, template: undefined }), new Date(Date.now() + wait)]);
      return { status: 'queued', reason: `Held until ${quiet.to}:00 because of the school's quiet hours.` };
    }
    const cap = Number(settings.max_auto_per_day ?? 4);
    const today = await db.one(
      "select count(*)::int n from crm.messages where org_id = $1 and household_id = $2 and direction = 'out' and sender_id is null and campaign_id is null and status <> 'failed' and created_at > now() - interval '24 hours'",
      [org, m.householdId],
    );
    if (today!.n >= cap) return { status: 'failed', reason: `Skipped: this family already got ${cap} automated messages in the last 24 hours.` };
  }
  const { waConfig, waSendTemplate, waSendText } = await import('./meta');
  const live = m.channel === 'whatsapp' ? await waConfig(db) : null;
  const cost = live ? 0 : (MESSAGE_COST[m.channel] ?? 0); // the school's own Meta account bills the school directly
  let reason: string | undefined;
  let providerId: string | null = null;
  const gated = ['whatsapp', 'sms', 'email'].includes(m.channel);
  const consented = !g || !gated ? true : ((await db.one('select core.can_contact($1, $2, $3) as ok', ['crm_guardian', g.id, m.channel]))!.ok as boolean);
  if (!g) reason = 'No guardian contact on this household.';
  else if (!consented) reason = `This parent has opted out of ${CHANNEL_NAME[m.channel] ?? m.channel} messages. Use another channel they have agreed to.`;
  else if (m.channel === 'email' && !g.email) reason = 'No email address on file. Ask the parent for one or use WhatsApp.';
  else if (live) {
    const lastIn = await db.one("select max(created_at) as at from crm.messages where org_id = $1 and household_id = $2 and channel = 'whatsapp' and direction = 'in'", [org, m.householdId]);
    const windowOpen = !!lastIn?.at && Date.now() - new Date(lastIn.at).getTime() < 24 * 3600e3;
    const tpl = m.template && m.template.channel === 'whatsapp' && m.template.provider_status === 'APPROVED' && m.template.provider_template_name ? m.template : null;
    const res = tpl ? await waSendTemplate(live, g.phone, tpl, m.vars ?? {}) : windowOpen ? await waSendText(live, g.phone, m.body) : null;
    if (!res) reason = m.template ? 'This template is not approved on WhatsApp yet, and it is more than 24 hours since the parent last wrote. Ask your admin to sync templates, or call.' : 'More than 24 hours since the parent last wrote, so only an approved template can be sent.';
    else if (!res.ok) reason = res.reason;
    else providerId = res.id;
  } else if ((await waWalletBalance(db)) < cost) reason = 'Message credits have run out. Ask your admin to recharge the wallet.';
  else if (m.channel === 'whatsapp' && g.phone.endsWith('00')) reason = 'This number cannot receive WhatsApp messages. Try SMS or call.';
  const status = reason ? 'failed' : live ? 'sent' : 'delivered';
  await db.insert('crm.messages', {
    household_id: m.householdId, enquiry_id: m.enquiryId ?? null, channel: m.channel, direction: 'out', body: m.body, status, fail_reason: reason ?? null,
    campaign_id: m.campaignId ?? null, sender_id: m.actorId ?? null, read: true, provider_id: providerId,
  });
  if (!reason && cost > 0) await db.q('select crm.wallet_post($1, $2, $3, $4)', ['debit', m.channel, cost, m.campaignId ? 'Campaign message' : 'Message']);
  await logActivity(db, {
    householdId: m.householdId, enquiryId: m.enquiryId, type: m.channel, actorId: m.actorId,
    content: reason ? `Not delivered: ${reason}` : m.body, meta: { direction: 'out', status, body: reason ? m.body : undefined, automated: !m.actorId },
  });
  return { status, reason };
}

const OPT_OUT = /^\s*(stop|unsubscribe|opt ?out)\s*$/i;

/** Inbound parent message from the provider webhook (or the demo "parent replies" button). */
export async function receiveMessage(db: Db, householdId: string, channel: string, body: string) {
  const org = db.requireOrg();
  const e = await db.one(
    'select e.id, e.owner_id from crm.enquiries e join crm.stages s on s.org_id = e.org_id and s.id = e.stage_id where e.org_id = $1 and e.household_id = $2 order by s.is_closed, e.created_at desc limit 1',
    [org, householdId],
  );
  await db.insert('crm.messages', { household_id: householdId, enquiry_id: e?.id ?? null, channel, direction: 'in', body, status: 'received' });
  await db.q("update crm.households set inbox_status = 'open' where id = $1", [householdId]);
  if (OPT_OUT.test(body)) {
    for (const g of await db.q('select id from crm.guardians where org_id = $1 and household_id = $2', [org, householdId])) {
      await db.q('select crm.set_consent($1, $2, false, $3, null)', [g.id, channel, 'Parent replied STOP']);
    }
    await logActivity(db, { householdId, enquiryId: e?.id, type: 'system', content: `Parent opted out of ${CHANNEL_NAME[channel] ?? channel} messages. No further ${CHANNEL_NAME[channel] ?? channel} messages will be sent.` });
  }
  await logActivity(db, { householdId, enquiryId: e?.id, type: channel, content: body, meta: { direction: 'in' } });
  if (e) {
    await notify(db, e.owner_id, 'parent_replied', 'Parent replied: ' + body.slice(0, 60), `/inbox?h=${householdId}`);
    await emit(db, 'parent_replied', e.id);
  }
}

// ---------- events ----------

export async function emit(db: Db, event: string, enquiryId: string) {
  const { runTrigger } = await import('./workflows');
  await runTrigger(db, event, enquiryId);
}

/**
 * Outbound webhooks (API-02), configured in core.webhooks (product_key crm; the signing secret is the crm.org_secrets
 * row `webhook_secret:<id>`). Best effort with a short timeout; the last HTTP status (0 = unreachable) is stored.
 */
export async function dispatchWebhooks(db: Db, event: string, payload: Row) {
  const org = db.requireOrg();
  const hooks = await db.q("select * from core.webhooks where org_id = $1 and product_key = 'crm' and active and deleted_at is null", [org]);
  if (!hooks.length) return;
  const { getSecret } = await import('./secrets');
  const body = JSON.stringify({ event, sent_at: new Date().toISOString(), data: payload });
  await Promise.all(
    hooks
      .filter((h) => !h.events.length || h.events.includes(event))
      .map(async (h) => {
        let status = 0;
        try {
          const secret = (await getSecret(db, `webhook_secret:${h.id}`)) ?? '';
          const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');
          const r = await fetch(h.url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-autoed-signature': sig }, body, signal: AbortSignal.timeout(4000) });
          status = r.status;
        } catch {
          status = 0;
        }
        await db.q('update core.webhooks set last_status = $2, last_delivery_at = now() where id = $1', [h.id, status]);
      }),
  );
}
