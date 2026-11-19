import { describe, expect, it } from 'vitest';
import { SHIFT_TICKS } from '../src/constants.js';
import { loadScenario } from '../src/scenario/engine.js';
import { scenarioForShift } from '../src/scenario/library.js';
import { startShift } from '../src/shift.js';
import { createInitialState, type PlantState } from '../src/state.js';
import { tick } from '../src/tick.js';

const T0 = Date.UTC(2026, 0, 1);

function runShift(s: PlantState): PlantState {
  for (let i = 0; i < SHIFT_TICKS && s.phase === 'running'; i++) s = tick(s, []).state;
  return s;
}

const allLoops = (s: PlantState) => [
  s.loops.tbt,
  s.loops.intakeFlow,
  s.loops.recirc,
  s.loops.blowdown,
  s.loops.vacuum,
  ...s.loops.levels,
];

describe('startShift resets per-shift supply conditions and controller faults', () => {
  it('shift 3 curtailment and price spike do not carry into shift 4; damage does', () => {
    // A career that has played shifts 1 and 2: shift 3 (pipeline-notice) is next.
    const career = { ...createInitialState(1, T0), careerShiftCount: 2 };
    const shift3 = startShift(career, 'auto').state;
    expect(shift3.scenario.id).toBe('pipeline-notice');
    const ended = runShift(shift3);
    expect(ended.phase).toBe('handover');
    // Shift 3 really did curtail and spike the gas.
    expect(ended.fuel.gas.capMW).toBe(25);
    expect(ended.fuel.gas.priceUsdPerGJ).toBeCloseTo(8 * 1.8);

    // Leave a fault and a pending notice behind, as a random shift-4+ event could.
    const dirty: PlantState = {
      ...ended,
      fuel: { ...ended.fuel, gas: { ...ended.fuel.gas, curtailmentNotice: { atTick: ended.tick + 5, capMW: 10 } } },
      loops: {
        ...ended.loops,
        recirc: { ...ended.loops.recirc, fault: { kind: 'stuck', bias: 0 } },
        levels: ended.loops.levels.map((l, i) => (i === 3 ? { ...l, fault: { kind: 'drift', bias: 2 } } : l)),
      },
    };

    const shift4 = startShift(dirty, 'auto').state;
    expect(shift4.shift?.id).toBe(4);
    expect(shift4.fuel.gas).toEqual({ capMW: 60, priceUsdPerGJ: 8, curtailmentNotice: null });
    expect(allLoops(shift4).every((l) => l.fault === null)).toBe(true);

    // Persistent damage is kept across the shift boundary.
    expect(shift4.stages).toEqual(dirty.stages);
    expect(shift4.heater.burnerCondition).toBe(dirty.heater.burnerCondition);
    expect(shift4.intake.pumps).toEqual(dirty.intake.pumps);
    expect(shift4.fuel.backup).toEqual(dirty.fuel.backup);
  });

  it('keeps bearingWearMult across shifts (persistent damage by design)', () => {
    const s = createInitialState(1, T0);
    const worn: PlantState = {
      ...s,
      intake: { ...s.intake, pumps: { ...s.intake.pumps, 'P-102': { ...s.intake.pumps['P-102'], bearingWearMult: 4 } } },
    };
    expect(startShift(worn, 'auto').state.intake.pumps['P-102'].bearingWearMult).toBe(4);
  });

  it('lets Scenario.initial override the starting gas cap and price', () => {
    const base = scenarioForShift(1, 0);
    const scenario = { ...base, initial: { ...base.initial, gasCapMW: 30, gasPriceUsdPerGJ: 11 } };
    const s = loadScenario(createInitialState(1, T0), scenario);
    expect(s.fuel.gas).toEqual({ capMW: 30, priceUsdPerGJ: 11, curtailmentNotice: null });
  });
});
