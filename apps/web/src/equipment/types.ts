import type { PlantStatus, ShiftTarget } from '@desal/schema';

/** Every equipment drawing takes the same props; anything may be missing. */
export interface EquipmentProps {
  status: PlantStatus | null;
  readings: Record<string, number>;
  /** The current shift's target, from its shiftStart event. */
  target?: ShiftTarget | null;
}
