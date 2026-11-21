import { defineConfig } from 'vitest/config';

// Integration tests need the docker compose Kafka running (see infra/). flink.int.test.ts also
// needs both Flink jobs running on its topics, so it runs only through scripts/e2e-flink.sh,
// which sets DESAL_E2E_FLINK=1.
export default defineConfig({
  test: {
    globals: true,
    include: ['test/**/*.int.test.ts'],
    exclude: ['node_modules/**', ...(process.env.DESAL_E2E_FLINK === '1' ? [] : ['test/flink.int.test.ts'])],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
