/**
 * Unified staff login (decisions 35-37): identifiers, password policy and the request schemas shared by the
 * server, the web shell and the mobile app. See docs/adr/shell-and-login.md.
 */
import { z } from 'zod';
import type { ProductKey } from './billing/plans';

export type ProductKeyName = ProductKey;
/** Where each product's staff screens live in the one web app (decision 35). */
export const PRODUCT_HOME: Record<ProductKeyName, string> = { os: '/os', crm: '/crm', erp: '/erp' };

export type LoginIdentifier = { kind: 'email'; value: string } | { kind: 'phone'; value: string };

/** E-mail (lower-cased) or an Indian/international phone number as +digits (10 digits get +91). */
export function parseLoginIdentifier(raw: string): LoginIdentifier | null {
  const s = (raw ?? '').trim();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return { kind: 'email', value: s.toLowerCase() };
  const digits = s.replace(/[\s()-]/g, '');
  if (!/^\+?\d{10,15}$/.test(digits)) return null;
  const d = digits.replace(/^\+/, '');
  return { kind: 'phone', value: `+${d.length === 10 ? `91${d}` : d}` };
}

// ---------------------------------------------------------------- password policy
export const PASSWORD_MIN_LENGTH_DEFAULT = 10;
export const PASSWORD_MAX_LENGTH = 128;
export type PasswordProblem = 'too_short' | 'too_long' | 'same_as_identifier' | 'too_simple' | 'common' | 'breached';

/** Small list of passwords that are always refused (the optional breached-password check covers the rest). */
const COMMON = new Set(['password', 'password1', 'password123', '1234567890', '12345678910', 'qwertyuiop', 'iloveyou12', 'welcome123', 'admin12345', 'school1234', 'autoed1234', 'abcdefghij', 'changeme123', 'letmein123']);

/**
 * Checks a new password. Length is what matters most (NIST 800-63B): no composition rules beyond refusing
 * one repeated character or a straight sequence, the identifier itself, and well-known passwords.
 */
export function checkPassword(pw: string, opts: { minLength?: number; identifiers?: (string | null | undefined)[] } = {}): PasswordProblem[] {
  const min = Math.max(8, opts.minLength ?? PASSWORD_MIN_LENGTH_DEFAULT);
  const out: PasswordProblem[] = [];
  if (pw.length < min) out.push('too_short');
  if (pw.length > PASSWORD_MAX_LENGTH) out.push('too_long');
  const low = pw.toLowerCase();
  for (const id of opts.identifiers ?? []) {
    if (!id) continue;
    const local = id.toLowerCase().split('@')[0]!.replace(/^\+/, '');
    if (low === id.toLowerCase() || (local.length >= 4 && low.includes(local))) {
      out.push('same_as_identifier');
      break;
    }
  }
  if (/^(.)\1+$/.test(pw) || isSequence(low)) out.push('too_simple');
  if (COMMON.has(low)) out.push('common');
  return out;
}

function isSequence(s: string): boolean {
  if (s.length < 4) return false;
  let up = true;
  let down = true;
  for (let i = 1; i < s.length; i++) {
    const d = s.charCodeAt(i) - s.charCodeAt(i - 1);
    if (d !== 1) up = false;
    if (d !== -1) down = false;
  }
  return up || down;
}

// ---------------------------------------------------------------- request schemas
const identifier = z.string().trim().min(3).max(200);
export const loginMethodSchema = z.enum(['otp_phone', 'otp_email', 'password']);
export const passwordLoginSchema = z.object({ identifier, password: z.string().min(1).max(PASSWORD_MAX_LENGTH) });
export const otpStartSchema = z.object({ identifier });
export const otpVerifySchema = z.object({ identifier, code: z.string().trim().min(4).max(10), purpose: z.enum(['login', 'reset']).default('login') });
export const passwordChangeSchema = z.object({ current_password: z.string().max(PASSWORD_MAX_LENGTH).optional().nullable(), new_password: z.string().min(1).max(PASSWORD_MAX_LENGTH * 2) });
export const sessionExchangeSchema = z.object({ accessToken: z.string().min(10), method: loginMethodSchema.optional(), purpose: z.enum(['login', 'reset']).optional() });

/** What a sign-in returns (POST /auth/*): the token also goes into the httpOnly cookie on the web. */
export interface SignInResult {
  token: string;
  expires_at: string;
  org: { id: string; name: string } | null;
  products: ProductKeyName[];
  must_change_password: boolean;
  is_platform_admin: boolean;
}

/** GET /session: the platform session the web shell and the mobile app build their navigation from. */
export interface PlatformSession {
  user: { id: string; name: string; kind: string | null; email: string | null; phone: string | null };
  org: { id: string; name: string; slug: string; kind: string; branding: Record<string, string>; logo_path: string | null } | null;
  products: { key: ProductKeyName; name: string; home: string; modules: { key: string; name: string }[] }[];
  must_change_password: boolean;
  password_set: boolean;
  is_platform_admin: boolean;
  lang: 'en' | 'hi' | 'te';
  password_min_length: number;
}
