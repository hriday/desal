import type { Command } from '@desal/schema';
import { createContext, useCallback, useContext, useEffect, useReducer, useRef, type ReactNode } from 'react';
import { cmdMsg } from '../commands';
import { createSocket, defaultWsUrl } from '../net/socket';
import { initialState, reducer, type Action, type State } from './store';

export interface Game {
  state: State;
  dispatch: (a: Action) => void;
  /** Send a command; it shows as pending only if the socket accepted it. Returns whether it was sent. */
  send: (command: Command) => boolean;
  /** Ask the gateway for a new game. */
  newGame: () => boolean;
}

const Ctx = createContext<Game | null>(null);

export function useGame(): Game {
  const g = useContext(Ctx);
  if (!g) throw new Error('useGame outside GameProvider');
  return g;
}

export function GameProvider({ children, url, factory }: { children: ReactNode; url?: string; factory?: (u: string) => WebSocket }) {
  const [state, dispatch] = useReducer(reducer, undefined, initialState);
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
