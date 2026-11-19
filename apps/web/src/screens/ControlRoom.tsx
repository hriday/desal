import { useCallback, useMemo, useState } from 'react';
import { alarmContext, alarmsFor, type MonitorId } from '../alarms/rules';
import { quit } from '../commands';
import { ExpandedView } from '../expanded/ExpandedView';
import { useGame } from '../state/GameProvider';
import { AlarmStrip } from '../wall/AlarmStrip';
import { Wall } from '../wall/Wall';
import { TopBar } from './TopBar';
import './room.css';

/**
 * The control room during a shift: top bar, alarm strip, and the wall or one expanded monitor
 * (Esc or Back returns to the wall). A gameEnd swaps the whole screen for GameOver via the session.
 */
export function ControlRoom() {
  const { state, send } = useGame();
  const { status, readings, events } = state;
  const [opened, setOpened] = useState<MonitorId | null>(null);
  const close = useCallback(() => setOpened(null), []);
  const ctx = useMemo(
    () => alarmContext(events, status?.shiftId ?? null, status?.shiftTarget),
    [events, status?.shiftId, status?.shiftTarget],
  );
  const alarms = useMemo(() => alarmsFor(status, readings, ctx), [status, readings, ctx]);
  return (
    <main className="room" data-screen="room" data-game-id={state.gameId ?? undefined}>
      <TopBar status={status} conn={state.conn} quitting={state.pending.has('quitGame')} onQuit={() => send(quit())} />
      <p className="room__narrow">This control room is best on a larger screen.</p>
      <AlarmStrip alarms={alarms} onOpen={setOpened} />
      {opened ? (
        <ExpandedView
          id={opened} status={status} readings={readings} trends={state.trends} events={events}
          alarms={alarms} target={ctx.target} pending={state.pending} send={send} onClose={close}
        />
      ) : (
        <Wall status={status} readings={readings} target={ctx.target} alarms={alarms} onOpen={setOpened} />
      )}
    </main>
  );
}
