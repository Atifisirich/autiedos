import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';
import { chunkedStorage, type Kv } from './lib/chunked';

// supabase-js needs a complete URL implementation on React Native: add `react-native-url-polyfill` before the first device build
// (see docs/parent-app.md). It is optional here so the project typechecks and the pure logic tests run without it.
try { require('react-native-url-polyfill/auto'); } catch { /* not installed yet */ }

const extra = (Constants.expoConfig?.extra ?? {}) as { supabaseUrl?: string; supabaseAnonKey?: string; webBase?: string };
export const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL ?? extra.supabaseUrl ?? '';
export const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? extra.supabaseAnonKey ?? '';
export const WEB_BASE = process.env.EXPO_PUBLIC_WEB_BASE ?? extra.webBase ?? '';

/** Session in the OS keychain (chunked: a session is longer than one keychain value). Only the anon key and the user's token are ever used. */
const keychain: Kv = {
  get: (k) => SecureStore.getItemAsync(k).catch(() => null),
  set: (k, v) => SecureStore.setItemAsync(k, v),
  del: (k) => SecureStore.deleteItemAsync(k).catch(() => undefined),
};
/** Offline copies of screens: plain storage, scoped per user (they hold what the screens already showed, nothing secret). */
export const files: Kv = {
  get: (k) => AsyncStorage.getItem(k).catch(() => null),
  set: (k, v) => AsyncStorage.setItem(k, v).catch(() => undefined),
  del: (k) => AsyncStorage.removeItem(k).catch(() => undefined),
};

export const supabase = createClient(SUPABASE_URL || 'http://localhost', SUPABASE_ANON_KEY || 'anon', {
  auth: { storage: chunkedStorage(keychain), persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'autoed-parent-auth' },
});
