import { defineConfig } from 'vitest/config';

/** Tests that need no database (no globalSetup): `pnpm --filter @autoed/server test:unit`. */
export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts'],
    env: { NODE_ENV: 'test' },
  },
});
