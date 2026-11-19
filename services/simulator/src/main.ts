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
      console.error(
        '[sim] run with --new-career to start over; older saves may still be in the topic until compaction',
      );
      process.exit(1);
    }
    if (career.kind === 'found') {
      for (const s of career.skipped) {
        console.warn(`[sim] skipped an invalid save at plant.state offset ${s.offset}: ${s.reason}`);
      }
      if (career.skipped.length > 0) console.warn('[sim] fell back to the newest valid save');
      console.log(`[sim] resuming career at tick ${career.state.tick}, shift ${career.state.shift?.id ?? 'none'}`);
      state = career.state;
    } else {
      console.log('[sim] no saved career: starting a fresh one');
      state = newCareer();
    }
  }

  // A fatal runner error has already saved the last good state and disconnected.
  const runner = new SimRunner(kafka, state, { onFatal: () => process.exit(1) });
  await runner.start();

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`[sim] ${signal}: saving and shutting down`);
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
