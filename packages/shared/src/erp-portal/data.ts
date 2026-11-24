/**
 * The portals' data layer, shared by the web portal and the Expo app: every read and write is a Supabase Data API call made as
 * the signed-in user (decision 51), so row-level security decides what comes back. Nothing here knows about a service key.
 *
 * `PortalDb` is the one method of a supabase-js client these functions use (`schema(name)`), so the module needs no dependency.
 * Each function throws `PortalDbError` (message and Postgres code) when the API answers with an error.
 */
import type { DemandRow, Mark, ResultRow, PaymentAllocation, TripRow, TestQuestion } from './logic';

// supabase-js query builders are deeply generic; this module only chains their methods, so the builder stays untyped here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface PortalDb { schema(name: string): any }
export class PortalDbError extends Error {
  constructor(message: string, public code?: string) { super(message); this.name = 'PortalDbError'; }
}
type Res<T> = PromiseLike<{ data: T | null; error: { message: string; code?: string } | null }>;
const E = (sb: PortalDb) => sb.schema('erp');
const C = (sb: PortalDb) => sb.schema('core');
async function list<T>(p: Res<T[]>): Promise<T[]> {
  const { data, error } = await p;
  if (error) throw new PortalDbError(error.message, error.code);
  return data ?? [];
}
async function single<T>(p: Res<T>): Promise<T | null> {
  const { data, error } = await p;
  if (error) throw new PortalDbError(error.message, error.code);
  return data ?? null;
}
async function write(p: Res<unknown>): Promise<void> {
  const { error } = await p;
  if (error) throw new PortalDbError(error.message, error.code);
}
/** The message the database wrote on purpose (checks the portal functions make: 22xxx, 54xxx, 55xxx) or a generic line. */
export const friendlyError = (e: unknown, fallback: string): string => {
  const code = (e as { code?: string } | null)?.code ?? '';
  const message = (e as { message?: string } | null)?.message ?? '';
  return /^(22|54|55)/.test(code) && message ? message : fallback;
};
export const isOffline = (e: unknown): boolean => /fetch|network|load failed|failed to fetch/i.test(String((e as { message?: string } | null)?.message ?? e));

// ---------------------------------------------------------------------------------------------------------------- session boot
export interface MemberRow { user_id: string; org_id: string; kind: string; display_name: string | null; home_branch_id: string | null }
export interface OrgRow { id: string; name: string; branding: unknown; logo_file_id: string | null }
export interface ChildRow { id: string; first_name: string; last_name: string | null; full_name: string | null; section_id: string | null; branch_id: string | null; status: string; admission_no: string | null }
export interface BootData { member: MemberRow; org: OrgRow | null; children: ChildRow[]; guardian: { id: string; language: string | null } | null }
/** Who this login is, their school, children and guardian record. `null` when the login belongs to no school. */
export async function loadBoot(sb: PortalDb, userId: string): Promise<BootData | null> {
  const [m, o, kids, g] = await Promise.all([
    list<MemberRow>(C(sb).from('org_users').select('user_id, org_id, kind, display_name, home_branch_id').eq('user_id', userId).limit(1)),
    list<OrgRow>(C(sb).from('organizations').select('id, name, branding, logo_file_id').limit(1)),
    list<ChildRow>(C(sb).from('students').select('id, first_name, last_name, full_name, section_id, branch_id, status, admission_no').is('deleted_at', null).in('status', ['active', 'admitted', 'suspended']).order('dob')),
    list<{ id: string; language: string | null }>(C(sb).from('guardians').select('id, language').eq('user_id', userId).is('deleted_at', null).limit(1)),
  ]);
  const member = m[0];
  return member ? { member, org: o[0] ?? null, children: kids, guardian: g[0] ?? null } : null;
}

// ---------------------------------------------------------------------------------------------------------------- directory
export interface Directory {
  section: string | null; programme: string | null;
  class_teacher: { id: string; name: string } | null;
  subject_teachers: { id: string; name: string; subject: string }[];
  ptm_staff: { id: string; name: string }[];
  transport: { route_id: string; route: string; stop: string | null; pickup_time: string | null; drop_time: string | null; vehicle: string | null; driver: string | null; attendant: string | null } | null;
}
export async function loadDirectory(sb: PortalDb, studentId: string): Promise<Directory> {
  const { data, error } = await E(sb).rpc('portal_directory', { p_student: studentId });
  if (error) throw new PortalDbError(error.message, error.code);
  return data as Directory;
}

