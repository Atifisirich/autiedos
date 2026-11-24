import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  inr, istToday, addDays, fmtDate, pickChild, pickLanguage, demandBalance, demandState, feeSummary, allocationsFor, allocationTotal, attendanceSummary,
  monthGrid, percentOf, resultsByTerm, readSnapshot, verifyUrl, resolveBranding, normaliseHex, onColour, contrastRatio, tripState, etaMinutes, haversineKm,
  readFormFields, validateAnswers, makeSwitchCounter, secondsLeft, clock, testWindow, nextActions, wrapCache, readCache, cacheKey, normalisePhone,
  parseIdentifier, roleOfKind, answeredCount, type DemandRow,
} from '../src/erp-portal';
import { lookup, makeL, catalogueProblems, STRING_KEYS, PORTAL_STRINGS } from '../src/erp-portal/strings';

const dem = (id: string, amount: number, due: string, extra: Partial<DemandRow> = {}): DemandRow => ({ id, student_id: 's1', label: 'T', amount, concession: 0, fine: 0, paid: 0, due_date: due, status: 'due', ...extra });

describe('money and dates', () => {
  it('Indian grouping', () => {
    expect(inr(0)).toBe('₹0');
    expect(inr(999)).toBe('₹999');
    expect(inr(1234567)).toBe('₹12,34,567');
    expect(inr('5000.5')).toBe('₹5,000.50');
    expect(inr(-1500)).toBe('-₹1,500');
    expect(inr(null)).toBe('₹0');
  });
  it('today in India, not in UTC', () => {
    expect(istToday(new Date('2026-11-24T19:00:00Z'))).toBe('2026-11-25'); // 00:30 IST next day
    expect(istToday(new Date('2026-11-24T05:00:00Z'))).toBe('2026-11-24');
    expect(addDays('2026-11-30', 2)).toBe('2026-12-02');
  });
  it('formats dates in the chosen language and never throws on bad input', () => {
    expect(fmtDate('2026-12-12', 'en')).toBe('12 Dec');
    expect(fmtDate('2026-12-12', 'en', true)).toContain('2026');
    expect(fmtDate(null)).toBe('');
    expect(fmtDate('not a date')).toBe('not a date');
  });
});

describe('children and language', () => {
  const kids = [{ id: 'a' }, { id: 'b' }];
  it('keeps the remembered child if it is still the family\'s, else the first', () => {
    expect(pickChild(kids, 'b')?.id).toBe('b');
    expect(pickChild(kids, 'gone')?.id).toBe('a');
    expect(pickChild([], 'a')).toBeNull();
  });
  it('language: saved choice first, then the device language, English last', () => {
    expect(pickLanguage('te', 'hi')).toBe('te');
    expect(pickLanguage(undefined, 'hi-IN')).toBe('hi');
    expect(pickLanguage('fr', 'de')).toBe('en');
  });
});

describe('fees', () => {
  const rows = [
    dem('d1', 5000, '2026-06-15', { status: 'paid', paid: 5000 }),
    dem('d2', 3000, '2026-09-15', { concession: 500, fine: 100 }),
    dem('d3', 4000, '2027-01-15', { status: 'partial', paid: 1000 }),
    dem('d4', 900, '2026-05-01', { status: 'cancelled' }),
  ];
  it('balance and state', () => {
    expect(demandBalance(rows[1]!)).toBe(2600);
    expect(demandBalance(rows[2]!)).toBe(3000);
    expect(demandState(rows[0]!, '2026-11-24')).toBe('paid');
    expect(demandState(rows[1]!, '2026-11-24')).toBe('overdue');
    expect(demandState(rows[2]!, '2026-11-24')).toBe('partial');
    expect(demandState(rows[3]!, '2026-11-24')).toBe('closed');
  });
  it('summary counts open balances only, and overdue only past the due date', () => {
    expect(feeSummary(rows, '2026-11-24')).toEqual({ due: 5600, overdue: 2600, paid: 6000, openCount: 2, nextDue: '2026-09-15' });
    expect(feeSummary([], '2026-11-24')).toEqual({ due: 0, overdue: 0, paid: 0, openCount: 0, nextDue: null });
  });
  it('allocations pay the full balance of selected open fees and never a closed one', () => {
    const a = allocationsFor(rows, ['d1', 'd2', 'd3', 'd4', 'nope']);
    expect(a).toEqual([{ demand_id: 'd2', amount: 2600 }, { demand_id: 'd3', amount: 3000 }]);
    expect(allocationTotal(a)).toBe(5600);
    expect(allocationsFor(rows, new Set<string>())).toEqual([]);
  });
});

