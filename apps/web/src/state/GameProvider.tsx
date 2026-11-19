import type { Command } from '@desal/schema';
import { createContext, useCallback, useContext, useEffect, useReducer, useRef, type ReactNode } from 'react';
import { cmdMsg } from '../commands';
import { createSocket, defaultWsUrl, storedGameId, storeGameId } from '../net/socket';
import { initialState, reducer, type Action, type State } from './store';

export interface Game {
  state: State;
  dispatch: (a: Action) => void;
  /** Send a command; it shows as pending only if the socket accepted it. Returns whether it was sent. */
  send: (command: Command) => boolean;
  /** Ask the gateway for a new game. */
  newGame: () => boolean;
}

export const RESUME_TIMEOUT_MS = 5000;

const Ctx = createContext<Game | null>(null);

export function useGame(): Game {
  const g = useContext(Ctx);
  if (!g) throw new Error('useGame outside GameProvider');
  return g;
}

export function GameProvider({ children, url, factory }: { children: ReactNode; url?: string; factory?: (u: string) => WebSocket }) {
  const [state, rawDispatch] = useReducer(reducer, null, () => initialState(storedGameId() !== null));
  const dispatch = useCallback((a: Action) => {
    if (a.type === 'reset') storeGameId(null); // Play again: never resume the finished run
    rawDispatch(a);
  }, []);
  const sock = useRef<ReturnType<typeof createSocket> | null>(null);

  useEffect(() => {
    const s = createSocket(
      url ?? defaultWsUrl(),
      (msg) => dispatch({ type: 'server', msg }),
      (conn) => dispatch({ type: 'conn', conn }),
      { factory },
    );
    sock.current = s;
    return () => { s.close(); sock.current = null; };
  }, [url, factory]);

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

  const send = useCallback((command: Command) => {
    const { msg, commandId } = cmdMsg(command);
    const ok = sock.current?.send(msg) ?? false;
    if (ok) dispatch({ type: 'sent', command, commandId });
    return ok;
  }, []);

  const newGame = useCallback(() => {
    const ok = sock.current?.send({ t: 'newGame' }) ?? false;
    if (ok) dispatch({ type: 'startClicked' });
    return ok;
  }, []);

  return <Ctx.Provider value={{ state, dispatch, send, newGame }}>{children}</Ctx.Provider>;
}
