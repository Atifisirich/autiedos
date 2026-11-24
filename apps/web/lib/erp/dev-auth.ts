/**
 * DEV-ONLY authentication shim. Signs HS256 JWTs that a local PostgREST accepts (PGRST_JWT_SECRET = ERP_JWT_SECRET), so the ERP can be
 * exercised without Supabase Auth. It looks the user up in auth.users through DATABASE_URL, which exists only on a developer machine.
 * It is disabled unless ERP_AUTH_PROVIDER=dev (never set in production, where /api/erp/session accepts a Supabase Auth access token).
 */
import { createHmac } from 'node:crypto';

export const devAuthEnabled = () => process.env.ERP_AUTH_PROVIDER === 'dev' && process.env.NODE_ENV !== 'production';

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
export function signDevToken(sub: string, hours = 12): string {
  const secret = process.env.ERP_JWT_SECRET;
  if (!secret) throw new Error('ERP_JWT_SECRET is not set');
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({ role: 'authenticated', sub, aud: 'authenticated', iat: now, exp: now + hours * 3600 });
  const sig = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

export async function findDevUser(email: string): Promise<{ id: string } | null> {
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  try {
    const r = await pool.query('select id from auth.users where lower(email) = lower($1) limit 1', [email.trim()]);
    return r.rows[0] ?? null;
  } finally {
    await pool.end();
  }
}
