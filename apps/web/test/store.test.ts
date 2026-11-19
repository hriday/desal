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
    fuel: {
      active: 'gas', changeoverTo: null, changeoverRemainingTicks: null, backupGrade: 'standard', gasCurtailmentNotice: null,
      gasPriceUsdPerGJ: 8, gasCapMW: 60, backupPriceUsdPerGJ: 14,
    },
    doses: { chlorineMgL: 1, antiscalantMgL: 2 }, shiftTarget: null,
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
  it('a dose stays pending until the status reports it', () => {
    let s = reducer(initialState(), { type: 'sent', command: { type: 'setDose', chemical: 'chlorine', mgL: 2.5 }, commandId: 'c1' });
    s = server(s, statusMsg({ doses: { chlorineMgL: 1, antiscalantMgL: 2 } }));
    expect(s.pending.has('setDose:chlorine')).toBe(true);
    s = server(s, statusMsg({ doses: { chlorineMgL: 2.5, antiscalantMgL: 2 } }));
    expect(s.pending.has('setDose:chlorine')).toBe(false);
  });

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

  it('once over, a late status of any phase (even handover) does not leave over; only reset does', () => {
    let s = server(initialState(), statusMsg({ phase: 'running' }));
    s = server(s, eventMsg({ seq: 3, type: 'gameEnd', reason: 'quit', score: { totalProductM3: 1, shiftsCompleted: 0, balanceUsd: 1 } }));
    expect(s.session).toBe('over');
    s = server(s, statusMsg({ phase: 'handover' }));
    expect(s.session).toBe('over');
    s = server(s, statusMsg({ phase: 'running' }));
    expect(s.session).toBe('over');
    s = reducer(s, { type: 'reset' });
    expect(s.session).toBe('start');
  });

  it('resuming: initial session when a game is stored; a status takes over, no game returns to start, timeout to start', () => {
    expect(initialState().session).toBe('start');
    const r = initialState(true);
    expect(r.session).toBe('resuming');
    expect(server(r, { t: 'game', gameId }).session).toBe('resuming');
    expect(server(r, statusMsg({ phase: 'running' })).session).toBe('room');
    expect(server(r, { t: 'error', reason: 'no game' }).session).toBe('start');
    expect(reducer(r, { type: 'resumeTimeout' }).session).toBe('start');
    // A timeout that fires after the game resumed changes nothing.
    const room = server(r, statusMsg({ phase: 'running' }));
    expect(reducer(room, { type: 'resumeTimeout' }).session).toBe('room');
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

  const CID = '22222222-2222-4222-8222-222222222222';
  const CID2 = '33333333-3333-4333-8333-333333333333';

  it('commandRejected toasts and clears only the mapped pending entry', () => {
    let s = reducer(initialState(), { type: 'sent', command: setpoint('tbt', 90), commandId: CID });
    s = reducer(s, { type: 'sent', command: { type: 'setDose', chemical: 'chlorine', mgL: 1 }, commandId: CID2 });
    s = server(s, eventMsg({ type: 'commandRejected', commandId: CID, reason: 'not in manual' }));
    expect(s.toast).toEqual({ kind: 'rejected', message: 'not in manual' });
    expect([...s.pending.keys()]).toEqual(['setDose:chlorine']);
    expect(reducer(s, { type: 'dismissToast' }).toast).toBeNull();
  });

  it('commandRejected with an unknown id clears all pending', () => {
    let s = reducer(initialState(), { type: 'sent', command: setpoint('tbt', 90), commandId: CID });
    s = server(s, eventMsg({ type: 'commandRejected', commandId: 'unknown', reason: 'x' }));
    expect(s.pending.size).toBe(0);
  });

  it('status confirms a pending command only when the plant reports the value', () => {
    let s = reducer(initialState(), { type: 'sent', command: setpoint('tbt', 90) });
    s = server(s, statusMsg()); // reports 100
    expect(s.pending.has('setSetpoint:tbt')).toBe(true);
    s = server(s, statusMsg({ loops: { tbt: { mode: 'auto', setpoint: 90, output: 50 } } as PlantStatus['loops'] }));
    expect(s.pending.has('setSetpoint:tbt')).toBe(false);
  });

  it('pump pending is confirmed by running state', () => {
    let s = reducer(initialState(), { type: 'sent', command: { type: 'pump', pumpId: 'P-102', action: 'start' } });
    s = server(s, statusMsg());
    expect(s.pending.has('pump:P-102')).toBe(true);
    s = server(s, statusMsg({ pumps: { ...status().pumps, 'P-102': { running: true, overhaulRemainingTicks: 0 } } }));
    expect(s.pending.size).toBe(0);
  });

  it('an unconfirmed pending entry expires after 3 statuses', () => {
    let s = reducer(initialState(), { type: 'sent', command: setpoint('tbt', 999), commandId: CID });
    s = server(s, statusMsg());
    s = server(s, statusMsg());
    expect(s.pending.size).toBe(1);
    s = server(s, statusMsg());
    expect(s.pending.size).toBe(0);
    expect(s.commandKeys.size).toBe(0);
  });

  it('connection drop clears pending', () => {
    let s = reducer(initialState(), { type: 'sent', command: setpoint('tbt', 90), commandId: CID });
    s = reducer(s, { type: 'conn', conn: 'closed' });
    expect(s.pending.size).toBe(0);
    expect(s.commandKeys.size).toBe(0);
  });

  it('server errors: game ended / no game go to over or start', () => {
    for (const reason of ['game ended', 'no game'] as const) {
      expect(server({ ...initialState(), gameId }, { t: 'error', reason }).gameId).toBeNull();
      expect(server(initialState(), { t: 'error', reason }).session).toBe('start');
      const score = { shiftsCompleted: 1, totalProductM3: 1, balanceUsd: 1 };
      expect(server({ ...initialState(), session: 'room', score }, { t: 'error', reason }).session).toBe('over');
    }
  });

  it('server error capacity -> start with capacity toast; others toast only', () => {
    let s = server({ ...initialState(), session: 'starting' }, { t: 'error', reason: 'capacity' });
    expect(s.session).toBe('start');
    expect(s.toast?.kind).toBe('capacity');
    s = server({ ...initialState(), session: 'room' }, { t: 'error', reason: 'rate limited' });
    expect(s.session).toBe('room');
    expect(s.toast).toEqual({ kind: 'error', message: 'rate limited' });
  });

  it('gameRejected duplicate returns to start with a toast', () => {
    let s = reducer(initialState(), { type: 'startClicked' });
    s = server(s, eventMsg({ type: 'gameRejected', reason: 'duplicate' }));
    expect(s.session).toBe('start');
    expect(s.toast?.kind).toBe('error');
  });

  it('conn action updates the connection state', () => {
    expect(reducer(initialState(), { type: 'conn', conn: 'closed' }).conn).toBe('closed');
  });

  it('commandKey is type plus target', () => {
    expect(commandKey({ type: 'pump', pumpId: 'P-101', action: 'start' })).toBe('pump:P-101');
    expect(commandKey({ type: 'setDose', chemical: 'chlorine', mgL: 1 })).toBe('setDose:chlorine');
  });
});