describe('attendance', () => {
  const marks = [
    { date: '2026-11-02', status: 'present' }, { date: '2026-11-03', status: 'present' }, { date: '2026-11-04', status: 'late' },
    { date: '2026-11-05', status: 'absent' }, { date: '2026-11-06', status: 'on_leave' }, { date: '2026-11-07', status: 'half_day' },
  ];
  it('summary: leave is excused (not in the denominator), half day counts half', () => {
    const s = attendanceSummary(marks);
    expect(s).toMatchObject({ present: 2, late: 1, absent: 1, on_leave: 1, half_day: 1, total: 6 });
    expect(s.percent).toBe(70); // (2 + 1 + 0.5) / 5
    expect(attendanceSummary([]).percent).toBeNull();
  });
  it('month grid starts on Monday and pads the weeks', () => {
    const g = monthGrid(2026, 11, { '2026-11-05': 'absent' });
    expect(g.length).toBe(6);
    expect(g[0]!.length).toBe(7);
    expect(g[0]![0]).toBeNull(); // 1 Nov 2026 is a Sunday: Monday-first puts it in the last column
    expect(g[0]![6]!.date).toBe('2026-11-01');
    expect(g[0]!.filter(Boolean).length).toBe(1);
    expect(g.flat().find((c) => c?.date === '2026-11-05')?.status).toBe('absent');
  });
});

describe('results and report cards', () => {
  it('percent and grouping by term and subject (coded rows are not marks)', () => {
    expect(percentOf(41, 50)).toBe(82);
    expect(percentOf(null, 50)).toBeNull();
    const rows = [
      { assessment_id: '1', name: 'UT1', term: 'Term 1', component: null, subject: 'Science', max_marks: 50, marks: 40, code: null, grade: null, held_on: null },
      { assessment_id: '2', name: 'UT2', term: 'Term 1', component: null, subject: 'Science', max_marks: 50, marks: 30, code: null, grade: null, held_on: null },
      { assessment_id: '3', name: 'Quiz', term: 'Term 1', component: null, subject: 'Science', max_marks: 10, marks: null, code: 'AB', grade: null, held_on: null },
    ];
    const g = resultsByTerm(rows);
    expect(g).toHaveLength(1);
    expect(g[0]!.subjects[0]).toMatchObject({ name: 'Science', marks: 70, max: 100, percent: 70 });
    expect(g[0]!.subjects[0]!.rows).toHaveLength(3);
  });
  it('reads the snapshot defensively', () => {
    expect(readSnapshot(null)).toBeNull();
    expect(readSnapshot({ nope: 1 })).toBeNull();
    const s = readSnapshot({ student: { name: 'A' }, term: 'T1', subjects: [{ name: 'Sci', percent: 82, grade: 'A2', pass: true, parts: [{ name: 'UT', marks: 41, max: 50 }] }, { name: 'bad', percent: 'x' }], overall: 80, rank: 2, class_size: 30, attendance: { present: 90, total: 100, percent: 90 } });
    expect(s?.subjects[0]).toMatchObject({ name: 'Sci', percent: 82, grade: 'A2', pass: true });
    expect(s?.subjects[0]?.parts[0]).toEqual({ name: 'UT', marks: '41', max: 50 });
    expect(s?.subjects[1]?.percent).toBeNull();
    expect(s?.attendance?.percent).toBe(90);
  });
  it('verify link', () => {
    expect(verifyUrl('https://greenfield.autoed.in/', 'RC-123 456')).toBe('https://greenfield.autoed.in/erp/verify/RC-123%20456');
  });
});

