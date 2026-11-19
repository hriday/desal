import type {
  FuelGrade,
  FuelKind,
  Phase,
  PlantStatusKind,
  PumpId,
  RestartStep,
  TripCause,
} from '@desal/schema';
import {
  BLOWDOWN_MAX_M3H,
  CF_MAX,
  CF_MIN,
  CF_NOMINAL,
  LEVEL_BALANCE_VALVE_PCT,
  LOOP_GAINS,
  RECIRC_NOMINAL_M3H,
  RECIRC_PUMP_MAX_M3H,
  STAGE_COUNT,
  VACUUM_QUALITY_MIN,
  VACUUM_QUALITY_NOMINAL,
} from './constants.js';

export type LoopFault = { kind: 'stuck' | 'drift' | 'oscillate'; bias: number };
export interface Loop {
  mode: 'auto' | 'manual';
  setpoint: number;
  output: number;
  integral: number;
  prevError: number;
  fault: LoopFault | null;
}
export interface Pump {
  running: boolean;
  wear: number; // 0..1
  cavitation: number; // 0..1
  bearingWearMult: number;
}
export interface Stage {
  tempC: number;
  levelM: number;
  softScaleMm: number;
  hardScaleMm: number;
}
export interface Delivery {
  arrivesAtTick: number;
  tonnes: number;
  grade: FuelGrade;
}
export interface ShiftTarget {
  productM3: number;
  maxSalinityPpm: number;
  fuelBudgetUsd: number;
}
export interface ShiftState {
  id: number;
  startTick: number;
  mode: 'auto' | 'manual';
  target: ShiftTarget;
  acc: { productM3: number; offSpecTicks: number; fuelCostUsd: number; trips: number };
}
export interface ScenarioEffects {
  offgradeOnly: boolean;
  deliveryDelayTicks: number;
  chlorophyllTarget: number;
  chlorophyllRampPerTick: number;
}

export interface PlantState {
  version: 1;
  seed: number;
  tick: number;
  plantTime: number;
  phase: Phase;
  controlMode: 'auto' | 'manual';
  status: PlantStatusKind;
  trip: { cause: TripCause; atTick: number } | null;
  /** prevFiringPct: firing (tbt output) seen at the previous restart step, used to police the manual ramp rate. */
  restart: { step: RestartStep; stepStartedTick: number; auto: boolean; prevFiringPct: number } | null;
  acidCleanRemainingTicks: number;
  loops: Record<'tbt' | 'intakeFlow' | 'recirc' | 'blowdown' | 'vacuum', Loop> & { levels: Loop[] };
  seawater: { tempC: number; salinityGL: number; chlorophyllUgL: number };
  intake: { pumps: Record<PumpId, Pump>; screenFouling: number; flowM3h: number; requiredM3h: number };
  pretreat: { chlorineMgL: number; antiscalantMgL: number; biofouling: number };
  heater: { tbtC: number; firingPct: number; burnerCondition: number; heatMW: number };
  stages: Stage[];
  brine: { recircM3h: number; concentrationFactor: number; blowdownM3h: number };
  vacuum: { quality: number };
  product: { flowM3h: number; salinityPpm: number; divertToDrain: boolean };
  fuel: {
    active: FuelKind;
    changeover: { to: FuelKind; remainingTicks: number } | null;
    gas: { capMW: number; priceUsdPerGJ: number; curtailmentNotice: { atTick: number; capMW: number } | null };
    backup: { tonnes: number; grade: FuelGrade; priceUsdPerGJ: number };
    deliveries: Delivery[];
    burnMW: number;
  };
  ballCleaning: boolean;
  shift: ShiftState | null;
  scenario: { id: string; nextEventIndex: number; effects: ScenarioEffects };
  careerShiftCount: number;
}

// Nominal steady-state values; a later calibration task tunes these.
const NOMINAL = {
  tbtC: 108,
  recircM3h: RECIRC_NOMINAL_M3H,
  intakeM3h: 5500,
  intakePumpPct: 90,
  vacuumQuality: VACUUM_QUALITY_NOMINAL,
  concentrationFactor: CF_NOMINAL,
  levelM: 0.3,
  firingPct: 63,
  heatMW: 45,
};

