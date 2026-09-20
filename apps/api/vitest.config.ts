import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['./test/globalSetup.ts'],
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.ts'],
    // The rental invariant tests fire concurrent requests at one Postgres row;
    // running files sequentially keeps their fixtures from colliding.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