// ---------------------------------------------------------------------------------------------------------------- home, attendance, homework
export const loadMarks = (sb: PortalDb, studentId: string, since: string): Promise<(Mark & { note: string | null })[]> =>
  list(C(sb).from('student_attendance_marks').select('date, status, note').eq('student_id', studentId).eq('session_key', 'day').is('deleted_at', null).gte('date', since).order('date', { ascending: false }).limit(400));

export interface Post { id: string; type: string; title: string; body: string | null; due_date: string | null; published_at: string | null; subject_id: string | null; student_id: string | null; allow_submission: boolean; max_marks: number | null }
export interface Submission { post_id: string; body: string | null; submitted_at: string; late: boolean; marks: number | null; feedback: string | null }
export async function loadHomework(sb: PortalDb, child: { id: string; section_id: string | null }) {
  const filter = child.section_id ? `section_id.eq.${child.section_id},student_id.eq.${child.id}` : `student_id.eq.${child.id}`;
  const [posts, subjects, subs] = await Promise.all([
    list<Post>(C(sb).from('class_posts').select('id, type, title, body, due_date, published_at, subject_id, student_id, allow_submission, max_marks').eq('status', 'published').is('deleted_at', null).or(filter).order('published_at', { ascending: false }).limit(60)),
    list<{ id: string; name: string }>(C(sb).from('subjects').select('id, name')),
    list<Submission>(E(sb).from('post_submissions').select('post_id, body, submitted_at, late, marks, feedback').eq('student_id', child.id).is('deleted_at', null)),
  ]);
  return { posts, subjects: Object.fromEntries(subjects.map((s) => [s.id, s.name])) as Record<string, string>, submissions: Object.fromEntries(subs.map((s) => [s.post_id, s])) as Record<string, Submission> };
}
export async function submitHomework(sb: PortalDb, orgId: string, post: { id: string; due_date: string | null }, studentId: string, body: string, today: string): Promise<void> {
  await write(E(sb).from('post_submissions').insert({ org_id: orgId, post_id: post.id, student_id: studentId, body, late: Boolean(post.due_date && post.due_date < today) }));
}

export interface PeriodRow { seq: number; label: string; start: string | null; subject: string | null }
/** Today's lessons of the child's section from the published timetable, with period start times from the bell schedule. */
export async function loadTimetable(sb: PortalDb, sectionId: string | null, isoWeekday: number): Promise<PeriodRow[]> {
  if (!sectionId) return [];
  const versions = await list<{ id: string }>(C(sb).from('timetable_versions').select('id').eq('status', 'published').is('deleted_at', null));
  if (!versions.length) return [];
  const [entries, periods, subjects] = await Promise.all([
    list<{ period_seq: number; subject_id: string | null; fixed_label: string | null }>(C(sb).from('timetable_entries').select('period_seq, subject_id, fixed_label').in('version_id', versions.map((v) => v.id)).eq('section_id', sectionId).eq('day', isoWeekday).is('deleted_at', null).order('period_seq')),
    list<{ seq: number; label: string; starts_at: string | null; kind: string }>(C(sb).from('periods').select('seq, label, starts_at, kind').is('deleted_at', null)),
    list<{ id: string; name: string }>(C(sb).from('subjects').select('id, name')),
  ]);
  const subj = new Map(subjects.map((s) => [s.id, s.name]));
  const per = new Map(periods.map((p) => [p.seq, p]));
  return entries.map((e) => ({ seq: e.period_seq, label: per.get(e.period_seq)?.label ?? `P${e.period_seq}`, start: per.get(e.period_seq)?.starts_at ?? null, subject: e.fixed_label ?? (e.subject_id ? subj.get(e.subject_id) ?? null : null) }));
}

