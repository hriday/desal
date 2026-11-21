import { describe, expect, it } from 'vitest';
import {
  BURNER_WEAR_GAS,
  CHANGEOVER_TICKS,
  CONTAMINATION_FLAMEOUT_P,
  CONTAMINATION_WEAR_MULT,
  CREW_JOBS,
  TICK_PLANT_S,
} from '../../../src/constants.js';
import { nextRandom } from '../../../src/rng.js';
import { applyFuelContamination, contaminationActive, fuelContaminationViable } from '../../../src/scenario/disaster/fuelContamination.js';
import { isCleared } from '../../../src/scenario/director.js';
import { applyEffect } from '../../../src/scenario/effects.js';
import type { FiredEvent } from '../../../src/scenario/chaosTypes.js';
import { drawEvent, eventMessage } from '../../../src/scenario/library.js';
import { startShift } from '../../../src/shift.js';
import { createInitialState, NOMINAL, type PlantState } from '../../../src/state.js';
import { tick } from '../../../src/tick.js';
import { env, GAME_ID } from '../../envelope.js';

function quiet(): PlantState {
  const s = startShift(createInitialState(1, 0, GAME_ID), 'auto').state;
  return { ...s, chaos: { ...s.chaos, active: null } };
}
function run(s: PlantState, n: number): PlantState {
  for (let i = 0; i < n; i++) s = tick(s, []).state;
  return s;
}
const cmd = (s: PlantState, command: Record<string, unknown>) => tick(s, [env(s, command)]);
const contaminate = (s: PlantState): PlantState => applyEffect(s, 'fuelContamination', { fuel: s.fuel.active });
const settle = (): PlantState => run(quiet(), 30);
const rejection = (r: ReturnType<typeof tick>) =>
  r.events.find((e) => e.type === 'commandRejected') as { reason: string } | undefined;
const fired = { eventId: 1, kind: 'fuelContamination', params: { fuel: 'gas' }, cleared: false, how: null } as unknown as FiredEvent;

describe('contaminated fuel effect', () => {
  it('cuts delivered heat to at most 0.7x and wears the burner CONTAMINATION_WEAR_MULT times faster than gas', () => {
    const clean = settle();
    const bad = contaminate(clean);
    expect(contaminationActive(bad)).toBe(true);
    const c1 = tick(clean, []).state;
    const b1 = tick(bad, []).state;
    expect(b1.heater.heatMW).toBeLessThanOrEqual(0.7 * c1.heater.heatMW + 1e-9);
    const cWear = clean.heater.burnerCondition - c1.heater.burnerCondition;
    const bWear = bad.heater.burnerCondition - b1.heater.burnerCondition;
    expect(cWear).toBeCloseTo(BURNER_WEAR_GAS);
    expect(bWear / cWear).toBeCloseTo(CONTAMINATION_WEAR_MULT);
  });

  it('ends the game through burnerFailed within 270 ticks when ignored on a healthy burner', () => {
    let s = contaminate(settle());
    expect(s.heater.burnerCondition).toBeGreaterThan(0.99);
    for (let i = 0; i < 270 && s.phase === 'running'; i++) s = tick(s, []).state;
    expect(s.run.over?.reason).toBe('burnerFailed');
  });

  it('leaves the burner well above 0.7 when the player switches fuel within 30 ticks', () => {
    let s = run(contaminate(settle()), 29);
    s = run(cmd(s, { type: 'selectFuel', fuel: 'backup' }).state, CHANGEOVER_TICKS + 60);
    expect(s.phase).toBe('running');
    expect(s.heater.burnerCondition).toBeGreaterThan(0.7);
  });

  it('stops the extra wear once the changeover away completes', () => {
    let s = contaminate(settle());
    s = cmd(s, { type: 'selectFuel', fuel: 'backup' }).state;
    expect(contaminationActive(s)).toBe(false);
    s = run(s, CHANGEOVER_TICKS + 1);
    expect(s.fuel.active).toBe('backup');
    const wear = s.heater.burnerCondition - tick(s, []).state.heater.burnerCondition;
    expect(wear).toBeLessThan((CONTAMINATION_WEAR_MULT * BURNER_WEAR_GAS) / 4);
  });

  it('switching back before the flush restarts the damage', () => {
    let s = contaminate(settle());
    s = run(cmd(s, { type: 'selectFuel', fuel: 'backup' }).state, CHANGEOVER_TICKS + 1);
    s = run(cmd(s, { type: 'selectFuel', fuel: 'gas' }).state, CHANGEOVER_TICKS + 1);
    expect(s.fuel.active).toBe('gas');
    expect(contaminationActive(s)).toBe(true);
  });

  it('trips through the flameOut path when the per-tick roll fires, and not when it misses', () => {
    const base = contaminate(settle());
    let hit = 1;
    while (nextRandom(hit)[0] >= CONTAMINATION_FLAMEOUT_P) hit++;
    const r = tick({ ...base, seed: hit }, []);
    expect(r.state.status).toBe('tripped');
    expect(r.state.trip?.cause).toBe('flameOut');
    let miss = 1;
    while (nextRandom(miss)[0] < CONTAMINATION_FLAMEOUT_P) miss++;
    expect(tick({ ...base, seed: miss }, []).state.status).toBe('online');
  });
});

