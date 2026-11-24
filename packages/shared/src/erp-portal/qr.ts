/**
 * A small QR code encoder (byte mode, error correction level M, versions 1 to 10: up to 213 bytes), for the verification link on
 * report cards and certificates. No dependency, so the web portal (SVG) and the Expo app (plain Views) draw the same code.
 * Follows ISO/IEC 18004: Reed-Solomon over GF(256) (0x11d), the eight masks with the four penalty rules, BCH format/version info.
 */

// version -> [ec codewords per block, [blocks, data codewords per block][]] for level M
const M_TABLE: Record<number, [number, [number, number][]]> = {
  1: [10, [[1, 16]]], 2: [16, [[1, 28]]], 3: [26, [[1, 44]]], 4: [18, [[2, 32]]], 5: [24, [[2, 43]]],
  6: [16, [[4, 27]]], 7: [18, [[4, 31]]], 8: [22, [[2, 38], [2, 39]]], 9: [22, [[3, 36], [2, 37]]], 10: [26, [[4, 43], [1, 44]]],
};
const ALIGN: Record<number, number[]> = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50] };

const EXP = new Array<number>(512);
const LOG = new Array<number>(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!;
})();
const gmul = (a: number, b: number): number => (a === 0 || b === 0 ? 0 : EXP[LOG[a]! + LOG[b]!]!);

function rsGenerator(degree: number): number[] {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array<number>(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) { next[j] = (next[j] ?? 0) ^ gmul(poly[j]!, 1); next[j + 1] = (next[j + 1] ?? 0) ^ gmul(poly[j]!, EXP[i]!); }
    poly = next;
  }
  return poly;
}
function rsRemainder(data: number[], degree: number): number[] {
  const gen = rsGenerator(degree);
  const rem = new Array<number>(degree).fill(0);
  for (const b of data) {
    const factor = b ^ rem.shift()!;
    rem.push(0);
    for (let i = 0; i < degree; i++) rem[i] = rem[i]! ^ gmul(gen[i + 1]!, factor);
  }
  return rem;
}

const dataCapacity = (v: number): number => M_TABLE[v]![1].reduce((s, [n, k]) => s + n * k, 0);

export function qrVersionFor(byteLength: number): number {
  for (let v = 1; v <= 10; v++) {
    const bitsNeeded = 4 + (v < 10 ? 8 : 16) + byteLength * 8;
    if (bitsNeeded <= dataCapacity(v) * 8) return v;
  }
  throw new Error('qr: text too long (max 213 bytes)');
}

function bchFormat(data: number): number {
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}
function bchVersion(v: number): number {
  let rem = v;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (v << 12) | rem;
}

