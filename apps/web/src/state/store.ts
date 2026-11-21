import type { Command, GameEndReason, GameMode, GameScore, PlantEvent, PlantStatus, ServerMsg, ShiftReport } from '@desal/schema';
import { commandKey } from '../commands';
import type { ConnState } from '../net/socket';
import { FIX } from '../expanded/labels';
import { dueHints } from './hints';
import { initialRadio, radioReducer, type RadioState } from './radio';
import { pushFrame, type Trends } from './trends';

/** 'resuming': a stored game is being resumed; it ends with the first status, a 'no game' error, or a timeout. */
export type Session = 'start' | 'starting' | 'resuming' | 'handover' | 'room' | 'over';
/** 'idle': no socket (the Start screen holds none); 'full': the gateway closed it with 1013. */
export type Conn = 'idle' | ConnState;
export type Toast = { kind: 'rejected' | 'capacity' | 'error'; message: string };
/** The run's rank within its mode (sent by the gateway once the run has ended); `today` is null when it did not end in the last 24 h. */
export type Rank = { allTime: number; today: number | null };
/**
 * The handover's wait for Flink's report card: 'waiting' from a shiftEnd until REPORT_WAIT_MS passes
 * ('expired': the debrief shows alone), null once the next shift starts.
 */
export type ReportWait = 'waiting' | 'expired' | null;
/**
 * The final report's wait for the run's rank: 'waiting' from the gameEnd until RANK_WAIT_MS passes
 * ('expired': the rank line is left out, since Flink may be down); a rank that comes later still shows.
 */
export type RankWait = 'waiting' | 'expired' | null;

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
  /** The mode the finished run was played in (from gameEnd), for the over screen. */
  endMode: GameMode | null;
  conn: Conn;
  /** The socket has been open at least once, so a later 'connecting' is a reconnect. */
  everOpen: boolean;
  /**
   * The game's newest epoch seen (restores from a snapshot). A restore can rewind seq, so events are
   * de-duplicated on (epoch, seq): a higher epoch starts the de-dup afresh, an older one is stale.
   */
  epoch: number;
  /** No status for a while although the socket is open (the watchdog in GameProvider). */
  telemetryLost: boolean;
  radio: RadioState;
  /** plantTime of the session's first status: radio ignores scenario events older than this (a resume's replay). */
  sessionStartPlantTime: number | null;
  /** Alarms the player has seen by opening their monitor (alarms/rules seenKey); a seen high alarm stops pulsing. */
  seenAlarms: ReadonlySet<string>;
  /** Keys (`shift:eventId:hint`) of the hints already put on the radio, so each shows once. */
  hinted: ReadonlySet<string>;
  /** Flink's report cards, by shiftId; a later report for the same shift (after a restore) replaces it. */
  reports: Record<number, ShiftReport>;
  rank: Rank | null;
  reportWait: ReportWait;
  rankWait: RankWait;
}

export type Action =
  | { type: 'server'; msg: ServerMsg }
  | { type: 'conn'; conn: Conn }
  | { type: 'startClicked' }
  | { type: 'reset' }
  // The resume got no answer in time: offer a new run.
  | { type: 'resumeTimeout' }
  // Dispatch only when socket.send() returned true; a command that was never sent must not show as pending.
  | { type: 'sent'; command: Command; commandId?: string }
  | { type: 'dismissToast' }
  | { type: 'radioExpire' }
  // The player opened a monitor: its active alarms (seenKeys) count as seen.
  | { type: 'alarmsSeen'; ids: readonly string[] }
  // The alarms active now (seenKeys): seen ones that have cleared are forgotten, so a recurrence alerts again.
  | { type: 'alarmsActive'; ids: readonly string[] }
  // No gameStart answer within the start timeout.
  | { type: 'startTimeout' }
  // No status within the watchdog window while connected.
  | { type: 'telemetryLost' }
  // No report card within REPORT_WAIT_MS of a shiftEnd.
  | { type: 'reportTimeout' }
  // No rank within RANK_WAIT_MS of the gameEnd.
  | { type: 'rankTimeout' };

