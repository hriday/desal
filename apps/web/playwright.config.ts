import { defineConfig, devices } from '@playwright/test';

const WS_URL = process.env.VITE_WS_URL ?? 'ws://localhost:8081/ws';
const PREVIEW_PORT = 4173;
/** E2E_EXTERNAL_STACK=1: the simulator and gateway are already running (see e2e/README.md). */
const external = process.env.E2E_EXTERNAL_STACK === '1';
const graceful = { signal: 'SIGTERM' as const, timeout: 10_000 };

const stack = [
  {
    name: 'simulator',
    command: 'pnpm --filter @desal/simulator start',
    wait: { stdout: /running with \d+ live game/ },
    timeout: 120_000,
    gracefulShutdown: graceful,
  },
  {
    name: 'gateway',
    command: 'pnpm --filter @desal/gateway start',
    url: 'http://localhost:8081/healthz', // 503 until Kafka is joined
    timeout: 120_000,
    gracefulShutdown: graceful,
  },
];

export default defineConfig({
  testDir: 'e2e',
  timeout: 120_000,
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: `http://localhost:${PREVIEW_PORT}`,
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
  },
  webServer: [
    ...(external ? [] : stack),
    {
      name: 'web',
      command: `pnpm exec vite build && pnpm exec vite preview --port ${PREVIEW_PORT} --strictPort`,
      env: { VITE_WS_URL: WS_URL },
      url: `http://localhost:${PREVIEW_PORT}`,
      timeout: 120_000,
    },
  ],
});
