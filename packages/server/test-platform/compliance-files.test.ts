/** Pure file-format helpers of the compliance exports: CSV, ZIP, sha256, identifier expansion. No database. */
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cellText, createZip, crc32, readZip, sha256, toCsv, toXlsx } from '../src/compliance/files';
import { expandIdentifiers } from '../src/compliance/person';

describe('csv', () => {
  it('quotes, escapes and keeps unicode; null is empty; objects are JSON', () => {
    const csv = toCsv(['a', 'b', 'c'], [{ a: 'x,y', b: 'say "hi"\nthere', c: null }, { a: 'हिन्दी', b: { k: 1 }, c: 5 }]).toString('utf8');
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv.slice(1)).toBe('a,b,c\r\n"x,y","say ""hi""\nthere",\r\nहिन्दी,"{""k"":1}",5\r\n');
  });

  it('guards formula injection but leaves phone numbers and negative numbers alone', () => {
    const csv = toCsv(['v'], [{ v: '=SUM(A1)' }, { v: '@cmd' }, { v: '+91 98765 43210' }, { v: '-12.5' }, { v: '-evil' }, { v: 'ok' }, { v: -5 }]).toString('utf8').split('\r\n');
    expect(csv.slice(1, 8)).toEqual(["'=SUM(A1)", "'@cmd", '+91 98765 43210', '-12.5', "'-evil", 'ok', '-5']);
  });

  it('cellText renders every kind of value', () => {
    expect([cellText(null), cellText(undefined), cellText(true), cellText(3), cellText({ a: 1 }), cellText('s')]).toEqual(['', '', 'true', '3', '{"a":1}', 's']);
  });
});

describe('zip', () => {
  it('round-trips entries, verifies CRC, and is a valid archive for standard tools', async () => {
    const entries = [
      { name: 'a.txt', data: Buffer.from('hello') },
      { name: 'dir/b.bin', data: Buffer.alloc(100000, 7) },
      { name: 'हिन्दी.csv', data: Buffer.from('x') },
      { name: 'empty', data: Buffer.alloc(0) },
    ];
    const zip = createZip(entries);
    const back = readZip(zip);
    expect(back.map((e) => e.name)).toEqual(entries.map((e) => e.name));
    expect(back.every((e, i) => e.data.equals(entries[i]!.data))).toBe(true);
    // a flipped byte in the data is detected
    const bad = Buffer.from(zip);
    bad[40] = bad[40]! ^ 0xff;
    expect(() => readZip(bad)).toThrow();
    // and `unzip -t` (when installed) agrees that the archive is well formed
    const dir = await mkdtemp(join(tmpdir(), 'zip-'));
    try {
      await writeFile(join(dir, 't.zip'), zip);
      let out = '';
      try {
        out = execFileSync('unzip', ['-t', join(dir, 't.zip')], { encoding: 'utf8' });
      } catch (e) {
        if ((e as { code?: string }).code === 'ENOENT') return;
        throw e;
      }
      expect(out).toContain('No errors detected');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('crc32 and sha256 match the known test vectors', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
    expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('xlsx', () => {
  it('produces a workbook with a header and the rows', async () => {
    const buf = await toXlsx('crm.leads', ['name', 'n'], [{ name: 'A', n: 1 }, { name: '=1+1', n: 2 }]);
    expect(buf.subarray(0, 2).toString()).toBe('PK');
    const files = readZip(buf).map((e) => e.name);
    expect(files).toContain('xl/workbook.xml');
  });
});

describe('identifiers', () => {
  it('lower-cases emails and adds the E.164 form of phone numbers', () => {
    expect(expandIdentifiers(['Lena@Example.test', '98765 00001', ' ', '+91 98765 00002']).sort()).toEqual(
      ['+91 98765 00002', '+919876500001', '+919876500002', '98765 00001', 'lena@example.test'].sort(),
    );
  });
});
