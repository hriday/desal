import type { PlantEvent } from '@desal/schema';
import type { Alarm } from '../alarms/rules';
import type { ControlCtx } from '../controls/ctx';
import type { EquipmentProps } from '../equipment/types';
import type { Trends } from '../state/trends';

/** Every expanded view takes the same props; anything may be missing. Without `send` the controls are disabled. */
export interface ExpandedProps extends EquipmentProps, Omit<ControlCtx, 'status'> {
  trends: Trends;
  events: readonly PlantEvent[];
  alarms?: readonly Alarm[];
}