// ---------------------------------------------------------------------------------------------------------------- fees
export interface ReceiptRow { id: string; receipt_no: string; date: string; total: number | string; status: string }
export interface OrderRow { id: string; amount: number | string; status: string; created_at: string; allocations: PaymentAllocation[] }
export async function loadFees(sb: PortalDb, studentId: string) {
  const [dem, heads, receipts, wallet, orders, docs] = await Promise.all([
    list<DemandRow & { head_id: string | null }>(E(sb).from('fee_demands').select('id, student_id, label, amount, concession, fine, paid, due_date, status, head_id').eq('student_id', studentId).neq('status', 'cancelled').is('deleted_at', null).order('due_date')),
    list<{ id: string; name: string }>(E(sb).from('fee_heads').select('id, name')),
    list<ReceiptRow>(E(sb).from('receipts').select('id, receipt_no, date, total, status').eq('student_id', studentId).is('deleted_at', null).order('date', { ascending: false }).limit(40)),
    list<{ balance: number | string }>(E(sb).from('student_wallets').select('balance').eq('student_id', studentId).limit(1)),
    list<OrderRow>(E(sb).from('payment_orders').select('id, amount, status, created_at, allocations').eq('student_id', studentId).eq('status', 'created').order('created_at', { ascending: false }).limit(5)),
    list<{ id: string; number: string | null; title: string | null; type: string; verify_code: string | null }>(E(sb).from('issued_documents').select('id, number, title, type, verify_code').eq('student_id', studentId).eq('type', 'fee').is('deleted_at', null)),
  ]);
  const hn = new Map(heads.map((h) => [h.id, h.name]));
  return { demands: dem.map((d) => ({ ...d, head: d.head_id ? hn.get(d.head_id) ?? null : null })) as DemandRow[], receipts, wallet: wallet[0] ? Number(wallet[0].balance) : null, orders, certificates: docs };
}
/** One payment order for the chosen fees of one child. The database checks every amount against the balance. */
export async function createPaymentOrder(sb: PortalDb, studentId: string, allocations: PaymentAllocation[]): Promise<string> {
  const { data, error } = await E(sb).rpc('create_payment_order', { p_student: studentId, p_allocations: allocations });
  if (error) throw new PortalDbError(error.message, error.code);
  return data as string;
}
export const loadOrder = (sb: PortalDb, id: string) => single<OrderRow & { student_id: string; receipt_id: string | null }>(E(sb).from('payment_orders').select('id, student_id, amount, status, created_at, allocations, receipt_id').eq('id', id).maybeSingle());

// ---------------------------------------------------------------------------------------------------------------- academics
export interface CardRow { id: string; term: string; published_at: string | null; verify_code: string | null }
export const loadReportCards = (sb: PortalDb, studentId: string): Promise<CardRow[]> =>
  list(E(sb).from('report_cards').select('id, term, published_at, verify_code').eq('student_id', studentId).eq('status', 'published').is('deleted_at', null).order('published_at', { ascending: false }));
export interface CardFull extends CardRow { snapshot: unknown; class_teacher_remark: string | null; principal_remark: string | null; section_id: string | null }
/** Opens a published report card through `erp.open_report_card`, which counts the view and writes it to the audit log. */
export async function openReportCard(sb: PortalDb, id: string): Promise<CardFull> {
  const { data, error } = await E(sb).rpc('open_report_card', { p_id: id });
  if (error) throw new PortalDbError(error.message, error.code);
  return data as CardFull;
}
export async function loadResults(sb: PortalDb, studentId: string): Promise<ResultRow[]> {
  const { data, error } = await E(sb).rpc('portal_results', { p_student: studentId });
  if (error) throw new PortalDbError(error.message, error.code);
  return ((data ?? []) as (ResultRow & { held_on: string | null })[]);
}
export const loadGrowth = (sb: PortalDb, studentId: string) =>
  list<{ id: string; type: string | null; title: string | null; note: string | null; date: string }>(E(sb).from('growth_records').select('id, type, title, note, date').eq('student_id', studentId).is('deleted_at', null).order('date', { ascending: false }).limit(10));

// ---------------------------------------------------------------------------------------------------------------- bus
export interface StopRow { id: string; name: string; sort: number; lat: number | null; lng: number | null; pickup_time: string | null }
export interface EventRow { id: string; type: string; at: string; note: string | null }
export async function loadBus(sb: PortalDb, studentId: string, routeId: string | null, today: string) {
  if (!routeId) return { trip: null, trail: [], stops: [], events: [] };
  const [trips, stops, events] = await Promise.all([
    list<TripRow & { route_id: string; date: string }>(E(sb).from('trips').select('id, status, direction, delay_minutes, last_lat, last_lng, last_at, started_at, route_id, date').eq('route_id', routeId).eq('date', today).is('deleted_at', null).order('started_at', { ascending: false }).limit(1)),
    list<StopRow>(E(sb).from('stops').select('id, name, sort, lat, lng, pickup_time').eq('route_id', routeId).is('deleted_at', null).order('sort')),
    list<EventRow>(E(sb).from('trip_events').select('id, type, at, note').eq('student_id', studentId).gte('at', `${today}T00:00:00+05:30`).order('at', { ascending: false }).limit(10)),
  ]);
  const trip = trips[0] ?? null;
  const trail = trip ? await list<{ lat: number; lng: number; at: string }>(E(sb).from('trip_positions').select('lat, lng, at').eq('trip_id', trip.id).order('at', { ascending: false }).limit(40)) : [];
  return { trip, trail: trail.reverse(), stops, events };
}

