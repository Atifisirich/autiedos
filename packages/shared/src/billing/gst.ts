/**
 * GST invoice calculation for AutoEd -> client invoices (pure, no I/O).
 *
 * Conventions
 *  - Money is integer paise. Rates are integer basis points (1800 = 18%).
 *  - Intra-state supply (supplier state == place of supply) -> CGST + SGST, each half the rate.
 *  - Inter-state supply -> IGST at the full rate.
 *  - Tax is computed per invoice line and rounded half-up to the paisa per component;
 *    invoice totals are the sums of the line values. Because CGST and SGST are rounded
 *    separately, on odd-paise bases the intra-state total tax can differ from the IGST figure by
 *    one paisa (e.g. base 10.50 -> IGST 1.89 but CGST 0.95 + SGST 0.95 = 1.90). This is the usual
 *    invoicing-software behaviour; CONFIRM with the accountant that it is acceptable.
 *
 * Statutory facts here (state codes, SAC, Rule 46 invoice number rules) were written from
 * knowledge, not re-verified against the GST portal in this build. Items marked CONFIRM need an
 * accountant's sign-off before the first real invoice.
 */
import { divRoundHalfUp } from './money';

/** Default GST rate for software/IT services: 18%. CONFIRM with accountant. */
export const DEFAULT_GST_RATE_BPS = 1800;

/**
 * Default SAC (Services Accounting Code) for the subscription line.
 * CONFIRM: 998314 = "IT design and development services". Alternatives an accountant may prefer:
 * 998313 (IT consulting & support), 998315 (hosting & IT infrastructure provisioning),
 * 997331 (licensing services for the right to use computer software).
 */
export const DEFAULT_SAC_CODE = '998314';

/** GST state / UT codes (first two digits of a GSTIN). CONFIRM against the GST portal master list. */
export const GST_STATE_CODES: Readonly<Record<string, string>> = {
  '01': 'Jammu and Kashmir',
  '02': 'Himachal Pradesh',
  '03': 'Punjab',
  '04': 'Chandigarh',
  '05': 'Uttarakhand',
  '06': 'Haryana',
  '07': 'Delhi',
  '08': 'Rajasthan',
  '09': 'Uttar Pradesh',
  '10': 'Bihar',
  '11': 'Sikkim',
  '12': 'Arunachal Pradesh',
  '13': 'Nagaland',
  '14': 'Manipur',
  '15': 'Mizoram',
  '16': 'Tripura',
  '17': 'Meghalaya',
  '18': 'Assam',
  '19': 'West Bengal',
  '20': 'Jharkhand',
  '21': 'Odisha',
  '22': 'Chhattisgarh',
  '23': 'Madhya Pradesh',
  '24': 'Gujarat',
  '26': 'Dadra and Nagar Haveli and Daman and Diu',
  '27': 'Maharashtra',
  '29': 'Karnataka',
  '30': 'Goa',
  '31': 'Lakshadweep',
  '32': 'Kerala',
  '33': 'Tamil Nadu',
  '34': 'Puducherry',
  '35': 'Andaman and Nicobar Islands',
  '36': 'Telangana',
  '37': 'Andhra Pradesh',
  '38': 'Ladakh',
  '97': 'Other Territory',
  '99': 'Centre Jurisdiction',
};

export function isValidStateCode(code: string): boolean {
  return Object.prototype.hasOwnProperty.call(GST_STATE_CODES, code);
}

/** Structural GSTIN check (15 chars, state code, PAN shape, entity digit, 'Z', check char). No checksum maths. */
export const GSTIN_REGEX = /^(\d{2})([A-Z]{5}\d{4}[A-Z])([1-9A-Z])Z([0-9A-Z])$/;

export function isValidGstinFormat(gstin: string): boolean {
  const m = GSTIN_REGEX.exec(gstin);
  return !!m && isValidStateCode(m[1]!);
}

export function stateCodeFromGstin(gstin: string): string | null {
  return isValidGstinFormat(gstin) ? gstin.slice(0, 2) : null;
}

export type GstRegime = 'intra_state' | 'inter_state';

/**
 * Decide the tax regime. `placeOfSupplyStateCode` for B2B services is the recipient's state
 * (CONFIRM the place-of-supply rule for unregistered recipients: location on record, else supplier's).
 */
