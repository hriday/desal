import type { PumpId, ShiftSummary } from '@desal/schema';
import { TICK_PLANT_S } from './constants.js';
import { nextRandom } from './rng.js';
import { loadScenario } from './scenario/engine.js';
import { scenarioForShift } from './scenario/library.js';
import type { Loop, PlantState, SimEvent } from './state.js';

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

/**
 * A restart carried over handover belongs to the previous shift's control mode (a Manual sequence
 * cannot be continued, nor an Auto one restarted, in the other mode). Abandon it: back to tripped
 * with the burner off, no damage, the original trip record kept.
 */
function abandonCarriedRestart(s: PlantState): PlantState {
  if (s.status !== 'restarting') return s;
  return { ...s, status: 'tripped', restart: null, loops: { ...s.loops, tbt: { ...s.loops.tbt, output: 0 } } };
}

/**
 * Begin a shift: draw its scenario, reset shift accumulators, abandon any restart left in progress,
 * and set the loop modes for the chosen control mode.
 */
export function startShift(s: PlantState, mode: 'auto' | 'manual'): { state: PlantState; events: SimEvent[] } {
  const shiftNumber = s.run.shiftNumber + 1;
  const [value, seed] = nextRandom(s.seed);
  const scenario = scenarioForShift(shiftNumber, Math.floor(value * 4294967296));
  const loaded = loadScenario(abandonCarriedRestart({ ...s, seed }), scenario);
  const state: PlantState = {
    ...loaded,
    run: { ...s.run, shiftNumber },
    controlMode: mode,
    phase: 'running',
    loops: withModes(loaded.loops, mode),
    shift: {
      id: shiftNumber,
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
        shiftId: shiftNumber,
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
export function endShift(s: PlantState): { state: PlantState; events: SimEvent[] } {
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
    revenueUsd: 0,
    finesUsd: 0,
    balanceUsd: s.run.balanceUsd,
    damage: {
      maxHardScaleMm: s.stages.reduce((m, st) => Math.max(m, st.hardScaleMm), 0),
      pumpWear,
      burnerCondition: s.heater.burnerCondition,
    },
  };
  return {
    state: {
      ...s,
      phase: 'handover',
      run: { ...s.run, totalProductM3: s.run.totalProductM3 + acc.productM3, shiftsCompleted: s.run.shiftsCompleted + 1 },
    },
    events: [{ type: 'shiftEnd', tick: s.tick, plantTime: s.plantTime, shiftId: shift.id, summary }],
  };
}
