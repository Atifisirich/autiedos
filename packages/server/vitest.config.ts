import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 120000,
    hookTimeout: 600000,
    env: { AI_RATE_PER_MINUTE: '10000', AUTH_PROVIDER: 'dev', NODE_ENV: 'test', STORAGE_DIR: '/tmp/autoed-test-storage' },
  },
});
