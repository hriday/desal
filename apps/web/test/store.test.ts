import type { PlantEvent, PlantStatus, ServerMsg } from '@desal/schema';
import { commandKey, setpoint } from '../src/commands';
import { initialState, reducer, type State } from '../src/state/store';
import { MAX_POINTS } from '../src/state/trends';

const gameId = '11111111-1111-4111-8111-111111111111';

function status(over: Partial<PlantStatus> = {}): PlantStatus {
  return {
    gameId, shiftNumber: 1, balanceUsd: 1000, tick: 0, plantTime: 0, shiftId: 1,
    phase: 'running', status: 'online', controlMode: 'auto', tripCause: null, restartStep: null,
    loops: { tbt: { mode: 'auto', setpoint: 100, output: 50 } } as PlantStatus['loops'],
    pumps: { 'P-101': { running: true, overhaulRemainingTicks: 0 }, 'P-102': { running: false, overhaulRemainingTicks: 0 }, 'P-103': { running: false, overhaulRemainingTicks: 0 } },
    fuel: { active: 'gas', changeoverTo: null, backupGrade: 'standard', gasCurtailmentNotice: null },
    ballCleaning: false, divertToDrain: false, shiftTicksRemaining: 100, deliveries: [],
    acidCleanRemainingTicks: 0, restartAuto: null, offeredGrade: 'standard', ...over,
  };
}
const ev = (e: Record<string, unknown>): PlantEvent =>
  ({ gameId, seq: 0, tick: 0, plantTime: 0, shiftId: 1, ...e }) as PlantEvent;
const server = (s: State, msg: ServerMsg) => reducer(s, { type: 'server', msg });
const statusMsg = (over: Partial<PlantStatus> = {}): ServerMsg => ({ t: 'status', status: status(over) });
const eventMsg = (e: Record<string, unknown>): ServerMsg => ({ t: 'event', event: ev(e) });

describe('store reducer', () => {
  it('frames update readings and trends', () => {
    let s = server(initialState(), { t: 'frame', tick: 1, plantTime: 10, readings: { a: 1, b: 2 } });
    s = server(s, { t: 'frame', tick: 2, plantTime: 11, readings: { a: 3 } });
    expect(s.readings).toEqual({ a: 3, b: 2 });
    expect(s.trends['a']!.map((p) => p.v)).toEqual([1, 3]);
    expect(s.trends['b']!).toHaveLength(1);
  });

  it('caps trends at 600 points per sensor', () => {
    let s = initialState();
    for (let i = 0; i < MAX_POINTS + 50; i++) s = server(s, { t: 'frame', tick: i, plantTime: i, readings: { a: i } });
    expect(s.trends['a']).toHaveLength(MAX_POINTS);
    expect(s.trends['a']![0]!.v).toBe(50);
  });

  it('keeps duplicate events (same seq) once and the last 200', () => {
    let s = server(initialState(), eventMsg({ type: 'online', seq: 5 }));
    s = server(s, eventMsg({ type: 'online', seq: 5 }));
    expect(s.events).toHaveLength(1);
    for (let i = 10; i < 330; i++) s = server(s, eventMsg({ type: 'online', seq: i }));
    expect(s.events).toHaveLength(200);
    expect(s.events.at(-1)!.seq).toBe(329);
  });

  it('status phases drive the session', () => {
    let s = server(initialState(), statusMsg({ phase: 'handover' }));
    expect(s.session).toBe('handover');
    s = server(s, statusMsg({ phase: 'running' }));
    expect(s.session).toBe('room');
    s = server(s, statusMsg({ phase: 'paused' }));
    expect(s.session).toBe('room');
    s = server(s, statusMsg({ phase: 'over' }));
    expect(s.session).toBe('over');
  });

  it('startClicked -> starting; game message records gameId', () => {
    let s = reducer(initialState(), { type: 'startClicked' });
    expect(s.session).toBe('starting');
    s = server(s, { t: 'game', gameId });
    expect(s.gameId).toBe(gameId);
    expect(s.session).toBe('starting');
  });

  it('gameEnd mid-room switches to over with its score', () => {
    let s = server(initialState(), statusMsg());
    const score = { shiftsCompleted: 3, totalProductM3: 900, balanceUsd: 12 };
    s = server(s, eventMsg({ type: 'gameEnd', reason: 'bankrupt', score, seq: 1 }));
    expect(s.session).toBe('over');
    expect(s.score).toEqual(score);
    expect(s.endReason).toBe('bankrupt');
    // a later status must not resurrect the room
    s = server(s, statusMsg());
    expect(s.session).toBe('over');
  });

  it('error "game ended" shows over from last score, else start', () => {
    expect(server(initialState(), { t: 'error', reason: 'game ended' }).session).toBe('start');
    const score = { shiftsCompleted: 1, totalProductM3: 1, balanceUsd: 1 };
    let s = server(initialState(), eventMsg({ type: 'gameEnd', reason: 'quit', score }));
    s = { ...s, session: 'room' };
    expect(server(s, { t: 'error', reason: 'game ended' }).session).toBe('over');
  });

  it('capacity rejection shows a capacity toast and returns to start', () => {
    let s = reducer(initialState(), { type: 'startClicked' });
    s = server(s, eventMsg({ type: 'gameRejected', reason: 'capacity' }));
    expect(s.session).toBe('start');
    expect(s.toast?.kind).toBe('capacity');
  });

  it('commandRejected sets a toast and clears pending', () => {
    let s = reducer(initialState(), { type: 'sent', key: commandKey(setpoint('tbt', 90)), value: 90 });
    expect(s.pending.get('setSetpoint:tbt')).toBe(90);
    s = server(s, eventMsg({ type: 'commandRejected', commandId: 'x', reason: 'not in manual' }));
    expect(s.toast).toEqual({ kind: 'rejected', message: 'not in manual' });
    expect(s.pending.size).toBe(0);
    expect(reducer(s, { type: 'dismissToast' }).toast).toBeNull();
  });

  it('status confirms a pending command only when the plant reports the value', () => {
    let s = reducer(initialState(), { type: 'sent', key: 'setSetpoint:tbt', value: 90 });
    s = server(s, statusMsg()); // reports 100
    expect(s.pending.has('setSetpoint:tbt')).toBe(true);
    s = server(s, statusMsg({ loops: { tbt: { mode: 'auto', setpoint: 90, output: 50 } } as PlantStatus['loops'] }));
    expect(s.pending.has('setSetpoint:tbt')).toBe(false);
  });

  it('conn action updates the connection state', () => {
    expect(reducer(initialState(), { type: 'conn', conn: 'closed' }).conn).toBe('closed');
  });

  it('commandKey is type plus target', () => {
    expect(commandKey({ type: 'pump', pumpId: 'P-101', action: 'start' })).toBe('pump:P-101');
    expect(commandKey({ type: 'setDose', chemical: 'chlorine', mgL: 1 })).toBe('setDose:chlorine');
  });
});
