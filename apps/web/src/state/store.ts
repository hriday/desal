import type { Command, GameEndReason, GameScore, PlantEvent, PlantStatus, ServerMsg } from '@desal/schema';
import { commandKey } from '../commands';
import { pushFrame, type Trends } from './trends';

export type Session = 'start' | 'starting' | 'handover' | 'room' | 'over';
export type Conn = 'connecting' | 'open' | 'closed';
export type Toast = { kind: 'rejected' | 'capacity' | 'error'; message: string };

/** A command awaiting confirmation; `age` counts statuses received since it was sent. */
export interface PendingEntry { command: Command; age: number }
/** An unconfirmed pending entry is dropped after this many statuses (the plant clamped or ignored it). */
export const PENDING_MAX_AGE = 3;

export interface State {
  session: Session;
  gameId: string | null;
  status: PlantStatus | null;
  readings: Record<string, number>;
  trends: Trends;
  events: PlantEvent[];
  pending: Map<string, PendingEntry>;
  /** commandId -> pending key, so a commandRejected clears only its own entry. */
  commandKeys: Map<string, string>;
  toast: Toast | null;
  score: GameScore | null;
  endReason: GameEndReason | null;
  conn: Conn;
}

export type Action =
  | { type: 'server'; msg: ServerMsg }
  | { type: 'conn'; conn: Conn }
  | { type: 'startClicked' }
  // Dispatch only when socket.send() returned true; a command that was never sent must not show as pending.
  | { type: 'sent'; command: Command; commandId?: string }
  | { type: 'dismissToast' };

export const MAX_EVENTS = 200;

export function initialState(): State {
  return {
    session: 'start', gameId: null, status: null, readings: {}, trends: {}, events: [],
    pending: new Map(), commandKeys: new Map(), toast: null, score: null, endReason: null, conn: 'connecting',
  };
}

const close = (a: unknown, b: unknown) =>
  typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) < 1e-6 : a === b;

/** Has the plant reported what the command asked for? Commands with no status echo confirm on the next status. */
function confirmed(cmd: Command, st: PlantStatus): boolean {
  switch (cmd.type) {
    case 'setSetpoint': return close(st.loops[cmd.loop]?.setpoint, cmd.value);
    case 'setOutput': return close(st.loops[cmd.loop]?.output, cmd.value);
    case 'setLoopMode': return st.loops[cmd.loop]?.mode === cmd.mode;
    case 'pump': return st.pumps[cmd.pumpId]?.running === (cmd.action === 'start');
    case 'setDose': return close(cmd.chemical === 'chlorine' ? st.doses?.chlorineMgL : st.doses?.antiscalantMgL, cmd.mgL);
    case 'ballCleaning': return st.ballCleaning === cmd.on;
    case 'divertToDrain': return st.divertToDrain === cmd.on;
    case 'selectFuel': return st.fuel.active === cmd.fuel || st.fuel.changeoverTo === cmd.fuel;
    default: return true;
  }
}

function sessionFor(st: PlantStatus): Session {
  switch (st.phase) {
    case 'handover': return 'handover';
    case 'running':
    case 'paused': return 'room';
    case 'over': return 'over';
  }
}

function withoutRejected(s: State, commandId: string): Pick<State, 'pending' | 'commandKeys'> {
  const key = s.commandKeys.get(commandId);
  if (key === undefined) return { pending: new Map(), commandKeys: new Map() }; // unknown id: clear everything
  const pending = new Map(s.pending);
  pending.delete(key);
  const commandKeys = new Map(s.commandKeys);
  commandKeys.delete(commandId);
  return { pending, commandKeys };
}

function addEvent(s: State, e: PlantEvent): State {
  if (s.events.some((x) => x.seq === e.seq)) return s;
  let next: State = { ...s, events: [...s.events, e].slice(-MAX_EVENTS) };
  switch (e.type) {
    case 'gameEnd':
      next = { ...next, session: 'over', score: e.score, endReason: e.reason };
      break;
    case 'commandRejected':
      next = { ...next, ...withoutRejected(s, e.commandId), toast: { kind: 'rejected', message: e.reason } };
      break;
    case 'gameRejected':
      next = {
        ...next,
        session: 'start',
        toast: e.reason === 'capacity'
          ? { kind: 'capacity', message: 'The plant is at capacity, try again in a minute' }
          : { kind: 'error', message: 'You already have a game running in another tab' },
      };
      break;
  }
  return next;
}

function onServer(s: State, msg: ServerMsg): State {
  switch (msg.t) {
    case 'game':
      return { ...s, gameId: msg.gameId };
    case 'status': {
      const pending = new Map<string, PendingEntry>();
      for (const [k, p] of s.pending) {
        if (confirmed(p.command, msg.status) || p.age + 1 >= PENDING_MAX_AGE) continue;
        pending.set(k, { ...p, age: p.age + 1 });
      }
      const commandKeys = new Map([...s.commandKeys].filter(([, k]) => pending.has(k)));
      // gameEnd (or a terminal error) wins over any later status for the same game.
      const session = s.session === 'over' && msg.status.phase !== 'handover' ? 'over' : sessionFor(msg.status);
      return { ...s, status: msg.status, gameId: msg.status.gameId, pending, commandKeys, session };
    }
    case 'frame':
      return { ...s, readings: { ...s.readings, ...msg.readings }, trends: pushFrame(s.trends, msg.plantTime, msg.readings) };
    case 'event':
      return addEvent(s, msg.event);
    case 'error':
      switch (msg.reason) {
        case 'game ended':
        case 'no game':
          return { ...s, session: s.score ? 'over' : 'start', gameId: null };
        case 'capacity':
          return { ...s, session: 'start', toast: { kind: 'capacity', message: 'The plant is at capacity, try again in a minute' } };
        default:
          return { ...s, toast: { kind: 'error', message: msg.reason } };
      }
    case 'pong':
      return s;
  }
}

export function reducer(s: State, a: Action): State {
  switch (a.type) {
    case 'server': return onServer(s, a.msg);
    case 'conn':
      // On a drop, fall back to plant-reported values; anything in flight is unknowable.
      return a.conn === 'closed'
        ? { ...s, conn: a.conn, pending: new Map(), commandKeys: new Map() }
        : { ...s, conn: a.conn };
    case 'startClicked': return { ...initialState(), conn: s.conn, session: 'starting' };
    case 'sent': {
      const key = commandKey(a.command);
      const commandKeys = new Map(s.commandKeys);
      if (a.commandId) commandKeys.set(a.commandId, key);
      return { ...s, pending: new Map(s.pending).set(key, { command: a.command, age: 0 }), commandKeys };
    }
    case 'dismissToast': return { ...s, toast: null };
  }
}
