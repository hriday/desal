import type {
  CrewJob,
  FuelGrade,
  GameEndReason,
  GameMode,
  PlantEvent,
  FuelKind,
  Phase,
  PlantStatusKind,
  PumpId,
  RestartStep,
  TripCause,
} from '@desal/schema';
import {
  BASE_SALINITY_PPM,
  BIO_GROWTH_PER_CHL,
  BIO_KILL_PER_CHLORINE,
  BLOWDOWN_MAX_M3H,
  BOTTOM_APPROACH_C,
  BOTTOM_VACUUM_PENALTY_C,
  BRINE_DENSITY,
  BURNER_MAX_MW,
  CF_MAX,
  CF_MIN,
  CF_NOMINAL,
  CP_BRINE,
  DISTILLATE_DENSITY,
  GAS_BASE_PRICE_USD_PER_GJ,
  GAS_CAP_MW,
  HEATER_DT0_C,
  INTAKE_REQUIRED_BASE_M3H,
  LATENT_J_kg,
  LEVEL_BALANCE_VALVE_PCT,
  LOOP_GAINS,
  PUMP_RATED_M3H,
  RECIRC_NOMINAL_M3H,
  RECIRC_PUMP_MAX_M3H,
  STAGE_COUNT,
  START_BALANCE_USD,
  VACUUM_QUALITY_MIN,
  VACUUM_QUALITY_NOMINAL,
} from './constants.js';
import type { ActiveChaos, ChaosPlan, SensorFault } from './scenario/chaosTypes.js';
import type { Scenario } from './scenario/types.js';

/** The loops' process values, which a sensor fault can corrupt (the names match the LoopId of the same loops). */
export type LoopSensorId = 'tbt' | 'intakeFlow' | 'recirc' | 'blowdown' | 'vacuum';

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
  /** Ticks left in an overhaul (0 = not under overhaul). */
  overhaulRemainingTicks: number;
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
  /**
   * productM3: in-spec water delivered (the shift's progress); offSpecM3: off-spec water delivered,
   * which counts for nothing. fuelCostUsd: gas burned plus backup ordered. spentUsd: fuel plus
   * repairs, crew jobs and the standing cost.
   */
  acc: { productM3: number; offSpecM3: number; offSpecTicks: number; fuelCostUsd: number; trips: number; spentUsd: number };
}
export interface ScenarioEffects {
  offgradeOnly: boolean;
  deliveryDelayTicks: number;
  chlorophyllTarget: number;
  chlorophyllRampPerTick: number;
}

/** An event as the plant units produce it; tick() stamps gameId, seq, tick and plantTime. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type SimEvent = DistributiveOmit<PlantEvent, 'gameId' | 'epoch' | 'seq'>;

/** A tsunami in progress: the warning, the surge, and whether the crew cleaned up after it. */
export interface TsunamiFault {
  warnRemainingTicks: number;
  surgeRemainingTicks: number;
  surgeDone: boolean;
  cleanedAfterSurge: boolean;
  /** Seawater cooling (degC) applied when the surge arrives, drawn when the tsunami fires. */
  coolC: number;
}

/** One game = one run of shifts in one sitting; the operating account lives here. */
export interface Run {
  gameId: string;
  mode: GameMode;
  balanceUsd: number;
  shiftNumber: number;
  totalProductM3: number;
  shiftsCompleted: number;
  /** Next event seq to assign (per game, monotonically increasing within an epoch). */
  eventSeq: number;
  /** Times this game was restored from a snapshot (GameHost.restore); stamped on every record. */
  epoch: number;
  over: { reason: GameEndReason; atTick: number } | null;
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
  /**
   * prevFiringPct: firing (tbt output) seen at the previous restart step, used to police the manual ramp rate.
   * progressTick / bestTbtC: the Auto stall clock; the tick the step last made progress, and the best
   * TBT seen in the ramp.
   */
  restart: {
    step: RestartStep;
    stepStartedTick: number;
    auto: boolean;
    prevFiringPct: number;
    progressTick: number;
    bestTbtC: number;
  } | null;
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
  scenario: { id: string; definition: Scenario | null; nextEventIndex: number; effects: ScenarioEffects };
  run: Run;
  chaos: { pending: ChaosPlan | null; active: ActiveChaos | null; lastWasHell: boolean; lastHadDisaster: boolean };
  crew: { job: CrewJob; remainingTicks: number } | null;
  faults: {
    tubeLeak: { stage: number; ppm: number } | null;
    ejectorFailed: boolean;
    /** Vacuum quality the failed ejector loses per plant minute at nominal load. */
    ejectorRatePerMin: number;
    powerDipRemainingTicks: number;
    /** Recirculation pump cap while a power dip lasts, as a fraction of its normal maximum. */
    powerDipRecircFactor: number;
    stormRemainingTicks: number;
    stormFouling: number;
    /** Set by the cleanScreens crew job (Task 8); it alone makes a storm count as cleared by the crew. */
    stormCleanedByCrew: boolean;
    /** Fuel contaminated by a bad delivery; set while the contaminated fuel is the active one. */
    fuelContamination: { fuel: FuelKind } | null;
    tsunami: TsunamiFault | null;
    sensors: Partial<Record<LoopSensorId, SensorFault>>;
    /** Per-stage capacity multiplier, 1 = healthy. */
    stageDerate: number[];
  };
}

