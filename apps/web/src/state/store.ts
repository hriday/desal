import type { GameEndReason, GameScore, PlantEvent, PlantStatus, ServerMsg } from '@desal/schema';
import { pushFrame, type Trends } from './trends';

export type Session = 'start' | 'starting' | 'handover' | 'room' | 'over';
export type Conn = 'connecting' | 'open' | 'closed';
export type Toast = { kind: 'rejected' | 'capacity'; message: string };

export interface State {
  session: Session;
  gameId: string | null;
  status: PlantStatus | null;
  readings: Record<string, number>;
  trends: Trends;
  events: PlantEvent[];
  pending: Map<string, unknown>;
  toast: Toast | null;
  score: GameScore | null;
  endReason: GameEndReason | null;
  conn: Conn;
}

export type Action =
  | { type: 'server'; msg: ServerMsg }
  | { type: 'conn'; conn: Conn }
  | { type: 'startClicked' }
  | { type: 'sent'; key: string; value: unknown }
  | { type: 'dismissToast' };

export const MAX_EVENTS = 200;

export function initialState(): State {
  return {
    session: 'start', gameId: null, status: null, readings: {}, trends: {}, events: [],
    pending: new Map(), toast: null, score: null, endReason: null, conn: 'connecting',
  };
}

const close = (a: unknown, b: unknown) =>
  typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) < 1e-6 : a === b;

/** Has the plant reported the value we sent? Commands with no status echo confirm on the next status. */
function confirmed(key: string, value: unknown, st: PlantStatus): boolean {
  const [type, target = ''] = key.split(':');
  switch (type) {
    case 'setSetpoint': return close(st.loops[target as keyof typeof st.loops]?.setpoint, value);
    case 'setOutput': return close(st.loops[target as keyof typeof st.loops]?.output, value);
    case 'setLoopMode': return st.loops[target as keyof typeof st.loops]?.mode === value;
    case 'pump': return st.pumps[target as keyof typeof st.pumps]?.running === (value === 'start');
    case 'ballCleaning': return st.ballCleaning === value;
    case 'divertToDrain': return st.divertToDrain === value;
    case 'selectFuel': return st.fuel.active === value || st.fuel.changeoverTo === value;
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

function addEvent(s: State, e: PlantEvent): State {
  if (s.events.some((x) => x.seq === e.seq)) return s;
  let next: State = { ...s, events: [...s.events, e].slice(-MAX_EVENTS) };
  switch (e.type) {
    case 'gameEnd':
      next = { ...next, session: 'over', score: e.score, endReason: e.reason };
      break;
    case 'commandRejected':
      next = { ...next, pending: new Map(), toast: { kind: 'rejected', message: e.reason } };
      break;
    case 'gameRejected':
      next = e.reason === 'capacity'
        ? { ...next, session: 'start', toast: { kind: 'capacity', message: 'The plant is at capacity, try again in a minute' } }
        : next;
      break;
  }
  return next;
}

function onServer(s: State, msg: ServerMsg): State {
  switch (msg.t) {
    case 'game':
      return { ...s, gameId: msg.gameId };
    case 'status': {
      const pending = new Map([...s.pending].filter(([k, v]) => !confirmed(k, v, msg.status)));
      // gameEnd (or a terminal error) wins over any later status for the same game.
      const session = s.session === 'over' && msg.status.phase !== 'handover' ? 'over' : sessionFor(msg.status);
      return { ...s, status: msg.status, gameId: msg.status.gameId, pending, session };
    }
    case 'frame':
      return { ...s, readings: { ...s.readings, ...msg.readings }, trends: pushFrame(s.trends, msg.plantTime, msg.readings) };
    case 'event':
      return addEvent(s, msg.event);
    case 'error':
      if (msg.reason === 'game ended') return { ...s, session: s.score ? 'over' : 'start', gameId: null };
      return s;
    case 'pong':
      return s;
  }
}

export function reducer(s: State, a: Action): State {
  switch (a.type) {
    case 'server': return onServer(s, a.msg);
    case 'conn': return { ...s, conn: a.conn };
    case 'startClicked': return { ...initialState(), conn: s.conn, session: 'starting' };
    case 'sent': return { ...s, pending: new Map(s.pending).set(a.key, a.value) };
    case 'dismissToast': return { ...s, toast: null };
  }
}
