/**
 * The portal's Supabase client. It talks to the Data API as the signed-in user (decision 51): the anon key and the user's own
 * access token only, never a service key. Row-level security is the barrier; this file adds nothing on top of it.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export type Sb = SupabaseClient<any, any, any>;

export const STORAGE_KEY = 'autoed-portal-auth';
let client: Sb | null = null;

/** `null` when the deployment has no Supabase URL / anon key (the sign-in page says so instead of failing). */
export function getSb(): Sb | null {
  if (client) return client;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key || typeof window === 'undefined') return null;
  client = createClient(url, key, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: STORAGE_KEY },
  });
  return client;
}

export const erp = (sb: Sb) => sb.schema('erp');
export const core = (sb: Sb) => sb.schema('core');