// ---------------------------------------------------------------------------------------------------------------- messages
export interface Circular { id: string; title: string; body: string | null; requires_ack: boolean; status: string; read_at: string | null; ack_at: string | null; created_at: string }
export const loadCirculars = (sb: PortalDb, userId: string) =>
  list<Circular>(E(sb).from('announcement_recipients').select('id, title, body, requires_ack, status, read_at, ack_at, created_at').eq('user_id', userId).is('deleted_at', null).order('created_at', { ascending: false }).limit(50));
export const markCircular = (sb: PortalDb, id: string, ack: boolean) =>
  write(E(sb).from('announcement_recipients').update({ status: 'read', read_at: new Date().toISOString(), ...(ack ? { ack_at: new Date().toISOString() } : {}) }).eq('id', id));
export interface Conversation { id: string; subject: string; student_id: string | null; with_role: string; status: string; messages: { id: string; sender: string | null; sender_name: string | null; body: string; at: string }[]; lastAt: string }
export async function loadConversations(sb: PortalDb): Promise<Conversation[]> {
  const [convs, msgs] = await Promise.all([
    list<Omit<Conversation, 'messages' | 'lastAt'> & { last_message_at: string }>(E(sb).from('conversations').select('id, subject, student_id, with_role, status, last_message_at').is('deleted_at', null).limit(60)),
    list<{ id: string; conversation_id: string; sender: string | null; sender_name: string | null; body: string; at: string }>(E(sb).from('conversation_messages').select('id, conversation_id, sender, sender_name, body, at').is('deleted_at', null).order('at').limit(1000)),
  ]);
  return convs.map((c) => {
    const messages = msgs.filter((m) => m.conversation_id === c.id);
    return { ...c, messages, lastAt: messages[messages.length - 1]?.at ?? c.last_message_at };
  }).sort((a, b) => b.lastAt.localeCompare(a.lastAt));
}
export async function startConversation(sb: PortalDb, orgId: string, a: { subject: string; studentId: string; withRole: string; name: string; body: string }): Promise<string> {
  const c = await single<{ id: string }>(E(sb).from('conversations').insert({ org_id: orgId, subject: a.subject, student_id: a.studentId, parent_name: a.name, with_role: a.withRole }).select('id').single());
  if (!c) throw new PortalDbError('no row');
  await write(E(sb).from('conversation_messages').insert({ org_id: orgId, conversation_id: c.id, sender_name: a.name, body: a.body }));
  return c.id;
}
export const replyConversation = (sb: PortalDb, orgId: string, conversationId: string, name: string, body: string) =>
  write(E(sb).from('conversation_messages').insert({ org_id: orgId, conversation_id: conversationId, sender_name: name, body }));

// ---------------------------------------------------------------------------------------------------------------- requests
export interface LeaveRow { id: string; start_date: string; end_date: string; days: number | null; reason: string | null; status: string; created_at: string }
export interface TicketRow { id: string; title: string; description: string | null; status: string; created_at: string; payload: { kind?: string } | null }
export interface DocRow { id: string; type: string; number: string | null; title: string | null; verify_code: string | null; issued_on: string | null; status: string | null }
export async function loadRequests(sb: PortalDb, studentId: string) {
  const [leaves, tickets, docs] = await Promise.all([
    list<LeaveRow>(C(sb).from('student_leave_requests').select('id, start_date, end_date, days, reason, status, created_at').eq('student_id', studentId).is('deleted_at', null).order('created_at', { ascending: false }).limit(20)),
    list<TicketRow>(C(sb).from('tickets').select('id, title, description, status, created_at, payload').eq('student_id', studentId).is('deleted_at', null).order('created_at', { ascending: false }).limit(20)),
    list<DocRow>(E(sb).from('issued_documents').select('id, type, number, title, verify_code, issued_on, status').eq('student_id', studentId).is('deleted_at', null).order('issued_on', { ascending: false }).limit(20)),
  ]);
  return { leaves, tickets, docs };
}
/** Leave for a child: a pending row the class teacher decides on (the school's leave screen lists it). */
export const requestLeave = (sb: PortalDb, orgId: string, a: { studentId: string; from: string; to: string; reason: string; days: number }) =>
  write(C(sb).from('student_leave_requests').insert({ org_id: orgId, student_id: a.studentId, start_date: a.from, end_date: a.to, days: a.days, reason: a.reason, status: 'pending' }));
