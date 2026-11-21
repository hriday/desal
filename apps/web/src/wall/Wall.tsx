import { MONITORS, type Alarm, type MonitorId } from '../alarms/rules';
import type { EquipmentProps } from '../equipment/types';
import { Monitor } from './Monitor';
import './wall.css';

export interface WallProps extends EquipmentProps {
  alarms: readonly Alarm[];
  onOpen: (id: MonitorId) => void;
}

/** The six monitors in a 3 x 2 grid. */
export function Wall({ alarms, onOpen, ...data }: WallProps) {
  return (
    <section className="wall" aria-label="Monitor wall">
      {MONITORS.map((id) => (
        <Monitor key={id} id={id} {...data} alarms={alarms} onOpen={onOpen} />
      ))}
    </section>
  );
}
