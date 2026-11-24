/**
 * Pure rules of the parent / student / driver portals (web `apps/web/app/erp/(portal)` and the Expo app `mobile-parent`).
 * No I/O, no framework: everything here is unit-tested in packages/shared/test/erp-portal.test.ts.
 */

// ---------------------------------------------------------------------------------------------------------------- language
export const PORTAL_LANGS = ['en', 'hi', 'te'] as const;
export type PortalLang = (typeof PORTAL_LANGS)[number];
export const isPortalLang = (x: unknown): x is PortalLang => typeof x === 'string' && (PORTAL_LANGS as readonly string[]).includes(x);
/** The language of a guardian row (`core.guardians.language`) or of the phone, falling back to English. */
export function pickLanguage(saved: unknown, ...hints: unknown[]): PortalLang {
  for (const h of [saved, ...hints]) {
    if (isPortalLang(h)) return h;
    if (typeof h === 'string') {
      const base = h.toLowerCase().split(/[-_]/)[0];
      if (isPortalLang(base)) return base;
    }
  }
  return 'en';
}

// ---------------------------------------------------------------------------------------------------------------- money, dates
/** Indian digit grouping (12,34,567.50) without a currency font dependency. */
export function inr(n: number | string | null | undefined, opts: { paise?: boolean } = {}): string {
  const v = Number(n ?? 0);
  if (!Number.isFinite(v)) return '₹0';
  const neg = v < 0;
  const fixed = Math.abs(v).toFixed(opts.paise || !Number.isInteger(Math.round(Math.abs(v) * 100) / 100) ? 2 : 0);
  const [whole = '0', frac] = fixed.split('.');
  const last3 = whole.slice(-3);
  const rest = whole.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}` : last3;
  return `${neg ? '-' : ''}₹${grouped}${frac ? `.${frac}` : ''}`;
}

/** Today's date (YYYY-MM-DD) in India, whatever the device time zone says. */
export function istToday(now: Date = new Date()): string {
  return new Date(now.getTime() + 330 * 60000).toISOString().slice(0, 10);
}
export const addDays = (iso: string, days: number): string => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
export const daysBetween = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);

const LOCALE: Record<PortalLang, string> = { en: 'en-IN', hi: 'hi-IN', te: 'te-IN' };
export function fmtDate(iso: string | null | undefined, lang: PortalLang = 'en', withYear = false): string {
  if (!iso) return '';
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  if (Number.isNaN(d.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat(LOCALE[lang], { day: 'numeric', month: 'short', ...(withYear ? { year: 'numeric' } : {}), timeZone: iso.length === 10 ? 'UTC' : 'Asia/Kolkata' }).format(d);
  } catch {
    return iso.slice(0, 10);
  }
}
export function fmtTime(iso: string | null | undefined, lang: PortalLang = 'en'): string {
  if (!iso) return '';
  const hhmm = /^(\d{2}):(\d{2})/.exec(iso);
  const d = hhmm ? new Date(Date.UTC(2000, 0, 1, Number(hhmm[1]), Number(hhmm[2]))) : new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat(LOCALE[lang], { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: hhmm ? 'UTC' : 'Asia/Kolkata' }).format(d);
  } catch {
    return iso.slice(11, 16);
  }
}

// ---------------------------------------------------------------------------------------------------------------- children
export interface Child { id: string; first_name: string; last_name: string | null; full_name?: string | null; section_id: string | null; branch_id: string | null; status?: string }
export const childName = (c: Pick<Child, 'first_name' | 'last_name' | 'full_name'>): string => (c.full_name || `${c.first_name} ${c.last_name ?? ''}`).trim();
export const initials = (name: string): string => name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('') || '?';
/** The remembered child if it is still one of the family's, else the first. */
export function pickChild<T extends { id: string }>(children: readonly T[], savedId: string | null | undefined): T | null {
  return children.find((c) => c.id === savedId) ?? children[0] ?? null;
}

// ---------------------------------------------------------------------------------------------------------------- fees
export interface DemandRow { id: string; student_id: string; label: string | null; amount: number | string; concession: number | string; fine: number | string; paid: number | string; due_date: string; status: string; head?: string | null }
export const demandTotal = (d: Pick<DemandRow, 'amount' | 'concession' | 'fine'>): number => Number(d.amount) - Number(d.concession) + Number(d.fine);
export const demandBalance = (d: Pick<DemandRow, 'amount' | 'concession' | 'fine' | 'paid'>): number => Math.max(0, Math.round((demandTotal(d) - Number(d.paid)) * 100) / 100);
export const isOpenDemand = (d: Pick<DemandRow, 'status'>): boolean => d.status === 'due' || d.status === 'partial';
export const isOverdue = (d: DemandRow, today: string): boolean => isOpenDemand(d) && d.due_date < today && demandBalance(d) > 0;
export type DemandState = 'paid' | 'overdue' | 'due' | 'partial' | 'closed';
export function demandState(d: DemandRow, today: string): DemandState {
  if (d.status === 'paid' || (isOpenDemand(d) && demandBalance(d) === 0)) return 'paid';
  if (!isOpenDemand(d)) return 'closed';
  if (isOverdue(d, today)) return 'overdue';
  return d.status === 'partial' ? 'partial' : 'due';
}
export function feeSummary(demands: readonly DemandRow[], today: string) {
  const open = demands.filter((d) => isOpenDemand(d) && demandBalance(d) > 0);
  return {
    due: open.reduce((s, d) => s + demandBalance(d), 0),
    overdue: open.filter((d) => d.due_date < today).reduce((s, d) => s + demandBalance(d), 0),
    paid: demands.filter((d) => d.status !== 'cancelled').reduce((s, d) => s + Number(d.paid), 0),
    openCount: open.length,
    nextDue: open.map((d) => d.due_date).sort()[0] ?? null,
  };
}
export interface PaymentAllocation { demand_id: string; amount: number }
/** Allocations for `erp.create_payment_order`: the full balance of each selected open demand, never more. */
export function allocationsFor(demands: readonly DemandRow[], selected: ReadonlySet<string> | readonly string[]): PaymentAllocation[] {
  const set = new Set(selected);
  return demands.filter((d) => set.has(d.id) && isOpenDemand(d) && demandBalance(d) > 0).map((d) => ({ demand_id: d.id, amount: demandBalance(d) }));
}
export const allocationTotal = (a: readonly PaymentAllocation[]): number => Math.round(a.reduce((s, x) => s + x.amount, 0) * 100) / 100;

// ---------------------------------------------------------------------------------------------------------------- attendance
export type MarkStatus = 'present' | 'absent' | 'late' | 'half_day' | 'on_leave' | 'on_duty';
export interface Mark { date: string; status: MarkStatus | string }
export function attendanceSummary(marks: readonly Mark[]) {
  const c = { present: 0, absent: 0, late: 0, half_day: 0, on_leave: 0, on_duty: 0 };
  for (const m of marks) if (m.status in c) c[m.status as MarkStatus] += 1;
  const total = marks.length;
  // present, late, half-day and on-duty count as attended; leave is neither (it is excused, not attended)
  const attended = c.present + c.late + c.on_duty + c.half_day * 0.5;
  const counted = total - c.on_leave;
  return { ...c, total, attended, percent: counted > 0 ? Math.round((attended / counted) * 1000) / 10 : null };
}
export const attendanceTone = (status: string | null | undefined): 'good' | 'bad' | 'warn' | 'info' | 'none' =>
  status === 'present' || status === 'on_duty' ? 'good' : status === 'absent' ? 'bad' : status === 'late' || status === 'half_day' ? 'warn' : status === 'on_leave' ? 'info' : 'none';
/** A month as weeks (Monday first) for the calendar grid; days outside the month are null. */
export function monthGrid(year: number, month1: number, byDate: Readonly<Record<string, string>>): { date: string; day: number; status: string | null }[][] {
  const first = new Date(Date.UTC(year, month1 - 1, 1));
  const days = new Date(Date.UTC(year, month1, 0)).getUTCDate();
  const lead = (first.getUTCDay() + 6) % 7;
  const cells: ({ date: string; day: number; status: string | null } | null)[] = Array.from({ length: lead }, () => null);
  for (let d = 1; d <= days; d++) {
    const date = `${year}-${String(month1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    cells.push({ date, day: d, status: byDate[date] ?? null });
  }
  while (cells.length % 7) cells.push(null);
  const weeks: typeof cells[] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks as { date: string; day: number; status: string | null }[][];
}

