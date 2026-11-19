import { useCallback, useState } from 'react';
import { alarmsFor, MONITORS, type MonitorId } from './alarms/rules';
import { demoEvents, demoReadings, demoStatus, demoTarget, demoTrends } from './demo';
import { ExpandedView } from './expanded/ExpandedView';
import { AlarmStrip } from './wall/AlarmStrip';
import { Wall } from './wall/Wall';

// Placeholder screens; replaced by the real screens in later tasks.
export type Screen = 'start' | 'handover' | 'room' | 'over';

const asMonitor = (v: string | null): MonitorId | null =>
  v !== null && (MONITORS as readonly string[]).includes(v) ? (v as MonitorId) : null;

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
        ? <ExpandedView id={opened} {...data} target={demoTarget} onClose={close} />
        : <Wall status={data.status} readings={data.readings} target={demoTarget} alarms={data.alarms} onOpen={setOpened} />}
    </main>
  );
}

export function App({ screen = 'start' }: { screen?: Screen }) {
  const params = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
  if (params?.has('demo')) return <Demo open={asMonitor(params.get('open'))} />;
  return (
    <main>
      <h1>Desalination Control Room</h1>
      <p data-screen={screen}>Screen: {screen}</p>
    </main>
  );
}
