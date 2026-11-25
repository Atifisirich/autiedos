/**
 * Privacy guard for AI calls (rule 8, PRD 8.3). Only class, subject and topic context may go to
 * the provider. This removes phone numbers, emails and known personal names, and replaces
 * student names with roster tokens that are restored on screen.
 */
// Indian mobile numbers: 10 digits starting 6-9, optionally written with +91 / 91 / 0091 in front, with or without a space or
// dash after the prefix and in the middle ("+919876543210", "+91 98765-43210", "09876543210"). The look-behind sits before the
// optional prefix, so a prefix glued to the number ("+919876543210") is matched too (it was missed before).
const PHONE = /(?<!\d)(?:(?:\+|00)?91[\s-]?|0)?[6-9]\d{4}[\s-]?\d{5}(?!\d)/g;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface Redaction {
  text: string;
  /** token -> original, to restore on screen */
  map: Record<string, string>;
}

/**
 * Redacts personal data from free text. `students` are replaced by stable roster tokens
 * (S-<id prefix>); `staff` names are replaced by T-<n> unless listed in `allowStaffNames`.
 */
export function redact(text: string, people: { students?: { id: string; name: string }[]; staff?: { id: string; name: string }[]; allowStaffNames?: boolean } = {}): Redaction {
  const map: Record<string, string> = {};
  let out = text.replace(EMAIL, '[email]').replace(PHONE, '[phone]');
  const sorted = (xs: { id: string; name: string }[]) => [...xs].filter((x) => x.name.trim().length > 1).sort((a, b) => b.name.length - a.name.length);
  for (const s of sorted(people.students ?? [])) {
    const token = `S-${s.id.slice(0, 8)}`;
    const re = new RegExp(`\\b${escapeRe(s.name)}\\b`, 'gi');
    if (re.test(out)) {
      map[token] = s.name;
      out = out.replace(re, token);
    }
  }
  if (!people.allowStaffNames) {
    let n = 1;
    for (const s of sorted(people.staff ?? [])) {
      const token = `T-${n}`;
      const re = new RegExp(`\\b${escapeRe(s.name)}\\b`, 'gi');
      if (re.test(out)) {
        map[token] = s.name;
        out = out.replace(re, token);
        n++;
      }
    }
  }
  return { text: out, map };
}

export function restore(text: string, map: Record<string, string>): string {
  let out = text;
  for (const [token, name] of Object.entries(map)) out = out.split(token).join(name);
  return out;
}

/** True if a payload still contains something that looks like a phone or email. */
export function containsContactData(payload: unknown): boolean {
  const s = JSON.stringify(payload);
  return new RegExp(PHONE.source).test(s) || new RegExp(EMAIL.source, 'i').test(s);
}
