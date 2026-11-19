import {
  BALL_CLEAN_DISTILLATE_FACTOR,
  BALL_CLEAN_RATE,
  BLOWDOWN_MAX_M3H,
  BOTTOM_APPROACH_C,
  BOTTOM_FLOW_PENALTY_C,
  BOTTOM_VACUUM_PENALTY_C,
  BRINE_DENSITY,
  CARRYOVER_LEVEL_M,
  CF_MAX,
  CF_MIN,
  CF_TAU_S,
  CP_BRINE,
  DISTILLATE_DENSITY,
  EJECTOR_HALVE_FIRING_FRAC,
  EJECTOR_HALVE_TBT_C,
  EJECTOR_MIN_LOAD_FACTOR,
  HEATER_DT0_C,
  K_LEVEL,
  LATENT_J_kg,
  LEVEL_BALANCE_VALVE_PCT,
  LEVEL_MAX_M,
  LEVEL_RECIRC_DISTURB_M,
  RECIRC_NOMINAL_M3H,
  RECIRC_PUMP_MAX_M3H,
  RECIRC_TAU_S,
  SCALE_K,
  SCALE_REF_MM,
  SOFT_TO_HARD_PER_S,
  VACUUM_QUALITY_MIN,
  VACUUM_TAU_S,
} from '../constants.js';
import { NOMINAL, type PlantState, type Stage } from '../state.js';

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
const pct = (output: number): number => clamp(output, 0, 100) / 100;
/** Exact first-order lag of x toward target over dtS with time constant tauS. */
const lag = (x: number, target: number, dtS: number, tauS: number): number =>
  x + (target - x) * (1 - Math.exp(-dtS / tauS));

/**
 * How much of a failed ejector's vacuum loss a load leaves: 1 at or above nominal, falling linearly to
 * a half at EJECTOR_HALVE_TBT_C below nominal TBT or EJECTOR_HALVE_FIRING_FRAC below nominal firing
 * (whichever cut is deeper), and never below EJECTOR_MIN_LOAD_FACTOR.
 */
export function ejectorLoadFactor(tbtC: number, firingPct: number): number {
  const tbtCut = (NOMINAL.tbtC - tbtC) / EJECTOR_HALVE_TBT_C;
  const firingCut = (NOMINAL.firingPct - firingPct) / (NOMINAL.firingPct * EJECTOR_HALVE_FIRING_FRAC);
  const cut = Math.max(0, tbtCut, firingCut);
  return Math.max(EJECTOR_MIN_LOAD_FACTOR, 1 - 0.5 * cut);
}

/** Heat-transfer effectiveness of a stage's tubes: 1 when clean, falling with total scale. */
export function stageEffectiveness(stage: Stage): number {
  return 1 / (1 + (stage.softScaleMm + stage.hardScaleMm) / SCALE_REF_MM);
}

/**
 * Brine temperature entering the heater after heat recovery. Scaled tubes recover less, so the
 * heater must do more. Never below the bottom-stage temperature, so with no firing TBT decays
 * toward it instead of falling without limit.
 */
export function recoveredTempC(s: PlantState): number {
  const meanEff = s.stages.reduce((sum, st) => sum + stageEffectiveness(st), 0) / s.stages.length;
  return Math.max(bottomTempC(s), s.heater.tbtC - HEATER_DT0_C / meanEff);
}

/** Last-stage temperature: seawater plus an approach that widens with poor vacuum and short cooling flow. */
export function bottomTempC(s: PlantState): number {
  const flowShort = Math.max(0, 1 - s.intake.flowM3h / s.intake.requiredM3h);
  return (
    s.seawater.tempC +
    BOTTOM_APPROACH_C +
    (1 - s.vacuum.quality) * BOTTOM_VACUUM_PENALTY_C +
    flowShort * BOTTOM_FLOW_PENALTY_C
  );
}

/** Soft scale growth rate (mm/s) at a stage temperature for the current chemistry. */
function softScaleRate(tempC: number, antiscalantMgL: number, cf: number): number {
  const inhibition = 1 - Math.min(0.9, antiscalantMgL / 4);
  const cfMult = Math.max(1, (cf - 1.5) * 4 + 1);
  return SCALE_K * Math.exp((tempC - 110) / 5) * inhibition * cfMult;
}

