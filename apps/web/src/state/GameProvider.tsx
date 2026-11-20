import type { ClientMsg, Command } from '@desal/schema';
import { createContext, useCallback, useContext, useEffect, useReducer, useRef, type ReactNode } from 'react';
import { cmdMsg } from '../commands';
import { createSocket, defaultWsUrl, storedGameId, storeGameId, type GameSocket } from '../net/socket';
import { initialState, reducer, type Action, type State } from './store';

export interface Game {
  state: State;
  dispatch: (a: Action) => void;
  /** Send a command; it shows as pending only if the socket accepted it. Returns whether it was sent. */
  send: (command: Command) => boolean;
  /** Ask the gateway for a new game (opens the socket first if there is none). */
  newGame: () => boolean;
  /** At capacity: reconnect now instead of waiting out the backoff. */
  retry: () => void;
}

export const RESUME_TIMEOUT_MS = 5000;
/** A start (Start pressed, no game yet) gives up after this long. */
export const START_TIMEOUT_MS = 10_000;
/** In the room or handover, no status for this long while connected shows "Telemetry lost". */
export const WATCHDOG_MS = 5000;

const Ctx = createContext<Game | null>(null);

export function useGame(): Game {
  const g = useContext(Ctx);
  if (!g) throw new Error('useGame outside GameProvider');
  return g;
}

/**
 * The game session and its socket. The socket exists only while there is a game to play or start:
 * it opens when the player presses Start, or at once when a stored gameId is to be resumed, and it
 * closes whenever the session is back on the Start screen.
 */
export function GameProvider({ children, url, factory }: { children: ReactNode; url?: string; factory?: (u: string) => WebSocket }) {
  const [state, rawDispatch] = useReducer(reducer, null, () => initialState(storedGameId() !== null));
  const dispatch = useCallback((a: Action) => {
    if (a.type === 'reset') storeGameId(null); // Play again: never resume the finished run
    rawDispatch(a);
  }, []);
  const sock = useRef<GameSocket | null>(null);
  /** Start was pressed: the next open sends newGame (once) instead of a resume. */
  const wantNewGame = useRef(false);

  const hello = useCallback((): ClientMsg | null => {
    if (wantNewGame.current) {
      wantNewGame.current = false;
      return { t: 'newGame', mode: 'normal' };
    }
    const id = storedGameId();
    return id ? { t: 'resume', gameId: id } : null;
  }, []);

  const openSocket = useCallback(() => {
    if (sock.current) return;
    sock.current = createSocket(
      url ?? defaultWsUrl(),
      (msg) => dispatch({ type: 'server', msg }),
      (conn) => dispatch({ type: 'conn', conn }),
      { factory, hello },
    );
  }, [url, factory, hello, dispatch]);

  const closeSocket = useCallback(() => {
    const s = sock.current;
    if (!s) return;
    sock.current = null;
    wantNewGame.current = false;
    s.close();
    rawDispatch({ type: 'conn', conn: 'idle' });
  }, []);

  // A stored game: connect at once to resume it. Otherwise wait for Start.
  useEffect(() => {
    if (storedGameId() !== null) openSocket();
    return () => {
      sock.current?.close();
      sock.current = null;
    };
  }, [openSocket]);

  // Back on the Start screen (no game, a failed start, Play again): hold no socket.
  useEffect(() => {
    if (state.session === 'start') closeSocket();
  }, [state.session, closeSocket]);

  // A resume that gets no answer (no status, no 'no game') within 5 s of the socket opening gives up
  // and offers a new run. Counting from open keeps a slow first connect from discarding the game.
  const resuming = state.session === 'resuming' && state.conn === 'open';
  useEffect(() => {
    if (!resuming) return;
    const t = setTimeout(() => {
      storeGameId(null);
      rawDispatch({ type: 'resumeTimeout' });
    }, RESUME_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [resuming]);

  // Start pressed but no game came of it in time: back to Start with a toast.
  const starting = state.session === 'starting';
  useEffect(() => {
    if (!starting) return;
    const t = setTimeout(() => rawDispatch({ type: 'startTimeout' }), START_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [starting]);

  // Liveness watchdog: every status restarts it (the plant sends one per tick, also when paused).
  const watching = (state.session === 'room' || state.session === 'handover') && state.conn === 'open';
  useEffect(() => {
    if (!watching) return;
    const t = setTimeout(() => rawDispatch({ type: 'telemetryLost' }), WATCHDOG_MS);
    return () => clearTimeout(t);
  }, [watching, state.status]);

  const send = useCallback((command: Command) => {
    const { msg, commandId } = cmdMsg(command);
    const ok = sock.current?.send(msg) ?? false;
    if (ok) dispatch({ type: 'sent', command, commandId });
    return ok;
  }, [dispatch]);

  const newGame = useCallback(() => {
    const s = sock.current;
    if (s) {
      // A socket is already open (it normally is not, on Start): ask on it.
      const ok = s.send({ t: 'newGame', mode: 'normal' });
      if (ok) dispatch({ type: 'startClicked' });
      return ok;
    }
    wantNewGame.current = true;
    dispatch({ type: 'startClicked' });
    openSocket();
    return true;
  }, [dispatch, openSocket]);

  const retry = useCallback(() => sock.current?.retryNow(), []);

  return <Ctx.Provider value={{ state, dispatch, send, newGame, retry }}>{children}</Ctx.Provider>;
}
