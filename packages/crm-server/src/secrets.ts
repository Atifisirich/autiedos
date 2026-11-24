// Provider credentials per org (WhatsApp token, Meta app secret and verify token, page token), AES-256-GCM.
// The key comes from APP_SECRET, so the database alone is not enough to read them. Rows live in crm.org_secrets
// (module `secrets`: only roles with admin F and the automation user can read them).
import crypto from 'node:crypto';
import type { Db } from './db';

function key(): Buffer {
  const secret = process.env.APP_SECRET;
  if (!secret && process.env.NODE_ENV === 'production') throw new Error('APP_SECRET must be set to store provider credentials.');
  return crypto.createHash('sha256').update(secret ?? 'autoed-dev-secret').digest();
}

export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv.toString('base64'), c.getAuthTag().toString('base64'), data.toString('base64')].join('.');
}

export function decrypt(enc: string): string {
  const [iv, tag, data] = enc.split('.').map((p) => Buffer.from(p, 'base64')) as [Buffer, Buffer, Buffer];
  const d = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString('utf8');
}

export async function setSecret(db: Db, name: string, value: string) {
  await db.q(
    `insert into crm.org_secrets (org_id, key, value_enc) values ($1,$2,$3)
     on conflict (org_id, key) do update set value_enc = excluded.value_enc, updated_at = now()`,
    [db.requireOrg(), name, encrypt(value)],
  );
}

export async function getSecret(db: Db, name: string): Promise<string | null> {
  const r = await db.one('select value_enc from crm.org_secrets where org_id = $1 and key = $2', [db.requireOrg(), name]);
  if (!r) return null;
  try {
    return decrypt(r.value_enc);
  } catch {
    return null;
  }
}

export async function deleteSecret(db: Db, name: string) {
  await db.q('delete from crm.org_secrets where org_id = $1 and key = $2', [db.requireOrg(), name]);
}

/** Last four characters only, for showing that a secret is set. */
export async function secretHint(db: Db, name: string): Promise<string | null> {
  const v = await getSecret(db, name);
  return v ? '••••' + v.slice(-4) : null;
}
