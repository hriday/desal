# End-to-end smoke

`e2e/play.spec.ts` plays one run in Chromium against the real stack.

## Run

Kafka must be up on `localhost:9092`. Then, from `apps/web`:

```sh
pnpm exec playwright install chromium   # once
pnpm e2e
```

Playwright's `webServer` (see `playwright.config.ts`) starts, and stops afterwards:

1. the simulator: `pnpm --filter @desal/simulator start` (ready when it logs `running with N live game(s)`);
2. the gateway: `pnpm --filter @desal/gateway start` on port 8081 (ready when `/healthz` answers 200);
3. the page: `vite build && vite preview --port 4173` built with `VITE_WS_URL=ws://localhost:8081/ws`.

If the simulator and gateway are already running, skip them with `E2E_EXTERNAL_STACK=1 pnpm e2e`.
Set `VITE_WS_URL` to point the page at another gateway, and `E2E_SCREENSHOT=<path>` to choose where the
screenshot of the live control room is saved (default `test-results/live-room.png`).

The spec starts exactly one game: the gateway allows one `newGame` per 10 s per client, so wait 10 s
between back-to-back runs.
