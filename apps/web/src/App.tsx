import { Component, useCallback, useState, type ErrorInfo, type ReactNode, type SyntheticEvent } from 'react';
import { alarmsFor, MONITORS, type MonitorId } from './alarms/rules';
import { demoEvents, demoReadings, demoStatus, demoTarget, demoTrends } from './demo';
import { ExpandedView } from './expanded/ExpandedView';
import { AlarmStrip } from './wall/AlarmStrip';
import { quit, startShift } from './commands';
import { ControlRoom } from './screens/ControlRoom';
import { GameOver } from './screens/GameOver';
import { Handover } from './screens/Handover';
import { Start } from './screens/Start';
import { GameProvider, useGame } from './state/GameProvider';
import { ConnOverlay } from './ui/Overlay';
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

const swallow = (e: SyntheticEvent) => { e.preventDefault(); e.stopPropagation(); };

export function Screens() {
  const { state, dispatch, send, newGame, retry } = useGame();
  const capacity = state.toast?.kind === 'capacity' ? state.toast.message : null;
  const blocked = state.conn !== 'open' && state.conn !== 'idle';
  let body;
  switch (state.session) {
    case 'start':
    case 'starting':
      body = <Start onStart={newGame} starting={state.session === 'starting'} capacityMessage={capacity} />;
      break;
    case 'resuming':
      body = <main className="screen" data-screen="resuming"><p>Resuming your game…</p></main>;
      break;
    case 'handover':
      body = (
        <Handover status={state.status} readings={state.readings} events={state.events}
          busy={state.pending.has('startShift') || state.pending.has('quitGame')}
          onStartShift={(mode) => send(startShift(mode))} onQuit={() => send(quit())} />
      );
      break;
    case 'room':
      body = <ControlRoom />;
      break;
    case 'over':
      body = <GameOver reason={state.endReason} score={state.score} onPlayAgain={() => dispatch({ type: 'reset' })} />;
      break;
  }
  return (
    <>
      {/* Under the connection overlay nothing can be focused (inert) or clicked (the capture guard
          also covers synthetic clicks and browsers without inert). */}
      <div className="app" inert={blocked} onClickCapture={blocked ? swallow : undefined}>{body}</div>
      <ConnOverlay conn={state.conn} everOpen={state.everOpen} onRetry={retry} />
      <Toast toast={capacity ? null : state.toast} onDismiss={() => dispatch({ type: 'dismissToast' })} />
    </>
  );
}

/**
 * Catches a render error anywhere below. The gameId stays in sessionStorage, so Reload resumes
 * the same game within the gateway's window.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: unknown, info: ErrorInfo) { console.error('render failed', error, info.componentStack); }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="screen" data-screen="error" role="alert">
        <h1>Something went wrong, reload</h1>
        <p>Your game is still running; reloading picks it up where you left it.</p>
        <div className="screen__actions">
          <button type="button" className="primary" onClick={() => window.location.reload()}>Reload</button>
        </div>
      </main>
    );
  }
}

export function App() {
  const params = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
  if (params?.has('demo')) return <Demo open={asMonitor(params.get('open'))} />;
  return (
    <ErrorBoundary>
      <GameProvider>
        <Screens />
      </GameProvider>
    </ErrorBoundary>
  );
}
