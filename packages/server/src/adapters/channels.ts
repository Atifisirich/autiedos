/**
 * Delivery adapters: push (Expo), WhatsApp (the CRM's provider), email, file storage,
 * embeddings. Each has a mock used until credentials are provided (PRD 1.3).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';

// ---------------------------------------------------------------- push
export interface PushMessage {
  token: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}
export interface PushAdapter {
  name: string;
  send(msgs: PushMessage[]): Promise<{ token: string; ok: boolean; error?: string }[]>;
}

const expoPush: PushAdapter = {
  name: 'expo',
  async send(msgs) {
    const res = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(process.env.EXPO_ACCESS_TOKEN ? { authorization: `Bearer ${process.env.EXPO_ACCESS_TOKEN}` } : {}) },
      body: JSON.stringify(msgs.map((m) => ({ to: m.token, title: m.title, body: m.body, data: m.data, sound: 'default' }))),
    });
    const body = (await res.json()) as { data?: { status: string; message?: string }[] };
    return msgs.map((m, i) => ({ token: m.token, ok: body.data?.[i]?.status === 'ok', error: body.data?.[i]?.message }));
  },
};

export const sentPush: PushMessage[] = [];
const mockPush: PushAdapter = {
  name: 'mock',
  async send(msgs) {
    sentPush.push(...msgs);
    return msgs.map((m) => ({ token: m.token, ok: true }));
  },
};

export function getPush(): PushAdapter {
  return process.env.PUSH_PROVIDER === 'expo' ? expoPush : mockPush;
}

// ---------------------------------------------------------------- WhatsApp
export interface WhatsAppMessage {
  to: string;
  template: string;
  language: string;
  variables: string[];
}
export interface WhatsAppAdapter {
  name: string;
  send(m: WhatsAppMessage): Promise<{ ok: boolean; ref?: string; error?: string }>;
}

/**
 * Generic HTTP adapter for the CRM's messaging provider. Configure WHATSAPP_API_URL and
 * WHATSAPP_API_TOKEN; the payload follows the template-message shape most Indian BSPs accept.
 */
