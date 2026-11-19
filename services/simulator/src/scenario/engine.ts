import type { PumpId, ScenarioKind } from '@desal/schema';
import { GAS_BASE_PRICE_USD_PER_GJ, GAS_CAP_MW, TICK_PLANT_S } from '../constants.js';
import { nextRandom } from '../rng.js';
import type { Loop, PlantState, SimEvent } from '../state.js';
import { drawEvent } from './library.js';
import type { Scenario } from './types.js';

const clearFault = (l: Loop): Loop => ({ ...l, fault: null });

/**
 * Store a scenario in the state, reset its progress and effects, and apply its initial conditions.
 * Supply conditions and controller faults are per shift, so they are reset here: gas goes back to
 * full supply at the base price (or the scenario's initial override) with no pending curtailment,
 * and every loop fault is cleared. Physical damage (scale, wear, bearingWearMult, burner
 * condition, backup tank level) is persistent and is not touched.
 */
export function loadScenario(s: PlantState, scenario: Scenario): PlantState {
  const l = s.loops;
  return {
    ...s,
    fuel: {
      ...s.fuel,
      gas: {
        capMW: scenario.initial.gasCapMW ?? GAS_CAP_MW,
        priceUsdPerGJ: scenario.initial.gasPriceUsdPerGJ ?? GAS_BASE_PRICE_USD_PER_GJ,
        curtailmentNotice: null,
      },
    },
    loops: {
      tbt: clearFault(l.tbt),
      intakeFlow: clearFault(l.intakeFlow),
      recirc: clearFault(l.recirc),
      blowdown: clearFault(l.blowdown),
      vacuum: clearFault(l.vacuum),
      levels: l.levels.map(clearFault),
    },
    seawater: {
      ...s.seawater,
      tempC: scenario.initial.seawaterTempC,
      chlorophyllUgL: scenario.initial.chlorophyllUgL,
    },
    scenario: {
      id: scenario.id,
      definition: scenario,
      nextEventIndex: 0,
      effects: {
        offgradeOnly: false,
        deliveryDelayTicks: 0,
        chlorophyllTarget: scenario.initial.chlorophyllUgL,
        chlorophyllRampPerTick: 0,
      },
    },
  };
}

function setLoopFault(s: PlantState, loopId: string, kind: string): PlantState {
  const fault = { kind: kind as 'stuck' | 'drift' | 'oscillate', bias: 0 };
  const level = /^level(\d+)$/.exec(loopId);
  if (level) {
    const i = Number(level[1]) - 1;
    if (!s.loops.levels[i]) return s;
    const levels = s.loops.levels.map((x, j): Loop => (j === i ? { ...x, fault } : x));
    return { ...s, loops: { ...s.loops, levels } };
  }
  if (loopId === 'tbt' || loopId === 'intakeFlow' || loopId === 'recirc' || loopId === 'blowdown' || loopId === 'vacuum') {
    return { ...s, loops: { ...s.loops, [loopId]: { ...s.loops[loopId], fault } } };
  }
  return s;
}

function applyEffect(s: PlantState, kind: ScenarioKind, p: Record<string, number | string>): PlantState {
  if (!s.shift) return s;
  switch (kind) {
    case 'bloom': {
      const peak = Number(p.peakUgL);
      const ticks = Math.max(1, (Number(p.rampMinutes) * 60) / TICK_PLANT_S);
      return {
        ...s,
        scenario: {
          ...s.scenario,
          effects: {
            ...s.scenario.effects,
            chlorophyllTarget: peak,
            chlorophyllRampPerTick: (peak - s.seawater.chlorophyllUgL) / ticks,
          },
        },
      };
    }
    case 'seawaterTemp':
      return { ...s, seawater: { ...s.seawater, tempC: s.seawater.tempC + Number(p.deltaC) } };
    case 'pumpBearing': {
      const id = p.pumpId as PumpId;
      const pump = s.intake.pumps[id];
      if (!pump) return s;
      return {
        ...s,
        intake: { ...s.intake, pumps: { ...s.intake.pumps, [id]: { ...pump, bearingWearMult: Number(p.mult) } } },
      };
    }
    case 'gasCurtailNotice':
      return {
        ...s,
        fuel: {
          ...s.fuel,
          gas: {
            ...s.fuel.gas,
            curtailmentNotice: {
              atTick: s.shift.startTick + (Number(p.effectiveMinute) * 60) / TICK_PLANT_S,
              capMW: Number(p.capMW),
            },
          },
        },
      };
    case 'gasPriceSpike':
      return {
        ...s,
        fuel: { ...s.fuel, gas: { ...s.fuel.gas, priceUsdPerGJ: s.fuel.gas.priceUsdPerGJ * Number(p.mult) } },
      };
    case 'offgradeOnly':
      return { ...s, scenario: { ...s.scenario, effects: { ...s.scenario.effects, offgradeOnly: true } } };
    case 'deliveryDelay':
      return {
        ...s,
        scenario: { ...s.scenario, effects: { ...s.scenario.effects, deliveryDelayTicks: Number(p.ticks) } },
      };
    case 'demandChange':
      return {
        ...s,
        shift: { ...s.shift, target: { ...s.shift.target, productM3: s.shift.target.productM3 + Number(p.deltaM3) } },
      };
    case 'controllerFault':
      return setLoopFault(s, String(p.loop), String(p.kind));
    // Plan 4 Task 4 replaces
    default:
      return s;
  }
}

/**
 * Fire due scheduled events (once each), roll random events, then move chlorophyll toward its target.
 * Does nothing outside a running shift that has a loaded scenario.
 */
export function stepScenario(s: PlantState): { state: PlantState; events: SimEvent[] } {
  const def = s.scenario.definition;
  if (s.phase !== 'running' || !s.shift || !def) return { state: s, events: [] };
  const base = { tick: s.tick, plantTime: s.plantTime, shiftId: s.shift.id };
  const events: SimEvent[] = [];
  const elapsedMin = ((s.tick - s.shift.startTick) * TICK_PLANT_S) / 60;
  let state = s;

  let idx = s.scenario.nextEventIndex;
  for (let e = def.events[idx]; e && elapsedMin >= e.atMinute; e = def.events[idx]) {
    state = applyEffect(state, e.kind, e.params);
    // Plan 4 Task 5 replaces eventId and radio
    events.push({ ...base, type: 'scenario', eventId: s.tick * 100 + events.length + 1, kind: e.kind, message: e.message, radio: e.message });
    idx++;
  }
  state = { ...state, scenario: { ...state.scenario, nextEventIndex: idx } };

  let seed = state.seed;
  for (const { kind, p } of def.randomPerHour) {
    let v: number;
    [v, seed] = nextRandom(seed);
    if (v < (p * TICK_PLANT_S) / 3600) {
      const [e, next] = drawEvent(kind, elapsedMin, seed, state.run.shiftNumber);
      seed = next;
      state = applyEffect(state, e.kind, e.params);
      // Plan 4 Task 5 replaces eventId and radio
      events.push({ ...base, type: 'scenario', eventId: s.tick * 100 + events.length + 1, kind: e.kind, message: e.message, radio: e.message });
    }
  }
  state = { ...state, seed };

  const { chlorophyllTarget: target, chlorophyllRampPerTick: ramp } = state.scenario.effects;
  const chl = state.seawater.chlorophyllUgL;
  const step = Math.min(Math.abs(target - chl), Math.abs(ramp));
  const next = chl + Math.sign(target - chl) * step;
  state = { ...state, seawater: { ...state.seawater, chlorophyllUgL: next } };

  return { state, events };
}
