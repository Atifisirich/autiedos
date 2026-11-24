/**
 * Indian financial year (1 April - 31 March, evaluated in IST) and GST invoice numbering.
 *
 * GST Rule 46 (CONFIRM): the invoice serial number is consecutive, unique for a financial year,
 * at most 16 characters, using only letters, digits, '-' and '/'.
 * The requested style "AE/2026-27/000123" is 17 characters, so the default here is the short
 * financial-year form "AE/26-27/000123" (15 chars). The long form is available but
 * validateInvoiceNumber() rejects it for being over 16 characters.
 */
import { toLocal } from '../time';

export interface FinancialYear {
  /** Calendar year in which the FY starts (FY 2026-27 -> 2026). */
  startYear: number;
  /** "2026-27" */
  label: string;
  /** "26-27" */
  short: string;
  /** First day, "2026-04-01". */
  startDate: string;
  /** Last day, "2027-03-31". */
  endDate: string;
}

function fyFromStartYear(startYear: number): FinancialYear {
  const endYY = String((startYear + 1) % 100).padStart(2, '0');
  const startYY = String(startYear % 100).padStart(2, '0');
  return {
    startYear,
    label: `${startYear}-${endYY}`,
    short: `${startYY}-${endYY}`,
    startDate: `${startYear}-04-01`,
    endDate: `${startYear + 1}-03-31`,
  };
}

/** Financial year containing the IST calendar date of the instant `at`. */
export function financialYearOf(at: Date): FinancialYear {
  return financialYearOfDate(toLocal(at, 'Asia/Kolkata').date);
}

/** Financial year containing an IST calendar date "YYYY-MM-DD". */
export function financialYearOfDate(isoDate: string): FinancialYear {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) throw new RangeError(`Invalid date ${isoDate}`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  return fyFromStartYear(month >= 4 ? year : year - 1);
}

export const INVOICE_NUMBER_MAX_LENGTH = 16;

export interface InvoiceNumberOptions {
  /** Default 'AE'. */
  prefix?: string;
  /** 'short' = 26-27 (default, fits 16 chars), 'long' = 2026-27. */
  fyStyle?: 'short' | 'long';
  /** Zero-padded width of the sequence. Default 6. */
  width?: number;
}

export function formatInvoiceNumber(fy: FinancialYear, sequence: number, opts: InvoiceNumberOptions = {}): string {
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new RangeError('Invoice sequence must be a positive integer');
  const prefix = opts.prefix ?? 'AE';
  const width = opts.width ?? 6;
  const fyPart = (opts.fyStyle ?? 'short') === 'long' ? fy.label : fy.short;
  return `${prefix}/${fyPart}/${String(sequence).padStart(width, '0')}`;
}

export function validateInvoiceNumber(n: string): { ok: true } | { ok: false; reason: string } {
  if (n.length === 0) return { ok: false, reason: 'empty' };
  if (n.length > INVOICE_NUMBER_MAX_LENGTH) return { ok: false, reason: `longer than ${INVOICE_NUMBER_MAX_LENGTH} characters` };
  if (!/^[A-Za-z0-9/-]+$/.test(n)) return { ok: false, reason: 'only letters, digits, "-" and "/" are allowed' };
  return { ok: true };
}

export function parseInvoiceNumber(n: string): { prefix: string; fy: string; sequence: number } | null {
  const m = /^([A-Za-z0-9]+)\/(\d{2,4}-\d{2})\/(\d+)$/.exec(n);
  return m ? { prefix: m[1]!, fy: m[2]!, sequence: Number(m[3]) } : null;
}

/**
 * Next sequence in a financial year. `lastSequenceInFy` is the highest number issued in the
 * same FY (null/undefined when none yet): the series restarts at 1 every 1 April.
 * Callers must allocate numbers inside a transaction or under a row lock so the series stays gap-free.
 */
export function nextInvoiceSequence(lastSequenceInFy: number | null | undefined): number {
  return (lastSequenceInFy ?? 0) + 1;
}
