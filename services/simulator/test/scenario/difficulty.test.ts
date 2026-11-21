import { describe, expect, it } from 'vitest';
import { DISASTER_MINUTE, DISASTER_SALT, LOW_STEAM_MINUTE, LOW_STEAM_SALT, PROFILES } from '../../src/scenario/difficulty.js';
import { drawEvent, scenarioForShift } from '../../src/scenario/library.js';
import { allFinite } from '../helpers.js';

const target = (n: number) => Math.round(3900 * (1 + 0.04 * (n - 1)));

describe('difficulty profiles', () => {
  it('has the Normal and Hard values', () => {
    expect(PROFILES.normal).toEqual({
      hellEveryShift: false, disasterChance: 0.08, disasterFromShift: 3, lowSteamChance: 0.15, lowSteamFromShift: 2,
      vacuumTrainChance: 0.2, vacuumTrainFromShift: 2,
    });
    expect(PROFILES.hard).toEqual({
      hellEveryShift: true, disasterChance: 0.4, disasterFromShift: 2, lowSteamChance: 0.3, lowSteamFromShift: 2,
      vacuumTrainChance: 0.4, vacuumTrainFromShift: 2,
    });
    expect(DISASTER_SALT).toBe(0xd15a5);
    expect(DISASTER_MINUTE).toEqual([90, 300]);
    expect(LOW_STEAM_SALT).toBe(0x57ea3);
    expect(LOW_STEAM_MINUTE).toEqual([60, 360]);
  });
});

describe('escalating difficulty', () => {
  it('the target grows 4% per shift with no cap, hand-written shifts included', () => {
    for (const n of [1, 2, 3, 4, 7, 20, 30, 60]) expect(scenarioForShift(n, 5).target.productM3).toBe(target(n));
    expect(scenarioForShift(30, 1).target.productM3).toBe(Math.round(3900 * 2.16));
  });

  it('scenarioForShift supplies only conditions and the base target', () => {
    for (const n of [1, 2, 3, 10]) {
      const sc = scenarioForShift(n, 9);
      expect(sc.events).toEqual([]);
      expect(sc.target.fuelBudgetUsd).toBe(Math.round(12000 * (1 + 0.04 * (n - 1))));
      expect(allFinite(sc)).toBe(true);
    }
    expect(scenarioForShift(1, 9).initial).toEqual({ seawaterTempC: 30, chlorophyllUgL: 1 });
    expect(scenarioForShift(7, 5)).toEqual(scenarioForShift(7, 5));
  });

  it('severity scales with the shift number', () => {
    expect(drawEvent('bloom', 0, 1, 10)[0].params.peakUgL).toBe(11);
    expect(drawEvent('gasCurtailNotice', 0, 1, 10)[0].params.capMW).toBe(10);
    expect(drawEvent('gasCurtailNotice', 0, 1, 20)[0].params.capMW).toBe(0);
    expect(drawEvent('gasPriceSpike', 0, 1, 10)[0].params.mult).toBe(1.7);
    expect(drawEvent('gasPriceSpike', 0, 1, 4)[0].params.mult).toBe(1.4);
    expect(drawEvent('bloom', 0, 1, 20)[0].params.peakUgL).toBeGreaterThan(drawEvent('bloom', 0, 1, 10)[0].params.peakUgL as number);
  });

  it('severity is capped: delivery delay <= 180 ticks, bearing x6, demand +600 m3', () => {
    for (const n of [4, 12, 24, 40, 100]) {
      expect(drawEvent('deliveryDelay', 0, 1, n)[0].params.ticks).toBeLessThanOrEqual(180);
      expect(drawEvent('pumpBearing', 0, 1, n)[0].params.mult).toBeLessThanOrEqual(6);
      expect(drawEvent('demandChange', 0, 1, n)[0].params.deltaM3).toBeLessThanOrEqual(600);
    }
    expect(drawEvent('deliveryDelay', 0, 1, 40)[0].params.ticks).toBe(180);
    expect(drawEvent('pumpBearing', 0, 1, 40)[0].params.mult).toBe(6);
    expect(drawEvent('demandChange', 0, 1, 40)[0].params.deltaM3).toBe(600);
  });

  it('new sharp kinds draw their params, scaled by difficulty', () => {
    expect(drawEvent('pumpTrip', 0, 1, 3, ['P-102'])[0].params).toEqual({ pumpId: 'P-102' });
    const leak = (n: number) => drawEvent('tubeLeak', 0, 1, n)[0].params;
    expect(leak(1).stage).toBeGreaterThanOrEqual(0);
    expect(leak(1).stage).toBeLessThan(20);
    expect(leak(30).ppm).toBeGreaterThan(leak(1).ppm as number);
    expect(drawEvent('vacuumLoss', 0, 1, 10)[0].params.ratePerMin).toBeGreaterThan(drawEvent('vacuumLoss', 0, 1, 1)[0].params.ratePerMin as number);
    expect(Object.keys(drawEvent('powerDip', 0, 1, 5)[0].params).sort()).toEqual(['minutes', 'pumpId', 'recircFactor']);
    expect(Object.keys(drawEvent('storm', 0, 1, 5)[0].params).sort()).toEqual(['deltaC', 'fouling', 'minutes']);
    const sf = drawEvent('sensorFailure', 0, 1, 5)[0].params;
    expect(['freeze', 'noise']).toContain(sf.mode);
    expect(['tbt', 'intakeFlow', 'recirc', 'blowdown', 'vacuum']).toContain(sf.loop);
  });

  it("shift 1's gentle sensor failure always freezes, on a loop where it shows (spec 4.10)", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const p = drawEvent('sensorFailure', 0, seed, 1)[0].params;
      expect(p.mode, `seed ${seed}`).toBe('freeze');
      expect(['tbt', 'intakeFlow', 'recirc'], `seed ${seed}`).toContain(p.loop);
    }
  });
});
