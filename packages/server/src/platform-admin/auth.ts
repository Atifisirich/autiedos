/**
 * Sign-in of AutoEd staff. Credentials live in Supabase Auth (phone/e-mail OTP or password, decision 36); the console
 * only turns a verified Supabase access token into its own short-lived session (issuer `autoed-admin`, 8 hours).
 * The session proves identity only: whether the person is a platform admin is asked of the database
 * (`app.is_platform_admin()`) on EVERY request, so removing an admin takes effect on their next request.
 */
import { SignJWT, jwtVerify, createRemoteJWKSet } from 'jose';
import { unauthorized } from './errors';

export interface AdminSession {
  token: string;
  expires_at: string;
}

export interface AdminAuth {
  issue(userId: string): Promise<AdminSession>;
  /** Verifies a console session token; throws a 401 AdminError. */
  verify(token: string | null | undefined): Promise<{ userId: string }>;
  /** Verifies a Supabase Auth access token and returns the auth user id; throws a 401 AdminError. */
  verifyProviderToken(accessToken: string): Promise<string>;
  /** Local development e-mail login (AUTH_PROVIDER=dev and not production). */
  devLoginEnabled(): boolean;
}

const ISSUER = 'autoed-admin';

export function createAdminAuth(env: Record<string, string | undefined> = process.env): AdminAuth {
  const ttl = Number(env.ADMIN_SESSION_TTL_SECONDS ?? 60 * 60 * 8);
  const secret = (): Uint8Array => {
    const s = env.AUTH_JWT_SECRET;
    if (!s && env.NODE_ENV === 'production') throw new Error('AUTH_JWT_SECRET is required in production');
    return new TextEncoder().encode(s ?? 'dev-only-secret-change-me-dev-only-secret');
  };
  let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
  return {
    async issue(userId) {
      const exp = Math.floor(Date.now() / 1000) + ttl;
      const token = await new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setSubject(userId).setIssuedAt().setExpirationTime(exp).setIssuer(ISSUER).sign(secret());
      return { token, expires_at: new Date(exp * 1000).toISOString() };
    },
    async verify(token) {
      if (!token) throw unauthorized();
      try {
        const { payload } = await jwtVerify(token, secret(), { issuer: ISSUER });
        const userId = String(payload.sub ?? '');
        if (!userId) throw new Error('no subject');
        return { userId };
      } catch {
        throw unauthorized('invalid_session');
      }
    },
    async verifyProviderToken(accessToken) {
      try {
        if (env.SUPABASE_JWT_SECRET) {
          const { payload } = await jwtVerify(accessToken, new TextEncoder().encode(env.SUPABASE_JWT_SECRET));
          return String(payload.sub);
        }
        if (!env.SUPABASE_URL) throw new Error('SUPABASE_URL missing');
        jwks ??= createRemoteJWKSet(new URL(`${env.SUPABASE_URL}/auth/v1/.well-known/jwks.json`));
        const { payload } = await jwtVerify(accessToken, jwks);
        return String(payload.sub);
      } catch {
        throw unauthorized('invalid_provider_token');
      }
    },
    devLoginEnabled: () => env.AUTH_PROVIDER === 'dev' && env.NODE_ENV !== 'production',
  };
}