export const MAX_EVENTS = 200;

export const CAPACITY_MESSAGE = 'The plant is at capacity, try again in a minute';
/** The gateway itself is full (close 1013). */
export const GATEWAY_FULL_MESSAGE = 'The plant is at capacity, try again shortly';
export const START_FAILED_MESSAGE = "Couldn't start a game, try again";

const startFailed = (s: State): State => ({ ...s, session: 'start', toast: { kind: 'error', message: START_FAILED_MESSAGE } });

/** `resuming`: a gameId is stored, so the socket will try to resume it. */
export function initialState(resuming = false): State {
  return {
    session: resuming ? 'resuming' : 'start', gameId: null, status: null, readings: {}, trends: {}, events: [],
    pending: new Map(), commandKeys: new Map(), toast: null, score: null, endReason: null, endMode: null, conn: resuming ? 'connecting' : 'idle', everOpen: false,
    epoch: 0, telemetryLost: false, radio: initialRadio, sessionStartPlantTime: null, seenAlarms: new Set(),
    hinted: new Set(), reports: {}, rank: null, reportWait: null, rankWait: null,
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
    // Held until the plant leaves handover / ends, so these buttons can't send twice meanwhile.
    case 'startShift': return st.phase !== 'handover';
    case 'quitGame': return st.phase === 'over';
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
  // Host events (seq 0, outside the game's seq order) are never de-duplicated and never move the epoch.
  if (!e.host) {
    if (e.epoch < s.epoch) return s; // from before the game was restored: superseded
    if (s.events.some((x) => !x.host && x.epoch === e.epoch && x.seq === e.seq)) return s;
  }
  let next: State = { ...s, epoch: e.host ? s.epoch : e.epoch, events: [...s.events, e].slice(-MAX_EVENTS) };
  switch (e.type) {
    case 'scenario':
      // Only events from this session's own plant time on: a resume must not replay old radio calls.
      if (s.sessionStartPlantTime !== null && e.plantTime >= s.sessionStartPlantTime) {
        next = { ...next, radio: radioReducer(s.radio, { type: 'push', eventId: e.eventId, shiftId: e.shiftId, kind: e.kind, text: e.radio, message: e.message }) };
      }
      break;
    case 'shiftEnd':
      next = { ...next, reportWait: 'waiting' };
      break;
    case 'shiftStart':
      next = { ...next, reportWait: null };
      break;
    case 'gameEnd':
      next = { ...next, session: 'over', score: e.score, endReason: e.reason, endMode: e.mode, rankWait: 'waiting' };
      break;
    case 'commandRejected':
      next = { ...next, ...withoutRejected(s, e.commandId), toast: { kind: 'rejected', message: e.reason } };
      break;
    case 'gameRejected':
      next = {
        ...next,
        session: 'start',
        toast: e.reason === 'capacity'
          ? { kind: 'capacity', message: CAPACITY_MESSAGE }
          : { kind: 'error', message: 'You already have a game running in another tab' },
      };
      break;
  }
  return next;
}

/**
 * Puts each hint now due (state/hints.ts) on the radio, on its event's monitor, and records it in
 * `hinted`. An at-once hint for an event from before this session (a resume's replay) is recorded
 * but not shown, like the event's own radio call.
 */
function withHints(s: State, st: PlantStatus): State {
  const due = dueHints(s.events, st, s.hinted);
  if (due.length === 0) return s;
  let radio = s.radio;
  for (const h of due) {
    const e = s.events.find((x) => x.type === 'scenario' && x.shiftId === st.shiftId && x.eventId === h.eventId);
    if (e?.type !== 'scenario') continue;
    if (FIX[h.kind].hint === 'atOnce' && s.sessionStartPlantTime !== null && e.plantTime < s.sessionStartPlantTime) continue;
    radio = radioReducer(radio, { type: 'push', key: h.key, eventId: h.eventId, shiftId: e.shiftId, kind: h.kind, text: h.text, message: e.message });
  }
  return { ...s, radio, hinted: new Set([...s.hinted, ...due.map((h) => h.key)]) };
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
      // Once over, only reset or startClicked leave it: a late status (of any phase) never revives the run.
      const session = s.session === 'over' ? 'over' : sessionFor(msg.status);
      const epoch = Math.max(s.epoch, msg.status.epoch);
      const next: State = { ...s, status: msg.status, gameId: msg.status.gameId, pending, commandKeys, session, epoch, telemetryLost: false,
        sessionStartPlantTime: s.sessionStartPlantTime ?? msg.status.plantTime };
      return withHints(next, msg.status);
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
          return { ...s, session: 'start', toast: { kind: 'capacity', message: CAPACITY_MESSAGE } };
        default:
          return { ...s, toast: { kind: 'error', message: msg.reason } };
      }
    case 'shiftReport':
      return { ...s, reports: { ...s.reports, [msg.report.shiftId]: msg.report } };
    case 'rank':
      return { ...s, rank: { allTime: msg.allTime, today: msg.today } };
    case 'pong':
      return s;
  }
}