// ---------------------------------------------------------------------------------------------------------------- results
export interface ResultRow { assessment_id: string; name: string; term: string | null; component: string | null; subject: string | null; max_marks: number | string; marks: number | string | null; code: string | null; grade: string | null; held_on: string | null }
export const percentOf = (marks: number | string | null, max: number | string): number | null => (marks === null || marks === undefined || Number(max) <= 0 ? null : Math.round((Number(marks) / Number(max)) * 1000) / 10);
export function resultsByTerm(rows: readonly ResultRow[]) {
  const terms = new Map<string, Map<string, { name: string; marks: number; max: number; rows: ResultRow[] }>>();
  for (const r of rows) {
    const term = r.term ?? '';
    const subject = r.subject ?? '';
    const t = terms.get(term) ?? new Map();
    const s = t.get(subject) ?? { name: subject, marks: 0, max: 0, rows: [] };
    if (r.marks !== null && !r.code) { s.marks += Number(r.marks); s.max += Number(r.max_marks); }
    s.rows.push(r);
    t.set(subject, s);
    terms.set(term, t);
  }
  return [...terms.entries()].map(([term, subjects]) => ({
    term,
    subjects: [...subjects.values()].map((s) => ({ ...s, percent: s.max > 0 ? Math.round((s.marks / s.max) * 1000) / 10 : null })),
  }));
}

