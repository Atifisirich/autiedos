import { describe, expect, it } from 'vitest';
import {
  computeInvoice,
  DEFAULT_SAC_CODE,
  divRoundHalfUp,
  financialYearOf,
  financialYearOfDate,
  formatInvoiceNumber,
  formatPaise,
  grossForTaxable,
  gstinSchema,
  gstRegime,
  isValidGstinFormat,
  nextInvoiceSequence,
  parseInvoiceNumber,
  parseRupees,
  stateCodeFromGstin,
  validateInvoiceNumber,
  computeInvoiceInputSchema,
} from '../src';

const MH = '27'; // Maharashtra
const KA = '29'; // Karnataka
const TG = '36'; // Telangana

describe('money', () => {
  it('rounds half up', () => {
    expect(divRoundHalfUp(5, 2)).toBe(3);
    expect(divRoundHalfUp(4, 3)).toBe(1);
    expect(divRoundHalfUp(0, 7)).toBe(0);
    expect(() => divRoundHalfUp(-1, 2)).toThrow();
  });
  it('formats and parses rupees', () => {
    expect(formatPaise(118000)).toBe('1180.00');
    expect(formatPaise(5)).toBe('0.05');
    expect(parseRupees('1000')).toBe(100000);
    expect(parseRupees('10.5')).toBe(1050);
    expect(() => parseRupees('10.555')).toThrow();
  });
});