function buildCodewords(bytes: number[], version: number): number[] {
  const bits: number[] = [];
  const put = (val: number, len: number) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  put(0b0100, 4);
  put(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  const cap = dataCapacity(version) * 8;
  put(0, Math.min(4, cap - bits.length));
  while (bits.length % 8) bits.push(0);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  for (let pad = 0xec; data.length < dataCapacity(version); pad ^= 0xec ^ 0x11) data.push(pad);
  const [ecLen, groups] = M_TABLE[version]!;
  const blocks: { data: number[]; ec: number[] }[] = [];
  let at = 0;
  for (const [n, k] of groups) for (let i = 0; i < n; i++) { const d = data.slice(at, at + k); at += k; blocks.push({ data: d, ec: rsRemainder(d, ecLen) }); }
  const out: number[] = [];
  const maxData = Math.max(...blocks.map((b) => b.data.length));
  for (let i = 0; i < maxData; i++) for (const b of blocks) if (i < b.data.length) out.push(b.data[i]!);
  for (let i = 0; i < ecLen; i++) for (const b of blocks) out.push(b.ec[i]!);
  return out;
}

const MASKS: ((r: number, c: number) => boolean)[] = [
  (r, c) => (r + c) % 2 === 0, (r) => r % 2 === 0, (_r, c) => c % 3 === 0, (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0, (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0, (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function penalty(m: boolean[][]): number {
  const n = m.length;
  let p = 0;
  const lines = (get: (i: number, j: number) => boolean) => {
    for (let i = 0; i < n; i++) {
      let run = 1;
      for (let j = 1; j <= n; j++) {
        if (j < n && get(i, j) === get(i, j - 1)) run++;
        else { if (run >= 5) p += 3 + (run - 5); run = 1; }
      }
      // finder-like 1:1:3:1:1 with 4 light modules on either side
      for (let j = 0; j + 11 <= n; j++) {
        const s = Array.from({ length: 11 }, (_, k) => (get(i, j + k) ? 1 : 0)).join('');
        if (s === '10111010000' || s === '00001011101') p += 40;
      }
    }
  };
  lines((i, j) => m[i]![j]!);
  lines((i, j) => m[j]![i]!);
  for (let i = 0; i < n - 1; i++) for (let j = 0; j < n - 1; j++) if (m[i]![j] === m[i]![j + 1] && m[i]![j] === m[i + 1]![j] && m[i]![j] === m[i + 1]![j + 1]) p += 3;
  const dark = m.reduce((s, row) => s + row.filter(Boolean).length, 0);
  p += Math.floor(Math.abs((dark * 100) / (n * n) - 50) / 5) * 10;
  return p;
}

/** The module matrix (true = dark) of a QR code for `text` (UTF-8, level M). Throws if it does not fit in version 10. */
export function qrMatrix(text: string, forceMask?: number): boolean[][] {
  const bytes = [...new TextEncoder().encode(text)];
  const version = qrVersionFor(bytes.length);
  const n = 17 + version * 4;
  const mod: boolean[][] = Array.from({ length: n }, () => new Array<boolean>(n).fill(false));
  const fn: boolean[][] = Array.from({ length: n }, () => new Array<boolean>(n).fill(false)); // function patterns (not data)
  const set = (r: number, c: number, dark: boolean) => { if (r >= 0 && r < n && c >= 0 && c < n) { mod[r]![c] = dark; fn[r]![c] = true; } };

  // finder patterns with separators
  for (const [r0, c0] of [[0, 0], [0, n - 7], [n - 7, 0]] as const) {
    for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) {
      const inner = r >= 0 && r <= 6 && c >= 0 && c <= 6 && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
      set(r0 + r, c0 + c, inner);
    }
  }
  // timing
  for (let i = 8; i < n - 8; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  // alignment
  const pos = ALIGN[version]!;
  for (const r of pos) for (const c of pos) {
    if ((r === 6 && c === 6) || (r === 6 && c === n - 7) || (r === n - 7 && c === 6)) continue;
    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
  }
  // reserve format and version areas, dark module
  for (let i = 0; i < 9; i++) if (i !== 6) { set(8, i, false); set(i, 8, false); }
  for (let i = 0; i < 8; i++) { set(8, n - 1 - i, false); set(n - 1 - i, 8, false); }
  set(n - 8, 8, true);
  if (version >= 7) {
    const v = bchVersion(version);
    for (let i = 0; i < 18; i++) { const bit = ((v >>> i) & 1) === 1; const a = Math.floor(i / 3); const b = (i % 3) + n - 11; set(a, b, bit); set(b, a, bit); }
  }

  // data placement (zig-zag from the bottom right, skipping column 6)
  const words = buildCodewords(bytes, version);
  const dbits: boolean[] = [];
  for (const w of words) for (let i = 7; i >= 0; i--) dbits.push(((w >>> i) & 1) === 1);
  let k = 0;
  let up = true;
  for (let col = n - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (let step = 0; step < n; step++) {
      const r = up ? n - 1 - step : step;
      for (const c of [col, col - 1]) if (!fn[r]![c]) { mod[r]![c] = k < dbits.length ? dbits[k]! : false; k++; }
    }
    up = !up;
  }

  const apply = (mask: number): boolean[][] => {
    const m = mod.map((row) => row.slice());
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (!fn[r]![c] && MASKS[mask]!(r, c)) m[r]![c] = !m[r]![c];
    const f = bchFormat((0b00 << 3) | mask); // level M = 00
    const bit = (i: number) => ((f >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) m[i]![8] = bit(i);
    m[7]![8] = bit(6); m[8]![8] = bit(7); m[8]![7] = bit(8);
    for (let i = 9; i < 15; i++) m[8]![14 - i] = bit(i);
    for (let i = 0; i < 8; i++) m[8]![n - 1 - i] = bit(i);
    for (let i = 8; i < 15; i++) m[n - 15 + i]![8] = bit(i);
    m[n - 8]![8] = true;
    return m;
  };
  if (forceMask !== undefined) return apply(forceMask);
  let best = apply(0);
  let bestScore = penalty(best);
  for (let mask = 1; mask < 8; mask++) { const m = apply(mask); const s = penalty(m); if (s < bestScore) { best = m; bestScore = s; } }
  return best;
}

/** An SVG path (one `M x y h1 v1 h-1z` per dark module, merged by row) for a code with a 4-module quiet zone; viewBox is `0 0 size size`. */
export function qrSvgPath(text: string): { d: string; size: number } {
  const m = qrMatrix(text);
  const q = 4;
  let d = '';
  for (let r = 0; r < m.length; r++) {
    let c = 0;
    while (c < m.length) {
      if (!m[r]![c]) { c++; continue; }
      let e = c;
      while (e < m.length && m[r]![e]) e++;
      d += `M${c + q} ${r + q}h${e - c}v1h-${e - c}z`;
      c = e;
    }
  }
  return { d, size: m.length + q * 2 };
}
