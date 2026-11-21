import type { PumpId, ScenarioKind } from '@desal/schema';
import { TICK_PLANT_S } from '../constants.js';
import type { Loop, PlantState } from '../state.js';
import { applyFuelContamination } from './disaster/fuelContamination.js';
import { applyTsunami } from './disaster/tsunami.js';
import { applySharpEffect } from './sharp.js';

function setLoopFault(s: PlantState, loopId: string, kind: string): PlantState {
  const fault = { kind: kind as 'stuck' | 'drift' | 'oscillate', bias: 0 };
  const level = /^level(\d+)$/.exec(loopId);
  if (level) {
    const i = Number(level[1]) - 1;
    if (!s.loops.levels[i]) return s;
    const levels = s.loops.levels.map((x, j): Loop => (j === i ? { ...x, fault } : x));
    return { ...s, loops: { ...s.loops, levels } };
  }
  if (loopId === 'tbt' || loopId === 'intakeFlow' || loopId === 'recirc' || loopId === 'blowdown' || loopId === 'vacuum' || loopId === 'makeup') {
    return { ...s, loops: { ...s.loops, [loopId]: { ...s.loops[loopId], fault } } };
  }
  return s;
}

/** Apply the effect of an event of `kind` with params `p`. Does nothing outside a shift. */
export function applyEffect(s: PlantState, kind: ScenarioKind, p: Record<string, number | string>): PlantState {
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
    case 'pumpTrip':
    case 'tubeLeak':
    case 'vacuumLoss':
    case 'powerDip':
    case 'storm':
    case 'sensorFailure':
      return applySharpEffect(s, kind, p);
    case 'fuelContamination':
      return applyFuelContamination(s);
    case 'tsunami':
      return applyTsunami(s, { warnMinutes: Number(p.warnMinutes), coolC: Number(p.coolC) });
    case 'earthquake':
      return s;
  }
}
