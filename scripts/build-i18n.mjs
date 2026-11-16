#!/usr/bin/env node
/**
 * Builds the flat catalogues (en.json, hi.json, te.json) from packages/shared/src/i18n/source/*.txt.
 * Each line: key | English | Hindi | Telugu. Lines starting with # are comments.
 * Keeping the three languages on one line makes missing translations obvious in review.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = new URL('../packages/shared/src/i18n/', import.meta.url).pathname;
const out = { en: {}, hi: {}, te: {} };
const errors = [];
for (const f of readdirSync(join(dir, 'source')).filter((x) => x.endsWith('.txt')).sort()) {
  readFileSync(join(dir, 'source', f), 'utf8').split('\n').forEach((line, i) => {
    if (!line.trim() || line.startsWith('#')) return;
    const cols = line.split(' | ');
    if (cols.length !== 4 || cols.some((c) => !c.trim())) return errors.push(`${f}:${i + 1}: expected 4 non-empty columns separated by " | "`);
    const [key, en, hi, te] = cols.map((c) => c.trim());
    if (key in out.en) errors.push(`${f}:${i + 1}: duplicate key ${key}`);
    out.en[key] = en;
    out.hi[key] = hi;
    out.te[key] = te;
  });
}
if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
for (const l of ['en', 'hi', 'te']) {
  const sorted = Object.fromEntries(Object.entries(out[l]).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(join(dir, `${l}.json`), `${JSON.stringify(sorted, null, 1)}\n`);
}
console.log(`built ${Object.keys(out.en).length} keys × 3 languages`);
