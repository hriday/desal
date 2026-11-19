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
  /**
   * Conditions at the shift start. Gas supply defaults to GAS_CAP_MW at GAS_BASE_PRICE_USD_PER_GJ;
   * a scenario may start the shift already curtailed or at a different price.
   */
  initial: { seawaterTempC: number; chlorophyllUgL: number; gasCapMW?: number; gasPriceUsdPerGJ?: number };
  events: ScenarioEvent[];
  randomPerHour: { kind: ScenarioKind; p: number }[];
}
