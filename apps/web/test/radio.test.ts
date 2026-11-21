import { initialRadio, monitorFor, radioReducer, type RadioAction } from '../src/state/radio';
import { initialState, reducer } from '../src/state/store';

const p = (eventId: number, text = `msg ${eventId}`, shiftId?: number): RadioAction => ({ type: 'push', eventId, shiftId, kind: 'storm', text });

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
  it('treats the same eventId in another shift as a new call', () => {
    let s = radioReducer(initialRadio, p(1, 'msg 1', 1));
    s = radioReducer(s, { type: 'expire' });
    s = radioReducer(s, p(1, 'next shift', 2));
    expect(s.current?.text).toBe('next shift');
    s = radioReducer(s, p(1, 'again', 2));
    expect(s.queue).toHaveLength(0);
  });
  it('ignores a duplicate eventId, even after it was shown', () => {
    let s = radioReducer(initialRadio, p(1));
    s = radioReducer(s, p(1));
    expect(s.queue).toHaveLength(0);
    s = radioReducer(s, { type: 'expire' });
    s = radioReducer(s, p(1));
    expect(s.current).toBeNull();
  });
  it("a push with its own key does not collide with the event's own call", () => {
    let s = radioReducer(initialRadio, p(1, 'call', 1));
    s = radioReducer(s, { type: 'push', eventId: 1, shiftId: 1, kind: 'storm', text: 'Hint: x', key: '1:1:hint' });
    expect(s.queue.map((m) => [m.key, m.text])).toEqual([['1:1:hint', 'Hint: x']]);
    s = radioReducer(s, { type: 'push', eventId: 1, shiftId: 1, kind: 'storm', text: 'Hint: x', key: '1:1:hint' });
    expect(s.queue).toHaveLength(1);
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
    expect(monitorFor('fuelContamination')).toBe('fuel');
    expect(monitorFor('earthquake')).toBe('shift');
    expect(monitorFor('tsunami')).toBe('shift');
    expect(monitorFor('controllerFault', 'Controller fault on loop tbt')).toBe('heater');
    expect(monitorFor('controllerFault', 'loop recirc stuck')).toBe('stages');
    expect(monitorFor('controllerFault', 'Controller fault on loop makeup: stuck.')).toBe('stages');
  });
});

describe('store radio wiring', () => {
  const gameId = '11111111-1111-4111-8111-111111111111';
  const scen = (eventId: number, plantTime: number, shiftId = 1, seq = eventId) => ({
    t: 'event',
    event: { gameId, epoch: 0, seq, tick: 0, plantTime, shiftId, type: 'scenario', eventId, kind: 'storm', message: 'm', radio: `radio ${shiftId}.${eventId}` },
  }) as never;
  const statusMsg = (plantTime: number) =>
    ({ t: 'status', status: { gameId, epoch: 0, phase: 'running', plantTime, loops: {}, pumps: {} } }) as never;

  it('pushes scenario radio lines newer than the session start, not replayed older ones', () => {
    let s = reducer(initialState(), { type: 'server', msg: statusMsg(1000) });
    s = reducer(s, { type: 'server', msg: scen(1, 500) });
    expect(s.radio.current).toBeNull();
    s = reducer(s, { type: 'server', msg: scen(2, 1500) });
    expect(s.radio.current?.text).toBe('radio 1.2');
    s = reducer(s, { type: 'radioExpire' });
    expect(s.radio.current).toBeNull();
  });

  it('shows each shift its own calls: eventIds restart at 1 every shift (C1)', () => {
    let s = reducer(initialState(), { type: 'server', msg: statusMsg(1000) });
    s = reducer(s, { type: 'server', msg: scen(1, 1500, 1, 10) });
    expect(s.radio.current?.text).toBe('radio 1.1');
    s = reducer(s, { type: 'radioExpire' });
    // Shift 2 (and 3) number their events from 1 again; each must still reach the radio.
    s = reducer(s, { type: 'server', msg: scen(1, 30000, 2, 20) });
    expect(s.radio.current?.text).toBe('radio 2.1');
    s = reducer(s, { type: 'radioExpire' });
    s = reducer(s, { type: 'server', msg: scen(1, 60000, 3, 30) });
    s = reducer(s, { type: 'server', msg: scen(2, 61000, 3, 31) });
    expect(s.radio.current?.text).toBe('radio 3.1');
    expect(s.radio.queue.map((m) => m.text)).toEqual(['radio 3.2']);
  });
  it('a push with no kind opens the monitor it names', () => {
    const s = radioReducer(initialRadio, { type: 'push', eventId: 0, shiftId: 1, kind: null, text: 'Hint: x', key: '1:divert:0', monitor: 'product' });
    expect(s.current).toMatchObject({ kind: null, monitor: 'product', key: '1:divert:0' });
  });
});
