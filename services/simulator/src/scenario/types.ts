import type { ScenarioKind } from '@desal/schema';

export type { ScenarioKind };

/**
 * A scheduled (or randomly drawn) scenario event. `atMinute` is plant minutes from the shift start.
 * Params by kind:
 *  - bloom: { peakUgL, rampMinutes }
 *  - seawaterTemp: { deltaC }
 *  - pumpBearing: { pumpId, mult }
 *  - gasCurtailNotice: { capMW, effectiveMinute } (effectiveMinute is plant minutes from shift start)
 *  - gasPriceSpike: { mult }
 *  - offgradeOnly: {}
 *  - deliveryDelay: { ticks }
 *  - demandChange: { deltaM3 }
 *  - controllerFault: { loop (a LoopId), kind ('stuck' | 'drift' | 'oscillate') }
 */
export interface ScenarioEvent {
  atMinute: number;
  kind: ScenarioKind;
  params: Record<string, number | string>;
  message: string;
}

export interface Scenario {
  id: string;
  target: { productM3: number; maxSalinityPpm: number; fuelBudgetUsd: number };
  initial: { seawaterTempC: number; chlorophyllUgL: number };
  events: ScenarioEvent[];
  randomPerHour: { kind: ScenarioKind; p: number }[];
}
