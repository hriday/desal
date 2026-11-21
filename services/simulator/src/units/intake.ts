import {
  BIO_GROWTH_PER_CHL,
  BIO_KILL_PER_CHLORINE,
  CAVITATION_DECAY_PER_TICK,
  CAVITATION_RISE_PER_TICK,
  CAVITATION_SCREEN_THRESHOLD,
  CAVITATION_SPEED_PCT,
  INTAKE_REQUIRED_BASE_M3H,
  INTAKE_REQUIRED_PER_C,
  PUMP_RATED_M3H,
  PUMP_WEAR_BASE_PER_TICK,
  PUMP_WEAR_CAVITATION_PER_TICK,
  PUMP_WEAR_FLOW_LOSS,
  SCREEN_LAG_PER_TICK,
  TICK_PLANT_S,
} from '../constants.js';
import type { PlantState, Pump } from '../state.js';

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

/** Advance intake and pretreatment one step. Reads loops.intakeFlow.output; does not step the PID. */
export function stepIntake(s: PlantState, dtS: number): PlantState {
  const k = dtS / TICK_PLANT_S; // rates are per nominal tick
  const { chlorophyllUgL, tempC } = s.seawater;
  const { chlorineMgL } = s.pretreat;

  const bio = s.pretreat.biofouling;
  const biofouling = clamp01(bio + (BIO_GROWTH_PER_CHL * chlorophyllUgL - BIO_KILL_PER_CHLORINE * chlorineMgL * bio) * k);
  const screenFouling = clamp01(
    s.intake.screenFouling + (clamp01(biofouling + s.faults.stormFouling) - s.intake.screenFouling) * Math.min(1, SCREEN_LAG_PER_TICK * k),
  );

  const speedPct = s.loops.intakeFlow.output;
  const cavitating = screenFouling > CAVITATION_SCREEN_THRESHOLD && speedPct > CAVITATION_SPEED_PCT;

  let maxFlow = 0;
  const pumps = {} as PlantState['intake']['pumps'];
  for (const id of Object.keys(s.intake.pumps) as (keyof typeof pumps)[]) {
    const p = s.intake.pumps[id];
    let next: Pump;
    if (p.running) {
      const cavitation = clamp01(
        cavitating
          ? p.cavitation + CAVITATION_RISE_PER_TICK * ((screenFouling - CAVITATION_SCREEN_THRESHOLD) * 2) * k
          : p.cavitation - CAVITATION_DECAY_PER_TICK * k,
      );
      const wear = clamp01(
        p.wear + (PUMP_WEAR_BASE_PER_TICK + cavitation * PUMP_WEAR_CAVITATION_PER_TICK) * p.bearingWearMult * k,
      );
      next = { ...p, cavitation, wear };
      maxFlow += PUMP_RATED_M3H * (1 - PUMP_WEAR_FLOW_LOSS * wear) * (1 - screenFouling);
    } else {
      next = { ...p, cavitation: clamp01(p.cavitation - CAVITATION_DECAY_PER_TICK * k) };
    }
    pumps[id] = next;
  }

  const flowM3h = (Math.min(100, Math.max(0, speedPct)) / 100) * maxFlow;
  const requiredM3h = INTAKE_REQUIRED_BASE_M3H * (1 + INTAKE_REQUIRED_PER_C * Math.max(0, tempC - 30));

  return {
    ...s,
    pretreat: { ...s.pretreat, biofouling },
    intake: { pumps, screenFouling, flowM3h, requiredM3h },
  };
}

/**
 * Count down pump overhauls by one tick. A pump under overhaul is stopped, so it takes no wear;
 * on completion it is as new (no wear, no cavitation, normal bearings).
 */
export function stepOverhauls(s: PlantState): PlantState {
  const ids = Object.keys(s.intake.pumps) as (keyof PlantState['intake']['pumps'])[];
  if (ids.every((id) => s.intake.pumps[id].overhaulRemainingTicks <= 0)) return s;
  const pumps = { ...s.intake.pumps };
  for (const id of ids) {
    const p = pumps[id];
    if (p.overhaulRemainingTicks <= 0) continue;
    const left = p.overhaulRemainingTicks - 1;
    pumps[id] =
      left > 0
        ? { ...p, overhaulRemainingTicks: left }
        : { ...p, wear: 0, cavitation: 0, bearingWearMult: 1, overhaulRemainingTicks: 0 };
  }
  return { ...s, intake: { ...s.intake, pumps } };
}
