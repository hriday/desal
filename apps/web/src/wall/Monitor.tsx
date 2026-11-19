import type { ComponentType } from 'react';
import { worstLevel, type Alarm, type MonitorId } from '../alarms/rules';
import { BrineHeater } from '../equipment/BrineHeater';
import { FlashStages } from '../equipment/FlashStages';
import { Fuel } from '../equipment/Fuel';
import { Intake } from '../equipment/Intake';
import { ProductWater } from '../equipment/ProductWater';
import { ShiftAccount } from '../equipment/ShiftAccount';
import type { EquipmentProps } from '../equipment/types';

export const MONITOR_TITLES: Record<MonitorId, string> = {
  intake: 'Intake', heater: 'Brine Heater', stages: 'Flash Stages', product: 'Product Water', fuel: 'Fuel', shift: 'Shift & Account',
};

const DRAWINGS: Record<Exclude<MonitorId, 'shift'>, ComponentType<EquipmentProps>> = {
  intake: Intake, heater: BrineHeater, stages: FlashStages, product: ProductWater, fuel: Fuel,
};

export interface MonitorProps extends EquipmentProps {
  id: MonitorId;
  alarms: readonly Alarm[];
  onOpen: (id: MonitorId) => void;
}

/** One screen on the wall: a button whose border and light follow its worst alarm. */
export function Monitor({ id, alarms, onOpen, ...data }: MonitorProps) {
  const level = worstLevel(alarms, id);
  const title = MONITOR_TITLES[id];
  const Drawing = id === 'shift' ? null : DRAWINGS[id];
  return (
    <button
      type="button"
      className={`monitor monitor--${level}`}
      data-monitor={id}
      aria-label={`${title}, ${level === 'ok' ? 'normal' : level === 'warn' ? 'warning' : 'alarm'}`}
      onClick={() => onOpen(id)}
    >
      <span className="monitor__title">
        {title.toUpperCase()}
        <span className={`monitor__light monitor__light--${level}`} aria-hidden="true">●</span>
      </span>
      {Drawing ? <Drawing {...data} /> : <ShiftAccount {...data} alarms={alarms} />}
    </button>
  );
}