describe('branding (decision 46)', () => {
  it('takes the school\'s name and colours', () => {
    const b = resolveBranding({ name: ' Greenfield ', branding: { primary: '#0f766e', accent: '#F59E0B', tagline: 'Learning with care' }, logo_file_id: 'f1' });
    expect(b).toMatchObject({ name: 'Greenfield', primary: '#0f766e', accent: '#f59e0b', onPrimary: '#ffffff', tagline: 'Learning with care', logoFileId: 'f1' });
  });
  it('falls back for missing, malformed or unreadable colours', () => {
    expect(resolveBranding(null)).toMatchObject({ name: 'School', primary: '#1d4ed8' });
    expect(resolveBranding({ name: 'X', branding: { primary: 'javascript:alert(1)' } }).primary).toBe('#1d4ed8');
    expect(resolveBranding({ name: 'X', branding: { primary: '#abc' } }).primary).toBe('#aabbcc');
    expect(normaliseHex('0F0', '#000000')).toBe('#00ff00');
    expect(normaliseHex(12, '#123456')).toBe('#123456');
  });
  it('a mid-grey primary that cannot carry text at 4.5:1 is replaced; light colours get dark text', () => {
    expect(resolveBranding({ name: 'X', branding: { primary: '#808080' } }).primary).toBe('#1d4ed8');
    expect(onColour('#ffee00')).toBe('#111827');
    expect(onColour('#0f766e')).toBe('#ffffff');
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 0);
  });
});

describe('bus', () => {
  const now = Date.parse('2026-11-24T08:00:00Z');
  const trip = (extra = {}) => ({ id: 't', status: 'running', direction: 'pickup', delay_minutes: null, last_lat: 17.38, last_lng: 78.48, last_at: new Date(now - 60000).toISOString(), started_at: null, ...extra });
  it('live when the last position is fresh, stale when old, none without a running trip', () => {
    expect(tripState(trip(), now)).toBe('running_live');
    expect(tripState(trip({ last_at: new Date(now - 10 * 60000).toISOString() }), now)).toBe('running_stale');
    expect(tripState(trip({ last_at: null }), now)).toBe('running_stale');
    expect(tripState(trip({ status: 'completed' }), now)).toBe('completed');
    expect(tripState(null, now)).toBe('none');
  });
  it('distance and a rough ETA', () => {
    const a = { lat: 17.385, lng: 78.4867 };
    const b = { lat: 17.4399, lng: 78.4983 };
    expect(haversineKm(a, b)).toBeGreaterThan(5);
    expect(haversineKm(a, b)).toBeLessThan(7);
    expect(etaMinutes({ ...a, speed: 30 }, b)).toBe(12);
    expect(etaMinutes({ ...a, speed: 0 }, a)).toBe(1);
  });
});

describe('forms', () => {
  const fields = readFormFields([{ id: 'q1', label: 'Rating', type: 'rating', required: true }, { key: 'q2', label: 'Size', type: 'select', options: 'S, M, L' }, { label: 'Notes', type: 'weird' }, { nolabel: true }, 'junk']);
  it('reads tolerant field definitions', () => {
    expect(fields.map((f) => [f.key, f.type, f.required])).toEqual([['q1', 'rating', true], ['q2', 'select', false], ['f3', 'text', false]]);
    expect(fields[1]!.options).toEqual(['S', 'M', 'L']);
    expect(readFormFields(null)).toEqual([]);
  });
  it('validates required, numbers and options', () => {
    expect(validateAnswers(fields, {})).toEqual({ q1: 'required' });
    expect(validateAnswers(fields, { q1: '4', q2: 'XL' })).toEqual({ q2: 'option' });
    expect(validateAnswers(readFormFields([{ key: 'n', label: 'N', type: 'number' }]), { n: 'abc' })).toEqual({ n: 'number' });
    expect(validateAnswers(fields, { q1: '4', q2: 'M' })).toEqual({});
  });
});

describe('online tests', () => {
  it('counts one tab switch per hide, not per event', () => {
    const c = makeSwitchCounter();
    c.hide(); c.hide(); c.hide();
    expect(c.count).toBe(1);
    c.show(); c.hide();
    expect(c.count).toBe(2);
  });
  it('timer, clock, answered count, window', () => {
    expect(secondsLeft(1000, 10, 1000 + 4 * 60000)).toBe(360);
    expect(secondsLeft(1000, 10, 1000 + 11 * 60000)).toBe(0);
    expect(clock(65)).toBe('1:05');
    expect(answeredCount([{ id: 'a', question: '', type: 'mcq', options: null, marks: 1 }, { id: 'b', question: '', type: 'mcq', options: null, marks: 1 }], { a: '4', b: ' ' })).toBe(1);
    const n = Date.parse('2026-11-24T08:00:00Z');
    expect(testWindow({ status: 'live', starts_at: null, ends_at: null }, n)).toBe('open');
    expect(testWindow({ status: 'live', starts_at: '2026-11-25T00:00:00Z', ends_at: null }, n)).toBe('upcoming');
    expect(testWindow({ status: 'live', starts_at: null, ends_at: '2026-11-23T00:00:00Z' }, n)).toBe('closed');
    expect(testWindow({ status: 'draft', starts_at: null, ends_at: null }, n)).toBe('closed');
  });
});