/** The published report card's snapshot (written by the ERP when marks are published), read defensively: it is JSON from the school. */
export interface CardSnapshot {
  student: { name: string; admission_no: string | null }; section: string; term: string; year: string;
  subjects: { name: string; percent: number | null; grade: string | null; pass: boolean | null; absent: boolean; parts: { name: string; marks: string; max: number }[] }[];
  overall: number | null; overall_grade: string | null; rank: number | null; class_size: number | null;
  attendance: { present: number; total: number; percent: number | null } | null;
}
export function readSnapshot(raw: unknown): CardSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.subjects)) return null;
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const stu = (r.student ?? {}) as Record<string, unknown>;
  const att = r.attendance as Record<string, unknown> | null | undefined;
  return {
    student: { name: str(stu.name), admission_no: typeof stu.admission_no === 'string' ? stu.admission_no : null },
    section: str(r.section), term: str(r.term), year: str(r.year),
    subjects: (r.subjects as Record<string, unknown>[]).map((s) => ({
      name: str(s.name), percent: num(s.percent), grade: typeof s.grade === 'string' ? s.grade : null, pass: typeof s.pass === 'boolean' ? s.pass : null, absent: s.absent === true,
      parts: Array.isArray(s.parts) ? (s.parts as Record<string, unknown>[]).map((p) => ({ name: str(p.name), marks: String(p.marks ?? '-'), max: num(p.max) ?? 0 })) : [],
    })),
    overall: num(r.overall), overall_grade: typeof r.overall_grade === 'string' ? r.overall_grade : null, rank: num(r.rank), class_size: num(r.class_size),
    attendance: att && typeof att === 'object' ? { present: num(att.present) ?? 0, total: num(att.total) ?? 0, percent: num(att.percent) } : null,
  };
}
/** The public check page for a report card or certificate (QR link). `origin` is the school's web address. */
export const verifyUrl = (origin: string, code: string): string => `${origin.replace(/\/+$/, '')}/erp/verify/${encodeURIComponent(code)}`;

// ---------------------------------------------------------------------------------------------------------------- branding (decision 46)
export interface Branding { name: string; primary: string; accent: string; onPrimary: string; tagline: string | null; logoFileId: string | null }
const HEX = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i;
export function normaliseHex(v: unknown, fallback: string): string {
  if (typeof v !== 'string' || !HEX.test(v.trim())) return fallback;
  let h = v.trim().replace('#', '').toLowerCase();
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return `#${h}`;
}
export function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
}
export const contrastRatio = (a: string, b: string): number => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi! + 0.05) / (lo! + 0.05); };
/** White or near-black text, whichever reads better on the colour (WCAG contrast). */
export const onColour = (hex: string): string => (contrastRatio(hex, '#ffffff') >= contrastRatio(hex, '#111827') ? '#ffffff' : '#111827');
export const DEFAULT_BRAND = { primary: '#1d4ed8', accent: '#f59e0b' } as const;
/** A school's name and colours from `core.organizations` (name, branding jsonb, logo_file_id). A bad or missing colour falls back; a primary that cannot carry text is darkened. */
export function resolveBranding(org: { name?: string | null; branding?: unknown; logo_file_id?: string | null } | null | undefined): Branding {
  const b = (org?.branding && typeof org.branding === 'object' ? org.branding : {}) as Record<string, unknown>;
  let primary = normaliseHex(b.primary ?? b.primary_color ?? b.color, DEFAULT_BRAND.primary);
  const accent = normaliseHex(b.accent ?? b.accent_color ?? b.secondary, DEFAULT_BRAND.accent);
  // buttons are filled with the primary: if neither white nor dark text reaches 4.5:1, use the default instead of an unreadable button
  if (contrastRatio(primary, onColour(primary)) < 4.5) primary = DEFAULT_BRAND.primary;
  return {
    name: (org?.name ?? '').trim() || 'School', primary, accent, onPrimary: onColour(primary),
    tagline: typeof b.tagline === 'string' && b.tagline.trim() ? b.tagline.trim().slice(0, 80) : null, logoFileId: org?.logo_file_id ?? null,
  };
}

