import { GAS_BASE_PRICE_USD_PER_GJ, GAS_CAP_MW } from '../constants.js';
import type { Loop, PlantState, SimEvent } from '../state.js';
import { stepDirector } from './director.js';
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

/**
 * Run the chaos director (which fires the shift's events), then move chlorophyll toward its target.
 * Does nothing outside a running shift that has a loaded scenario.
 */
export function stepScenario(s: PlantState): { state: PlantState; events: SimEvent[] } {
  if (s.phase !== 'running' || !s.shift || !s.scenario.definition) return { state: s, events: [] };
  const director = stepDirector(s);
  let state = director.state;

  const { chlorophyllTarget: target, chlorophyllRampPerTick: ramp } = state.scenario.effects;
  const chl = state.seawater.chlorophyllUgL;
  const step = Math.min(Math.abs(target - chl), Math.abs(ramp));
  const next = chl + Math.sign(target - chl) * step;
  state = { ...state, seawater: { ...state.seawater, chlorophyllUgL: next } };

  return { state, events: director.events };
}
