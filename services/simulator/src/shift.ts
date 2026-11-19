import type { PumpId, ShiftSummary } from '@desal/schema';
import { TICK_PLANT_S } from './constants.js';
import { allocationUsd, credit } from './economy.js';
import { nextRandom } from './rng.js';
import { drawChaosPlan } from './scenario/draw.js';
import { loadScenario } from './scenario/engine.js';
import { scenarioForShift } from './scenario/library.js';
import type { Scenario } from './scenario/types.js';
import { noFaults, type Loop, type PlantState, type SimEvent } from './state.js';

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

/** The previous shift's in-spec water against its target, if there was one. */
const previousResult = (s: PlantState): { productM3: number; targetM3: number } | null =>
  s.shift ? { productM3: s.shift.acc.productM3, targetM3: s.shift.target.productM3 } : null;

/**
 * Draw the next shift's chaos plan (shift `run.shiftNumber + 1`) and store it as `chaos.pending`.
 * The shift's starting conditions are drawn first, from the same seed sequence, and stored on the
 * plan so the orders quote exactly what the player will get. Advances `seed`; called at game
 * creation and at every shift end.
 */
export function drawPendingPlan(s: PlantState): PlantState {
  const shiftNumber = s.run.shiftNumber + 1;
  const [value, afterScenario] = nextRandom(s.seed);
  const { initial } = scenarioForShift(shiftNumber, Math.floor(value * 4294967296));
  const [plan, seed] = drawChaosPlan({ shiftNumber, seed: afterScenario, lastWasHell: s.chaos.lastWasHell, state: s, initial });
  return { ...s, seed, chaos: { ...s.chaos, pending: plan } };
}

const PUMP_START_ORDER = ['P-101', 'P-102', 'P-103'] as const;

/**
 * The oncoming crew lines up the plant: if fewer than two intake pumps run, start available ones
 * (stopped, not under overhaul, not worn out), duty pumps first. Only at shift start; Auto never
 * starts a pump mid-shift.
 */
function lineUpPumps(intake: PlantState['intake']): PlantState['intake'] {
  const pumps = { ...intake.pumps };
  let running = PUMP_START_ORDER.filter((id) => pumps[id].running).length;
  for (const id of PUMP_START_ORDER) {
    if (running >= 2) break;
    const p = pumps[id];
    if (p.running || p.overhaulRemainingTicks > 0 || p.wear >= 1) continue;
    pumps[id] = { ...p, running: true };
    running++;
  }
  return { ...intake, pumps };
}

/**
 * Begin a shift: activate the pending plan (drawing one now if the state has none, e.g. a bare
 * test state), apply its starting conditions, reset shift accumulators, clear the crew and every
 * per-shift fault, abandon any restart left in progress, its scenario, reset shift accumulators, abandon any restart left in progress,
 * set the loop modes for the chosen control mode, and credit the shift's allocation (scaled by how
 * much in-spec water the previous shift delivered against its target).
 */
export function startShift(s: PlantState, mode: 'auto' | 'manual'): { state: PlantState; events: SimEvent[] } {
  const shiftNumber = s.run.shiftNumber + 1;
  const drawn = s.chaos.pending?.shiftNumber === shiftNumber ? s : drawPendingPlan(s);
  const plan = drawn.chaos.pending!;
  const scenario: Scenario = {
    id: `shift-${shiftNumber}`,
    target: { productM3: plan.targetM3, maxSalinityPpm: plan.orders.maxSalinityPpm, fuelBudgetUsd: plan.orders.budgetUsd },
    initial: plan.initial,
    events: [],
  };
  const loaded = loadScenario(abandonCarriedRestart(drawn), scenario);
  const allocation = allocationUsd(shiftNumber, previousResult(s));
  const started: PlantState = {
    ...loaded,
    run: { ...s.run, shiftNumber },
    chaos: {
      pending: null,
      active: { plan, fired: [], lastFiredMinute: null, nextEventId: plan.queue.length + 1 },
      lastWasHell: plan.hell,
    },
    intake: lineUpPumps(loaded.intake),
    crew: null,
    faults: noFaults(),
    controlMode: mode,
    phase: 'running',
    loops: withModes(loaded.loops, mode),
    shift: {
      id: shiftNumber,
      startTick: s.tick,
      mode,
      target: { ...scenario.target },
      acc: { productM3: 0, offSpecM3: 0, offSpecTicks: 0, fuelCostUsd: 0, trips: 0, spentUsd: 0 },
    },
  };
  const funded = credit(started, allocation, 'allocation');
  return {
    state: funded.state,
    events: [
      {
        type: 'shiftStart',
        tick: s.tick,
        plantTime: s.plantTime,
        shiftId: shiftNumber,
        scenarioId: scenario.id,
        mode,
        target: { ...scenario.target },
        hell: plan.hell,
        orders: plan.orders,
      },
      funded.event,
    ],
  };
}

/**
 * End the running shift: emit `shiftEnd` with its summary and return to handover. There is no fine
 * for a shortfall; it shows up as a smaller next allocation. All plant state is kept, and so is
 * `shift` (its id and final accumulators) until the next startShift. The next shift's plan is
 * drawn here so the handover screen can show its orders.
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
    offSpecM3: acc.offSpecM3,
    fuelCostUsd: acc.fuelCostUsd,
    fuelBudgetUsd: target.fuelBudgetUsd,
    trips: acc.trips,
    spentUsd: acc.spentUsd,
    nextAllocationUsd: allocationUsd(shift.id + 1, { productM3: acc.productM3, targetM3: target.productM3 }),
    balanceUsd: s.run.balanceUsd,
    damage: {
      maxHardScaleMm: s.stages.reduce((m, st) => Math.max(m, st.hardScaleMm), 0),
      pumpWear,
      burnerCondition: s.heater.burnerCondition,
    },
    hell: s.chaos.active?.plan.hell ?? false,
    // Only events that fired; queue entries that never fired are omitted.
    events: (s.chaos.active?.fired ?? []).map(({ eventId, kind, atMinute, cleared, how }) => ({ eventId, kind, atMinute, cleared, how })),
  };
  const ended: PlantState = {
    ...s,
    phase: 'handover',
    run: { ...s.run, totalProductM3: s.run.totalProductM3 + acc.productM3, shiftsCompleted: s.run.shiftsCompleted + 1 },
    chaos: { ...s.chaos, active: null },
  };
  return {
    state: drawPendingPlan(ended),
    events: [{ type: 'shiftEnd', tick: s.tick, plantTime: s.plantTime, shiftId: shift.id, summary }],
  };
}
