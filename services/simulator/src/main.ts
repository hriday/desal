import { randomInt } from 'node:crypto';
import { GameHost } from './host.js';
import { createKafka, ensureTopics, waitForTopics } from './kafka/client.js';
import { loadGames, SimRunner } from './kafka/runner.js';

const log = (m: string) => console.log(`[sim] ${m}`);

/** Usage: pnpm --filter @desal/simulator start */
async function main(): Promise<void> {
  const kafka = createKafka();
  await ensureTopics(kafka);
  // Fresh topics need a moment before their metadata is everywhere; reading or
  // subscribing before that fails with ERR_UNKNOWN_TOPIC_OR_PART.
  await waitForTopics(kafka, { log });

  const games = await loadGames(kafka, (m) => console.warn(`[sim] ${m}`));
  for (const g of games) log(`resuming game ${g.run.gameId} at tick ${g.tick}, shift ${g.run.shiftNumber} (${g.phase})`);

  // A random host seed: each new game's plant seed is drawn from it, so games differ across runs.
  const host = new GameHost({ seed: randomInt(0, 2 ** 32) });
  // A fatal runner error has already saved every game and disconnected.
  const runner = new SimRunner(kafka, host, { onFatal: () => process.exit(1) });
  await runner.start(games);

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log(`${signal}: saving and shutting down`);
    try {
      await runner.stop();
    } catch (e) {
      console.error('[sim] shutdown failed:', e);
      process.exit(1);
    }
    process.exit(runner.failed ? 1 : 0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((e: unknown) => {
  console.error('[sim] fatal:', e);
  process.exit(1);
});
