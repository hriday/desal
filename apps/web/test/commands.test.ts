import { CommandSchema } from '@desal/schema';
import * as c from '../src/commands';

describe('command builders', () => {
  const all = [
    c.setpoint('tbt', 100), c.output('tbt', 70), c.loopMode('vacuum', 'manual'),
    c.pump('P-101', 'start'), c.dose('chlorine', 1.5), c.ballCleaning(true), c.divert(false),
    c.selectFuel('backup'), c.orderFuel(50), c.restart(), c.restartStep('ramp'), c.acidClean(),
    c.overhaul('P-102'), c.manualTrip(), c.pause(), c.resume(), c.startShift('auto'), c.quit(),
  ];
  it('every builder output parses with CommandSchema', () => {
    for (const cmd of all) expect(CommandSchema.safeParse(cmd).success, JSON.stringify(cmd)).toBe(true);
  });
  it('never builds startGame or heartbeat', () => {
    expect(all.some((x) => x.type === 'startGame' || x.type === 'heartbeat')).toBe(false);
  });
  it('controlFor: setpoint in auto, output in manual, setpoint for levels always', () => {
    expect(c.controlFor('auto', 'tbt', 1).type).toBe('setSetpoint');
    expect(c.controlFor('manual', 'tbt', 70)).toEqual({ type: 'setOutput', loop: 'tbt', value: 70 });
    expect(c.controlFor('manual', 'level3', 0.3)).toEqual({ type: 'setSetpoint', loop: 'level3', value: 0.3 });
  });
});