// ---------------------------------------------------------------------------------------------------------------- bus
export interface TripRow { id: string; status: string; direction: string; delay_minutes: number | null; last_lat: number | string | null; last_lng: number | string | null; last_at: string | null; started_at: string | null }
/** A position older than this is shown as "last seen", not "live". */
export const LIVE_WINDOW_MS = 3 * 60000;
export function tripState(t: TripRow | null | undefined, now = Date.now()): 'none' | 'running_live' | 'running_stale' | 'completed' {
  if (!t) return 'none';
  if (t.status === 'completed') return 'completed';
  if (t.status !== 'running') return 'none';
  return t.last_at && now - Date.parse(t.last_at) <= LIVE_WINDOW_MS ? 'running_live' : 'running_stale';
}
export function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371;
  const rad = (x: number) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
/** Rough minutes to the child's stop at the last reported speed (or 20 km/h in town if the bus is slow or still). */
export function etaMinutes(bus: { lat: number; lng: number; speed?: number | null }, stop: { lat: number; lng: number }): number {
  const kmh = Math.max(Number(bus.speed ?? 0), 20);
  return Math.max(1, Math.round((haversineKm(bus, stop) / kmh) * 60));
}
/** A static map link that needs no key: OpenStreetMap with a marker. */
export const mapLink = (lat: number, lng: number): string => `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=16/${lat}/${lng}`;
export const mapEmbed = (lat: number, lng: number): string => {
  const d = 0.004;
  return `https://www.openstreetmap.org/export/embed.html?bbox=${lng - d}%2C${lat - d}%2C${lng + d}%2C${lat + d}&layer=mapnik&marker=${lat}%2C${lng}`;
};

// ---------------------------------------------------------------------------------------------------------------- forms (erp.forms.fields)
export interface FormField { key: string; label: string; type: 'text' | 'textarea' | 'number' | 'date' | 'select' | 'yesno' | 'rating'; required: boolean; options: string[] }
const FIELD_TYPES = ['text', 'textarea', 'number', 'date', 'select', 'yesno', 'rating'];
export function readFormFields(raw: unknown): FormField[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((f, i): FormField[] => {
    if (!f || typeof f !== 'object') return [];
    const r = f as Record<string, unknown>;
    const label = typeof r.label === 'string' ? r.label : typeof r.name === 'string' ? r.name : '';
    if (!label) return [];
    const type = (FIELD_TYPES.includes(String(r.type)) ? r.type : 'text') as FormField['type'];
    return [{
      key: String(r.key ?? r.id ?? `f${i + 1}`), label, type, required: r.required === true,
      options: Array.isArray(r.options) ? r.options.map(String) : typeof r.options === 'string' ? r.options.split(/[,|]/).map((s) => s.trim()).filter(Boolean) : [],
    }];
  });
}
export function validateAnswers(fields: readonly FormField[], answers: Readonly<Record<string, unknown>>): Record<string, 'required' | 'number' | 'option'> {
  const errors: Record<string, 'required' | 'number' | 'option'> = {};
  for (const f of fields) {
    const v = answers[f.key];
    const empty = v === undefined || v === null || String(v).trim() === '';
    if (empty) { if (f.required) errors[f.key] = 'required'; continue; }
    if (f.type === 'number' && !Number.isFinite(Number(v))) errors[f.key] = 'number';
    if ((f.type === 'select') && f.options.length && !f.options.includes(String(v))) errors[f.key] = 'option';
  }
  return errors;
}

// ---------------------------------------------------------------------------------------------------------------- online tests
export interface TestQuestion { id: string; question: string; type: string; options: string[] | null; marks: number }
export const answeredCount = (qs: readonly TestQuestion[], answers: Readonly<Record<string, string>>): number => qs.filter((q) => (answers[q.id] ?? '').trim() !== '').length;
export const secondsLeft = (startedAtMs: number, durationMin: number, nowMs: number): number => Math.max(0, Math.round((startedAtMs + durationMin * 60000 - nowMs) / 1000));
export const clock = (sec: number): string => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
/** The tab-switch logger: counts each time the page is hidden (visibility change or window blur), once per hide, not per event. */
export function makeSwitchCounter() {
  let hidden = false;
  let n = 0;
  return {
    hide() { if (!hidden) { hidden = true; n += 1; } },
    show() { hidden = false; },
    get count() { return n; },
  };
}
export const testWindow = (t: { starts_at: string | null; ends_at: string | null; status: string }, now = Date.now()): 'open' | 'upcoming' | 'closed' =>
  t.status !== 'live' ? 'closed' : t.starts_at && Date.parse(t.starts_at) > now ? 'upcoming' : t.ends_at && Date.parse(t.ends_at) < now ? 'closed' : 'open';

