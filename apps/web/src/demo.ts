import type { PlantEvent, PlantStatus, ShiftTarget } from '@desal/schema';
import { LEVEL_LOOP_COUNT, STAGE_COUNT } from './plantConstants';
import type { Trends } from './state/trends';

/** Built-in sample plant for `?demo` and the tests: mid-shift, S2 badly scaled, chlorophyll rising. */
export const DEMO_GAME_ID = '11111111-1111-4111-8111-111111111111';

export const demoTarget: ShiftTarget = { productM3: 3900, maxSalinityPpm: 25, fuelBudgetUsd: 12000 };

export function demoStatus(over: Partial<PlantStatus> = {}): PlantStatus {
  const loop = (setpoint: number, output: number) => ({ mode: 'auto' as const, setpoint, output });
  const loops: Record<string, { mode: 'auto'; setpoint: number; output: number }> = {
    tbt: loop(93.5, 72), intakeFlow: loop(5800, 66), recirc: loop(5350, 82), blowdown: loop(1.45, 40), vacuum: loop(0.95, 55),
    makeup: loop(0.3, 50),
  };
  for (let i = 1; i <= LEVEL_LOOP_COUNT; i++) loops[`level${i}`] = loop(0.35, 50);
  return {
    gameId: DEMO_GAME_ID, callSign: 'Kestrel-42', epoch: 0, shiftNumber: 3, balanceUsd: 12450, tick: 1720, plantTime: 68800, shiftId: 3,
    phase: 'running', mode: 'normal', pace: 'calm', status: 'online', controlMode: 'auto', tripCause: null, restartStep: null,
    loops: loops as PlantStatus['loops'],
    pumps: {
      'P-101': { running: true, overhaulRemainingTicks: 0 },
      'P-102': { running: true, overhaulRemainingTicks: 0 },
      'P-103': { running: false, overhaulRemainingTicks: 0 },
    },
    fuel: {
      active: 'gas', changeoverTo: null, changeoverRemainingTicks: null, backupGrade: 'standard', gasCurtailmentNotice: null,
      gasPriceUsdPerGJ: 8, gasCapMW: 60, backupPriceUsdPerGJ: 14,
    },
    doses: { chlorineMgL: 1.5, antiscalantMgL: 3 },
    shiftTarget: demoTarget,
    ballCleaning: false, divertToDrain: false, divertMode: 'auto', standbySteam: false, standbyEjectors: false, shiftTicksRemaining: 330, deliveries: [],
    acidCleanRemainingTicks: 0, restartAuto: null, offeredGrade: 'standard',
    shiftProductM3: 0, shiftOffSpecM3: 0, productFlowM3h: 0, crew: null, orders: null, hell: null, // Plan 4 Task 11 replaces
    ...over,
  };
}

const pad = (i: number) => `s${String(i).padStart(2, '0')}`;

/** One full frame of readings (every simulator sensor id). */
export function demoReadings(over: Record<string, number> = {}): Record<string, number> {
  const r: Record<string, number> = {
    'intake.P-101.flowM3h': 2950, 'intake.P-101.wear': 0.12, 'intake.P-101.cavitation': 0,
    'intake.P-102.flowM3h': 2850, 'intake.P-102.wear': 0.31, 'intake.P-102.cavitation': 0.05,
    'intake.P-103.flowM3h': 0, 'intake.P-103.wear': 0.05, 'intake.P-103.cavitation': 0,
    'intake.flowM3h': 5800, 'intake.screenFouling': 0.18, 'intake.seawaterTempC': 28,
    'pretreat.chlorophyllUgL': 4.1,
    'heater.tbtC': 93.5, 'heater.firingPct': 72, 'heater.heatMW': 43.2, 'heater.burnerCondition': 0.93,
    'brine.recircM3h': 5350, 'brine.concentrationFactor': 1.45, 'brine.blowdownM3h': 760,
    'brine.makeupM3h': 1714, 'brine.coolingRejectM3h': 4086,
    'vacuum.quality': 0.94,
    'vacuum.motiveSteamBar': 14.5,
    'product.flowM3h': 512, 'product.salinityPpm': 18, 'product.shiftProductM3': 2380,
    'fuel.gasCapMW': 60, 'fuel.gasPriceUsdPerGJ': 8, 'fuel.backupTonnes': 128, 'fuel.burnMW': 43.2, 'fuel.shiftCostUsd': 5120,
  };
  for (let i = 1; i <= STAGE_COUNT; i++) {
    const k = pad(i);
    r[`stages.${k}.tempC`] = 92.1 - (i - 1) * 2.3;
    // S24 is the brine pool, held at the makeup loop's setpoint.
    r[`stages.${k}.levelM`] = i === STAGE_COUNT ? 0.3 : 0.31 + (i - 1) * 0.004;
    r[`stages.${k}.softScaleMm`] = 0.05;
    r[`stages.${k}.hardScaleMm`] = i === 2 ? 0.8 : 0.08;
  }
  return { ...r, ...over };
}

/** Ten minutes of history (one point per second) for every sensor in the demo frame, wobbling around its value. */
export function demoTrends(points = 600): Trends {
  const now = demoStatus().plantTime;
  const out: Trends = {};
  for (const [id, v] of Object.entries(demoReadings())) {
    out[id] = Array.from({ length: points }, (_, i) => ({
      t: now - (points - 1 - i),
      v: v * (1 + 0.02 * Math.sin(i / 37 + id.length) + 0.01 * Math.sin(i / 7)),
    }));
  }
  return out;
}

/** This shift's events so far: start, allocation, a bloom notice and a pump overhaul. */
export function demoEvents(): PlantEvent[] {
  const base = (seq: number, tick: number) => ({ gameId: DEMO_GAME_ID, epoch: 0, seq, tick, plantTime: tick * 40, shiftId: 3 });
  return [
    { ...base(40, 1440), type: 'shiftStart', scenarioId: 'shift-3', mode: 'auto', target: demoTarget, hell: false, orders: { targetM3: demoTarget.productM3, maxSalinityPpm: demoTarget.maxSalinityPpm, budgetUsd: demoTarget.fuelBudgetUsd, lines: [], briefing: [] } },
    { ...base(41, 1440), type: 'accountChange', deltaUsd: 20000, balanceUsd: 25570, cause: 'allocation' },
    { ...base(42, 1500), type: 'scenario', eventId: 1, kind: 'bloom', message: 'Algal bloom in the intake water: chlorophyll rising toward 8 ug/L.', radio: 'Algal bloom in the intake water: chlorophyll rising toward 8 ug/L.' },
    { ...base(43, 1610), type: 'accountChange', deltaUsd: -8000, balanceUsd: 17570, cause: 'overhaul' },
  ];
}
