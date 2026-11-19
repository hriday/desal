import type { ScenarioKind, ShiftOrders } from '@desal/schema';
import type { PlantState } from '../state.js';
import type { ChaosPlan } from './chaosTypes.js';

const MAX_SALINITY_PPM = 25;
/** A pump at or above this wear gets a line in the orders. */
const ROUGH_WEAR = 0.5;
const ROUGH_SHIFT_LINE = 'Expect a rough shift — stay sharp.';

/** What the crew says over the radio when `kind` hits, in the plant's voice. */
export function radioLine(kind: ScenarioKind, p: Record<string, number | string>): string {
  switch (kind) {
    case 'pumpTrip':
      return `Control, ${p.pumpId} just tripped — she's coasting down!`;
    case 'tubeLeak':
      return `Control, salt's showing in the product — tube leak near stage ${Number(p.stage) + 1}, about +${p.ppm} ppm!`;
    case 'vacuumLoss':
      return "Control, vacuum's bleeding off — something's wrong at the ejector!";
    case 'powerDip':
      return `Control, the grid just dipped — ${p.pumpId} is sagging and recirc is down!`;
    case 'storm':
      return "Control, storm surge at the intake — the sea's gone cold and the screens are loading up!";
    case 'sensorFailure':
      // Deliberately vague: a sensor failure is visible only as the reading's behaviour.
      return 'Control, one of the field instruments is acting up — trust your eyes over the numbers.';
    default:
      return `Control, event on the plant: ${kind}.`;
  }
}

const HINTS: Partial<Record<ScenarioKind, string>> = {
  storm: 'Storm forecast later in the shift.',
  powerDip: 'Grid is unstable today.',
  vacuumLoss: 'Maintenance flagged the evaporator — keep an eye on it.',
  tubeLeak: 'Maintenance flagged the evaporator — keep an eye on it.',
  pumpTrip: 'Intake pumps have been noisy.',
  pumpBearing: 'Intake pumps have been noisy.',
  gasCurtailNotice: 'Gas supplier is unreliable today.',
  gasPriceSpike: 'Gas supplier is unreliable today.',
  deliveryDelay: 'Gas supplier is unreliable today.',
  offgradeOnly: 'Gas supplier is unreliable today.',
};

/** Up to two distinct hint lines, in queue order, from the kinds the plan holds. */
function hintLines(plan: Omit<ChaosPlan, 'orders'>): string[] {
  const lines: string[] = [];
  for (const e of plan.queue) {
    const hint = HINTS[e.kind];
    if (hint && !lines.includes(hint)) lines.push(hint);
    if (lines.length === 2) break;
  }
  return lines;
}

/** The shift supervisor's orders card for `plan`. Shift 1 also carries the three-line briefing. */
export function buildOrders(plan: Omit<ChaosPlan, 'orders'>, state: PlantState, budgetUsd: number): ShiftOrders {
  const lines = [
    `Seawater is ${state.seawater.tempC.toFixed(1)} °C with chlorophyll at ${state.seawater.chlorophyllUgL.toFixed(1)} µg/L.`,
  ];
  for (const [id, pump] of Object.entries(state.intake.pumps)) {
    if (pump.wear >= ROUGH_WEAR) lines.push(`${id} is running rough.`);
  }
  if (plan.hell && plan.warned) {
    const hints = hintLines(plan);
    lines.push(...(hints.length > 0 ? hints : [ROUGH_SHIFT_LINE]));
  }
  const briefing =
    plan.shiftNumber === 1
      ? [
          `Deliver ${plan.targetM3.toLocaleString('en-US')} m³ of in-spec water this shift.`,
          `Keep product salt under ${MAX_SALINITY_PPM} ppm — diverted or off-spec water doesn't count.`,
          `Click a monitor to act on it, and watch the fuel budget ($${budgetUsd.toLocaleString('en-US')}).`,
        ]
      : [];
  return { targetM3: plan.targetM3, maxSalinityPpm: MAX_SALINITY_PPM, budgetUsd, lines, briefing };
}