const httpWhatsApp: WhatsAppAdapter = {
  name: 'http',
  async send(m) {
    const res = await fetch(process.env.WHATSAPP_API_URL!, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.WHATSAPP_API_TOKEN}` },
      body: JSON.stringify({ to: m.to, type: 'template', template: { name: m.template, language: { code: m.language }, components: [{ type: 'body', parameters: m.variables.map((v) => ({ type: 'text', text: v })) }] } }),
    });
    if (!res.ok) return { ok: false, error: `http_${res.status}` };
    const body = (await res.json().catch(() => ({}))) as { id?: string; messages?: { id: string }[] };
    return { ok: true, ref: body.id ?? body.messages?.[0]?.id };
  },
};

export const sentWhatsApp: WhatsAppMessage[] = [];
const mockWhatsApp: WhatsAppAdapter = {
  name: 'mock',
  async send(m) {
    sentWhatsApp.push(m);
    return { ok: true, ref: `mock-${sentWhatsApp.length}` };
  },
};

export function getWhatsApp(): WhatsAppAdapter {
  return process.env.WHATSAPP_API_URL && process.env.WHATSAPP_API_TOKEN ? httpWhatsApp : mockWhatsApp;
}

// ---------------------------------------------------------------- email (scheduled reports only)
export const sentEmail: { to: string; subject: string; html: string }[] = [];
export async function sendEmail(to: string, subject: string, html: string): Promise<void> {
  if (process.env.RESEND_API_KEY) {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: process.env.EMAIL_FROM ?? 'AutoEd OS <reports@autoed.app>', to, subject, html }),
    });
    return;
  }
  sentEmail.push({ to, subject, html });
}

// ---------------------------------------------------------------- storage
/**
 * Private files. On Supabase: bucket `os-files`, paths prefixed with the org id, signed URLs.
 * Locally: files under STORAGE_DIR and HMAC-signed URLs served by /api/os/files.
 */
const BUCKET = 'os-files';
const secret = () => process.env.STORAGE_SIGNING_SECRET ?? process.env.AUTH_JWT_SECRET ?? 'dev-storage-secret-change-me';
const localDir = () => process.env.STORAGE_DIR ?? join(process.cwd(), '.storage');
const supa = () => (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY ? { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY } : null);

function sign(path: string, exp: number, op: string) {
  return createHmac('sha256', secret()).update(`${op}:${path}:${exp}`).digest('hex');
}

export function verifyLocalSignature(path: string, exp: number, sig: string, op: 'get' | 'put'): boolean {
  if (Date.now() / 1000 > exp) return false;
  const expected = Buffer.from(sign(path, exp, op));
  const got = Buffer.from(sig);
  return expected.length === got.length && timingSafeEqual(expected, got);
}

export async function signedUploadUrl(path: string): Promise<{ url: string; method: 'PUT' | 'POST'; headers: Record<string, string> }> {
  const s = supa();
  if (s) {
    const res = await fetch(`${s.url}/storage/v1/object/upload/sign/${BUCKET}/${path}`, { method: 'POST', headers: { authorization: `Bearer ${s.key}`, apikey: s.key } });
    const body = (await res.json()) as { url: string };
    return { url: `${s.url}/storage/v1${body.url}`, method: 'PUT', headers: {} };
  }
  const exp = Math.floor(Date.now() / 1000) + 900;
  return { url: `/api/os/files/${path}?exp=${exp}&sig=${sign(path, exp, 'put')}`, method: 'PUT', headers: {} };
}

export async function signedDownloadUrl(path: string, seconds = 600): Promise<string> {
  const s = supa();
  if (s) {
    const res = await fetch(`${s.url}/storage/v1/object/sign/${BUCKET}/${path}`, { method: 'POST', headers: { authorization: `Bearer ${s.key}`, apikey: s.key, 'content-type': 'application/json' }, body: JSON.stringify({ expiresIn: seconds }) });
    const body = (await res.json()) as { signedURL: string };
    return `${s.url}/storage/v1${body.signedURL}`;
  }
  const exp = Math.floor(Date.now() / 1000) + seconds;
  return `/api/os/files/${path}?exp=${exp}&sig=${sign(path, exp, 'get')}`;
}

function safeLocal(path: string): string {
  const p = normalize(path).replace(/^(\.\.(\/|\\|$))+/, '');
  if (p.includes('..')) throw new Error('bad path');
  return join(localDir(), p);
}

export async function writeLocalFile(path: string, data: Buffer): Promise<void> {
  const full = safeLocal(path);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, data);
}

export async function readLocalFile(path: string): Promise<Buffer> {
  return readFile(safeLocal(path));
}

export async function deleteObject(path: string): Promise<void> {
  const s = supa();
  if (s) {
    await fetch(`${s.url}/storage/v1/object/${BUCKET}`, { method: 'DELETE', headers: { authorization: `Bearer ${s.key}`, apikey: s.key, 'content-type': 'application/json' }, body: JSON.stringify({ prefixes: [path] }) });
    return;
  }
  const { rm } = await import('node:fs/promises');
  await rm(safeLocal(path), { force: true });
}

// ---------------------------------------------------------------- embeddings
/**
 * Local embedding: feature-hashed bag of words and bigrams, L2-normalised (256 dims).
 * Works offline and keeps uploads inside the database; swap for a hosted embedding model
 * by replacing this function and the vector dimension in a migration.
 */
export const EMBED_DIM = 256;
export function embed(text: string): number[] {
  const v = new Array<number>(EMBED_DIM).fill(0);
  const tokens = text
    .toLowerCase()
    .normalize('NFKC')
    .split(/[^\p{L}\p{N}\p{M}]+/u)
    .filter((t) => t.length > 1);
  const grams = [...tokens, ...tokens.slice(1).map((t, i) => `${tokens[i]}_${t}`)];
  for (const g of grams) {
    let h = 2166136261;
    for (let i = 0; i < g.length; i++) h = Math.imul(h ^ g.charCodeAt(i), 16777619);
    const idx = Math.abs(h) % EMBED_DIM;
    v[idx]! += h & 1 ? 1 : -1;
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => Math.round((x / norm) * 1e6) / 1e6);
}

export function toVectorLiteral(v: number[]): string {
  return `[${v.join(',')}]`;
}

/** Splits text into ~800 character chunks on paragraph/sentence boundaries. */
export function chunkText(text: string, size = 800): string[] {
  const paras = text.replace(/\r/g, '').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const out: string[] = [];
  let cur = '';
  for (const p of paras) {
    const pieces = p.length > size ? p.match(new RegExp(`[^.!?।]{1,${size}}[.!?।]?`, 'g')) ?? [p] : [p];
    for (const piece of pieces) {
      if ((cur + '\n\n' + piece).length > size && cur) {
        out.push(cur.trim());
        cur = piece;
      } else cur = cur ? `${cur}\n\n${piece}` : piece;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