/** Certificates and concerns are helpdesk tickets (source portal) so the office sees them in the same queue as everything else. */
export const raiseTicket = (sb: PortalDb, orgId: string, a: { studentId: string; branchId: string | null; title: string; description: string; kind: 'certificate' | 'concern'; name: string; certType?: string }) =>
  write(C(sb).from('tickets').insert({ org_id: orgId, branch_id: a.branchId, product_key: 'erp', title: a.title, description: a.description, student_id: a.studentId, raised_by_name: a.name, source: 'portal', payload: { kind: a.kind, certificate: a.certType ?? null } }));

// ---------------------------------------------------------------------------------------------------------------- forms
export interface FormRow { id: string; title: string; description: string | null; fields: unknown; closes_on: string | null; anonymous: boolean }
export async function loadForms(sb: PortalDb, userId: string) {
  const [forms, done] = await Promise.all([
    list<FormRow>(E(sb).from('forms').select('id, title, description, fields, closes_on, anonymous').eq('status', 'published').is('deleted_at', null).order('created_at', { ascending: false })),
    list<{ form_id: string; student_id: string | null }>(E(sb).from('form_responses').select('form_id, student_id').eq('user_id', userId).is('deleted_at', null)),
  ]);
  return { forms, done: new Set(done.map((d) => d.form_id)) };
}
export const submitForm = (sb: PortalDb, orgId: string, formId: string, studentId: string | null, answers: Record<string, unknown>) =>
  write(E(sb).from('form_responses').insert({ org_id: orgId, form_id: formId, student_id: studentId, answers }));

// ---------------------------------------------------------------------------------------------------------------- events, PTM, appointments
export interface CalEvent { id: string; layer: string; title: string; description: string | null; starts_on: string; ends_on: string | null }
export interface SchoolEvent { id: string; name: string; type: string | null; event_date: string | null; venue: string | null; registration_open: boolean; fee: number | null; consent_required: boolean }
export async function loadCalendar(sb: PortalDb, studentId: string, today: string) {
  const [cal, events, regs] = await Promise.all([
    list<CalEvent>(C(sb).from('calendar_events').select('id, layer, title, description, starts_on, ends_on').in('audience', ['families', 'all']).is('deleted_at', null).gte('starts_on', today).order('starts_on').limit(60)),
    list<SchoolEvent>(C(sb).from('events').select('id, name, type, event_date, venue, registration_open, fee, consent_required').is('deleted_at', null).gte('event_date', today).order('event_date').limit(30)),
    list<{ event_id: string; status: string }>(E(sb).from('event_registrations').select('event_id, status').eq('student_id', studentId).is('deleted_at', null)),
  ]);
  return { cal, events, registered: new Set(regs.filter((r) => r.status !== 'cancelled').map((r) => r.event_id)) };
}
export const registerEvent = (sb: PortalDb, orgId: string, eventId: string, studentId: string, consent: boolean) =>
  write(E(sb).from('event_registrations').insert({ org_id: orgId, event_id: eventId, student_id: studentId, status: consent ? 'consented' : 'registered' }));
