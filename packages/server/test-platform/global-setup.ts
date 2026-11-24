import { execSync } from 'node:child_process';
import { join } from 'node:path';

/** An empty platform: ONLY the *_platform_* migrations (no legacy OS tables), rebuilt on every run. */
export default async function setup() {
  const root = join(__dirname, '..', '..', '..');
  const url = process.env.PLATFORM_DATABASE_URL ?? process.env.DATABASE_URL;
  execSync(`node ${join(root, 'scripts/db.mjs')} reset --platform-only`, {
    stdio: 'inherit',
    env: url ? { ...process.env, DATABASE_URL: url } : process.env,
  });
}
