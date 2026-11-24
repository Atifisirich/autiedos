#!/usr/bin/env node
/**
 * i18n check (rule 6):
 *  1. every key used in code exists in en, hi and te;
 *  2. the three catalogues have exactly the same keys and the same {placeholders};
 *  3. every dynamic key family (t(`prefix.${x}`)) has entries;
 *  4. no literal user-facing strings in JSX (text nodes, placeholder/title/alt/aria-label attributes).
 * `--list` prints used keys and families instead of checking.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const SRC = ['apps/web/app', 'apps/web/components', 'apps/web/lib', 'mobile/app', 'mobile/src', 'packages/server/src', 'packages/shared/src'].map((d) => join(root, d)).filter(existsSync);
const files = [];
const walk = (d) => {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (f === 'node_modules' || f.startsWith('.')) continue;
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(tsx?|mjs)$/.test(f) && !/\.d\.ts$/.test(f)) files.push(p);
  }
};
SRC.forEach(walk);

const keys = new Map(); // key -> first file
const families = new Map(); // prefix -> first file
const KEY = /^[a-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/;
const add = (k, f) => KEY.test(k) && !keys.has(k) && keys.set(k, f);
for (const f of files) {
  if (f.includes('/i18n/') || f.includes('/seed/') || f.includes('/test/')) continue;
  const s = readFileSync(f, 'utf8');
  for (const m of s.matchAll(/\b(?:t|translate\([^,]+,|tr)\(\s*'([^'$]+)'/g)) add(m[1], f);
  for (const m of s.matchAll(/\b(?:titleKey|bodyKey|labelKey|messageKey|errorKey)\s*:\s*'([^']+)'/g)) add(m[1], f);
  for (const m of s.matchAll(/\bt\(\s*`([a-zA-Z0-9_.]+)\.\$\{/g)) families.has(m[1]) || families.set(m[1], f);
  for (const m of s.matchAll(/\bt\(\s*`([a-zA-Z0-9_.]+\.)\$\{[^}]+\}(\.[a-z]+)`/g)) families.has(`${m[1].slice(0, -1)}.*${m[2]}`) || families.set(`${m[1].slice(0, -1)}.*${m[2]}`, f);
}

if (process.argv.includes('--list')) {
  console.log(JSON.stringify({ keys: [...keys.keys()].sort(), families: [...families.keys()].sort() }, null, 1));
  process.exit(0);
}

const cat = Object.fromEntries(['en', 'hi', 'te'].map((l) => [l, JSON.parse(readFileSync(join(root, `packages/shared/src/i18n/${l}.json`), 'utf8'))]));
const problems = [];
for (const [k, f] of keys) for (const l of ['en', 'hi', 'te']) if (!(k in cat[l])) problems.push(`missing ${l}: ${k} (${relative(root, f)})`);
for (const l of ['hi', 'te']) {
  for (const k of Object.keys(cat.en)) if (!(k in cat[l])) problems.push(`missing ${l}: ${k} (catalogue parity)`);
  for (const k of Object.keys(cat[l])) if (!(k in cat.en)) problems.push(`extra ${l}: ${k}`);
}
const ph = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
for (const k of Object.keys(cat.en)) for (const l of ['hi', 'te']) if (k in cat[l] && ph(cat.en[k]) !== ph(cat[l][k])) problems.push(`placeholder mismatch ${l}: ${k}`);
for (const [p, f] of families) {
  const [head, tail] = p.split('.*');
  const has = Object.keys(cat.en).some((k) => (tail ? k.startsWith(`${head}.`) && k.endsWith(tail) : k.startsWith(`${p}.`)));
  if (!has) problems.push(`no entries for dynamic family ${p}.* (${relative(root, f)})`);
}

// Literal strings in JSX.
// DECISION (owner delegated, 2026-11-24): the ported CRM and ERP screens are English-only for now (KNOWN GAP, to be translated
// to Hindi/Telugu). Only the literal-text check is skipped for them; key parity checks above still apply to everything.
const ENGLISH_ONLY = ['apps/web/app/crm', 'apps/web/app/erp', 'apps/web/components/crm', 'apps/web/components/erp', 'apps/web/lib/crm', 'apps/web/lib/erp'].map((d) => join(root, d));
for (const f of files.filter((x) => x.endsWith('.tsx') && !ENGLISH_ONLY.some((d) => x.startsWith(d)))) {
  const s = readFileSync(f, 'utf8').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
  const lines = s.split('\n');
  lines.forEach((line, i) => {
    if (/i18n-ignore/.test(line)) return;
    for (const m of line.matchAll(/>([^<>{}]*[A-Za-zऀ-౿]{2,}[^<>{}]*)</g)) {
      const txt = m[1].trim();
      // Skip code that only looks like text: generics (post<T>(…)), comparisons and ternaries inside {…}.
      if (!txt || /^[\s·•—–:;,.()\-/|*#%✓★›‹×+]+$/.test(txt) || /[?(=;]|=>|&&|\breturn\b/.test(txt) || /^[a-z][A-Za-z]*$/.test(txt) || /\bPromise\b/.test(txt)) continue;
      if (/^\s*[({]/.test(line.slice(m.index + m[0].length - 1 + 1))) continue;
      problems.push(`literal text in JSX: "${txt.slice(0, 60)}" (${relative(root, f)}:${i + 1})`);
    }
    for (const m of line.matchAll(/\b(placeholder|title|alt|aria-label|label)="([^"]*[A-Za-z]{2,}[^"]*)"/g)) problems.push(`literal ${m[1]}="${m[2]}" (${relative(root, f)}:${i + 1})`);
  });
}

if (problems.length) {
  console.error(problems.join('\n'));
  console.error(`\n${problems.length} i18n problem(s).`);
  process.exit(1);
}
console.log(`i18n OK: ${keys.size} keys, ${families.size} dynamic families, ${Object.keys(cat.en).length} catalogue entries × 3 languages.`);
