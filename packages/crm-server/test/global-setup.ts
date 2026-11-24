import { execSync } from 'node:child_process';
import { join } from 'node:path';

/**
 * An empty platform (only the *_platform_, *_core_master_, *_crm_, ... migrations: no legacy OS tables), rebuilt on
 * every run, in the database named by DATABASE_URL (the owner connection). The tests then connect as the real
 * login roles crm_server and job_runner (trust authentication on the local cluster).
 */
export default function setup() {
  const root = join(__dirname, '..', '..', '..');
  execSync(`node ${join(root, 'scripts/db.mjs')} reset --platform-only`, { stdio: 'inherit', env: process.env });
}