describe('home actions, cache, sign-in', () => {
  it('next actions in priority order', () => {
    expect(nextActions({ overdue: 100, approvedPasses: 1, unread: 2, openTests: 0, homeworkDueSoon: 3, openPtmSlots: 4, bookedPtm: false }).map((a) => a.key)).toEqual(['pay_overdue', 'pickup_otp', 'unread', 'homework_due', 'ptm_open']);
    expect(nextActions({ overdue: 0, approvedPasses: 0, unread: 0, openTests: 0, homeworkDueSoon: 0, openPtmSlots: 2, bookedPtm: true })).toEqual([]);
  });
  it('cache envelope: fresh, stale, corrupt', () => {
    const raw = JSON.stringify(wrapCache({ a: 1 }, 1000));
    expect(readCache<{ a: number }>(raw, 5000, 2000)).toEqual({ data: { a: 1 }, savedAt: 1000, stale: false });
    expect(readCache(raw, 5000, 9000)?.stale).toBe(true);
    expect(readCache('{broken')).toBeNull();
    expect(readCache(JSON.stringify({ v: 2, savedAt: 1, data: 1 }))).toBeNull();
    expect(readCache(null)).toBeNull();
    expect(cacheKey('u1', 'fees', 'c1')).toBe('portal:u1:fees:c1');
    expect(cacheKey('u1', 'home')).toBe('portal:u1:home');
  });
  it('phone and e-mail identifiers', () => {
    expect(normalisePhone('98765 43210')).toBe('919876543210');
    expect(normalisePhone('+91 98765-43210')).toBe('919876543210');
    expect(normalisePhone('098765 43210')).toBe('919876543210');
    expect(normalisePhone('12345')).toBeNull();
    expect(parseIdentifier(' Asha@Example.com ')).toEqual({ kind: 'email', email: 'asha@example.com' });
    expect(parseIdentifier('9000000001')).toEqual({ kind: 'phone', phone: '919000000001' });
    expect(parseIdentifier('nonsense')).toBeNull();
  });
  it('role from membership kind', () => {
    expect(['guardian', 'parent', 'student', 'staff', 'support', 'x', null].map(roleOfKind)).toEqual(['parent', 'parent', 'student', 'staff', 'staff', 'unknown', 'unknown']);
  });
});

describe('strings', () => {
  it('every entry has en, hi and te with the same placeholders', () => {
    expect(catalogueProblems()).toEqual([]);
  });
  it('lookup falls back to the key and substitutes placeholders', () => {
    expect(lookup('hi', 'nav.home')).toBe('होम');
    expect(lookup('en', 'home.hello', { name: 'Asha' })).toBe('Hello, Asha');
    expect(lookup('te', 'no.such.key')).toBe('no.such.key');
    expect(makeL('en')('fees.paySelected', { amount: '₹100' })).toBe('Pay ₹100');
  });
  it('every key used by the portal sources exists (web portal, web components, mobile app)', () => {
    const root = join(__dirname, '..', '..', '..');
    const roots = ['apps/web/app/erp/(portal)', 'apps/web/components/erp-portal', 'apps/web/lib/erp-portal', 'mobile-parent/app', 'mobile-parent/src'].map((d) => join(root, d)).filter(existsSync);
    const files: string[] = [];
    const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (f === 'node_modules') continue; if (statSync(p).isDirectory()) walk(p); else if (/\.(tsx?|ts)$/.test(f)) files.push(p); } };
    roots.forEach(walk);
    expect(files.length).toBeGreaterThan(0);
    const missing: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/\bL\(\s*'([a-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+)'/g)) if (!(m[1]! in PORTAL_STRINGS)) missing.push(`${m[1]} (${f.replace(root, '')})`);
      for (const m of src.matchAll(/\bL\(\s*`([a-z][A-Za-z0-9_.]*\.)\$\{/g)) if (!STRING_KEYS.some((k) => k.startsWith(m[1]!))) missing.push(`family ${m[1]}* (${f.replace(root, '')})`);
    }
    expect(missing).toEqual([]);
  });
});
