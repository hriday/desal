import { initialRadio, monitorFor, radioReducer, type RadioAction } from '../src/state/radio';
import { initialState, reducer } from '../src/state/store';

const p = (eventId: number, text = `msg ${eventId}`): RadioAction => ({ type: 'push', eventId, kind: 'storm', text });

describe('radioReducer', () => {
  it('shows one at a time, queues the rest, and advances on expire', () => {
    let s = [p(1), p(2), p(3)].reduce(radioReducer, initialRadio);
    expect(s.current?.eventId).toBe(1);
    expect(s.queue.map((m) => m.eventId)).toEqual([2, 3]);
    s = radioReducer(s, { type: 'expire' });
    expect(s.current?.eventId).toBe(2);
    s = radioReducer(s, { type: 'dismiss' });
    expect(s.current?.eventId).toBe(3);
    s = radioReducer(s, { type: 'expire' });
    expect(s.current).toBeNull();
  });
  it('ignores a duplicate eventId, even after it was shown', () => {
    let s = radioReducer(initialRadio, p(1));
    s = radioReducer(s, p(1));
    expect(s.queue).toHaveLength(0);
    s = radioReducer(s, { type: 'expire' });
    s = radioReducer(s, p(1));
    expect(s.current).toBeNull();
  });
});

describe('monitorFor', () => {
  it('maps kinds to monitors', () => {
    expect(monitorFor('pumpTrip')).toBe('intake');
    expect(monitorFor('tubeLeak')).toBe('product');
    expect(monitorFor('vacuumLoss')).toBe('stages');
    expect(monitorFor('sensorFailure')).toBe('shift');
    expect(monitorFor('gasPriceSpike')).toBe('fuel');
    expect(monitorFor('demandChange')).toBe('shift');
    expect(monitorFor('controllerFault', 'Controller fault on loop tbt')).toBe('heater');
    expect(monitorFor('controllerFault', 'loop recirc stuck')).toBe('stages');
  });
});

describe('store radio wiring', () => {
  const gameId = '11111111-1111-4111-8111-111111111111';
  const scen = (eventId: number, plantTime: number) => ({
    t: 'event',
    event: { gameId, epoch: 0, seq: eventId, tick: 0, plantTime, shiftId: 1, type: 'scenario', eventId, kind: 'storm', message: 'm', radio: `radio ${eventId}` },
  }) as never;
  const statusMsg = (plantTime: number) =>
    ({ t: 'status', status: { gameId, epoch: 0, phase: 'running', plantTime, loops: {}, pumps: {} } }) as never;

  it('pushes scenario radio lines newer than the session start, not replayed older ones', () => {
    let s = reducer(initialState(), { type: 'server', msg: statusMsg(1000) });
    s = reducer(s, { type: 'server', msg: scen(1, 500) });
    expect(s.radio.current).toBeNull();
    s = reducer(s, { type: 'server', msg: scen(2, 1500) });
    expect(s.radio.current?.text).toBe('radio 2');
    s = reducer(s, { type: 'radioExpire' });
    expect(s.radio.current).toBeNull();
  });
});