const SEAWATER_C = 30;
const TBT_C = 93.5;
const CHLOROPHYLL_UGL = 1;
const CHLORINE_MGL = 1;
/** Biofouling (and so screen fouling) where growth balances the chlorine kill (as units/intake). */
const BIOFOULING = (BIO_GROWTH_PER_CHL * CHLOROPHYLL_UGL) / (BIO_KILL_PER_CHLORINE * CHLORINE_MGL);
const INTAKE_SP_M3H = 6000;
const RUNNING_PUMPS = 2;
/** Bottom-stage temperature with full cooling flow at nominal vacuum (as units/stages bottomTempC). */
const BOTTOM_C = SEAWATER_C + BOTTOM_APPROACH_C + (1 - VACUUM_QUALITY_NOMINAL) * BOTTOM_VACUUM_PENALTY_C;
const RECIRC_KGS = (RECIRC_NOMINAL_M3H * BRINE_DENSITY) / 3600;
/** Heater duty that holds TBT with clean tubes: recovered = TBT - HEATER_DT0_C (as units/heater). */
const HEAT_MW = (RECIRC_KGS * CP_BRINE * HEATER_DT0_C) / 1e6;

// Nominal steady state, derived from the unit physics so tick 0 -> 1 starts at equilibrium.
export const NOMINAL = {
  tbtC: TBT_C,
  recircM3h: RECIRC_NOMINAL_M3H,
  intakeM3h: INTAKE_SP_M3H,
  /** Pump speed that delivers the intake setpoint through two clean pumps and the equilibrium screen. */
  intakePumpPct: (100 * INTAKE_SP_M3H) / (RUNNING_PUMPS * PUMP_RATED_M3H * (1 - BIOFOULING)),
  vacuumQuality: VACUUM_QUALITY_NOMINAL,
  concentrationFactor: CF_NOMINAL,
  levelM: 0.3,
  firingPct: (100 * HEAT_MW) / BURNER_MAX_MW,
  heatMW: HEAT_MW,
  /** Flash distillate over the whole cascade with clean tubes (as units/stages). */
  productM3h: ((RECIRC_KGS * CP_BRINE * (TBT_C - BOTTOM_C)) / LATENT_J_kg) * (3600 / DISTILLATE_DENSITY),
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
  return { running, wear: 0, cavitation: 0, bearingWearMult: 1, overhaulRemainingTicks: 0 };
}

/** Every per-shift fault cleared: the state a shift starts with. */
export function noFaults(): PlantState['faults'] {
  return {
    tubeLeak: null,
    ejectorFailed: false,
    ejectorRatePerMin: 0,
    powerDipRemainingTicks: 0,
    powerDipRecircFactor: 1,
    stormRemainingTicks: 0,
    stormFouling: 0,
    stormCleanedByCrew: false,
    fuelContamination: null,
    tsunami: null,
    sensors: {},
    stageDerate: Array.from({ length: STAGE_COUNT }, () => 1),
  };
}

export function createInitialState(seed: number, startPlantTime: number, gameId: string, mode: GameMode = 'normal'): PlantState {
  const stages: Stage[] = Array.from({ length: STAGE_COUNT }, (_, i) => ({
    tempC: NOMINAL.tbtC - (NOMINAL.tbtC - BOTTOM_C) * ((i + 0.5) / STAGE_COUNT),
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
    seawater: { tempC: SEAWATER_C, salinityGL: 45, chlorophyllUgL: CHLOROPHYLL_UGL },
    intake: {
      pumps: { 'P-101': pump(true), 'P-102': pump(true), 'P-103': pump(false) },
      screenFouling: BIOFOULING,
      flowM3h: NOMINAL.intakeM3h,
      requiredM3h: INTAKE_REQUIRED_BASE_M3H,
    },
    pretreat: { chlorineMgL: CHLORINE_MGL, antiscalantMgL: 2, biofouling: BIOFOULING },
    heater: { tbtC: NOMINAL.tbtC, firingPct: NOMINAL.firingPct, burnerCondition: 1, heatMW: NOMINAL.heatMW },
    stages,
    brine: {
      recircM3h: NOMINAL.recircM3h,
      concentrationFactor: NOMINAL.concentrationFactor,
      blowdownM3h: (BLOWDOWN_MAX_M3H * BALANCE.blowdownPct) / 100,
    },
    vacuum: { quality: NOMINAL.vacuumQuality },
    product: { flowM3h: NOMINAL.productM3h, salinityPpm: BASE_SALINITY_PPM, divertToDrain: false },
    fuel: {
      active: 'gas',
      changeover: null,
      gas: { capMW: GAS_CAP_MW, priceUsdPerGJ: GAS_BASE_PRICE_USD_PER_GJ, curtailmentNotice: null },
      backup: { tonnes: 200, grade: 'standard', priceUsdPerGJ: 14 },
      deliveries: [],
      burnMW: NOMINAL.heatMW,
    },
    ballCleaning: false,
    shift: null,
    scenario: {
      id: 'none',
      definition: null,
      nextEventIndex: 0,
      effects: { offgradeOnly: false, deliveryDelayTicks: 0, chlorophyllTarget: 1, chlorophyllRampPerTick: 0 },
    },
    run: { gameId, mode, balanceUsd: START_BALANCE_USD, shiftNumber: 0, totalProductM3: 0, shiftsCompleted: 0, eventSeq: 0, epoch: 0, over: null },
    chaos: { pending: null, active: null, lastWasHell: false, lastHadDisaster: false },
    crew: null,
    faults: noFaults(),
  };
}