// ---------------------------------------------------------------------------------------------------------------- next actions (home)
export type ActionKey = 'pay_overdue' | 'pickup_otp' | 'unread' | 'test_open' | 'homework_due' | 'ptm_open';
export interface ActionInput { overdue: number; approvedPasses: number; unread: number; openTests: number; homeworkDueSoon: number; openPtmSlots: number; bookedPtm: boolean }
export function nextActions(i: ActionInput): { key: ActionKey; count: number; href: string }[] {
  const out: { key: ActionKey; count: number; href: string }[] = [];
  if (i.overdue > 0) out.push({ key: 'pay_overdue', count: i.overdue, href: 'fees' });
  if (i.approvedPasses > 0) out.push({ key: 'pickup_otp', count: i.approvedPasses, href: 'pickup' });
  if (i.unread > 0) out.push({ key: 'unread', count: i.unread, href: 'messages' });
  if (i.homeworkDueSoon > 0) out.push({ key: 'homework_due', count: i.homeworkDueSoon, href: 'homework' });
  if (i.openTests > 0) out.push({ key: 'test_open', count: i.openTests, href: 'tests' });
  if (i.openPtmSlots > 0 && !i.bookedPtm) out.push({ key: 'ptm_open', count: i.openPtmSlots, href: 'ptm' });
  return out;
}

// ---------------------------------------------------------------------------------------------------------------- offline cache (mobile and PWA)
export interface CacheEnvelope<T> { v: 1; savedAt: number; data: T }
export const wrapCache = <T,>(data: T, now = Date.now()): CacheEnvelope<T> => ({ v: 1, savedAt: now, data });
/** Reads a stored envelope; returns null for anything that is not one. `stale` is true past `maxAgeMs`: show it, but say "last updated". */
export function readCache<T>(raw: string | null | undefined, maxAgeMs = 7 * 86400000, now = Date.now()): { data: T; savedAt: number; stale: boolean } | null {
  if (!raw) return null;
  try {
    const e = JSON.parse(raw) as Partial<CacheEnvelope<T>>;
    if (e?.v !== 1 || typeof e.savedAt !== 'number' || !('data' in e)) return null;
    return { data: e.data as T, savedAt: e.savedAt, stale: now - e.savedAt > maxAgeMs };
  } catch {
    return null;
  }
}
/** Cache key of a screen: scoped to the user and the child so one family never shows another's cached data on a shared phone. */
export const cacheKey = (userId: string, screen: string, childId?: string | null): string => `portal:${userId}:${screen}${childId ? `:${childId}` : ''}`;

// ---------------------------------------------------------------------------------------------------------------- sign-in
/** A phone number as the Auth service wants it: digits with the country code (India by default). */
export function normalisePhone(raw: string, defaultCountry = '91'): string | null {
  const digits = raw.replace(/[^\d]/g, '');
  if (digits.length === 10) return `${defaultCountry}${digits}`;
  if (digits.length === 12 && digits.startsWith(defaultCountry)) return digits;
  if (digits.length === 11 && digits.startsWith('0')) return `${defaultCountry}${digits.slice(1)}`;
  return null;
}
export const isEmail = (s: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s.trim());
/** Phone or e-mail typed into one box. */
export function parseIdentifier(raw: string): { kind: 'phone'; phone: string } | { kind: 'email'; email: string } | null {
  const t = raw.trim();
  if (isEmail(t)) return { kind: 'email', email: t.toLowerCase() };
  const p = normalisePhone(t);
  return p ? { kind: 'phone', phone: p } : null;
}
export type PortalRole = 'parent' | 'student' | 'staff' | 'unknown';
/** Where a signed-in person belongs, from `core.org_users.kind`. */
export const roleOfKind = (kind: string | null | undefined): PortalRole => (kind === 'guardian' || kind === 'parent' ? 'parent' : kind === 'student' ? 'student' : kind === 'staff' || kind === 'support' ? 'staff' : 'unknown');
