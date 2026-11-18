import Constants from 'expo-constants';

/** API base URL: EXPO_PUBLIC_API_BASE overrides app.json (so staging builds need no code change). */
export const API_BASE: string = process.env.EXPO_PUBLIC_API_BASE ?? ((Constants.expoConfig?.extra as { apiBase?: string } | undefined)?.apiBase ?? 'http://localhost:3000/api/os');
export const DEV_LOGIN = process.env.EXPO_PUBLIC_AUTH_PROVIDER === 'dev';