describe('GST regime and golden invoices', () => {
  it('intra-state 18% on 1000.00 => 90.00 CGST + 90.00 SGST', () => {
    const inv = computeInvoice({ supplierStateCode: MH, placeOfSupplyStateCode: MH, lines: [{ description: 'OS plan', quantity: 1, unitPricePaise: 100000 }] });
    expect(inv.regime).toBe('intra_state');
    expect(inv.taxablePaise).toBe(100000);
    expect(inv.cgstPaise).toBe(9000);
    expect(inv.sgstPaise).toBe(9000);
    expect(inv.igstPaise).toBe(0);
    expect(inv.totalTaxPaise).toBe(18000);
    expect(inv.totalPaise).toBe(118000);
    expect(inv.lines[0]!.sacCode).toBe(DEFAULT_SAC_CODE);
  });

  it('inter-state 18% on 1000.00 => IGST 180.00', () => {
    const inv = computeInvoice({ supplierStateCode: MH, placeOfSupplyStateCode: KA, lines: [{ description: 'OS plan', quantity: 1, unitPricePaise: 100000 }] });
    expect(inv.regime).toBe('inter_state');
    expect(inv.igstPaise).toBe(18000);
    expect(inv.cgstPaise).toBe(0);
    expect(inv.sgstPaise).toBe(0);
    expect(inv.totalPaise).toBe(118000);
  });

  it('rounds odd paise half-up per component', () => {
    // 10.50 -> IGST 1.89; CGST/SGST 0.945 each -> 0.95 (so intra total tax is 1.90, one paisa more)
    const intra = computeInvoice({ supplierStateCode: MH, placeOfSupplyStateCode: MH, lines: [{ description: 'x', quantity: 1, unitPricePaise: 1050 }] });
    expect([intra.cgstPaise, intra.sgstPaise, intra.totalTaxPaise, intra.totalPaise]).toEqual([95, 95, 190, 1240]);
    const inter = computeInvoice({ supplierStateCode: MH, placeOfSupplyStateCode: TG, lines: [{ description: 'x', quantity: 1, unitPricePaise: 1050 }] });
    expect([inter.igstPaise, inter.totalPaise]).toEqual([189, 1239]);
    // 3.33 -> 18% = 0.5994 -> 0.60 ; 9% = 0.2997 -> 0.30
    expect(computeInvoice({ supplierStateCode: MH, placeOfSupplyStateCode: KA, lines: [{ description: 'x', quantity: 1, unitPricePaise: 333 }] }).igstPaise).toBe(60);
    expect(computeInvoice({ supplierStateCode: MH, placeOfSupplyStateCode: MH, lines: [{ description: 'x', quantity: 1, unitPricePaise: 333 }] }).cgstPaise).toBe(30);
    // 0.50 at 9% = 0.045 -> 5 paise? 50*9% = 4.5 paise -> rounds up to 5
    expect(computeInvoice({ supplierStateCode: MH, placeOfSupplyStateCode: MH, lines: [{ description: 'x', quantity: 1, unitPricePaise: 50 }] }).cgstPaise).toBe(5);
  });

  it('supports a configurable rate (5% intra-state => 2.5% + 2.5%)', () => {
    const inv = computeInvoice({ supplierStateCode: MH, placeOfSupplyStateCode: MH, rateBps: 500, lines: [{ description: 'x', quantity: 1, unitPricePaise: 100000 }] });
    expect([inv.cgstPaise, inv.sgstPaise, inv.totalPaise]).toEqual([2500, 2500, 105000]);
    const zero = computeInvoice({ supplierStateCode: MH, placeOfSupplyStateCode: KA, rateBps: 0, lines: [{ description: 'x', quantity: 2, unitPricePaise: 7 }] });
    expect(zero.totalPaise).toBe(14);
  });

  it('sums several lines, applies discounts before tax, keeps per-line SAC', () => {
    const inv = computeInvoice({
      supplierStateCode: MH,
      placeOfSupplyStateCode: KA,
      lines: [
        { description: 'Per student', quantity: 200, unitPricePaise: 5000, discountPaise: 100000 }, // 10000.00 - 1000.00 = 9000.00
        { description: 'Setup', sacCode: '998313', quantity: 1, unitPricePaise: 250050 },
      ],
    });
    expect(inv.lines.map((l) => l.taxablePaise)).toEqual([900000, 250050]);
    expect(inv.lines.map((l) => l.igstPaise)).toEqual([162000, 45009]); // 45009.0 exactly
    expect(inv.lines[1]!.sacCode).toBe('998313');
    expect(inv.taxablePaise).toBe(1150050);
    expect(inv.totalPaise).toBe(inv.taxablePaise + inv.igstPaise);
  });

  it('rejects bad input', () => {
    const line = [{ description: 'x', quantity: 1, unitPricePaise: 100 }];
    expect(() => computeInvoice({ supplierStateCode: '25', placeOfSupplyStateCode: MH, lines: line })).toThrow(/state code/);
    expect(() => computeInvoice({ supplierStateCode: MH, placeOfSupplyStateCode: '00', lines: line })).toThrow(/state code/);
    expect(() => computeInvoice({ supplierStateCode: MH, placeOfSupplyStateCode: MH, lines: [] })).toThrow();
    expect(() => computeInvoice({ supplierStateCode: MH, placeOfSupplyStateCode: MH, lines: [{ description: 'x', quantity: 1, unitPricePaise: 100, discountPaise: 101 }] })).toThrow(/Discount/);
    expect(() => computeInvoice({ supplierStateCode: MH, placeOfSupplyStateCode: MH, lines: [{ description: 'x', quantity: 1, unitPricePaise: 10.5 }] })).toThrow();
    expect(() => computeInvoice({ supplierStateCode: MH, placeOfSupplyStateCode: MH, lines: line, rateBps: 18.5 })).toThrow();
  });

  it('gstRegime and grossForTaxable', () => {
    expect(gstRegime(MH, MH)).toBe('intra_state');
    expect(gstRegime(MH, TG)).toBe('inter_state');
    expect(grossForTaxable(100000, MH, MH)).toBe(118000);
    expect(grossForTaxable(1050, MH, MH)).toBe(1240);
    expect(grossForTaxable(1050, MH, KA)).toBe(1239);
  });
});