// Actuator outputs (percent) that hold the nominal plant at equilibrium with no PID action.
export const BALANCE = {
  recircPct: (100 * NOMINAL.recircM3h) / RECIRC_PUMP_MAX_M3H,
  vacuumPct: (100 * (NOMINAL.vacuumQuality - VACUUM_QUALITY_MIN)) / (1 - VACUUM_QUALITY_MIN),
  blowdownPct: (100 * (CF_MAX - NOMINAL.concentrationFactor)) / (CF_MAX - CF_MIN),
  levelPct: LEVEL_BALANCE_VALVE_PCT,
};

/** A loop at rest: the integral is preset so that at zero error the PI output equals `output`. */
function loop(kind: keyof typeof LOOP_GAINS, setpoint: number, output: number): Loop {
  const { ki } = LOOP_GAINS[kind];
  return { mode: 'auto', setpoint, output, integral: ki > 0 ? output / ki : 0, prevError: 0, fault: null };
}

function pump(running: boolean): Pump {
  return { running, wear: 0, cavitation: 0, bearingWearMult: 1 };
}

export function createInitialState(seed: number, startPlantTime: number): PlantState {
  const stages: Stage[] = Array.from({ length: STAGE_COUNT }, (_, i) => ({
    tempC: 104 - (66 * i) / (STAGE_COUNT - 1),
    levelM: NOMINAL.levelM,
    softScaleMm: 0,
    hardScaleMm: 0,
  }));
  return {
    version: 1,
    seed,
    tick: 0,
    plantTime: startPlantTime,
    phase: 'handover',
    controlMode: 'auto',
    status: 'online',
    trip: null,
    restart: null,
    acidCleanRemainingTicks: 0,
    loops: {
      tbt: loop('tbt', NOMINAL.tbtC, NOMINAL.firingPct),
      intakeFlow: loop('intakeFlow', NOMINAL.intakeM3h, NOMINAL.intakePumpPct),
      recirc: loop('recirc', NOMINAL.recircM3h, BALANCE.recircPct),
      blowdown: loop('blowdown', NOMINAL.concentrationFactor, BALANCE.blowdownPct),
      vacuum: loop('vacuum', NOMINAL.vacuumQuality, BALANCE.vacuumPct),
      levels: Array.from({ length: STAGE_COUNT }, () => loop('level', NOMINAL.levelM, BALANCE.levelPct)),
    },
    seawater: { tempC: 30, salinityGL: 45, chlorophyllUgL: 1 },
    intake: {
      pumps: { 'P-101': pump(true), 'P-102': pump(true), 'P-103': pump(false) },
      screenFouling: 0,
      flowM3h: NOMINAL.intakeM3h,
      requiredM3h: NOMINAL.intakeM3h,
    },
    pretreat: { chlorineMgL: 1, antiscalantMgL: 2, biofouling: 0 },
    heater: { tbtC: NOMINAL.tbtC, firingPct: NOMINAL.firingPct, burnerCondition: 1, heatMW: NOMINAL.heatMW },
    stages,
    brine: {
      recircM3h: NOMINAL.recircM3h,
      concentrationFactor: NOMINAL.concentrationFactor,
      blowdownM3h: (BLOWDOWN_MAX_M3H * BALANCE.blowdownPct) / 100,
    },
    vacuum: { quality: NOMINAL.vacuumQuality },
    product: { flowM3h: 510, salinityPpm: 10, divertToDrain: false },
    fuel: {
      active: 'gas',
      changeover: null,
      gas: { capMW: 60, priceUsdPerGJ: 8, curtailmentNotice: null },
      backup: { tonnes: 200, grade: 'standard', priceUsdPerGJ: 14 },
      deliveries: [],
      burnMW: NOMINAL.heatMW,
    },
    ballCleaning: false,
    shift: null,
    scenario: {
      id: 'none',
      nextEventIndex: 0,
      effects: { offgradeOnly: false, deliveryDelayTicks: 0, chlorophyllTarget: 1, chlorophyllRampPerTick: 0 },
    },
    careerShiftCount: 0,
  };
}
