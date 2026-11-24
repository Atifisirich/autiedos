/**
 * Money helpers. All amounts are integer paise (1 INR = 100 paise); floats never hold money.
 */

/** Divide n/d (n non-negative integer, d positive integer) rounding half up to an integer. */
export function divRoundHalfUp(n: number, d: number): number {
  if (!Number.isSafeInteger(n) || !Number.isSafeInteger(d) || d <= 0 || n < 0) {
    throw new RangeError(`divRoundHalfUp needs non-negative safe integers and d>0 (got ${n}/${d})`);
  }
  return Math.floor((2 * n + d) / (2 * d));
}

/** Format paise as "1234.50" (plain, no currency symbol or grouping) for logs and PDF text. */
export function formatPaise(paise: number): string {
  const sign = paise < 0 ? '-' : '';
  const abs = Math.abs(paise);
  const rupees = Math.floor(abs / 100);
  const p = String(abs % 100).padStart(2, '0');
  return `${sign}${rupees}.${p}`;
}

/** Parse "1000.00" / "1000" / "1000.5" into paise. Rejects more than 2 decimals. */
export function parseRupees(s: string): number {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s.trim());
  if (!m) throw new RangeError(`Invalid rupee amount: ${s}`);
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || '0');
}