describe('GSTIN and zod schemas', () => {
  it('checks GSTIN shape and extracts the state', () => {
    expect(isValidGstinFormat('27AAPFU0939F1ZV')).toBe(true);
    expect(stateCodeFromGstin('27AAPFU0939F1ZV')).toBe('27');
    expect(isValidGstinFormat('00AAPFU0939F1ZV')).toBe(false);
    expect(isValidGstinFormat('27AAPFU0939F1XV')).toBe(false);
    expect(isValidGstinFormat('27aapfu0939f1zv')).toBe(false);
    expect(gstinSchema.safeParse('27AAPFU0939F1ZV').success).toBe(true);
    expect(gstinSchema.safeParse('nope').success).toBe(false);
  });
  it('validates invoice input', () => {
    const ok = computeInvoiceInputSchema.safeParse({ supplierStateCode: '27', placeOfSupplyStateCode: '29', lines: [{ description: 'x', quantity: 1, unitPricePaise: 1 }] });
    expect(ok.success).toBe(true);
    expect(computeInvoiceInputSchema.safeParse({ supplierStateCode: '27', placeOfSupplyStateCode: '29', lines: [] }).success).toBe(false);
    expect(computeInvoiceInputSchema.safeParse({ supplierStateCode: '27', placeOfSupplyStateCode: '25', lines: [{ description: 'x', quantity: 1, unitPricePaise: 1 }] }).success).toBe(false);
  });
});

describe('financial year and invoice numbers', () => {
  it('FY runs 1 April - 31 March in IST', () => {
    expect(financialYearOf(new Date('2027-03-31T23:59:59+05:30')).label).toBe('2026-27');
    expect(financialYearOf(new Date('2027-04-01T00:00:00+05:30')).label).toBe('2027-28');
    // 2027-03-31T18:30:00Z is already 1 April in India
    expect(financialYearOf(new Date('2027-03-31T18:29:59Z')).label).toBe('2026-27');
    expect(financialYearOf(new Date('2027-03-31T18:30:00Z')).label).toBe('2027-28');
    expect(financialYearOfDate('2026-04-01').label).toBe('2026-27');
    expect(financialYearOfDate('2026-03-31').label).toBe('2025-26');
    expect(financialYearOfDate('2026-01-15')).toMatchObject({ startYear: 2025, short: '25-26', startDate: '2025-04-01', endDate: '2026-03-31' });
    expect(financialYearOfDate('2099-05-01').label).toBe('2099-00');
  });

  it('formats the series AE/26-27/000123 and rejects over-long numbers', () => {
    const fy = financialYearOfDate('2026-11-24');
    const n = formatInvoiceNumber(fy, 123);
    expect(n).toBe('AE/26-27/000123');
    expect(validateInvoiceNumber(n)).toEqual({ ok: true });
    const long = formatInvoiceNumber(fy, 123, { fyStyle: 'long' });
    expect(long).toBe('AE/2026-27/000123');
    expect(long).toHaveLength(17);
    expect(validateInvoiceNumber(long)).toMatchObject({ ok: false });
    expect(validateInvoiceNumber('AE/26-27/00 1')).toMatchObject({ ok: false });
    expect(formatInvoiceNumber(fy, 7, { prefix: 'X', fyStyle: 'long', width: 3 })).toBe('X/2026-27/007');
    expect(() => formatInvoiceNumber(fy, 0)).toThrow();
  });

  it('parses numbers and restarts the sequence each FY', () => {
    expect(parseInvoiceNumber('AE/26-27/000123')).toEqual({ prefix: 'AE', fy: '26-27', sequence: 123 });
    expect(parseInvoiceNumber('garbage')).toBeNull();
    expect(nextInvoiceSequence(null)).toBe(1);
    expect(nextInvoiceSequence(undefined)).toBe(1);
    expect(nextInvoiceSequence(123)).toBe(124);
    // last invoice of FY 26-27 and first of 27-28
    const last = formatInvoiceNumber(financialYearOf(new Date('2027-03-31T23:59:59+05:30')), 500);
    const first = formatInvoiceNumber(financialYearOf(new Date('2027-04-01T00:00:00+05:30')), nextInvoiceSequence(null));
    expect([last, first]).toEqual(['AE/26-27/000500', 'AE/27-28/000001']);
  });
});
