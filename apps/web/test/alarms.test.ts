import type { PlantEvent, PlantStatus } from '@desal/schema';
import { alarmContext, alarmsFor, requiredIntakeM3h, worstLevel, type Alarm, type AlarmContext } from '../src/alarms/rules';
import { DEMO_GAME_ID, demoReadings, demoStatus, demoTarget } from '../src/demo';

// A healthy plant: the demo frame with its two deliberate problems removed.
const clean = (over: Record<string, number> = {}) =>
  demoReadings({ 'pretreat.chlorophyllUgL': 1, 'stages.s02.hardScaleMm': 0.08, ...over });

function level(id: string, readings: Record<string, number>, status: PlantStatus = demoStatus(), ctx: AlarmContext = { target: demoTarget }) {
  return alarmsFor(status, readings, ctx).find((a) => a.id === id)?.level;
}

describe('alarmsFor', () => {
  it('a healthy plant has no alarms', () => {
    expect(alarmsFor(demoStatus(), clean(), { target: demoTarget })).toEqual([]);
  });

  it('never throws on missing status or readings', () => {
    expect(alarmsFor(null, {})).toEqual([]);
    expect(() => alarmsFor(demoStatus(), {})).not.toThrow();
  });

  it('TBT: warn at 112, bad at 116', () => {
    expect(level('tbt', clean({ 'heater.tbtC': 111.9 }))).toBeUndefined();
    expect(level('tbt', clean({ 'heater.tbtC': 112 }))).toBe('warn');
    expect(level('tbt', clean({ 'heater.tbtC': 115.9 }))).toBe('warn');
    expect(level('tbt', clean({ 'heater.tbtC': 116 }))).toBe('bad');
  });

  it('stage level: any stage at 0.5 is warn, at 0.65 bad', () => {
    expect(level('stageLevel', clean({ 'stages.s07.levelM': 0.499 }))).toBeUndefined();
    expect(level('stageLevel', clean({ 'stages.s07.levelM': 0.5 }))).toBe('warn');
    expect(level('stageLevel', clean({ 'stages.s07.levelM': 0.649 }))).toBe('warn');
    expect(level('stageLevel', clean({ 'stages.s07.levelM': 0.65 }))).toBe('bad');
    expect(alarmsFor(demoStatus(), clean({ 'stages.s07.levelM': 0.66 })).find((a) => a.id === 'stageLevel')?.text).toContain('S7');
  });

  it('vacuum: warn below 0.8, bad below 0.7', () => {
    expect(level('vacuum', clean({ 'vacuum.quality': 0.8 }))).toBeUndefined();
    expect(level('vacuum', clean({ 'vacuum.quality': 0.799 }))).toBe('warn');
    expect(level('vacuum', clean({ 'vacuum.quality': 0.7 }))).toBe('warn');
    expect(level('vacuum', clean({ 'vacuum.quality': 0.699 }))).toBe('bad');
  });

  it('intake flow: bad below required, warn within 5% of it', () => {
    const req = requiredIntakeM3h(28);
    expect(req).toBe(5500);
    expect(requiredIntakeM3h(32)).toBeCloseTo(5500 * 1.06);
    expect(level('intakeFlow', clean({ 'intake.flowM3h': req * 1.05 }))).toBeUndefined();
    expect(level('intakeFlow', clean({ 'intake.flowM3h': req * 1.049 }))).toBe('warn');
    expect(level('intakeFlow', clean({ 'intake.flowM3h': req }))).toBe('warn');
    expect(level('intakeFlow', clean({ 'intake.flowM3h': req - 1 }))).toBe('bad');
    // hotter seawater raises the requirement
    expect(level('intakeFlow', clean({ 'intake.flowM3h': 5800, 'intake.seawaterTempC': 32 }))).toBe('bad');
  });

  it('screen fouling: warn at 0.3, bad at 0.5', () => {
    expect(level('screen', clean({ 'intake.screenFouling': 0.299 }))).toBeUndefined();
    expect(level('screen', clean({ 'intake.screenFouling': 0.3 }))).toBe('warn');
    expect(level('screen', clean({ 'intake.screenFouling': 0.5 }))).toBe('bad');
  });

  it('chlorophyll: warn at 4', () => {
    expect(level('chlorophyll', clean({ 'pretreat.chlorophyllUgL': 3.99 }))).toBeUndefined();
    expect(level('chlorophyll', clean({ 'pretreat.chlorophyllUgL': 4 }))).toBe('warn');
    expect(level('chlorophyll', clean({ 'pretreat.chlorophyllUgL': 40 }))).toBe('warn');
  });

  it('max hard scale: warn at 0.3 mm, bad at 0.6 mm', () => {
    expect(level('scale', clean({ 'stages.s02.hardScaleMm': 0.299 }))).toBeUndefined();
    expect(level('scale', clean({ 'stages.s02.hardScaleMm': 0.3 }))).toBe('warn');
    expect(level('scale', clean({ 'stages.s02.hardScaleMm': 0.6 }))).toBe('bad');
  });

  it('salinity: warn at 80% of the limit, bad above it', () => {
    expect(level('salinity', clean({ 'product.salinityPpm': 19.9 }))).toBeUndefined();
    expect(level('salinity', clean({ 'product.salinityPpm': 20 }))).toBe('warn');
    expect(level('salinity', clean({ 'product.salinityPpm': 25 }))).toBe('warn');
    expect(level('salinity', clean({ 'product.salinityPpm': 25.1 }))).toBe('bad');
    // the shift target's limit applies; 25 ppm is the default without one
    expect(level('salinity', clean({ 'product.salinityPpm': 9 }), demoStatus(), { target: { ...demoTarget, maxSalinityPpm: 10 } })).toBe('warn');
    expect(level('salinity', clean({ 'product.salinityPpm': 25.1 }), demoStatus(), {})).toBe('bad');
  });

  it('backup tank: warn below 40 t, bad below 10 t', () => {
    expect(level('backupTank', clean({ 'fuel.backupTonnes': 40 }))).toBeUndefined();
    expect(level('backupTank', clean({ 'fuel.backupTonnes': 39.9 }))).toBe('warn');
    expect(level('backupTank', clean({ 'fuel.backupTonnes': 10 }))).toBe('warn');
    expect(level('backupTank', clean({ 'fuel.backupTonnes': 9.9 }))).toBe('bad');
  });

  it('gas curtailment notice is warn on the fuel monitor', () => {
    const fuel = { ...demoStatus().fuel, gasCurtailmentNotice: 'Gas capped at 40 MW from tick 900' };
    const a = alarmsFor(demoStatus({ fuel }), clean()).find((x) => x.id === 'gasCurtail');
    expect(a).toMatchObject({ monitor: 'fuel', level: 'warn', text: 'Gas capped at 40 MW from tick 900' });
  });

  it('tripped is bad on the shift monitor', () => {
    expect(level('tripped', clean(), demoStatus({ status: 'restarting' }))).toBeUndefined();
    const a = alarmsFor(demoStatus({ status: 'tripped', tripCause: 'tbtHighHigh' }), clean()).find((x) => x.id === 'tripped');
    expect(a).toMatchObject({ monitor: 'shift', level: 'bad' });
  });

  it('balance: warn below $5,000, bad below $0', () => {
    expect(level('balance', clean(), demoStatus({ balanceUsd: 5000 }))).toBeUndefined();
    expect(level('balance', clean(), demoStatus({ balanceUsd: 4999 }))).toBe('warn');
    expect(level('balance', clean(), demoStatus({ balanceUsd: 0 }))).toBe('warn');
    expect(level('balance', clean(), demoStatus({ balanceUsd: -1 }))).toBe('bad');
  });

  it('a controller-fault hint is warn on the monitor of its loop', () => {
    const alarms = alarmsFor(demoStatus(), clean(), { faults: ['Controller fault on loop tbt: drift.'] });
    expect(alarms).toEqual([expect.objectContaining({ monitor: 'heater', level: 'warn', text: 'Controller fault on loop tbt: drift.' })]);
  });

  it('assigns each rule to its monitor', () => {
    const r = clean({ 'heater.tbtC': 117, 'stages.s01.levelM': 0.7, 'intake.screenFouling': 0.6, 'product.salinityPpm': 30, 'fuel.backupTonnes': 5 });
    const by = (id: string) => alarmsFor(demoStatus(), r, { target: demoTarget }).find((a) => a.id === id)?.monitor;
    expect([by('tbt'), by('stageLevel'), by('screen'), by('salinity'), by('backupTank')]).toEqual(['heater', 'stages', 'intake', 'product', 'fuel']);
  });
});

