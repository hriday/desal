import { randomInt } from 'node:crypto';
import { createKafka, ensureTopics } from './kafka/client.js';
import { loadCareer, SimRunner } from './kafka/runner.js';
import { createInitialState, type PlantState } from './state.js';

/** Usage: pnpm --filter @desal/simulator start [--new-career] */
async function main(): Promise<void> {
  const kafka = createKafka();
  await ensureTopics(kafka);

  let state: PlantState;
  const newCareer = () => createInitialState(randomInt(0, 2 ** 32), Date.now());
  if (process.argv.includes('--new-career')) {
    console.log('[sim] --new-career: starting a fresh career');
    state = newCareer();
  } else {
    const career = await loadCareer(kafka);
    if (career.kind === 'corrupt') {
      console.error(`[sim] saved career is corrupt: ${career.reason}`);
      console.error('[sim] run with --new-career to start over (your old save stays in the topic history)');
      process.exit(1);
    }
    if (career.kind === 'found') {
      console.log(`[sim] resuming career at tick ${career.state.tick}, shift ${career.state.shift?.id ?? 'none'}`);
      state = career.state;
    } else {
      console.log('[sim] no saved career: starting a fresh one');
      state = newCareer();
    }
  }

  const runner = new SimRunner(kafka, state);
  await runner.start();

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`[sim] ${signal}: saving and shutting down`);
    await runner.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((e: unknown) => {
  console.error('[sim] fatal:', e);
  process.exit(1);
});
