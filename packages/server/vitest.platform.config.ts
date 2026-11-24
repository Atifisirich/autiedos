import { defineConfig } from 'vitest/config';

/** Platform isolation harness (plan section 8): runs against an empty platform database. */
export default defineConfig({
  test: {
    include: ['test-platform/**/*.test.ts'],
    globalSetup: ['test-platform/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 120000,
    hookTimeout: 300000,
  },
});