export interface Slot { id: string; staff_id: string; date: string; start_time: string; end_time: string | null; mode: string; status: string; student_id: string | null; feedback: string | null }
export interface Appointment { id: string; with_role: string; reason: string | null; preferred_at: string | null; status: string }
export async function loadPtm(sb: PortalDb, studentId: string, today: string) {
  const [slots, appts] = await Promise.all([
    list<Slot>(E(sb).from('ptm_slots').select('id, staff_id, date, start_time, end_time, mode, status, student_id, feedback').gte('date', today).is('deleted_at', null).order('date').order('start_time').limit(120)),
    list<Appointment>(E(sb).from('appointments').select('id, with_role, reason, preferred_at, status').eq('student_id', studentId).is('deleted_at', null).order('created_at', { ascending: false }).limit(10)),
  ]);
  return { open: slots.filter((s) => s.status === 'open'), mine: slots.filter((s) => s.student_id === studentId), appts };
}
export async function bookPtmSlot(sb: PortalDb, slotId: string, studentId: string): Promise<void> {
  const { error } = await E(sb).rpc('book_ptm_slot', { p_slot: slotId, p_student: studentId });
  if (error) throw new PortalDbError(error.message, error.code);
}
export const requestAppointment = (sb: PortalDb, orgId: string, a: { studentId: string; withRole: 'principal' | 'counsellor'; reason: string; preferredAt: string | null; name: string }) =>
  write(E(sb).from('appointments').insert({ org_id: orgId, student_id: a.studentId, with_role: a.withRole, reason: a.reason, preferred_at: a.preferredAt, requested_by_name: a.name }));

// ---------------------------------------------------------------------------------------------------------------- pickup (gate pass)
export interface GatePass { id: string; status: string; reason: string | null; collector_name: string | null; pickup_time: string | null; created_at: string }
export async function loadPickup(sb: PortalDb, studentId: string) {
  const [passes, people] = await Promise.all([
    list<GatePass>(E(sb).from('gate_passes').select('id, status, reason, collector_name, pickup_time, created_at').eq('student_id', studentId).eq('type', 'early_pickup').is('deleted_at', null).order('created_at', { ascending: false }).limit(10)),
    list<{ id: string; name: string; relation: string | null }>(E(sb).from('pickup_persons').select('id, name, relation').eq('student_id', studentId).eq('active', true).is('deleted_at', null)),
  ]);
  return { passes, people };
}
export async function requestGatePass(sb: PortalDb, a: { studentId: string; reason: string; collectorName: string | null; collectorPhone: string | null; pickupPerson: string | null; pickupTime: string | null }): Promise<string> {
  const { data, error } = await E(sb).rpc('request_gate_pass', { p_student: a.studentId, p_reason: a.reason, p_collector_name: a.collectorName, p_collector_phone: a.collectorPhone, p_pickup_person: a.pickupPerson, p_pickup_time: a.pickupTime });
  if (error) throw new PortalDbError(error.message, error.code);
  return data as string;
}
export async function loadPickupCode(sb: PortalDb, passId: string): Promise<string | null> {
  const { data, error } = await E(sb).rpc('my_gate_pass_otp', { p_pass: passId });
  if (error) throw new PortalDbError(error.message, error.code);
  return (data as string | null) ?? null;
}

// ---------------------------------------------------------------------------------------------------------------- more
export async function loadConsents(sb: PortalDb): Promise<Record<string, Record<string, string>>> {
  const { data, error } = await E(sb).rpc('portal_consents');
  if (error) throw new PortalDbError(error.message, error.code);
  return (data ?? {}) as Record<string, Record<string, string>>;
}
export async function setConsent(sb: PortalDb, channel: string, purpose: string, status: 'opted_in' | 'opted_out'): Promise<void> {
  const { error } = await E(sb).rpc('portal_set_consent', { p_channel: channel, p_purpose: purpose, p_status: status });
  if (error) throw new PortalDbError(error.message, error.code);
}
export const loadNotifications = (sb: PortalDb, userId: string) =>
  list<{ id: string; title: string; body: string | null; created_at: string; read_at: string | null; link: string | null }>(C(sb).from('notifications').select('id, title, body, created_at, read_at, link').eq('user_id', userId).is('deleted_at', null).order('created_at', { ascending: false }).limit(15));

