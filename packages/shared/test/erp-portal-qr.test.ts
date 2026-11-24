import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { qrMatrix, qrSvgPath } from '../src/erp-portal/qr';

const hash = (m: boolean[][]) => createHash('sha1').update(m.map((r) => r.map((b) => (b ? 1 : 0)).join('')).join('/')).digest('hex').slice(0, 16);

describe('qr code (verification links)', () => {
  it('matches the modules of an independent encoder (cross-checked once against qrcode-terminal: data, Reed-Solomon, format and version bits)', () => {
    expect(hash(qrMatrix('A', 4))).toBe('5e763d55057d2cc4');
    expect(hash(qrMatrix('https://x.example/erp/verify/RC-ac7bd3e8-L1', 4))).toBe('6bfff9a6387453d8');
    expect(hash(qrMatrix('q'.repeat(210), 3))).toBe('efc1c73f8d02dacd'); // version 10: version information bits
  });
  it('size follows the version, finder patterns are in three corners, long text is refused', () => {
    expect(qrMatrix('A').length).toBe(21);
    const m = qrMatrix('https://greenfield.autoed.in/erp/verify/RC-0123456789');
    expect((m.length - 17) % 4).toBe(0);
    for (const [r, c] of [[0, 0], [0, m.length - 7], [m.length - 7, 0]] as const) {
      expect(m[r]![c]).toBe(true);
      expect(m[r + 3]![c + 3]).toBe(true);
      expect(m[r + 1]![c + 1]).toBe(false);
    }
    expect(m[m.length - 8]![8]).toBe(true); // the dark module
    expect(() => qrMatrix('x'.repeat(214))).toThrow();
  });
  it('svg path covers the quiet zone', () => {
    const { d, size } = qrSvgPath('A');
    expect(size).toBe(29);
    expect(d.startsWith('M4 4h7')).toBe(true);
  });
});
