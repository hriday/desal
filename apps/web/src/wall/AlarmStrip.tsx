import type { Alarm, MonitorId } from '../alarms/rules';
import { MONITOR_TITLES } from './Monitor';
import './wall.css';

export interface AlarmStripProps {
  alarms: readonly Alarm[];
  onOpen: (id: MonitorId) => void;
}

/** Slim strip of every active alarm, worst first; clicking one opens its monitor. */
export function AlarmStrip({ alarms, onOpen }: AlarmStripProps) {
  const sorted = [...alarms].sort((a, b) => (a.level === b.level ? 0 : a.level === 'bad' ? -1 : 1));
  return (
    <nav className="alarm-strip" aria-label="Active alarms">
      {sorted.length === 0 && <span className="alarm-strip__none">No active alarms</span>}
      {sorted.map((a) => (
        <button key={a.id} type="button" className={`alarm alarm--${a.level}`} title={MONITOR_TITLES[a.monitor]} onClick={() => onOpen(a.monitor)}>
          ▲ {a.text}
        </button>
      ))}
    </nav>
  );
}
