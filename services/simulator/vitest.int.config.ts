import { defineConfig } from 'vitest/config';

// Integration tests need the docker compose Kafka running (see infra/).
export default defineConfig({
  test: {
    globals: true,
    include: ['test/**/*.int.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
