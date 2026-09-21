import { defineConfig } from 'vitest/config';

// Only the pure modules in src/lib are tested here - no React Native runtime.
export default defineConfig({
  test: { include: ['test/**/*.test.ts'], environment: 'node' },
});
