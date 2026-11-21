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
  HARD_SCALE_ONSET_C,
  HARD_SCALE_SHARE_PER_C,
  HEATER_DT0_C,
  K_LEVEL,
  LATENT_J_kg,
  LEVEL_BALANCE_VALVE_PCT,
  LEVEL_MAX_M,
  LEVEL_RECIRC_DISTURB_M,
  MAKEUP_MAX_M3H,
  MAKEUP_TAU_S,
  POOL_LEVEL_PER_M3H_S,
  RECIRC_NOMINAL_M3H,
  RECIRC_PUMP_MAX_M3H,
  RECIRC_SUCTION_MIN_M,
  RECIRC_TAU_S,
  RECOVERY_STAGES,
  SCALE_E_FOLD_C,
  SCALE_K,
  SCALE_REF_C,
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

/** Mean tube effectiveness of a run of stages (1 for an empty run). */
function meanEffectiveness(stages: readonly Stage[]): number {
  if (stages.length === 0) return 1;
  return stages.reduce((sum, st) => sum + stageEffectiveness(st), 0) / stages.length;
}

/**
 * Brine temperature entering the heater after heat recovery. The recycled brine runs through the
 * tubes of the heat-recovery stages (1-21) only, so only their scale matters: scaled tubes recover
 * less, and the heater must do more. Never below the bottom-stage temperature, so with no firing TBT
 * decays toward it instead of falling without limit.
 */
export function recoveredTempC(s: PlantState): number {
  const meanEff = meanEffectiveness(s.stages.slice(0, RECOVERY_STAGES));
  return Math.max(bottomTempC(s), s.heater.tbtC - HEATER_DT0_C / meanEff);
}

/**
 * Last-stage temperature: seawater plus an approach that widens with poor vacuum and short cooling
 * flow. The cooling seawater runs through the tubes of the heat-rejection stages (22-24), so the whole
 * approach above seawater is divided by their mean effectiveness: clean tubes give the plain approach.
 */
export function bottomTempC(s: PlantState): number {
  const flowShort = Math.max(0, 1 - s.intake.flowM3h / s.intake.requiredM3h);
  const approachC = BOTTOM_APPROACH_C + (1 - s.vacuum.quality) * BOTTOM_VACUUM_PENALTY_C + flowShort * BOTTOM_FLOW_PENALTY_C;
  return s.seawater.tempC + approachC / meanEffectiveness(s.stages.slice(RECOVERY_STAGES));
}

/**
 * The concentration factor the brine settles to. Online, salt in equals salt out at steady state, so
 * CF = (D + B) / B, with D the last tick's raw distillate (brine.distillateM3h) and B the blowdown
 * (m3/h), clamped to [CF_MIN, CF_MAX]; no blowdown gives CF_MAX. While the plant is not online
 * (tripped, restarting, acid cleaning) the target is held at its last online value (brine.cfTargetHeld),
 * so a trip does not swing the chemistry.
 */
export function cfTarget(s: PlantState, blowdownM3h: number): number {
  if (s.status !== 'online') return s.brine.cfTargetHeld;
  if (blowdownM3h <= 0) return CF_MAX;
  return clamp((s.brine.distillateM3h + blowdownM3h) / blowdownM3h, CF_MIN, CF_MAX);
}

/**
 * Scale growth rates (mm/s) at a stage temperature for the current chemistry. Soft scale rises
 * exponentially with temperature: low at <= 95 C, severe above 105 C. Above HARD_SCALE_ONSET_C, CaSO4
 * also deposits directly as hard scale, a share of the soft rate that grows with every degree over.
 */
export function scalingRates(tempC: number, antiscalantMgL: number, cf: number): { softMmPerS: number; hardMmPerS: number } {
  const inhibition = 1 - Math.min(0.9, antiscalantMgL / 4);
  const cfMult = Math.max(1, (cf - 1.5) * 4 + 1);
  const softMmPerS = SCALE_K * Math.exp((tempC - SCALE_REF_C) / SCALE_E_FOLD_C) * inhibition * cfMult;
  const hardMmPerS = softMmPerS * HARD_SCALE_SHARE_PER_C * Math.max(0, tempC - HARD_SCALE_ONSET_C);
  return { softMmPerS, hardMmPerS };
}

