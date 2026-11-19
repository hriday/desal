import type { ScenarioKind, ShiftOrders } from '@desal/schema';

/** An event the director has planned for this shift but not yet fired. */
export interface QueuedEvent {
  eventId: number;
  kind: ScenarioKind;
  params: Record<string, number | string>;
  earliestMinute: number;
  cascade: boolean;
}

/** The director's plan for one shift, drawn before the shift starts. */
export interface ChaosPlan {
  shiftNumber: number;
  hell: boolean;
  warned: boolean;
  targetM3: number;
  orders: ShiftOrders;
  queue: QueuedEvent[];
}

export interface FiredEvent {
  eventId: number;
  kind: ScenarioKind;
  atMinute: number;
  cleared: boolean;
  how: 'player' | 'crew' | 'expired' | 'noted' | null;
}

/** The plan in force during a shift, with what has fired so far. */
export interface ActiveChaos {
  plan: ChaosPlan;
  fired: FiredEvent[];
  lastFiredMinute: number | null;
  nextEventId: number;
}

/** A sensor reading gone bad: frozen at a value, or noisy by an amplitude. */
export type SensorFault = { kind: 'freeze'; value: number } | { kind: 'noise'; amplitude: number };
