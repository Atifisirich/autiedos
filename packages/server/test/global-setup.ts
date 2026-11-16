import { execSync } from 'node:child_process';
import { join } from 'node:path';

/** Fresh database for every test run: migrations + demo seed. */
export default async function setup() {
  const root = join(__dirname, '..', '..', '..');
  execSync(`node ${join(root, 'scripts/db.mjs')} reset`, { stdio: 'inherit' });
  const { seedDemo } = await import('../src/seed/demo');
  const { closePool } = await import('../src/db');
  await seedDemo({});
  await closePool();
}