describe('alarmContext', () => {
  const base = { gameId: DEMO_GAME_ID, tick: 0, plantTime: 0 };
  const events: PlantEvent[] = [
    { ...base, seq: 1, shiftId: 2, type: 'shiftStart', scenarioId: 'a', mode: 'auto', target: { ...demoTarget, productM3: 1 } },
    { ...base, seq: 2, shiftId: 2, type: 'scenario', kind: 'controllerFault', message: 'old fault' },
    { ...base, seq: 3, shiftId: 3, type: 'shiftStart', scenarioId: 'b', mode: 'auto', target: demoTarget },
    { ...base, seq: 4, shiftId: 3, type: 'scenario', kind: 'bloom', message: 'bloom' },
    { ...base, seq: 5, shiftId: 3, type: 'scenario', kind: 'controllerFault', message: 'Controller fault on loop vacuum: stuck.' },
  ];

  it('takes the current shift target and its controller faults only', () => {
    expect(alarmContext(events, 3)).toEqual({ target: demoTarget, faults: ['Controller fault on loop vacuum: stuck.'] });
    expect(alarmContext([], null)).toEqual({ target: null, faults: [] });
  });
});

describe('worstLevel', () => {
  const a = (monitor: Alarm['monitor'], lvl: Alarm['level']): Alarm => ({ id: `${monitor}${lvl}`, monitor, level: lvl, text: '' });
  it('is the worst alarm on that monitor, ok when none', () => {
    const alarms = [a('heater', 'warn'), a('stages', 'warn'), a('stages', 'bad')];
    expect(worstLevel(alarms, 'heater')).toBe('warn');
    expect(worstLevel(alarms, 'stages')).toBe('bad');
    expect(worstLevel(alarms, 'fuel')).toBe('ok');
  });
});
