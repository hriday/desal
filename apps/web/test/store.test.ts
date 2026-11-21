import type { PlantEvent, PlantStatus, ServerMsg } from '@desal/schema';
import { commandKey, setpoint } from '../src/commands';
import { FIX } from '../src/expanded/labels';
import { initialState, reducer, type State } from '../src/state/store';
import { MAX_POINTS } from '../src/state/trends';

const gameId = '11111111-1111-4111-8111-111111111111';

function status(over: Partial<PlantStatus> = {}): PlantStatus {
  return {
    gameId, epoch: 0, shiftNumber: 1, balanceUsd: 1000, tick: 0, plantTime: 0, shiftId: 1,
    phase: 'running', mode: 'normal', pace: 'calm', status: 'online', controlMode: 'auto', tripCause: null, restartStep: null,
    loops: { tbt: { mode: 'auto', setpoint: 100, output: 50 } } as PlantStatus['loops'],
    pumps: { 'P-101': { running: true, overhaulRemainingTicks: 0 }, 'P-102': { running: false, overhaulRemainingTicks: 0 }, 'P-103': { running: false, overhaulRemainingTicks: 0 } },
    fuel: {
      active: 'gas', changeoverTo: null, changeoverRemainingTicks: null, backupGrade: 'standard', gasCurtailmentNotice: null,
      gasPriceUsdPerGJ: 8, gasCapMW: 60, backupPriceUsdPerGJ: 14,
    },
    doses: { chlorineMgL: 1, antiscalantMgL: 2 }, shiftTarget: null,
    ballCleaning: false, divertToDrain: false, shiftTicksRemaining: 100, deliveries: [],
    acidCleanRemainingTicks: 0, restartAuto: null, offeredGrade: 'standard', shiftProductM3: 0, shiftOffSpecM3: 0, productFlowM3h: 0, crew: null, orders: null, hell: null, ...over,
  };
}
const ev = (e: Record<string, unknown>): PlantEvent =>
  ({ gameId, epoch: 0, seq: 0, tick: 0, plantTime: 0, shiftId: 1, ...e }) as PlantEvent;
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

  it('after a restore (epoch up), events whose seq rewound are kept; stale older-epoch events are dropped', () => {
    let s = initialState();
    for (let seq = 1; seq <= 5; seq++) s = server(s, eventMsg({ type: 'online', seq, epoch: 0 }));
    // The simulator crashed after seq 5 but its last save was at seq 3: the restored game reuses 3..5.
    s = server(s, eventMsg({ type: 'trip', cause: 'manual', seq: 3, epoch: 1 }));
    s = server(s, eventMsg({ type: 'online', seq: 4, epoch: 1 }));
    expect(s.events.map((e) => [e.epoch, e.seq])).toEqual([[0, 1], [0, 2], [0, 3], [0, 4], [0, 5], [1, 3], [1, 4]]);
    // A duplicate within the new epoch is still dropped, and a straggler from the old epoch too.
    s = server(s, eventMsg({ type: 'online', seq: 4, epoch: 1 }));
    s = server(s, eventMsg({ type: 'online', seq: 9, epoch: 0 }));
    expect(s.events).toHaveLength(7);
    expect(s.epoch).toBe(1);
  });

  it('host events (seq 0, epoch 0) are never de-duplicated and do not move the epoch', () => {
    let s = server(initialState(), statusMsg({ epoch: 3 }));
    s = server(s, eventMsg({ type: 'online', seq: 0, epoch: 3 }));
    const rejected = { type: 'commandRejected', host: true, seq: 0, epoch: 0, commandId: 'x', reason: 'invalid: bad' };
    s = server(s, eventMsg(rejected));
    expect(s.toast).toEqual({ kind: 'rejected', message: 'invalid: bad' });
    s = reducer(s, { type: 'dismissToast' });
    s = server(s, eventMsg(rejected));
    expect(s.toast).toEqual({ kind: 'rejected', message: 'invalid: bad' });
    expect(s.events.filter((e) => e.host)).toHaveLength(2);
    expect(s.epoch).toBe(3);
    // And they do not count as seq 0 of the game: the game's own seq 0 is still accepted.
    const fresh = server(server(initialState(), eventMsg(rejected)), eventMsg({ type: 'gameStart', seq: 0, epoch: 0 }));
    expect(fresh.events.map((e) => e.type)).toEqual(['commandRejected', 'gameStart']);
  });

  it('a status from a newer epoch moves the epoch too', () => {
    const s = server(initialState(), statusMsg({ epoch: 2 }));
    expect(s.epoch).toBe(2);
    expect(server(s, eventMsg({ type: 'online', seq: 1, epoch: 1 })).events).toEqual([]);
  });

  it('a start that takes too long returns to Start with a toast', () => {
    const s = reducer(reducer(initialState(), { type: 'startClicked' }), { type: 'startTimeout' });
    expect(s.session).toBe('start');
    expect(s.toast).toEqual({ kind: 'error', message: "Couldn't start a game, try again" });
    // Only a start in progress times out.
    const room = server(initialState(), statusMsg());
    expect(reducer(room, { type: 'startTimeout' })).toBe(room);
  });

  it('a socket that dropped while starting, before any game was assigned, returns to Start on reconnect', () => {
    let s = reducer(initialState(), { type: 'startClicked' });
    s = reducer(s, { type: 'conn', conn: 'connecting' });
    s = reducer(s, { type: 'conn', conn: 'open' }); // the first open: newGame goes out
    expect(s.session).toBe('starting');
    s = reducer(s, { type: 'conn', conn: 'closed' });
    expect(s.session).toBe('starting');
    s = reducer(s, { type: 'conn', conn: 'open' });
    expect(s.session).toBe('start');
    expect(s.toast).toEqual({ kind: 'error', message: "Couldn't start a game, try again" });
    // With a gameId the reconnect resumes it instead.
    let g = reducer(initialState(), { type: 'startClicked' });
    g = reducer(g, { type: 'conn', conn: 'open' });
    g = server(g, { t: 'game', gameId });
    g = reducer(reducer(g, { type: 'conn', conn: 'closed' }), { type: 'conn', conn: 'open' });
    expect(g.session).toBe('starting');
  });

  it('telemetry lost: set by the watchdog, cleared by the next status or a connection change', () => {
    let s = server(initialState(), statusMsg());
    s = reducer(s, { type: 'telemetryLost' });
    expect(s.telemetryLost).toBe(true);
    expect(server(s, statusMsg()).telemetryLost).toBe(false);
    expect(reducer(s, { type: 'conn', conn: 'closed' }).telemetryLost).toBe(false);
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

  it('alarmsSeen marks alarm ids seen; alarmsActive forgets cleared ones so a recurrence alerts again', () => {
    let s = reducer(initialState(), { type: 'alarmsSeen', ids: ['a', 'b'] });
    expect([...s.seenAlarms].sort()).toEqual(['a', 'b']);
    const same = reducer(s, { type: 'alarmsActive', ids: ['a', 'b', 'c'] });
    expect(same).toBe(s);
    s = reducer(s, { type: 'alarmsActive', ids: ['a'] });
    expect([...s.seenAlarms]).toEqual(['a']);
    expect(reducer(s, { type: 'startClicked' }).seenAlarms.size).toBe(0);
  });

  it('a status 20 plant minutes after an open event fired puts its hint on the radio once', () => {
    const MIN = 60_000;
    let s = server(initialState(), statusMsg({ plantTime: 0 }));
    s = server(s, eventMsg({ type: 'scenario', seq: 1, eventId: 1, kind: 'tubeLeak', message: 'm', radio: 'leak!', plantTime: 0 }));
    s = reducer(s, { type: 'radioExpire' });
    s = server(s, statusMsg({ plantTime: 19 * MIN }));
    expect(s.radio.current).toBeNull();
    s = server(s, statusMsg({ plantTime: 20 * MIN }));
    expect(s.radio.current).toMatchObject({ key: '1:1:hint', text: `Hint: ${FIX.tubeLeak.text}`, monitor: 'product' });
    expect(s.hinted.has('1:1:hint')).toBe(true);
    s = reducer(s, { type: 'radioExpire' });
    s = server(s, statusMsg({ plantTime: 21 * MIN }));
    expect(s.radio.current).toBeNull();
    expect(s.radio.queue).toHaveLength(0);
  });

  it('a hint opens the monitor the event names (a makeup controller fault opens Stages)', () => {
    let s = server(initialState(), statusMsg({ plantTime: 0 }));
    s = server(s, eventMsg({ type: 'scenario', seq: 1, eventId: 1, kind: 'controllerFault', message: 'Controller fault on loop makeup: stuck.', radio: 'r', plantTime: 0 }));
    s = reducer(s, { type: 'radioExpire' });
    s = server(s, statusMsg({ plantTime: 20 * 60_000 }));
    expect(s.radio.current).toMatchObject({ key: '1:1:hint', monitor: 'stages' });
  });

  it('a replayed earthquake from before the session start does not hint again on resume', () => {
    let s = server(initialState(true), statusMsg({ plantTime: 10 * 60_000 }));
    s = server(s, eventMsg({ type: 'scenario', seq: 1, eventId: 1, kind: 'earthquake', message: 'm', radio: 'quake', plantTime: 0 }));
    s = server(s, statusMsg({ plantTime: 11 * 60_000 }));
    expect(s.radio.current).toBeNull();
  });
});
