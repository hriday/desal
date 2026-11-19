import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['test/**/*.test.ts'],
    // Integration tests need a running Kafka; they run via `pnpm test:int`.
    exclude: ['test/**/*.int.test.ts', 'node_modules/**'],
  },
});
