/**
 * Translation layer shared by web and mobile (rule 6). Catalogues are flat JSON per language.
 * `t(lang, key, vars)` falls back to English, then to the key itself (caught by the i18n check).
 */
import en from './en.json';
import hi from './hi.json';
import te from './te.json';

export const LANGUAGES = ['en', 'hi', 'te'] as const;
export type Lang = (typeof LANGUAGES)[number];
export const LANGUAGE_NAMES: Record<Lang, string> = { en: 'English', hi: 'हिन्दी', te: 'తెలుగు' };

export type Catalog = Record<string, string>;
export const catalogs: Record<Lang, Catalog> = { en, hi, te };
export type MessageKey = keyof typeof en;

export function isLang(v: unknown): v is Lang {
  return typeof v === 'string' && (LANGUAGES as readonly string[]).includes(v);
}

export function translate(lang: Lang, key: string, vars?: Record<string, string | number>): string {
  const raw = catalogs[lang][key] ?? catalogs.en[key] ?? key;
  if (!vars) return raw;
  return raw.replace(/\{(\w+)\}/g, (_, k: string) => (vars[k] === undefined ? `{${k}}` : String(vars[k])));
}

/** Picks a label from an {en,hi,te} object stored in configuration tables. */
export function pickLabel(lang: Lang, value: Partial<Record<Lang, string>> | null | undefined, fallback = ''): string {
  if (!value) return fallback;
  return value[lang] || value.en || fallback;
}

export function makeT(lang: Lang) {
  return (key: string, vars?: Record<string, string | number>) => translate(lang, key, vars);
}
export type TFn = ReturnType<typeof makeT>;
