import type { ComponentType } from 'react';
import { seenKey, worstLevel, type Alarm, type MonitorId } from '../alarms/rules';
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
  /** Alarms already seen, by seenKey (their monitor was opened); missing means none seen. */
  seen?: ReadonlySet<string>;
  onOpen: (id: MonitorId) => void;
}

const NONE_SEEN: ReadonlySet<string> = new Set();
/** Plant states in which the process units stand still (their drawings dim and stop moving). */
const DOWN_STATES: ReadonlySet<string> = new Set(['tripped', 'acidCleaning']);

/** 'high' while an unseen high alarm is on this monitor (keeps pulsing); 'warn' for an unseen warning (pulses once). */
export function monitorAlert(alarms: readonly Alarm[], id: MonitorId, seen: ReadonlySet<string>): 'high' | 'warn' | undefined {
  let alert: 'warn' | undefined;
  for (const a of alarms) {
    if (a.monitor !== id || seen.has(seenKey(a))) continue;
    if (a.level === 'bad') return 'high';
    alert = 'warn';
  }
  return alert;
}

/**
 * One screen on the wall: a button whose border and light follow its worst alarm. Its frame pulses for
 * unseen alarms, and a process drawing goes still and dim while the plant is down.
 */
export function Monitor({ id, alarms, seen = NONE_SEEN, onOpen, ...data }: MonitorProps) {
  const level = worstLevel(alarms, id);
  const down = id !== 'shift' && DOWN_STATES.has(String(data.status?.status));
  const title = MONITOR_TITLES[id];
  const Drawing = id === 'shift' ? null : DRAWINGS[id];
  return (
    <button
      type="button"
      className={`monitor monitor--${level}`}
      data-monitor={id}
      data-alert={monitorAlert(alarms, id, seen)}
      data-down={down ? 'true' : undefined}
      aria-label={`${title}, ${level === 'ok' ? 'normal' : level === 'warn' ? 'warning' : 'alarm'}`}
      onClick={() => onOpen(id)}
    >
      <span className="monitor__title">
        {title.toUpperCase()}
        <span className={`monitor__light monitor__light--${level}`} aria-hidden="true" />
      </span>
      <span className="monitor__screen">
        {Drawing ? <Drawing {...data} /> : <ShiftAccount {...data} alarms={alarms} />}
      </span>
    </button>
  );
}
