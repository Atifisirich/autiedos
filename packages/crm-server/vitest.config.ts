import { defineConfig } from 'vitest/config';

/**
 * CRM server tests run against a real Postgres: the platform schema (migrations *_platform_, *_core_master_,
 * *_crm_ ...) and the real login roles crm_server / job_runner. DATABASE_URL is the owner connection used for
 * fixtures (and by global-setup to rebuild the database); the server connects as crm_server / job_runner.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 60000,
    hookTimeout: 300000,
    env: { PUSH_DISABLED: '1', NODE_ENV: 'test' },
  },
});
