import { useState } from 'react';
import { alarmsFor, type MonitorId } from './alarms/rules';
import { demoReadings, demoStatus, demoTarget } from './demo';
import { AlarmStrip } from './wall/AlarmStrip';
import { Wall } from './wall/Wall';

// Placeholder screens; replaced by the real screens in later tasks.
export type Screen = 'start' | 'handover' | 'room' | 'over';

/** `?demo`: the wall with the built-in sample plant, for visual checks without a backend. */
function Demo() {
  const [opened, setOpened] = useState<MonitorId | null>(null);
  const status = demoStatus();
  const readings = demoReadings();
  const alarms = alarmsFor(status, readings, { target: demoTarget });
  return (
    <main style={{ padding: 12 }}>
      <AlarmStrip alarms={alarms} onOpen={setOpened} />
      <div style={{ height: 8 }} />
      <Wall status={status} readings={readings} target={demoTarget} alarms={alarms} onOpen={setOpened} />
      {opened && <p style={{ color: 'var(--muted)', font: '11px var(--mono)' }}>Opened: {opened}</p>}
    </main>
  );
}

export function App({ screen = 'start' }: { screen?: Screen }) {
  if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('demo')) return <Demo />;
  return (
    <main>
      <h1>Desalination Control Room</h1>
      <p data-screen={screen}>Screen: {screen}</p>
    </main>
  );
}
