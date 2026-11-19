import type { PlantEvent, PumpId, ShiftSummary } from '@desal/schema';
import { TICK_PLANT_S } from './constants.js';
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

/**
 * End the running shift: emit `shiftEnd` with its summary and return to handover. All plant state
 * is kept, and so is `shift` (its id and final accumulators) until the next startShift.
 */
export function endShift(s: PlantState): { state: PlantState; events: PlantEvent[] } {
  const shift = s.shift;
  if (!shift) return { state: { ...s, phase: 'handover' }, events: [] };
  const { acc, target } = shift;
  const pumpWear = Object.fromEntries(
    Object.entries(s.intake.pumps).map(([id, p]) => [id, p.wear]),
  ) as Record<PumpId, number>;
  const summary: ShiftSummary = {
    productM3: acc.productM3,
    targetM3: target.productM3,
    offSpecMinutes: (acc.offSpecTicks * TICK_PLANT_S) / 60,
    fuelCostUsd: acc.fuelCostUsd,
    fuelBudgetUsd: target.fuelBudgetUsd,
    trips: acc.trips,
    damage: {
      maxHardScaleMm: s.stages.reduce((m, st) => Math.max(m, st.hardScaleMm), 0),
      pumpWear,
      burnerCondition: s.heater.burnerCondition,
    },
  };
  return {
    state: { ...s, phase: 'handover' },
    events: [{ type: 'shiftEnd', tick: s.tick, plantTime: s.plantTime, shiftId: shift.id, summary }],
  };
}