// ---------------------------------------------------------------------------------------------------------------- student: online tests
export interface TestRow { id: string; title: string; duration_min: number | null; starts_at: string | null; ends_at: string | null; status: string; is_diagnostic: boolean; subject_id: string | null }
export async function loadTests(sb: PortalDb, studentId: string) {
  const [tests, attempts, subjects] = await Promise.all([
    list<TestRow>(E(sb).from('online_tests').select('id, title, duration_min, starts_at, ends_at, status, is_diagnostic, subject_id').eq('status', 'live').is('deleted_at', null).order('starts_at', { ascending: false })),
    list<{ test_id: string; score: number | string | null; max_score: number | string | null; submitted_at: string | null; tab_switches: number }>(E(sb).from('test_attempts').select('test_id, score, max_score, submitted_at, tab_switches').eq('student_id', studentId).is('deleted_at', null)),
    list<{ id: string; name: string }>(C(sb).from('subjects').select('id, name')),
  ]);
  return { tests, attempts: Object.fromEntries(attempts.map((a) => [a.test_id, a])), subjects: Object.fromEntries(subjects.map((s) => [s.id, s.name])) as Record<string, string> };
}
export async function loadTestQuestions(sb: PortalDb, testId: string): Promise<TestQuestion[]> {
  const { data, error } = await E(sb).rpc('get_test_questions', { p_test: testId });
  if (error) throw new PortalDbError(error.message, error.code);
  return (data ?? []) as TestQuestion[];
}
export async function submitTest(sb: PortalDb, testId: string, studentId: string, answers: Record<string, string>, tabSwitches: number): Promise<{ score: number; max: number }> {
  const { data, error } = await E(sb).rpc('submit_test', { p_test: testId, p_student: studentId, p_answers: answers, p_tab_switches: tabSwitches });
  if (error) throw new PortalDbError(error.message, error.code);
  return data as { score: number; max: number };
}

// ---------------------------------------------------------------------------------------------------------------- driver and attendant
export interface DriverRoute { id: string; name: string; vehicle: string | null; running_trip: string | null }
export interface DriverStudent { student_id: string; name: string; stop: string | null; sort: number; last_event: string | null }
async function rpc<T>(sb: PortalDb, fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await E(sb).rpc(fn, args);
  if (error) throw new PortalDbError(error.message, error.code);
  return data as T;
}
export const driverRoutes = (sb: PortalDb) => rpc<DriverRoute[]>(sb, 'driver_routes');
export const driverStart = (sb: PortalDb, route: string, direction: 'pickup' | 'drop' | 'special') => rpc<string>(sb, 'driver_trip_start', { p_route: route, p_direction: direction });
export const driverStudents = (sb: PortalDb, trip: string) => rpc<DriverStudent[]>(sb, 'driver_trip_students', { p_trip: trip });
export const driverMark = (sb: PortalDb, trip: string, student: string | null, type: 'boarded' | 'dropped' | 'absent' | 'sos' | 'delay', pos?: { lat: number; lng: number } | null, note?: string | null) =>
  rpc<null>(sb, 'driver_mark', { p_trip: trip, p_student: student, p_type: type, p_lat: pos?.lat ?? null, p_lng: pos?.lng ?? null, p_note: note ?? null });
export const driverPosition = (sb: PortalDb, trip: string, lat: number, lng: number, speedKmh: number | null) => rpc<null>(sb, 'driver_position', { p_trip: trip, p_lat: lat, p_lng: lng, p_speed: speedKmh });
export const driverEnd = (sb: PortalDb, trip: string) => rpc<null>(sb, 'driver_trip_end', { p_trip: trip });
export const loadTrip = (sb: PortalDb, id: string) => single<TripRow>(E(sb).from('trips').select('id, status, direction, delay_minutes, last_lat, last_lng, last_at, started_at').eq('id', id).maybeSingle());

// ---------------------------------------------------------------------------------------------------------------- gate (collector check, staff on duty)
export interface GatePassRow { id: string; student_id: string; collector_name: string | null; collector_phone: string | null; pickup_time: string | null; reason: string | null }
export async function loadGatePasses(sb: PortalDb) {
  const passes = await list<GatePassRow>(E(sb).from('gate_passes').select('id, student_id, collector_name, collector_phone, pickup_time, reason').eq('status', 'approved').is('deleted_at', null).order('pickup_time', { nullsFirst: false }).limit(50));
  const ids = [...new Set(passes.map((p) => p.student_id))];
  const names = ids.length ? await list<{ id: string; full_name: string | null; first_name: string }>(C(sb).from('students').select('id, full_name, first_name').in('id', ids)) : [];
  const nm = new Map(names.map((n) => [n.id, n.full_name || n.first_name]));
  return passes.map((p) => ({ ...p, student: nm.get(p.student_id) ?? '' }));
}
export const verifyGatePass = (sb: PortalDb, passId: string, otp: string) => rpc<'ok' | 'mismatch'>(sb, 'verify_gate_pass', { p_pass: passId, p_otp: otp });
