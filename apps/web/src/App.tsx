import { useCallback, useState } from 'react';
import { alarmsFor, MONITORS, type MonitorId } from './alarms/rules';
import { demoEvents, demoReadings, demoStatus, demoTarget, demoTrends } from './demo';
import { ExpandedView } from './expanded/ExpandedView';
import { AlarmStrip } from './wall/AlarmStrip';
import { quit, startShift } from './commands';
import { GameOver } from './screens/GameOver';
import { Handover } from './screens/Handover';
import { Start } from './screens/Start';
import { GameProvider, useGame } from './state/GameProvider';
import { Toast } from './ui/Toast';
import { Wall } from './wall/Wall';
import './screens/screens.css';

const asMonitor = (v: string | null): MonitorId | null =>
  v !== null && (MONITORS as readonly string[]).includes(v) ? (v as MonitorId) : null;

/** The demo has no plant: controls are live but nothing is sent (so nothing shows as pending). */
const demoSend = () => false;

/** `?demo`: the wall with the built-in sample plant, for visual checks without a backend. `&open=stages` expands a monitor. */
function Demo({ open }: { open: MonitorId | null }) {
  const [opened, setOpened] = useState<MonitorId | null>(open);
  const close = useCallback(() => setOpened(null), []);
  const [data] = useState(() => {
    const status = demoStatus();
    const readings = demoReadings();
    return { status, readings, trends: demoTrends(), events: demoEvents(), alarms: alarmsFor(status, readings, { target: demoTarget }) };
  });
  return (
    <main style={{ padding: 12 }}>
      <AlarmStrip alarms={data.alarms} onOpen={setOpened} />
      <div style={{ height: 8 }} />
      {opened
        ? <ExpandedView id={opened} {...data} target={demoTarget} onClose={close} send={demoSend} />
        : <Wall status={data.status} readings={data.readings} target={demoTarget} alarms={data.alarms} onOpen={setOpened} />}
    </main>
  );
}

/** Stand-in for the control room (Task 7): the wall, and a monitor expands on click. */
function Room() {
  const { state, send } = useGame();
  const [opened, setOpened] = useState<MonitorId | null>(null);
  const close = useCallback(() => setOpened(null), []);
  const target = state.status?.shiftTarget ?? null;
  const alarms = alarmsFor(state.status, state.readings, { target });
  return (
    <main style={{ padding: 12 }}>
      <AlarmStrip alarms={alarms} onOpen={setOpened} />
      <div style={{ height: 8 }} />
      {opened
        ? <ExpandedView id={opened} status={state.status} readings={state.readings} trends={state.trends} events={state.events} alarms={alarms} target={target} onClose={close} send={send} />
        : <Wall status={state.status} readings={state.readings} target={target} alarms={alarms} onOpen={setOpened} />}
    </main>
  );
}

export function Screens() {
  const { state, dispatch, send, newGame } = useGame();
  const capacity = state.toast?.kind === 'capacity' ? state.toast.message : null;
  let body;
  switch (state.session) {
    case 'start':
    case 'starting':
      body = <Start onStart={newGame} starting={state.session === 'starting'} capacityMessage={capacity} />;
      break;
    case 'handover':
      body = (
        <Handover status={state.status} readings={state.readings} events={state.events}
          onStartShift={(mode) => send(startShift(mode))} onQuit={() => send(quit())} />
      );
      break;
    case 'room':
      body = <Room />;
      break;
    case 'over':
      body = <GameOver reason={state.endReason} score={state.score} onPlayAgain={() => dispatch({ type: 'reset' })} />;
      break;
  }
  return (
    <>
      {body}
      {state.conn === 'closed' && <div className="overlay" role="alert">Reconnecting…</div>}
      <Toast toast={capacity ? null : state.toast} onDismiss={() => dispatch({ type: 'dismissToast' })} />
    </>
  );
}

export function App() {
  const params = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
  if (params?.has('demo')) return <Demo open={asMonitor(params.get('open'))} />;
  return (
    <GameProvider>
      <Screens />
    </GameProvider>
  );
}
