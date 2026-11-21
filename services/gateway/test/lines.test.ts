import { describe, expect, it } from 'vitest';
import { parseLine } from '../src/cli/lines.js';

const cmd = (l: string) => {
  const r = parseLine(l);
  return r.ok ? r.command : r.error;
};

describe('parseLine', () => {
  it('parses word commands', () => {
    expect(cmd('startShift auto')).toEqual({ type: 'startShift', mode: 'auto' });
    expect(cmd('setpoint tbt 110')).toEqual({ type: 'setSetpoint', loop: 'tbt', value: 110 });
    expect(cmd('output level3 0.5')).toEqual({ type: 'setOutput', loop: 'level3', value: 0.5 });
    expect(cmd('pump P-103 start')).toEqual({ type: 'pump', pumpId: 'P-103', action: 'start' });
    expect(cmd('pump p-101 stop')).toEqual({ type: 'pump', pumpId: 'P-101', action: 'stop' });
    expect(cmd('trip')).toEqual({ type: 'manualTrip' });
    expect(cmd('restart')).toEqual({ type: 'restart' });
    expect(cmd('step vacuum')).toEqual({ type: 'restartStep', step: 'vacuum' });
    expect(cmd('order 50')).toEqual({ type: 'orderFuel', tonnes: 50 });
    expect(cmd('pause')).toEqual({ type: 'pause' });
    expect(cmd('resume')).toEqual({ type: 'resume' });
    expect(cmd('quit')).toEqual({ type: 'quitGame' });
  });

  it('parses raw JSON commands', () => {
    expect(cmd('{"type":"ballCleaning","on":true}')).toEqual({ type: 'ballCleaning', on: true });
  });

  it('rejects bad input', () => {
    for (const l of ['', 'dance', 'startShift', 'startShift fast', 'setpoint tbt', 'setpoint tbt x', 'step nope', 'order', 'trip now', '{oops', '{"type":"nope"}']) {
      expect(parseLine(l).ok, l).toBe(false);
    }
  });
});
