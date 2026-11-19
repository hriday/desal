import { describe, expect, it } from 'vitest';
import { drawEvent, scenarioForShift } from '../../src/scenario/library.js';
import { allFinite } from '../helpers.js';

const SEEDS = Array.from({ length: 40 }, (_, i) => i * 7919 + 3);
const target = (n: number) => Math.round(3900 * (1 + 0.04 * (n - 1)));

describe('escalating difficulty', () => {
  it('shift 10 targets 3900 x 1.36 and draws 5 events', () => {
    const sc = scenarioForShift(10, 1);
    expect(sc.target.productM3).toBe(Math.round(3900 * 1.36));
    expect(sc.events).toHaveLength(5);
  });

  it('the target grows 4% per shift with no cap, hand-written shifts included', () => {
    for (const n of [1, 2, 3, 4, 7, 20, 30, 60]) expect(scenarioForShift(n, 5).target.productM3).toBe(target(n));
    expect(scenarioForShift(30, 1).target.productM3).toBe(Math.round(3900 * 2.16));
  });

  it('shifts 1-3 keep their hand-written scenarios', () => {
    expect(scenarioForShift(1, 9).id).toBe('calm-seas');
    expect(scenarioForShift(2, 9).id).toBe('green-water');
    expect(scenarioForShift(3, 9).id).toBe('pipeline-notice');
    expect(scenarioForShift(3, 9).events.map((e) => e.kind)).toEqual(['offgradeOnly', 'gasCurtailNotice', 'gasPriceSpike']);
  });

  it('shift n >= 4 draws min(2 + floor((n - 4) / 2), 8) distinct events', () => {
    for (let n = 4; n <= 30; n++) {
      for (const seed of SEEDS.slice(0, 5)) {
        const sc = scenarioForShift(n, seed);
        expect(sc.events).toHaveLength(Math.min(2 + Math.floor((n - 4) / 2), 8));
        expect(new Set(sc.events.map((e) => e.kind)).size).toBe(sc.events.length);
        expect(allFinite(sc)).toBe(true);
      }
    }
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

  it('controller faults appear only from shift 5', () => {
    for (const seed of SEEDS) {
      const s4 = scenarioForShift(4, seed);
      expect(s4.events.some((e) => e.kind === 'controllerFault')).toBe(false);
      expect(s4.randomPerHour.some((r) => r.kind === 'controllerFault')).toBe(false);
    }
    expect(scenarioForShift(5, 1).randomPerHour.some((r) => r.kind === 'controllerFault')).toBe(true);
    expect(SEEDS.some((seed) => scenarioForShift(12, seed).events.some((e) => e.kind === 'controllerFault'))).toBe(true);
  });
});