describe('flushFuel', () => {
  it('is rejected while the bad fuel burns, accepted after switching, and clears the event on completion', () => {
    let s = contaminate(settle());
    expect(rejection(cmd(s, { type: 'dispatchCrew', job: 'flushFuel' }))?.reason).toBe('nothing to repair');
    s = run(cmd(s, { type: 'selectFuel', fuel: 'backup' }).state, CHANGEOVER_TICKS + 1);
    const r = cmd(s, { type: 'dispatchCrew', job: 'flushFuel' });
    expect(rejection(r)).toBeUndefined();
    s = r.state;
    expect(s.crew?.job).toBe('flushFuel');
    expect(isCleared(s, fired)).toBeNull();
    s = run(s, (CREW_JOBS.flushFuel.minutes * 60) / TICK_PLANT_S);
    expect(s.faults.fuelContamination).toBeNull();
    expect(isCleared(s, fired)).toBe('crew');
  });

  it('is accepted while the changeover away is underway', () => {
    const s = cmd(contaminate(settle()), { type: 'selectFuel', fuel: 'backup' }).state;
    expect(rejection(cmd(s, { type: 'dispatchCrew', job: 'flushFuel' }))).toBeUndefined();
  });
});

describe('fuelContaminationViable and the draw', () => {
  it('on gas needs 2 plant hours of backup at nominal burn', () => {
    const s = settle();
    const need = (NOMINAL.heatMW * 7200) / (42.5 * 1000);
    const withTonnes = (tonnes: number) => ({ ...s, fuel: { ...s.fuel, backup: { ...s.fuel.backup, tonnes } } });
    expect(fuelContaminationViable(withTonnes(need * 0.99))).toBe(false);
    expect(fuelContaminationViable(withTonnes(need * 1.01))).toBe(true);
  });

  it('on backup needs the gas cap at 0.7x nominal burn', () => {
    const s = settle();
    const on = (capMW: number) => ({ ...s, fuel: { ...s.fuel, active: 'backup' as const, gas: { ...s.fuel.gas, capMW } } });
    expect(fuelContaminationViable(on(0.69 * NOMINAL.heatMW))).toBe(false);
    expect(fuelContaminationViable(on(0.71 * NOMINAL.heatMW))).toBe(true);
  });

  it('draws its params from the active fuel and words the radio line', () => {
    const [e] = drawEvent('fuelContamination', 100, 5, 3, undefined, 'backup');
    expect(e.params).toEqual({ fuel: 'backup' });
    expect(e.message).toBe('Fuel lab: the backup tank is contaminated. Switch fuel and flush it.');
    expect(eventMessage('fuelContamination', { fuel: 'gas' })).toBe(
      'Fuel lab: the gas supply is contaminated. Switch fuel and flush it.',
    );
    expect(applyFuelContamination(settle()).faults.fuelContamination).toEqual({ fuel: 'gas' });
  });
});
