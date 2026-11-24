import { defineConfig } from 'vitest/config';

/** Tests that need no database: part of the repo-wide `pnpm test`. The database suite is `pnpm test:crm`. */
export default defineConfig({
  test: { include: ['test/migration.test.ts', 'test/totp.test.ts'], testTimeout: 20000 },
});
