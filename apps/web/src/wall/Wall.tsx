import { MONITORS, type Alarm, type MonitorId } from '../alarms/rules';
import type { EquipmentProps } from '../equipment/types';
import { Monitor } from './Monitor';
import './wall.css';

export interface WallProps extends EquipmentProps {
  alarms: readonly Alarm[];
  /** Alarms already seen, by seenKey (their monitor was opened). */
  seen?: ReadonlySet<string>;
  onOpen: (id: MonitorId) => void;
}

/** The six monitors in a 3 x 2 grid. */
export function Wall({ alarms, seen, onOpen, ...data }: WallProps) {
  return (
    <section className="wall" aria-label="Monitor wall">
      {MONITORS.map((id) => (
        <Monitor key={id} id={id} {...data} alarms={alarms} seen={seen} onOpen={onOpen} />
      ))}
    </section>
  );
}
