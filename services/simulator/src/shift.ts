import type { PlantEvent } from '@desal/schema';
import { nextRandom } from './rng.js';
import { loadScenario } from './scenario/engine.js';
import { scenarioForShift } from './scenario/library.js';
import type { Loop, PlantState } from './state.js';

function withModes(loops: PlantState['loops'], mode: 'auto' | 'manual'): PlantState['loops'] {
  const nonLevel: Loop['mode'] = mode === 'manual' ? 'manual' : 'auto';
  return {
    tbt: { ...loops.tbt, mode: nonLevel },
    intakeFlow: { ...loops.intakeFlow, mode: nonLevel },
    recirc: { ...loops.recirc, mode: nonLevel },
    blowdown: { ...loops.blowdown, mode: nonLevel },
    vacuum: { ...loops.vacuum, mode: nonLevel },
    levels: loops.levels.map((l) => ({ ...l, mode: 'auto' as const })),
  };
}

/** Begin a shift: draw its scenario, reset shift accumulators, and set the loop modes for the chosen control mode. */
export function startShift(s: PlantState, mode: 'auto' | 'manual'): { state: PlantState; events: PlantEvent[] } {
  const careerShiftCount = s.careerShiftCount + 1;
  const [value, seed] = nextRandom(s.seed);
  const scenario = scenarioForShift(careerShiftCount, Math.floor(value * 4294967296));
  const loaded = loadScenario({ ...s, seed }, scenario);
  const state: PlantState = {
    ...loaded,
    careerShiftCount,
    controlMode: mode,
    phase: 'running',
    loops: withModes(loaded.loops, mode),
    shift: {
      id: careerShiftCount,
      startTick: s.tick,
      mode,
      target: { ...scenario.target },
      acc: { productM3: 0, offSpecTicks: 0, fuelCostUsd: 0, trips: 0 },
    },
  };
  return {
    state,
    events: [
      {
        type: 'shiftStart',
        tick: s.tick,
        plantTime: s.plantTime,
        shiftId: careerShiftCount,
        scenarioId: scenario.id,
        mode,
        target: { ...scenario.target },
      },
    ],
  };
}
