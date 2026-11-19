import type { PlantEvent } from '@desal/schema';
import type { Alarm } from '../alarms/rules';
import type { EquipmentProps } from '../equipment/types';
import type { Trends } from '../state/trends';

/** Every expanded view takes the same props; anything may be missing. */
export interface ExpandedProps extends EquipmentProps {
  trends: Trends;
  events: readonly PlantEvent[];
  alarms?: readonly Alarm[];
}