/** The recirculation pump's deliverable maximum: reduced to a fraction of normal during a power dip. */
function recircCapM3h(s: PlantState): number {
  const dipping = s.faults.powerDipRemainingTicks > 0;
  return RECIRC_PUMP_MAX_M3H * (dipping ? s.faults.powerDipRecircFactor : 1);
}

/**
 * Advance the flash stages, vacuum and brine circuit one step. Reads recirc, vacuum, blowdown and
 * level loop outputs as actuator positions; does not step any PID. Returns the raw distillate
 * (before plant-status gating) and the brine carryover from flooded stages.
 */
export function stepStages(
  s: PlantState,
  dtS: number,
): { state: PlantState; distillateM3h: number; carryover: number } {
  // Actuators.
  const prevRecirc = s.brine.recircM3h;
  const recircM3h = lag(prevRecirc, Math.min(RECIRC_PUMP_MAX_M3H * pct(s.loops.recirc.output), recircCapM3h(s)), dtS, RECIRC_TAU_S);
  // A failed ejector gives no steam to pull vacuum, so the vacuum loop cannot recover it: it only falls, more slowly at low load.
  const quality = s.faults.ejectorFailed
    ? Math.max(
        0,
        s.vacuum.quality - (s.faults.ejectorRatePerMin * ejectorLoadFactor(s.heater.tbtC, s.heater.firingPct) * dtS) / 60,
      )
    : lag(
        s.vacuum.quality,
        VACUUM_QUALITY_MIN + (1 - VACUUM_QUALITY_MIN) * pct(s.loops.vacuum.output),
        dtS,
        VACUUM_TAU_S,
      );
  const blowdownPct = pct(s.loops.blowdown.output);
  const concentrationFactor = lag(
    s.brine.concentrationFactor,
    CF_MAX - (CF_MAX - CF_MIN) * blowdownPct,
    dtS,
    CF_TAU_S,
  );
  const brine = { recircM3h, concentrationFactor, blowdownM3h: BLOWDOWN_MAX_M3H * blowdownPct };
  const vacuum = { quality };

  // Temperature cascade.
  const tbt = s.heater.tbtC;
  const bottom = bottomTempC({ ...s, vacuum });
  const n = s.stages.length;
  const stageDtC = Math.max(0, (tbt - bottom) / n);
  const massKgS = (recircM3h * BRINE_DENSITY) / 3600;

  // Levels: recirc-proportional inflow against the interstage valve, plus a recirc-change disturbance.
  const inflowFraction = (LEVEL_BALANCE_VALVE_PCT / 100) * (recircM3h / RECIRC_NOMINAL_M3H);
  const disturbanceM = (LEVEL_RECIRC_DISTURB_M * (recircM3h - prevRecirc)) / RECIRC_NOMINAL_M3H;

  const { antiscalantMgL } = s.pretreat;
  const ballClean = s.ballCleaning;
  let distillateKgS = 0;
  let carryover = 0;
  const stages: Stage[] = s.stages.map((st, i) => {
    const tempC = tbt - (tbt - bottom) * ((i + 0.5) / n);
    distillateKgS += ((massKgS * CP_BRINE * stageDtC) / LATENT_J_kg) * stageEffectiveness(st) * (s.faults.stageDerate[i] ?? 1);

    const grown = st.softScaleMm + softScaleRate(tempC, antiscalantMgL, s.brine.concentrationFactor) * dtS;
    const hardened = grown * (1 - Math.exp(-SOFT_TO_HARD_PER_S * dtS));
    const cleaned = ballClean ? (grown - hardened) * Math.exp(-BALL_CLEAN_RATE * dtS) : grown - hardened;

    const levelLoop = s.loops.levels[i];
    const valve = levelLoop ? pct(levelLoop.output) : 0;
    const levelM = clamp(st.levelM + K_LEVEL * (inflowFraction - valve) * dtS + disturbanceM, 0, LEVEL_MAX_M);
    carryover += Math.max(0, levelM - CARRYOVER_LEVEL_M);

    return { tempC, levelM, softScaleMm: cleaned, hardScaleMm: st.hardScaleMm + hardened };
  });

  const factor = ballClean ? BALL_CLEAN_DISTILLATE_FACTOR : 1;
  const distillateM3h = ((distillateKgS * 3600) / DISTILLATE_DENSITY) * factor;
  return { state: { ...s, stages, brine, vacuum }, distillateM3h, carryover };
}