/**
 * The recirculation pump's deliverable maximum: reduced to a fraction of normal during a power dip,
 * and falling linearly to zero as the stage-24 brine pool it draws from drops below
 * RECIRC_SUCTION_MIN_M (the pump loses suction).
 */
function recircCapM3h(s: PlantState): number {
  const dipping = s.faults.powerDipRemainingTicks > 0;
  const poolM = s.stages[s.stages.length - 1]?.levelM ?? 0;
  const suction = Math.min(1, Math.max(0, poolM) / RECIRC_SUCTION_MIN_M);
  return RECIRC_PUMP_MAX_M3H * (dipping ? s.faults.powerDipRecircFactor : 1) * suction;
}

/**
 * Advance the flash stages, vacuum and brine circuit one step. Reads recirc, vacuum, blowdown, makeup
 * and level loop outputs as actuator positions; does not step any PID. Stages 1-23 hold their level
 * against their interstage valve; stage 24 is the brine pool, whose level follows its inventory:
 * seawater makeup in, this tick's distillate and the blowdown out. Makeup never exceeds the intake
 * flow. CF lags toward cfTarget (stored as brine.cfTargetHeld). Returns the raw distillate (before
 * plant-status gating, also stored as brine.distillateM3h) and the brine carryover from flooded stages.
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
  const blowdownM3h = BLOWDOWN_MAX_M3H * pct(s.loops.blowdown.output);
  // Stored as the held target: online it is this tick's salt balance, otherwise cfTarget already
  // returns the held value, so storing it leaves it unchanged.
  const cfTargetHeld = cfTarget(s, blowdownM3h);
  const concentrationFactor = lag(s.brine.concentrationFactor, cfTargetHeld, dtS, CF_TAU_S);
  // Makeup is a share of the seawater the intake delivers: never more than the intake flow.
  const intakeM3h = Math.max(0, s.intake.flowM3h);
  const makeupM3h = Math.min(
    intakeM3h,
    lag(s.brine.makeupM3h, Math.min(MAKEUP_MAX_M3H * pct(s.loops.makeup.output), intakeM3h), dtS, MAKEUP_TAU_S),
  );
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
  const stages: Stage[] = s.stages.map((st, i) => {
    const tempC = tbt - (tbt - bottom) * ((i + 0.5) / n);
    distillateKgS += ((massKgS * CP_BRINE * stageDtC) / LATENT_J_kg) * stageEffectiveness(st) * (s.faults.stageDerate[i] ?? 1);

    const rates = scalingRates(tempC, antiscalantMgL, s.brine.concentrationFactor);
    const grown = st.softScaleMm + rates.softMmPerS * dtS;
    const hardened = grown * (1 - Math.exp(-SOFT_TO_HARD_PER_S * dtS));
    const cleaned = ballClean ? (grown - hardened) * Math.exp(-BALL_CLEAN_RATE * dtS) : grown - hardened;
    const hardScaleMm = st.hardScaleMm + hardened + rates.hardMmPerS * dtS;

    // The pool (the last stage) has no interstage valve: its level is set below, once the distillate is known.
    const levelLoop = s.loops.levels[i];
    const valve = levelLoop ? pct(levelLoop.output) : 0;
    const levelM = i === n - 1 ? st.levelM : clamp(st.levelM + K_LEVEL * (inflowFraction - valve) * dtS + disturbanceM, 0, LEVEL_MAX_M);

    return { tempC, levelM, softScaleMm: cleaned, hardScaleMm };
  });

  const factor = ballClean ? BALL_CLEAN_DISTILLATE_FACTOR : 1;
  const distillateM3h = ((distillateKgS * 3600) / DISTILLATE_DENSITY) * factor;

  const pool = stages[n - 1];
  if (pool) {
    const netM3h = makeupM3h - distillateM3h - blowdownM3h;
    stages[n - 1] = { ...pool, levelM: clamp(pool.levelM + POOL_LEVEL_PER_M3H_S * netM3h * dtS, 0, LEVEL_MAX_M) };
  }
  const carryover = stages.reduce((sum, st) => sum + Math.max(0, st.levelM - CARRYOVER_LEVEL_M), 0);

  const brine = { ...s.brine, recircM3h, concentrationFactor, blowdownM3h, makeupM3h, distillateM3h, cfTargetHeld };
  return { state: { ...s, stages, brine, vacuum }, distillateM3h, carryover };
}