export function reducer(s: State, a: Action): State {
  switch (a.type) {
    case 'server': return onServer(s, a.msg);
    case 'conn':
      switch (a.conn) {
        case 'idle': return { ...s, conn: 'idle', everOpen: false, telemetryLost: false };
        // A retry after a 1013 stays 'full' (message and Retry) until it actually opens.
        case 'connecting': return { ...s, conn: s.conn === 'full' ? 'full' : 'connecting', telemetryLost: false };
        case 'open': {
          const opened: State = { ...s, conn: 'open', everOpen: true, telemetryLost: false };
          // A reconnect while starting with no game assigned: the newGame's fate is unknown, so
          // back to Start (the newGame is never resent; a game it may have made is abandoned).
          return s.everOpen && s.session === 'starting' && s.gameId === null ? startFailed(opened) : opened;
        }
        case 'closed':
        case 'full': {
          // On a drop, fall back to plant-reported values; anything in flight is unknowable.
          const dropped: State = { ...s, conn: a.conn, pending: new Map(), commandKeys: new Map(), telemetryLost: false };
          // Full before any game was assigned: back to Start (which holds no socket) to try again.
          if (a.conn === 'full' && s.session === 'starting' && s.gameId === null) {
            return { ...dropped, session: 'start', toast: { kind: 'capacity', message: GATEWAY_FULL_MESSAGE } };
          }
          return dropped;
        }
      }
      return s;
    case 'resumeTimeout': return s.session === 'resuming' ? { ...s, session: 'start' } : s;
    case 'reset': return { ...initialState(), conn: s.conn, everOpen: s.everOpen };
    case 'startClicked': return { ...initialState(), conn: s.conn, everOpen: s.everOpen, session: 'starting' };
    case 'sent': {
      const key = commandKey(a.command);
      const commandKeys = new Map(s.commandKeys);
      if (a.commandId) commandKeys.set(a.commandId, key);
      return { ...s, pending: new Map(s.pending).set(key, { command: a.command, age: 0 }), commandKeys };
    }
    case 'alarmsSeen': {
      if (a.ids.every((id) => s.seenAlarms.has(id))) return s;
      return { ...s, seenAlarms: new Set([...s.seenAlarms, ...a.ids]) };
    }
    case 'alarmsActive': {
      const active = new Set(a.ids);
      if ([...s.seenAlarms].every((id) => active.has(id))) return s;
      return { ...s, seenAlarms: new Set([...s.seenAlarms].filter((id) => active.has(id))) };
    }
    case 'radioExpire': return { ...s, radio: radioReducer(s.radio, { type: 'expire' }) };
    case 'dismissToast': return { ...s, toast: null };
    case 'startTimeout': return s.session === 'starting' ? startFailed(s) : s;
    case 'telemetryLost': return s.telemetryLost ? s : { ...s, telemetryLost: true };
    case 'reportTimeout': return s.reportWait === 'waiting' ? { ...s, reportWait: 'expired' } : s;
    case 'rankTimeout': return s.rankWait === 'waiting' ? { ...s, rankWait: 'expired' } : s;
  }
}