export function gstRegime(supplierStateCode: string, placeOfSupplyStateCode: string): GstRegime {
  if (!isValidStateCode(supplierStateCode)) throw new RangeError(`Unknown supplier state code ${supplierStateCode}`);
  if (!isValidStateCode(placeOfSupplyStateCode)) throw new RangeError(`Unknown place-of-supply state code ${placeOfSupplyStateCode}`);
  return supplierStateCode === placeOfSupplyStateCode ? 'intra_state' : 'inter_state';
}

export interface InvoiceLineInput {
  description: string;
  /** Falls back to DEFAULT_SAC_CODE. */
  sacCode?: string;
  quantity: number;
  /** Unit price before tax, paise. */
  unitPricePaise: number;
  /** Discount on the line before tax, paise. */
  discountPaise?: number;
}

export interface ComputeInvoiceInput {
  supplierStateCode: string;
  placeOfSupplyStateCode: string;
  lines: InvoiceLineInput[];
  /** Basis points; default 1800. */
  rateBps?: number;
}

export interface InvoiceLineResult {
  description: string;
  sacCode: string;
  quantity: number;
  unitPricePaise: number;
  discountPaise: number;
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  /** taxable + taxes */
  totalPaise: number;
}

export interface InvoiceTotals {
  regime: GstRegime;
  rateBps: number;
  lines: InvoiceLineResult[];
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  totalTaxPaise: number;
  totalPaise: number;
}

function assertInt(name: string, v: number, min = 0): void {
  if (!Number.isSafeInteger(v) || v < min) throw new RangeError(`${name} must be an integer >= ${min} (got ${v})`);
}

export function computeInvoice(input: ComputeInvoiceInput): InvoiceTotals {
  const rateBps = input.rateBps ?? DEFAULT_GST_RATE_BPS;
  assertInt('rateBps', rateBps);
  if (rateBps > 10000) throw new RangeError('rateBps cannot exceed 10000');
  if (input.lines.length === 0) throw new RangeError('An invoice needs at least one line');
  const regime = gstRegime(input.supplierStateCode, input.placeOfSupplyStateCode);

  const lines = input.lines.map((l): InvoiceLineResult => {
    assertInt('quantity', l.quantity, 1);
    assertInt('unitPricePaise', l.unitPricePaise);
    const discountPaise = l.discountPaise ?? 0;
    assertInt('discountPaise', discountPaise);
    const gross = l.quantity * l.unitPricePaise;
    if (!Number.isSafeInteger(gross)) throw new RangeError('Line amount too large');
    if (discountPaise > gross) throw new RangeError('Discount exceeds line amount');
    const taxablePaise = gross - discountPaise;
    let cgstPaise = 0;
    let sgstPaise = 0;
    let igstPaise = 0;
    if (regime === 'intra_state') {
      cgstPaise = divRoundHalfUp(taxablePaise * rateBps, 20000);
      sgstPaise = cgstPaise;
    } else {
      igstPaise = divRoundHalfUp(taxablePaise * rateBps, 10000);
    }
    return {
      description: l.description,
      sacCode: l.sacCode ?? DEFAULT_SAC_CODE,
      quantity: l.quantity,
      unitPricePaise: l.unitPricePaise,
      discountPaise,
      taxablePaise,
      cgstPaise,
      sgstPaise,
      igstPaise,
      totalPaise: taxablePaise + cgstPaise + sgstPaise + igstPaise,
    };
  });

  const sum = (f: (l: InvoiceLineResult) => number) => lines.reduce((a, l) => a + f(l), 0);
  const taxablePaise = sum((l) => l.taxablePaise);
  const cgstPaise = sum((l) => l.cgstPaise);
  const sgstPaise = sum((l) => l.sgstPaise);
  const igstPaise = sum((l) => l.igstPaise);
  const totalTaxPaise = cgstPaise + sgstPaise + igstPaise;
  return { regime, rateBps, lines, taxablePaise, cgstPaise, sgstPaise, igstPaise, totalTaxPaise, totalPaise: taxablePaise + totalTaxPaise };
}

/**
 * Tax-inclusive total for one taxable amount. Used to price Razorpay plans, which charge a fixed
 * amount (Razorpay does not add GST on subscriptions). See docs/adr/billing-razorpay-gst.md.
 */
export function grossForTaxable(taxablePaise: number, supplierStateCode: string, placeOfSupplyStateCode: string, rateBps = DEFAULT_GST_RATE_BPS): number {
  return computeInvoice({
    supplierStateCode,
    placeOfSupplyStateCode,
    rateBps,
    lines: [{ description: 'x', quantity: 1, unitPricePaise: taxablePaise }],
  }).totalPaise;
}
